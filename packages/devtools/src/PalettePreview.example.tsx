import type { PreviewProps } from '@opfs-vfs/file-preview';

// Example application-supplied extension. Adding it requires no changes to the shared renderer.
export default function PalettePreview({ file }: PreviewProps) {
  const source = file.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) : file.content;
  const colors = source.split('\n').filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  return (
    <div className="palette-example">
      <h3>Workspace palette</h3>
      <p>Custom preview extension</p>
      {colors.map((color) => (
        <div key={color}>
          <span style={{ background: color }} />
          {color}
        </div>
      ))}
    </div>
  );
}
