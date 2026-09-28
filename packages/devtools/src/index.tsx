import { createRoot } from 'react-dom/client';
import { DebugPanel } from './DebugPanel';
import { DevtoolsSession } from './runtime';
import type { PreviewExtension } from '@opfs-vfs/file-preview';
export type { PreviewExtension, PreviewProps } from '@opfs-vfs/file-preview';
export type DevtoolsOptions = {
  initialOpen?: boolean;
  initialDock?: 'floating' | 'left' | 'right' | 'top' | 'bottom';
  initialTheme?: 'dark' | 'light';
  previewExtensions?: PreviewExtension[];
};
let mounted: { unmount(): void } | undefined;
/** Explicitly mount on this origin. No application volume references are required. */
export function mountDevtools(options: DevtoolsOptions = {}) {
  if (mounted) return mounted;
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
    throw new Error('OPFS VFS devtools require a secure, cross-origin-isolated page (COOP/COEP headers).');
  const host = document.createElement('div');
  host.dataset.opfsDevtools = '';
  document.body.append(host);
  const root = createRoot(host);
  const session = new DevtoolsSession();
  root.render(<DebugPanel {...options} runtime={session} />);
  let disposed = false;
  mounted = {
    unmount() {
      if (disposed) return;
      disposed = true;
      root.unmount();
      host.remove();
      session.dispose();
      mounted = undefined;
    },
  };
  return mounted;
}
