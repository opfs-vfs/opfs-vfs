import { expect, test } from '@playwright/test';
import type * as T from 'three';

type Debug = {
  time: number;
  fps: number;
  calls: number;
  triangles: number;
  rings: T.Mesh;
  renderer: T.WebGLRenderer;
  camera: T.Camera;
  targets: T.WebGLRenderTarget[];
  uniforms: { uView: { value: T.Vector4 } };
};
type Host = HTMLDivElement & { heroDebug: Debug };

test.use({
  viewport: { width: 1440, height: 1100 },
  launchOptions: {
    args:
      process.platform === 'darwin' &&
      (!process.env.PLAYWRIGHT_BROWSER || process.env.PLAYWRIGHT_BROWSER === 'chromium')
        ? ['--use-angle=metal']
        : [],
  },
});

test('C2 rings render, animate and fit with the complete wordmark', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error' && /shader|WebGL|THREE/.test(e.text())) errors.push(e.text());
  });
  await page.goto('/');
  const host = page.locator('[data-hero-ready]');
  await expect(host).toBeVisible();
  await host.scrollIntoViewIfNeeded();
  const before = await host.screenshot();
  await page.waitForTimeout(700);
  expect((await host.screenshot()).equals(before)).toBe(false);
  const frame = await host.evaluate(async (element) => {
    const host = element as Host;
    return new Promise<{
      calls: number;
      rings: number;
      alpha: number[];
      contrast: number;
      fps: number;
      outsideGlow: number[];
      flatSegments: number;
      gradientSegments: number;
    }>((resolve) =>
      requestAnimationFrame(() => {
        const d = host.heroDebug,
          gl = d.renderer.getContext();
        const w = gl.drawingBufferWidth,
          h = gl.drawingBufferHeight;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const ring = d.rings.geometry.getAttribute('aRing');
        const rings = new Set(Array.from({ length: ring.count }, (_, i) => ring.getX(i))).size;
        const shade = d.rings.geometry.getAttribute('aShade');
        let flatSegments = 0,
          gradientSegments = 0;
        for (let i = 0; i < shade.count; i += 6) {
          const values = Array.from({ length: 6 }, (_, n) => shade.getX(i + n));
          if (values.every((value) => value === 1)) flatSegments++;
          else if (Math.max(...values) > Math.min(...values)) gradientSegments++;
        }
        let contrast = 0;
        const view = d.uniforms.uView.value;
        const cx = (w * (297 - view.x)) / view.z,
          cy = h * (1 - (394 - view.y) / view.w);
        const paper = pixels[(Math.floor(cy) * w + Math.floor(cx)) * 4 + 1];
        for (let y = Math.floor(cy - (157 * h) / view.w); y < cy + (157 * h) / view.w; y++)
          for (let x = Math.floor(cx - (157 * w) / view.z); x < cx + (157 * w) / view.z; x++) {
            const offset = (y * w + x) * 4;
            const radius = Math.hypot(((x - cx) * view.z) / w, ((y - cy) * view.w) / h);
            if (radius > 47 && radius < 157 && Math.abs(pixels[offset + 1] - paper) > 35) contrast++;
          }
        resolve({
          calls: d.calls,
          rings,
          fps: d.fps,
          contrast,
          flatSegments,
          gradientSegments,
          outsideGlow: [0, w - 1].map((x) => pixels[(Math.floor(cy) * w + x) * 4 + 3]),
          alpha: [3, (w - 1) * 4 + 3, (h - 1) * w * 4 + 3, w * h * 4 - 1].map((i) => pixels[i]),
        });
      }),
    );
  });
  console.log('C2 frame', frame);
  expect(frame.calls).toBe(7);
  expect(frame.rings).toBe(10);
  expect(frame.flatSegments).toBeGreaterThan(0);
  expect(frame.gradientSegments).toBeGreaterThan(0);
  expect(frame.contrast).toBeGreaterThan(300);
  expect(frame.alpha).toEqual([0, 0, 0, 0]);
  expect(frame.outsideGlow).not.toContain(0);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1920, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect
      .poll(() =>
        page.locator('.hero-art').evaluate((element) => {
          const art = element.getBoundingClientRect();
          const canvas = element.querySelector('canvas')!.getBoundingClientRect();
          return (
            Math.abs(canvas.left) < 1 &&
            Math.abs(canvas.right - document.documentElement.clientWidth) < 1 &&
            canvas.top < art.top &&
            canvas.bottom > art.bottom &&
            ['.hero-wordmark', '.hero-vfs'].every((selector) => {
              const rect = element.querySelector(selector)!.getBoundingClientRect();
              return (
                rect.left >= art.left && rect.right <= art.right && rect.top >= art.top && rect.bottom <= art.bottom
              );
            }) &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }),
      )
      .toBe(true);
  }
  expect(errors).toEqual([]);
});

test('blocks split and merge only between invisible cycles', async ({ page }) => {
  await page.goto('/');
  const host = page.locator('[data-hero-ready]');
  await expect(host).toBeVisible();
  await page.getByRole('button', { name: 'Pause motion' }).click();
  const result = await host.evaluate(async (element) => {
    const moduleUrl = '/src/components/hero-scene.ts';
    const { ringGeometry } = await import(/* @vite-ignore */ moduleUrl);
    const state = ringGeometry();
    const buffer = (state.geometry.getAttribute('position') as T.InterleavedBufferAttribute).data;
    const countBlocks = (data: Float32Array) => {
      let count = 0,
        lastX = NaN,
        lastY = NaN;
      for (let i = 0; i < data.length; i += 66) {
        if (data[i + 4] && (data[i] !== lastX || data[i + 1] !== lastY)) count++;
        lastX = data[i + 55];
        lastY = data[i + 56];
      }
      return count;
    };
    state.update(0);
    let previous = buffer.array.slice(),
      splits = 0,
      merges = 0,
      earlyChanges = 0;
    for (let time = 0.25; time <= 24; time += 0.25) {
      buffer.clearUpdateRanges();
      state.update(time);
      const next = buffer.array;
      for (let i = 0; i < next.length; i += 11) {
        if (next.slice(i, i + 11).every((v: number, n: number) => v === previous[i + n])) continue;
        const data = previous[i + 4] ? previous : next,
          duration = data[i + 4],
          begin = data[i + 5];
        if (Math.floor((time - 0.25 + begin) / duration) === Math.floor((time + begin) / duration)) earlyChanges++;
      }
      const change = countBlocks(next) - countBlocks(previous);
      if (change > 0) splits++;
      if (change < 0) merges++;
      previous = next.slice();
    }
    const version = buffer.version;
    state.update(24);
    const stable = buffer.version === version;

    // Swap a hidden region's actual geometry while its neighbors remain lit.
    state.update(0);
    const original = buffer.array.slice(),
      duration = original[4],
      begin = original[5];
    let end = 11;
    while (
      end < original.length &&
      (!original[end + 4] || (original[end + 4] === duration && original[end + 5] === begin))
    )
      end += 11;
    state.update(duration - begin + 0.001);
    const replacement = buffer.array.slice(0, end);
    const d = (element as Host).heroDebug,
      mesh = d.rings as T.Mesh<T.BufferGeometry, T.RawShaderMaterial>;
    const savedGeometry = mesh.geometry,
      uniforms = mesh.material.uniforms;
    const savedTime = uniforms.uTime.value,
      savedBloom = uniforms.uBloom.value,
      savedLight = uniforms.uLight.value;
    const gl = d.renderer.getContext();
    const capture = () => {
      d.renderer.setRenderTarget(null);
      d.renderer.clear();
      d.renderer.render(mesh.parent as T.Scene, d.camera);
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const load = (region: Float32Array) => {
      buffer.array.set(original);
      buffer.array.set(region);
      for (let i = 0; i < end; i += 11) if (buffer.array[i + 4]) buffer.array[i + 5] = buffer.array[i + 4] * 0.95;
      buffer.clearUpdateRanges();
      buffer.needsUpdate = true;
    };
    let hiddenChanges = 0,
      visibleNeighbors = true;
    try {
      mesh.geometry = state.geometry;
      uniforms.uTime.value = 0;
      for (const light of [0, 1])
        for (const bloom of [0, 1]) {
          uniforms.uLight.value = light;
          uniforms.uBloom.value = bloom;
          load(original.subarray(0, end));
          const before = capture();
          load(replacement);
          const after = capture();
          if (before.some((value, i) => value !== after[i])) hiddenChanges++;
          visibleNeighbors &&= before.some((value, i) => i % 4 === 3 && value > 0);
        }
    } finally {
      mesh.geometry = savedGeometry;
      uniforms.uTime.value = savedTime;
      uniforms.uBloom.value = savedBloom;
      uniforms.uLight.value = savedLight;
      state.geometry.dispose();
    }
    return { splits, merges, earlyChanges, stable, hiddenChanges, visibleNeighbors };
  });
  expect(result.splits).toBeGreaterThan(0);
  expect(result.merges).toBeGreaterThan(0);
  expect(result.earlyChanges).toBe(0);
  expect(result.stable).toBe(true);
  expect(result.hiddenChanges).toBe(0);
  expect(result.visibleNeighbors).toBe(true);
});

test('long block gradients persist through dimming and fade-out', async ({ page }) => {
  await page.goto('/');
  const host = page.locator('[data-hero-ready]');
  await expect(host).toBeVisible();
  await page.getByRole('button', { name: 'Pause motion' }).click();
  const samples = await host.evaluate((element) => {
    const d = (element as Host).heroDebug;
    const mesh = d.rings as T.Mesh<T.BufferGeometry, T.RawShaderMaterial>;
    const original = mesh.geometry,
      geometry = original.clone(),
      uniforms = mesh.material.uniforms;
    const position = geometry.getAttribute('position'),
      shade = geometry.getAttribute('aShade');
    const duration = geometry.getAttribute('aDur'),
      begin = geometry.getAttribute('aBeg') as T.InterleavedBufferAttribute;
    let first = 0;
    while (first < shade.count && shade.getX(first) !== Math.fround(0.55)) first += 6;
    if (first === shade.count) throw new Error('Expected a long gradient block');
    let last = first;
    while (shade.getX(last + 2) < 1.2999) last += 6;
    const points = [first, last].map((i) => ({
      x: 297 + (position.getX(i) + position.getX(i + 2)) / 2,
      y: 394 + (position.getY(i) + position.getY(i + 2)) / 2,
    }));
    const savedTime = uniforms.uTime.value,
      savedLight = uniforms.uLight.value,
      savedBloom = uniforms.uBloom.value;
    const gl = d.renderer.getContext(),
      view = d.uniforms.uView.value,
      pixel = new Uint8Array(4);
    const samples: { light: number; phase: number; darkEnd: number; brightEnd: number }[] = [];
    try {
      mesh.geometry = geometry;
      uniforms.uTime.value = 0;
      uniforms.uBloom.value = 0;
      for (const light of [0, 1])
        for (const phase of [0.449, 0.451, 0.75]) {
          uniforms.uLight.value = light;
          for (let i = 0; i < begin.count; i++) begin.setX(i, phase * duration.getX(i));
          begin.data.needsUpdate = true;
          d.renderer.setRenderTarget(null);
          d.renderer.clear();
          d.renderer.render(mesh.parent as T.Scene, d.camera);
          const values = points.map(({ x, y }) => {
            gl.readPixels(
              Math.floor(((x - view.x) / view.z) * gl.drawingBufferWidth),
              Math.floor((1 - (y - view.y) / view.w) * gl.drawingBufferHeight),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel,
            );
            return pixel[1];
          });
          samples.push({ light, phase, darkEnd: values[0], brightEnd: values[1] });
        }
    } finally {
      mesh.geometry = original;
      geometry.dispose();
      uniforms.uTime.value = savedTime;
      uniforms.uLight.value = savedLight;
      uniforms.uBloom.value = savedBloom;
    }
    return samples;
  });
  for (const sample of samples) {
    expect(sample.darkEnd, JSON.stringify(sample)).toBeGreaterThan(0);
    expect(sample.brightEnd / sample.darkEnd, JSON.stringify(sample)).toBeGreaterThan(1.5);
  }
});

test('rays softly change brightness and radial reach independently', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const host = page.locator('[data-hero-ready]');
  await expect(host).toBeVisible();
  await host.scrollIntoViewIfNeeded();
  const sample = () =>
    host.evaluate(
      (element) =>
        new Promise<number[][]>((resolve) => {
          requestAnimationFrame(() => {
            const d = (element as Host).heroDebug;
            const gl = d.renderer.getContext(),
              view = d.uniforms.uView.value;
            const pixel = new Uint8Array(4);
            resolve(
              Array.from({ length: 24 }, (_, i) => {
                const angle = -1 + (i * 2) / 23;
                return [0.34, 0.64].map((radius) => {
                  const x = 297 + Math.cos(angle) * radius * 720;
                  const y = 394 + Math.sin(angle) * radius * 720;
                  gl.readPixels(
                    Math.floor(((x - view.x) / view.z) * gl.drawingBufferWidth),
                    Math.floor((1 - (y - view.y) / view.w) * gl.drawingBufferHeight),
                    1,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixel,
                  );
                  // Remove the steady halo so brightness alone cannot masquerade as changing length.
                  const halo = 0.09 * Math.exp((-(radius - 162 / 720) * 1.8) / Math.max(1, view.z / 1440));
                  return pixel[3] / 255 / 0.95 - halo;
                });
              }),
            );
          });
        }),
    );
  const before = await sample();
  await page.waitForTimeout(3000);
  const after = await sample();
  const visible = before.map((a, i) => ({ a, b: after[i] })).filter(({ a, b }) => a[0] > 0.08 && b[0] > 0.08);
  expect(visible.filter(({ a, b }) => Math.abs(a[0] - b[0]) > 0.02).length).toBeGreaterThan(3);
  expect(visible.filter(({ a, b }) => Math.abs(a[1] / a[0] - b[1] / b[0]) > 0.08).length).toBeGreaterThan(3);
});

test('pause, offscreen suspension, mobile themes and reduced motion', async ({ page }) => {
  await page.goto('/');
  const host = page.locator('[data-hero-ready]');
  await expect(host).toBeVisible();
  await host.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Pause motion' }).click();
  const paused = await host.evaluate((e) => (e as Host).heroDebug.time);
  await page.waitForTimeout(150);
  expect(await host.evaluate((e) => (e as Host).heroDebug.time)).toBe(paused);
  await page.getByRole('button', { name: 'Play motion' }).click();
  await expect.poll(() => host.evaluate((e) => (e as Host).heroDebug.time)).toBeGreaterThan(paused);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const offscreen = await host.evaluate((e) => (e as Host).heroDebug.time);
  await page.waitForTimeout(150);
  expect(await host.evaluate((e) => (e as Host).heroDebug.time)).toBe(offscreen);
  await host.scrollIntoViewIfNeeded();
  await expect.poll(() => host.evaluate((e) => (e as Host).heroDebug.time)).toBeGreaterThan(offscreen);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(100);
    const before = await host.screenshot();
    await page.waitForTimeout(150);
    expect((await host.screenshot()).equals(before)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('WebGL failure, context loss and partial initialization preserve the wordmark', async ({ browser }) => {
  for (const mode of ['webgl', 'context', 'setup']) {
    const page = await browser.newPage();
    if (mode === 'webgl')
      await page.addInitScript(() => {
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply binds the canvas below.
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
          if (type.startsWith('webgl')) return null;
          return Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      });
    if (mode === 'setup')
      await page.addInitScript(() => {
        window.ResizeObserver = class {
          constructor() {
            throw new Error('Test setup failure');
          }
        } as typeof ResizeObserver;
      });
    await page.goto('/');
    if (mode === 'context') {
      await page.locator('[data-hero-ready]').waitFor();
      await page.locator('[data-hero-ready]').evaluate((e) => (e as Host).heroDebug.renderer.forceContextLoss());
    }
    await expect(page.locator('.hero-static-ring')).toBeVisible();
    await expect(page.locator('.hero-fallback')).toBeVisible();
    await expect(page.locator('.hero-wordmark')).toHaveText('PFS');
    await expect(page.locator('.hero-scene canvas')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Explore files', exact: true })).toBeVisible();
    await page.close();
  }
});

test('teardown disposes both glow targets and releases the context', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-hero-ready]').waitFor();
  expect(
    await page.evaluate(async () => {
      // Served by Vite for this local integration check.
      const moduleUrl = '/src/components/hero-scene.ts';
      const { mountHero } = await import(/* @vite-ignore */ moduleUrl);
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;width:600px;height:300px';
      document.body.append(el);
      const controller = mountHero(el, () => {
        throw new Error('Unexpected failure');
      });
      const debug = (el as Host).heroDebug,
        gl = debug.renderer.getContext();
      let disposedTargets = 0;
      debug.targets.forEach((target) => target.addEventListener('dispose', () => disposedTargets++));
      controller.dispose();
      controller.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const clean = !el.querySelector('canvas') && !(el as Partial<Host>).heroDebug && gl.isContextLost();
      el.remove();
      return { clean, disposedTargets };
    }),
  ).toEqual({ clean: true, disposedTargets: 2 });
});
