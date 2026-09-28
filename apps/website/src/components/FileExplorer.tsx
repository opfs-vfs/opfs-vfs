import { useEffect, useMemo, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { themeToTreeStyles } from '@pierre/trees';
import { useTheme } from '../lib/use-theme';
import type { ExplorerEntry } from '../lib/filesystem';

const treePath = (entry: Pick<ExplorerEntry, 'kind' | 'path'>) =>
  entry.kind === 'directory' ? `${entry.path}/` : entry.path;
const plainPath = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

export function FileExplorer({
  entries,
  onMove,
  onSelect,
  selected,
}: {
  entries: ExplorerEntry[];
  onMove: (source: string, destination: string, mode: 'directory' | 'exact') => void;
  onSelect: (entry: ExplorerEntry) => boolean;
  selected?: string;
}) {
  const theme = useTheme();
  const byPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const callbacks = useRef({ byPath, onMove, onSelect });
  callbacks.current = { byPath, onMove, onSelect };
  const paths = useMemo(() => entries.map(treePath), [entries]);
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: ['/workspace/'],
    initialSelectedPaths: selected ? [selected] : [],
    search: true,
    unsafeCSS: `
      [data-item-flattened-subitems] { display: flex; }
      [data-item-focused='true']::before,
      [role='treeitem']:focus-visible::before {
        outline: none;
        border-left: 2px solid var(--trees-accent);
        border-radius: 0;
        inset: 6px auto 6px 0;
      }
      @media (forced-colors: active) {
        [data-item-focused='true']::before,
        [role='treeitem']:focus-visible::before { border-color: Highlight; }
      }
    `,
    stickyFolders: true,
    composition: { contextMenu: { enabled: true, triggerMode: 'both' } },
    dragAndDrop: {
      canDrag: (dragged) => dragged.every((path) => plainPath(path) !== '/workspace'),
      onDropComplete: ({ draggedPaths, target }) => {
        const directory = plainPath(target.directoryPath || '/workspace');
        for (const source of draggedPaths) callbacks.current.onMove(plainPath(source), directory, 'directory');
      },
    },
    renaming: {
      canRename: (item) => plainPath(item.path) !== '/workspace',
      onRename: ({ sourcePath, destinationPath }) =>
        callbacks.current.onMove(plainPath(sourcePath), plainPath(destinationPath), 'exact'),
    },
  });
  useEffect(() => {
    return model.subscribe(() => {
      const entry = callbacks.current.byPath.get(plainPath(model.getSelectedPaths().at(-1) || ''));
      if (!entry || entry.path === selected) return;
      if (!callbacks.current.onSelect(entry) && selected) {
        for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
        const previous = callbacks.current.byPath.get(selected);
        model.getItem(previous ? treePath(previous) : selected)?.select();
      }
    });
  }, [model, selected]);
  useEffect(() => {
    const expanded = entries
      .filter(
        (entry) =>
          entry.kind === 'directory' &&
          (model.getItem(treePath(entry)) as { isExpanded?: () => boolean } | undefined)?.isExpanded?.(),
      )
      .map(treePath);
    model.resetPaths(paths, { initialExpandedPaths: expanded.length ? expanded : ['/workspace/'] });
  }, [entries, model, paths]);
  useEffect(() => {
    if (!selected) return;
    const entry = byPath.get(selected);
    const desired = entry ? treePath(entry) : selected;
    for (const path of model.getSelectedPaths()) if (path !== desired) model.getItem(path)?.deselect();
    model.getItem(desired)?.select();
  }, [byPath, model, selected]);
  return (
    <FileTree
      className="filesystem-tree"
      model={model}
      style={
        {
          height: '100%',
          ...themeToTreeStyles({ type: theme, bg: 'var(--panel)', fg: 'var(--ink)' }),
          '--trees-bg-override': 'var(--panel)',
          '--trees-accent-override': 'var(--accent)',
          '--trees-selected-bg-override': 'color-mix(in srgb, var(--accent) 16%, var(--panel))',
          '--trees-selected-fg-override': 'var(--ink)',
        } as React.CSSProperties
      }
    />
  );
}
