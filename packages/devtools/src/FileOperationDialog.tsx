import { useEffect, useRef, useState } from 'react';
import type { FileOperation } from './mock-files';
export type FileRequest = { volume: string; path: string; kind: 'file' | 'folder' | 'rename' | 'delete' };
export function FileOperationDialog({
  simulated = false,
  request,
  onConfirm,
  onClose,
}: {
  simulated?: boolean;
  request: FileRequest;
  onConfirm: (volume: string, operation: FileOperation) => void | Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(request.kind === 'rename' ? request.path.split('/').at(-1)! : '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const deleting = request.kind === 'delete';
  const title = { file: 'New file', folder: 'New folder', rename: 'Rename entry', delete: 'Delete entry' }[
    request.kind
  ];
  return (
    <dialog ref={dialog} className="debug-modal" aria-label={title} onCancel={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (working) return;
          setWorking(true);
          try {
            const operation: FileOperation =
              request.kind === 'delete'
                ? { kind: 'delete', path: request.path }
                : request.kind === 'rename'
                  ? { kind: 'rename', path: request.path, name }
                  : { kind: request.kind, parent: request.path, name };
            await onConfirm(request.volume, operation);
            onClose();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setWorking(false);
          }
        }}
      >
        <h2>{title}</h2>
        <p className="modal-subtitle">
          {request.volume} · {request.path}
        </p>
        {deleting ? (
          <p>
            {simulated
              ? 'This deletes the entry and its contents from simulated data. Reloading restores the fixtures.'
              : 'This permanently deletes the entry and its contents from this volume.'}
          </p>
        ) : (
          <label>
            Name
            <input autoFocus aria-label="Entry name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button disabled={working} className={deleting ? 'danger' : 'primary'} type="submit">
            {deleting ? 'Delete entry' : 'Save entry'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
