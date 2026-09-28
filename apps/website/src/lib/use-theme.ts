import { useSyncExternalStore } from 'react';

function subscribe(update: () => void) {
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const snapshot = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
export function useTheme() {
  return useSyncExternalStore(subscribe, snapshot, () => 'light' as const);
}
