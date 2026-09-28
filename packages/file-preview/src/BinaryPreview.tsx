import type { PreviewProps } from './FilePreview';

// Adapted from frachter-app/opfs-vfs bash-console/plugins/binary-raw.tsx, with a bounded hex view.
export default function BinaryPreview({ file }: PreviewProps) {
  const bytes = file.bytes ?? new TextEncoder().encode(file.content);
  const rows: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, 4096); offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, 4096));
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const ascii = Array.from(chunk, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join(
      '',
    );
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  return (
    <div className="fp-binary">
      <p>
        Read-only hex preview · first {Math.min(bytes.length, 4096)} of {bytes.length} bytes
      </p>
      <pre>{rows.join('\n') || 'Empty file'}</pre>
    </div>
  );
}
