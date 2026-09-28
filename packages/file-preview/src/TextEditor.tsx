import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';
import { limitTextChanges, textFits } from './text-limit';
import { extension } from './preview-policy';

function Editor({
  path,
  value,
  readOnly = true,
  preview = false,
  onChange,
}: {
  path: string;
  value: string;
  readOnly?: boolean;
  preview?: boolean;
  onChange?: (value: string) => void;
}) {
  const [limited, setLimited] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;
  const initial = useRef(value);
  initial.current = value;
  const syncing = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    let live = true;
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          limitTextChanges(setLimited),
          syntaxHighlighting(classHighlighter),
          language.of([]),
          preview ? EditorView.lineWrapping : [lineNumbers(), highlightActiveLine()],
          history(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          access.current.of(EditorState.readOnly.of(true)),
          EditorView.editable.of(!preview),
          EditorView.contentAttributes.of({
            'aria-label': `${preview ? 'Preview' : 'Edit'} ${path}`,
            spellcheck: 'false',
            ...(preview ? { tabindex: '0', 'aria-readonly': 'true' } : {}),
          }),
          EditorView.updateListener.of((update) => {
            // ponytail: drafts serialize the bounded document per edit; retain EditorState per file if this becomes a bottleneck.
            if (update.docChanged && !syncing.current) change.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    const name = path.split('/').at(-1) ?? path;
    const ext = extension(path);
    const alias =
      /^\.env(?:\.|$)/i.test(name) || ext === 'env'
        ? 'shell'
        : ['conf', 'cfg'].includes(ext)
          ? 'properties'
          : undefined;
    const description = alias
      ? LanguageDescription.matchLanguageName(languages, alias)
      : LanguageDescription.matchFilename(languages, name);
    void description
      ?.load()
      .then((support) => {
        if (live) editor.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(() => {
        // Keep the plain text editor usable if a language chunk fails to load.
      });
    return () => {
      live = false;
      editor.destroy();
      view.current = null;
    };
  }, [path, preview]);
  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure(EditorState.readOnly.of(preview || readOnly)) });
  }, [readOnly, path, preview]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      syncing.current = true;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
      syncing.current = false;
    }
  }, [value, path, preview]);
  return (
    <>
      <div className={`opfs-text-editor${preview ? ' opfs-text-preview' : ''}`} ref={host} />
      {limited && (
        <p role="status" className="fp-editor-limit">
          Edit rejected: text must remain within 16 MiB. Your previous content is unchanged.
        </p>
      )}
    </>
  );
}
export default function TextEditor(props: Parameters<typeof Editor>[0]) {
  return textFits(props.value) ? <Editor {...props} /> : <p role="alert">Text exceeds the 16 MiB editor limit.</p>;
}
