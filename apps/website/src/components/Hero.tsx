import { useEffect, useRef, useState } from 'react';
import { mountHero } from './hero-scene';
import './Hero.css';

export default function Hero() {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof mountHero> | null>(null);
  const [moving, setMoving] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    try {
      controller.current = mountHero(host.current, () => {
        setFailed(true);
        controller.current?.dispose();
        controller.current = null;
      });
    } catch {
      setFailed(true);
    }
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  const toggleMotion = () => {
    controller.current?.setMoving(!moving);
    setMoving(!moving);
  };
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="kicker">Persistent browser storage. Familiar file APIs.</p>
        <h1>
          <span>Many files.</span> <span>Few handles.</span>
          <br />
          <span>Synchronous I/O.</span>
        </h1>
        <p className="hero-summary">
          Store files in the browser with OPFS. Use synchronous I/O inside a worker, and inspect your files through
          familiar paths.
        </p>
        <div className="hero-sdks" aria-label="Use OPFS VFS with">
          <a href="#example-javascript">
            <img src="/brand/typescript.svg" alt="" width="24" height="24" /> TypeScript
          </a>
          <a href="#example-react">
            <img src="/brand/react.svg" alt="" width="24" height="24" /> React
          </a>
          <a href="#example-effect">
            <span className="effect-mark" aria-hidden="true">
              <img className="effect-on-light" src="/brand/effect-black.svg" alt="" width="24" height="24" />
              <img className="effect-on-dark" src="/brand/effect-white.svg" alt="" width="24" height="24" />
            </span>{' '}
            Effect
          </a>
        </div>
        <a className="hero-release" href="/docs/effect/">
          Effect v4 adapter <span className="release-badge">New</span> <span aria-hidden="true">→</span>
        </a>
        <div className="hero-actions">
          <a className="button solid" href="/demos/filesystem/">
            Explore files
          </a>
          <a className="button" href="/demos/pglite/">
            Try PGlite
          </a>
          <a className="hero-adapters-link" href="#adapters">
            Explore adapters <span aria-hidden="true">↓</span>
          </a>
        </div>
      </div>
      <div className={`hero-scene${failed ? ' hero-fallback' : ''}`}>
        <div className="hero-art" role="img" aria-label="Segmented storage rings representing an OPFS VFS volume">
          <div ref={host} className="hero-visual" aria-hidden="true" />
          <div className="hero-static-ring" aria-hidden="true" />
          <span className="hero-wordmark" aria-hidden="true">
            PFS
          </span>
          <span className="hero-vfs" aria-hidden="true">
            <span>[</span> VFS <span>]</span>
          </span>
        </div>
        {!failed && (
          <button className="motion" type="button" aria-pressed={!moving} onClick={toggleMotion}>
            {moving ? 'Pause motion' : 'Play motion'}
          </button>
        )}
      </div>
    </section>
  );
}
