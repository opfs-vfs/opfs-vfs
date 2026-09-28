import { useEffect, useRef, useState } from 'react';
import type { DemoFile, EdgeJSRequest, EdgeJSResponse } from '../workers/edgejs.worker';
import './EdgeJSDemo.css';

const INITIAL_CODE = `const fs = require('node:fs');
const path = '/data/counter.txt';
const previous = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;
const counter = previous + 1;
fs.writeFileSync(path, String(counter));
console.log('Counter:', counter);
console.log('Reload this page and run again to keep counting.');`;

export default function EdgeJSDemo() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(true);
  const [code, setCode] = useState(INITIAL_CODE);
  const [busy, setBusy] = useState(true);
  const [fatal, setFatal] = useState(false);
  const [status, setStatus] = useState('Checking browser support…');
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [files, setFiles] = useState<DemoFile[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState('');

  useEffect(() => {
    function fail(message: string) {
      pending.current = true;
      setFatal(true);
      setBusy(false);
      setStatus('Demo unavailable.');
      setError(message);
    }
    if (!isSecureContext || !navigator.storage?.getDirectory) {
      fail('This demo needs browser file storage on HTTPS or localhost.');
      return;
    }
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      fail('This page needs cross-origin isolation to run EdgeJS. See the integration guide.');
      return;
    }
    if (typeof (WebAssembly as typeof WebAssembly & { Suspending?: unknown }).Suspending !== 'function') {
      fail('Use a recent Chromium browser with WebAssembly JSPI support to run this experimental demo.');
      return;
    }
    let owner: Worker;
    try {
      owner = new Worker(new URL('../workers/edgejs.worker.ts', import.meta.url), { type: 'module' });
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : 'Could not start the demo worker.');
      return;
    }
    worker.current = owner;
    owner.onmessage = ({ data }: MessageEvent<EdgeJSResponse>) => {
      if (data.type === 'status') {
        setStatus(data.message);
        return;
      }
      pending.current = data.type === 'error' && data.fatal;
      setBusy(false);
      if (data.type === 'error') {
        setError(data.message);
        setFatal(data.fatal);
        setStatus(data.fatal ? 'Reload required.' : 'Ready.');
      } else if (data.type === 'ready') {
        setFiles(data.files);
        setStatus(data.message);
        setSelected('');
        setPreview('');
        if (data.output !== undefined) setOutput(data.output);
      } else {
        setSelected(data.path);
        setPreview(data.text);
        setStatus('File preview ready.');
      }
    };
    owner.onerror = (event) => {
      event.preventDefault();
      fail('The demo worker stopped responding. Reload this page before trying again.');
    };
    owner.onmessageerror = () => fail('The demo could not read a worker response. Reload this page.');
    owner.postMessage({ type: 'init' } satisfies EdgeJSRequest);
    // Page teardown is abrupt; completed runs explicitly synchronize before reporting success.
    const teardown = () => owner.terminate();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) fail('This page was restored after its worker closed. Reload to reopen your saved files.');
    };
    window.addEventListener('pagehide', teardown);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', teardown);
      window.removeEventListener('pageshow', resume);
      teardown();
      worker.current = null;
    };
  }, []);

  function request(message: EdgeJSRequest, description: string) {
    if (pending.current || fatal || !worker.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus(description);
    try {
      worker.current.postMessage(message);
    } catch (cause) {
      setFatal(true);
      setBusy(false);
      setError(`${cause instanceof Error ? cause.message : 'Could not reach the demo worker.'} Reload this page.`);
    }
  }

  const disabled = busy || fatal;
  return (
    <section className="edgejs-demo" aria-label="EdgeJS playground" aria-busy={busy}>
      <header>
        <div>
          <span className="kicker">Experimental</span>
          <h2>Run the counter example</h2>
        </div>
        <div className="edgejs-actions">
          <button
            className="button"
            disabled={disabled}
            onClick={() => request({ type: 'run', code }, 'Starting program…')}
          >
            Run program
          </button>
          <button
            className="button"
            disabled={disabled}
            onClick={() => request({ type: 'reset' }, 'Resetting demo files…')}
          >
            Reset demo files
          </button>
        </div>
      </header>
      <p className="edgejs-status" role="status" aria-live="polite">
        {status}
      </p>
      {error && (
        <p className="edgejs-error" role="alert">
          {error}
        </p>
      )}
      <div className="edgejs-workspace">
        <section className="edgejs-editor">
          <label htmlFor="edgejs-code">Program</label>
          <textarea
            id="edgejs-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={64 * 1024}
            aria-describedby="edgejs-limits"
          />
          <p id="edgejs-limits">Programs can run for 15 seconds. Guest networking is disabled.</p>
        </section>
        <section className="edgejs-output" aria-labelledby="edgejs-output-label">
          <h3 id="edgejs-output-label">Output</h3>
          <pre tabIndex={0}>{output || 'Run your program to see its output.'}</pre>
        </section>
      </div>
      <section className="edgejs-files" aria-labelledby="edgejs-files-label">
        <div>
          <h3 id="edgejs-files-label">Saved files in /data</h3>
          <p>Stored only in this browser. Reset clears this demo's files.</p>
          {files.length ? (
            <ul>
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    disabled={disabled}
                    aria-pressed={selected === file.path}
                    onClick={() => request({ type: 'preview', path: file.path }, 'Reading file…')}
                  >
                    <span>{file.path.slice(1)}</span>
                    <span>{file.size.toLocaleString()} B</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No saved files yet.</p>
          )}
        </div>
        <div>
          <h3>{selected ? `/data${selected}` : 'Text preview'}</h3>
          <pre tabIndex={0}>
            {selected ? preview || '(Empty file)' : 'Select a file to preview up to 4 KiB of text.'}
          </pre>
        </div>
      </section>
    </section>
  );
}
