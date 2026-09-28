import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import type { ReactElement } from 'react';

export type FileAction = 'preview' | 'edit' | 'file' | 'folder' | 'rename' | 'copy' | 'cut' | 'paste' | 'delete';
// Menu grouping follows the bash-console file tree, with no terminal or version-control coupling.
export function FileActions({
  children,
  name,
  directory,
  writable,
  pasteable,
  editable,
  onAction,
  container,
}: {
  children: ReactElement;
  name: string;
  directory: boolean;
  writable: boolean;
  pasteable: boolean;
  editable: boolean;
  onAction: (action: FileAction) => void;
  container: HTMLElement | null;
}) {
  const actions: [FileAction, string, boolean][] = [
    ['preview', directory ? 'Open folder' : 'Open preview', true],
    ['edit', 'Open in editor', editable],
    ['file', 'New file', writable],
    ['folder', 'New folder', writable],
    ['copy', 'Copy', true],
    ['cut', 'Cut', writable],
    ['paste', 'Paste here', writable && pasteable],
    ['rename', 'Rename', writable],
    ['delete', 'Delete', writable],
  ];
  return (
    <div className="file-entry-actions">
      <ContextMenu.Root>
        <ContextMenu.Trigger render={children} />
        <ContextMenu.Portal container={container}>
          <ContextMenu.Positioner className="file-action-menu-positioner">
            <ContextMenu.Popup className="file-action-menu" aria-label={`Actions for ${name}`}>
              {actions.map(([action, label, enabled]) => (
                <ContextMenu.Item key={action} disabled={!enabled} onClick={() => onAction(action)}>
                  {label}
                </ContextMenu.Item>
              ))}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <Menu.Root>
        <Menu.Trigger className="file-more" aria-label={`Actions for ${name}`}>
          <MoreHorizontal size={14} />
        </Menu.Trigger>
        <Menu.Portal container={container}>
          <Menu.Positioner className="file-action-menu-positioner" sideOffset={4}>
            <Menu.Popup className="file-action-menu" aria-label={`Actions for ${name}`}>
              {actions.map(([action, label, enabled]) => (
                <Menu.Item key={action} disabled={!enabled} onClick={() => onAction(action)}>
                  {label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
