import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DebugPanel, type LauncherPosition } from './DebugPanel';

const positions: [LauncherPosition, number, number][] = [
  ['top-left', 0, 0],
  ['top-center', 0.5, 0],
  ['top-right', 1, 0],
  ['right-center', 1, 0.5],
  ['bottom-right', 1, 1],
  ['bottom-center', 0.5, 1],
  ['bottom-left', 0, 1],
  ['left-center', 0, 0.5],
];

test('launcher accepts all initial positions and animates drag snapping without opening', async () => {
  await page.viewport(1000, 800);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const target = document.createElement('div');
  target.style.cssText = 'position:fixed;width:2px;height:2px;z-index:20000';
  document.body.append(target);
  try {
    for (const [position, x, y] of positions) {
      root.render(createElement(DebugPanel, { key: position, initialPosition: position }));
      await expect.poll(() => host.querySelector<HTMLElement>('.opfs-launcher')?.dataset.position).toBe(position);
      const button = host.querySelector<HTMLButtonElement>('.opfs-launcher')!;
      const bounds = button.getBoundingClientRect();
      expect(bounds.left).toBeCloseTo(16 + x * (1000 - bounds.width - 32), 0);
      expect(bounds.top).toBeCloseTo(16 + y * (800 - bounds.height - 32), 0);
    }
    const button = host.querySelector<HTMLButtonElement>('.opfs-launcher')!;
    let transitions = 0;
    button.addEventListener('transitionrun', () => {
      transitions++;
    });
    for (const [position, x, y] of positions) {
      const bounds = button.getBoundingClientRect();
      const left = 16 + x * (1000 - bounds.width - 32);
      const top = 16 + y * (800 - bounds.height - 32);
      // Release near, but not on, the anchor so a visible snap is required.
      target.style.left = `${left + bounds.width / 2 + (x === 1 ? -25 : 25)}px`;
      target.style.top = `${top + bounds.height / 2 + (y === 1 ? -25 : 25)}px`;
      await userEvent.dragAndDrop(button, target);
      await expect.poll(() => button.dataset.position).toBe(position);
      await expect.poll(() => Math.abs(button.getBoundingClientRect().left - left)).toBeLessThan(1);
      await expect.poll(() => Math.abs(button.getBoundingClientRect().top - top)).toBeLessThan(1);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
    expect(transitions).toBeGreaterThan(0);
    expect(getComputedStyle(button).transitionDuration).toContain('0.18s');
    expect(getComputedStyle(button).touchAction).toBe('none');
    const capture = vi.spyOn(button, 'setPointerCapture').mockImplementation(() => {});
    const beforeCancel = button.dataset.position;
    button.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 17,
        pointerType: 'touch',
        button: 0,
        clientX: 30,
        clientY: 400,
      }),
    );
    button.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 17,
        pointerType: 'touch',
        clientX: 200,
        clientY: 200,
      }),
    );
    await expect.poll(() => button.dataset.dragging).toBe('true');
    button.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 17, pointerType: 'touch' }));
    await expect.poll(() => button.dataset.dragging).toBe('false');
    expect(button.dataset.position).toBe(beforeCancel);
    capture.mockRestore();
    target.remove();
    button.focus();
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await expect.poll(() => button.dataset.position).toBe('top-left');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true');
    await page.getByRole('button', { name: 'Close volume explorer', exact: true }).click();
    await userEvent.click(button);
    await expect.poll(() => button.getAttribute('aria-expanded')).toBe('true');
    await page.viewport(390, 700);
    await expect.poll(() => Math.abs(button.getBoundingClientRect().left - 16)).toBeLessThan(1);
  } finally {
    root.unmount();
    host.remove();
    target.remove();
  }
}, 30000);
