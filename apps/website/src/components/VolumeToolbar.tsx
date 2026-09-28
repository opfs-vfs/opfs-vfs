import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectField } from './ui/select-field';
import { useRef, useState } from 'react';
import { Archive, Database, Plus, RefreshCw, RotateCcw, Upload, LoaderCircle } from 'lucide-react';

export function VolumeToolbar({
  busy,
  ready = true,
  loading = false,
  onRetry,
  name,
  names,
  onCreate,
  onExport,
  onImport,
  onOpen,
  onReset,
  onReopen,
}: {
  busy: boolean;
  ready?: boolean;
  loading?: boolean;
  onRetry?: () => void;
  name: string;
  names: string[];
  onCreate: (name: string) => void;
  onExport: () => void;
  onImport: (name: string, file: File) => void;
  onOpen: (name: string) => void;
  onReset: () => void;
  onReopen: () => void;
}) {
  const [nextName, setNextName] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  return (
    <div className="volume-toolbar">
      <div className="volume-toolbar-main">
        <div className="volume-heading">
          <Database aria-hidden="true" />
          <label>
            <span>Volume</span>
            <SelectField
              label="Volume"
              value={String(name)}
              onValueChange={(value) => onOpen(value)}
              options={names.map((item) => ({ value: item, label: item }))}
              disabled={busy}
              className="w-full"
            />
          </label>
          {loading ? (
            <span className="volume-loading" role="status">
              <LoaderCircle aria-hidden="true" /> Opening volume…
            </span>
          ) : null}
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry filesystem
            </Button>
          ) : null}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && nextName.trim()) {
              onCreate(nextName.trim());
              setNextName('');
            }
          }}
        >
          <Input
            disabled={busy}
            aria-label="New volume name"
            maxLength={40}
            placeholder="New volume"
            value={nextName}
            onChange={(event) => setNextName(event.target.value)}
          />
          <Button type="submit" variant="default" size="default" disabled={busy}>
            <Plus aria-hidden="true" />
            Create
          </Button>
        </form>
      </div>
      <div className="volume-actions">
        <Button variant="outline" size="sm" disabled={busy || !ready} onClick={onReopen}>
          <RefreshCw aria-hidden="true" />
          Save & reopen
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !ready} onClick={onExport}>
          <Archive aria-hidden="true" />
          Export ZIP
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !ready} onClick={() => importRef.current?.click()}>
          <Upload aria-hidden="true" />
          Import ZIP
        </Button>
        <input
          ref={importRef}
          hidden
          disabled={busy || !ready}
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file && !busy && ready) onImport(file.name.replace(/\.zip$/i, ''), file);
            event.target.value = '';
          }}
        />
        <Button variant="destructive" size="sm" disabled={busy || !ready} onClick={onReset}>
          <RotateCcw aria-hidden="true" />
          Reset
        </Button>
      </div>
    </div>
  );
}
