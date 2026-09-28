import { Button } from '../ui/button';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Pause, Play } from 'lucide-react';
import { useTheme } from '../../lib/use-theme';
import { createOpenFanScene as fan } from './open-fan';
import { createRibbonScene as ribbon } from './ribbon';
import { createLayerScene } from './layers';
import './studies.css';

const variants = [
  {
    name: 'Layers',
    detail:
      'Thin translucent layers form a virtual volume. Files flow into the gaps; pulses travel through the stored data.',
  },
  { name: 'Open fan', detail: 'A low disk, seen from above. Files spread across a broad, gentle fan.' },
  { name: 'Ribbon', detail: 'A stronger three-quarter view. An S-shaped ribbon separates near and distant files.' },
  { name: 'Arc', detail: 'A higher view over the disk. Files sweep upward from the lower left.' },
];

export default function HeroStudies() {
  const [selected, setSelected] = useState(0);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(false);
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    const element = host.current!;
    let renderer!: THREE.WebGLRenderer;
    let study: ReturnType<typeof fan>;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setClearColor(0, 0);
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      element.appendChild(renderer.domElement);
      study =
        selected === 0
          ? createLayerScene(renderer, theme === 'dark')
          : selected === 1
            ? fan(renderer, theme === 'dark')
            : ribbon(renderer, theme === 'dark', selected === 2 ? 'ribbon' : 'arc');
      setFailed(false);
    } catch {
      renderer?.dispose();
      element.querySelector('canvas')?.remove();
      setFailed(true);
      return;
    }
    const studio = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const reflections = pmrem.fromScene(studio, 0.04);
    study.scene.environment = reflections.texture;
    studio.dispose();
    pmrem.dispose();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let elapsed = 0;
    let last = 0;
    let visible = true;
    const draw = () => {
      study.update(elapsed);
      renderer.render(study.scene, study.camera);
    };
    const tick = (now: number) => {
      frame = 0;
      if (pauseRef.current || reduced.matches || document.hidden || !visible) {
        last = 0;
        return;
      }
      if (last) elapsed += Math.min((now - last) / 1000, 0.05);
      last = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (!pauseRef.current && !reduced.matches && !document.hidden && visible) frame = requestAnimationFrame(tick);
    };
    wake.current = resume;
    const sizing = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      study.resize(width, height);
      study.camera.updateMatrixWorld();
      const anchor = study.labelAnchor.clone().project(study.camera);
      if (label.current) {
        label.current.style.left = `${((anchor.x + 1) * width) / 2}px`;
        label.current.style.top = `${Math.min(height - 48, ((1 - anchor.y) * height) / 2 + 20)}px`;
      }
      draw();
    });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    sizing.observe(element);
    intersection.observe(element);
    document.addEventListener('visibilitychange', resume);
    reduced.addEventListener('change', resume);
    return () => {
      cancelAnimationFrame(frame);
      sizing.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', resume);
      reduced.removeEventListener('change', resume);
      wake.current = () => {};
      study.dispose();
      reflections.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [selected, theme]);
  return (
    <>
      <div className="study-toolbar">
        <div role="group" aria-label="Hero variants" className="study-options">
          {variants.map((variant, index) => (
            <Button
              variant={index === selected ? 'default' : 'outline'}
              size="default"
              key={variant.name}
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {String.fromCharCode(65 + index)} · {variant.name}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="default"
          className="study-motion"
          aria-pressed={paused}
          onClick={() => {
            pauseRef.current = !pauseRef.current;
            setPaused(pauseRef.current);
            wake.current();
          }}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? 'Play motion' : 'Pause motion'}
        </Button>
      </div>
      <p className="study-description" role="status">
        {variants[selected].detail}
      </p>
      <section className="study-hero" aria-label={`${variants[selected].name} hero preview`}>
        <div className="study-copy">
          <p className="kicker">Cross-browser performance. Reliable storage.</p>
          <h1>
            Many files. Few handles.
            <br />
            Built for speed.
          </h1>
          <p>A virtual filesystem for browser apps that need practical, persistent storage.</p>
          <div className="study-actions">
            <a href="/demos/filesystem/" className="button solid">
              Explore files
            </a>
            <a href="/demos/pglite/" className="button">
              Try PGlite
            </a>
          </div>
        </div>
        <div className="study-stage">
          <div
            ref={host}
            className="study-canvas"
            role="img"
            aria-label={`${variants[selected].name}: files flow into a virtual storage volume.`}
          />
          {failed && (
            <p className="study-fallback" role="alert">
              This preview needs WebGL. Try a browser with hardware acceleration enabled.
            </p>
          )}
          <div ref={label} className="study-disk-label">
            OPFS VFS<span>Many files. One volume.</span>
          </div>
        </div>
      </section>
    </>
  );
}
