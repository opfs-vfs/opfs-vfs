import { useEffect, useRef, useState, type HTMLAttributes } from 'react';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function usePanelLayout() {
  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratios, setRatios] = useState([0.26, 0.33, 0.41]);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ element: HTMLDivElement; pointer: number; x: number } | null>(null);
  const narrow = width > 0 && width <= 900;
  const stop = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    setDragging(false);
  };
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (narrow) stop();
  }, [narrow]);
  const available = Math.max(660, width - (collapsed ? 50 : 12));
  const first = collapsed ? 0 : clamp(available * ratios[0], 180, available - 480);
  const middle = clamp(((available - first) * ratios[1]) / (ratios[1] + ratios[2]), 240, available - first - 240);
  const sizes = [first, middle, available - first - middle];
  const divider = (index: 0 | 1, label: string, controls: string): HTMLAttributes<HTMLDivElement> => {
    const min = index === 0 ? 180 : 240;
    const max = sizes[index] + sizes[index + 1] - 240;
    const resize = (delta: number) => {
      const next = [...sizes];
      next[index] = clamp(next[index] + delta, min, max);
      next[index + 1] += sizes[index] - next[index];
      setRatios(
        collapsed
          ? [ratios[0], (next[1] / available) * (1 - ratios[0]), (next[2] / available) * (1 - ratios[0])]
          : next.map((size) => size / available),
      );
    };
    return {
      role: 'separator',
      tabIndex: 0,
      'aria-label': label,
      'aria-controls': controls,
      'aria-orientation': 'vertical',
      'aria-valuemin': Math.round(min),
      'aria-valuemax': Math.round(max),
      'aria-valuenow': Math.round(sizes[index]),
      'aria-valuetext': `${Math.round(sizes[index])} pixels`,
      onPointerDown(event) {
        if (event.button !== 0 || narrow) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { element: event.currentTarget, pointer: event.pointerId, x: event.clientX };
        setDragging(true);
      },
      onPointerMove(event) {
        if (!drag.current || drag.current.pointer !== event.pointerId) return;
        resize(event.clientX - drag.current.x);
        drag.current.x = event.clientX;
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onKeyDown(event) {
        const delta = event.shiftKey ? 50 : 20;
        const amount = { ArrowLeft: -delta, ArrowRight: delta, Home: -Infinity, End: Infinity }[event.key];
        if (amount === undefined) return;
        event.preventDefault();
        resize(amount);
      },
    };
  };
  return {
    grid,
    narrow,
    collapsed,
    setCollapsed,
    dragging,
    divider,
    columns:
      width && !narrow
        ? collapsed
          ? `44px 0px ${sizes[1]}px 6px ${sizes[2]}px`
          : `${sizes[0]}px 6px ${sizes[1]}px 6px ${sizes[2]}px`
        : undefined,
  };
}
