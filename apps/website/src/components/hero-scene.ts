import * as T from 'three';

// C2 reference: radius, block width, gap, rotation period, direction.
const RINGS = [
  [50, 6, 4, 38, 1],
  [61, 9, 5, 52, -1],
  [73, 5, 3, 30, 1],
  [85, 12, 6, 70, -1],
  [98, 7, 4, 44, 1],
  [109, 4, 3, 26, -1],
  [120, 10, 5, 60, 1],
  [131, 6, 4, 36, -1],
  [142, 8, 5, 48, 1],
  [152, 5, 3, 32, -1],
];
const LIT = [
  [0.18, 0.7, 0.42],
  [0.37, 0.89, 0.6],
  [0.66, 0.96, 0.79],
  [0.91, 1, 0.95],
];

export function ringGeometry() {
  const regions: {
    offset: number;
    capacity: number;
    duration: number;
    begin: number;
    cycle: number;
    write: (cycle: number) => number[];
  }[] = [];
  let capacity = 0;
  RINGS.forEach(([radius, width, gap, period, direction], ring) => {
    const count = Math.floor((2 * Math.PI * radius) / (width + gap));
    const slot = (2 * Math.PI) / count,
      gapAngle = (slot * gap) / (width + gap);
    // ponytail: merges stay within eight-slot regions; synchronize neighbors for cross-boundary merges.
    for (let first = 0; first < count; first += 8) {
      const slots = Math.min(8, count - first),
        seed = 987654321 + ring * 1024 + first;
      const duration = 6 + ((seed * 137) % 1000) / 250;
      const begin = (((seed * 173) % 1000) / 1000) * duration;
      // Each slot can become its own sector, including its rounding/minimum subdivisions.
      const size = (Math.ceil((slots * slot) / 0.06) + 2 * slots) * 6 * 11;
      regions.push({
        offset: capacity,
        capacity: size,
        duration,
        begin,
        cycle: -1,
        write(cycle) {
          const data: number[] = [];
          let state = (seed ^ Math.imul(cycle, 0x9e3779b9)) >>> 0;
          const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
          const run = () => {
            let value = random() * 100;
            for (const [i, weight] of [30, 18, 13, 10, 9, 8, 7, 5].entries()) {
              value -= weight;
              if (value < 0) return i + 1;
            }
            return 1;
          };
          const sector = (
            inner: number,
            outer: number,
            start: number,
            end: number,
            lit: number[],
            gradientFill = false,
          ) => {
            const segments = Math.max(2, Math.ceil((end - start) / 0.06));
            const vertex = (r: number, angle: number, gradient: number) =>
              data.push(
                r * Math.cos(angle),
                r * Math.sin(angle),
                0,
                (direction * 2 * Math.PI) / period,
                duration,
                begin,
                gradientFill ? 0.55 + 0.75 * gradient : 1,
                ...lit,
                ring,
              );
            for (let n = 0; n < segments; n++) {
              const a = start + ((end - start) * n) / segments,
                b = start + ((end - start) * (n + 1)) / segments;
              vertex(inner, a, n / segments);
              vertex(outer, a, n / segments);
              vertex(outer, b, (n + 1) / segments);
              vertex(inner, a, n / segments);
              vertex(outer, b, (n + 1) / segments);
              vertex(inner, b, (n + 1) / segments);
            }
          };
          for (let k = first; k < first + slots;) {
            const length = Math.min(run(), first + slots - k);
            if (random() >= 0.06) {
              const start = k * slot,
                end = (k + length) * slot - gapAngle;
              const lit = LIT[Math.floor(random() * LIT.length)];
              if (length >= 3 && random() < 0.75) {
                for (let n = 0; n < length; n++) {
                  const a = (k + n) * slot + slot * 0.16,
                    b = Math.min((k + n + 1) * slot - slot * 0.16, end);
                  if (b > a) sector(radius - width * 0.38, radius + width * 0.38, a, b, lit);
                }
              } else sector(radius - width / 2, radius + width / 2, start, end, lit, length > 3);
            }
            k += length;
          }
          return data;
        },
      });
      capacity += size;
    }
  });
  const buffer = new T.InterleavedBuffer(new Float32Array(capacity), 11).setUsage(T.DynamicDrawUsage);
  const geometry = new T.BufferGeometry();
  for (const [name, size, offset] of [
    ['position', 3, 0],
    ['aRate', 1, 3],
    ['aDur', 1, 4],
    ['aBeg', 1, 5],
    ['aShade', 1, 6],
    ['aLit', 3, 7],
    ['aRing', 1, 10],
  ] as const)
    geometry.setAttribute(name, new T.InterleavedBufferAttribute(buffer, size, offset));
  return {
    geometry,
    update(time: number) {
      for (const region of regions) {
        const cycle = Math.floor((time + region.begin) / region.duration);
        if (cycle === region.cycle) continue;
        const values = buffer.array.subarray(region.offset, region.offset + region.capacity);
        values.fill(0);
        values.set(region.write(cycle));
        buffer.addUpdateRange(region.offset, region.capacity);
        buffer.needsUpdate = true;
        region.cycle = cycle;
      }
    },
  };
}

const QUAD_VERTEX = `precision highp float;
attribute vec2 position;
varying vec2 vUv;
void main(){ vUv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`;

const RING_VERTEX = `precision highp float;
attribute vec2 position;
attribute float aRate, aDur, aBeg, aShade, aRing;
attribute vec3 aLit;
uniform float uTime, uLight;
uniform vec4 uView;
varying vec3 vColor;
varying float vAlpha;
void main(){
  float angle=aRate*uTime, c=cos(angle), s=sin(angle);
  vec2 p=vec2(position.x*c-position.y*s,position.x*s+position.y*c)+vec2(297.,394.);
  float phase=fract((uTime+aBeg)/max(aDur,.001));
  vAlpha=smoothstep(0.,.08,phase)*(1.-smoothstep(.60,.85,phase));
  vec3 base=mix(vec3(.110,.165,.130),vec3(.48,.62,.53),uLight);
  vec3 dim=mix(vec3(.075,.290,.170),vec3(.26,.52,.35),uLight);
  vec3 lit=mix(aLit,aLit*.45+vec3(0.,.16,.05),uLight), col;
  if(phase<.05) col=mix(base,lit,phase/.05);
  else if(phase<.18) col=lit;
  else if(phase<.45) col=mix(lit,dim,(phase-.18)/.27);
  else col=mix(dim,base,(phase-.45)/.55);
  col*=aShade;
  // A short coherent write crosses a few adjacent blocks on one ring.
  float cycle=floor(uTime/4.8), age=mod(uTime,4.8);
  float ring=mod(cycle*7.+2.,10.);
  float head=fract(sin(cycle*12.93+3.)*43758.54)*6.283185+age*.9;
  float delta=atan(position.y,position.x)+angle-head;
  float distance=abs(atan(sin(delta),cos(delta)));
  float write=(1.-step(.1,abs(aRing-ring)))*(1.-smoothstep(.05,.30,distance));
  write*=smoothstep(0.,.12,age)*(1.-smoothstep(.65,1.3,age));
  vColor=mix(col,mix(vec3(.82,1.,.9),vec3(.08,.38,.2),uLight),write*.8);
  vec2 screen=(p-uView.xy)/uView.zw;
  gl_Position=vec4(screen.x*2.-1.,1.-screen.y*2.,0.,1.);
}`;
const RING_FRAGMENT = `precision highp float;
varying vec3 vColor;
varying float vAlpha;
uniform float uBloom;
void main(){ gl_FragColor=vec4(mix(vColor,max(vColor-.3,0.),uBloom),vAlpha); }`;

const RAYS_FRAGMENT = `precision highp float;
varying vec2 vUv;
uniform float uTime, uLight;
uniform vec3 uPaper;
uniform vec4 uView;
float hash(float n){return fract(sin(n)*43758.5453123);}
float noise(float x){float i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(hash(i),hash(i+1.),f);}
float fbm(float x){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*noise(x);x*=2.03;a*=.5;}return s;}
void main(){
  vec2 f=uView.xy+vec2(vUv.x,1.-vUv.y)*uView.zw;
  vec2 p=(f-vec2(297.,394.))/720.;
  float r=length(p), angle=atan(p.y,p.x), disk=162./720.;
  if(r<disk*1.006){gl_FragColor=vec4(uPaper,1.);return;}
  float rays=pow(fbm(angle*9.+uTime*.06),3.)+pow(fbm(angle*21.-uTime*.04),4.)*.8+pow(fbm(angle*41.+uTime*.10),5.)*.6;
  float gate=smoothstep(disk,disk*1.05,r);
  float reach=max(1.,uView.z/1440.);
  // Different rays breathe independently, without pulsing the surrounding halo.
  float rayLength=1.+.30*sin(angle*13.+uTime*.45)+.15*sin(angle*29.-uTime*.27);
  float shimmer=.88+.22*sin(angle*19.-uTime*.65)+.10*sin(angle*37.+uTime*.39);
  float fall=exp(-max(r-disk,0.)*2.8/(reach*rayLength));
  float rim=exp(-abs(r-disk*1.02)*150.)*.55;
  float halo=.09*exp(-max(r-disk,0.)*1.8/reach);
  float energy=clamp(rays*gate*fall*shimmer*1.9+rim+halo,0.,2.);
  float hairline=exp(-abs(r-disk*1.008)*900.);
  vec3 col=mix(vec3(.07,.42,.24),vec3(.18,.70,.42),clamp(energy,0.,1.));
  col=mix(col,vec3(.66,.96,.79),clamp(energy-.85,0.,1.));
  col=mix(col,vec3(.37,.89,.60),hairline*.9);
  col=mix(col,col*.55,uLight);
  float edge=smoothstep(0.,180.,min(f.y-uView.y,uView.y+uView.w-f.y));
  float alpha=max(clamp(energy*.95,0.,.88),hairline*.9)*edge*mix(1.,.5,uLight);
  col+=(hash(dot(f,vec2(12.9898,78.233)))-.5)*.012;
  gl_FragColor=vec4(col*alpha,alpha);
}`;
const BLUR_FRAGMENT = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uStep;
void main(){
  vec4 s=texture2D(uTexture,vUv)*.227;
  s+=(texture2D(uTexture,vUv+uStep*1.385)+texture2D(uTexture,vUv-uStep*1.385))*.316;
  s+=(texture2D(uTexture,vUv+uStep*3.231)+texture2D(uTexture,vUv-uStep*3.231))*.070;
  gl_FragColor=s;
}`;
const BLOOM_FRAGMENT = `precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uLight;
void main(){
  vec3 col=texture2D(uTexture,vUv).rgb*mix(.85,.12,uLight);
  gl_FragColor=vec4(col,max(col.r,max(col.g,col.b)));
}`;
const SPARK_VERTEX = `precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute float aSeed;
uniform float uTime;
uniform vec4 uView;
varying vec2 vUv;
varying float vAlpha;
void main(){
  float cycle=uTime*(.095+fract(aSeed*7.13)*.05)+aSeed;
  float phase=fract(cycle);
  float life=clamp(phase/.22,0.,1.);
  float angle=aSeed*62.83185+floor(cycle)*1.3;
  vec2 radial=vec2(cos(angle),sin(angle)), tangent=vec2(-radial.y,radial.x);
  vec2 p=vec2(297.,394.)+radial*(166.+life*185.+position.y*(8.+life*10.))+tangent*position.x*1.7;
  vAlpha=sin(life*3.14159)*.55*(1.-step(.22,phase));vUv=uv;
  vec2 screen=(p-uView.xy)/uView.zw;
  gl_Position=vec4(screen.x*2.-1.,1.-screen.y*2.,0.,1.);
}`;
const SPARK_FRAGMENT = `precision highp float;
varying vec2 vUv;
varying float vAlpha;
uniform float uLight;
void main(){
  float alpha=vAlpha*pow(1.-abs(vUv.x*2.-1.),2.)*sin(vUv.y*3.14159);
  gl_FragColor=vec4(mix(vec3(.55,1.,.75),vec3(.03,.4,.19),uLight),alpha);
}`;

export function mountHero(el: HTMLDivElement, failed: () => void) {
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  const camera = new T.Camera();
  const scenes: T.Scene[] = [],
    targets: T.WebGLRenderTarget[] = [];
  let intersection: IntersectionObserver | undefined,
    sizing: ResizeObserver | undefined,
    theme: MutationObserver | undefined;
  let disposed = false,
    visible = false,
    moving = true,
    lost = false,
    raf = 0,
    last = 0,
    time = 2.3;
  let draw = () => {};
  let resize = () => {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  };
  const canRun = () => !disposed && !lost && visible && moving && !reduced.matches && !document.hidden;
  const tick = (now: number) => {
    raf = 0;
    if (!canRun()) {
      last = 0;
      return;
    }
    if (last) time += Math.min((now - last) / 1000, 0.05);
    last = now;
    draw();
    raf = requestAnimationFrame(tick);
  };
  const resume = () => {
    if (!raf && canRun()) raf = requestAnimationFrame(tick);
  };
  const motion = () => {
    stop();
    resume();
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    dispose();
    failed();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    intersection?.disconnect();
    sizing?.disconnect();
    theme?.disconnect();
    reduced.removeEventListener('change', motion);
    document.removeEventListener('visibilitychange', motion);
    window.removeEventListener('resize', resize);
    renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    const geometries = new Set<T.BufferGeometry>(),
      materials = new Set<T.Material>();
    for (const scene of scenes)
      scene.traverse((object) => {
        if (!(object instanceof T.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
      });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    targets.forEach((t) => t.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    delete el.dataset.heroReady;
    if (import.meta.env.DEV) delete (el as HTMLDivElement & { heroDebug?: unknown }).heroDebug;
  };
  try {
    renderer.setClearColor(0, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    el.append(renderer.domElement);
    const uniforms = {
      uTime: { value: time },
      uView: { value: new T.Vector4(0, 0, 1440, 720) },
      uLight: { value: 0 },
      uPaper: { value: new T.Color() },
      uBloom: { value: 0 },
    };
    const pass = (
      geometry: T.BufferGeometry,
      vertex: string,
      fragment: string,
      extra: Record<string, T.IUniform> = {},
      blending = T.NoBlending as T.Blending,
    ) => {
      const material = new T.RawShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: { ...uniforms, ...extra },
        depthTest: false,
        depthWrite: false,
        side: T.DoubleSide,
        forceSinglePass: true,
        transparent: blending !== T.NoBlending,
        blending,
      });
      const mesh = new T.Mesh(geometry, material);
      mesh.frustumCulled = false;
      const scene = new T.Scene();
      scene.add(mesh);
      scenes.push(scene);
      return { scene, mesh, material };
    };
    const quad = new T.BufferGeometry();
    quad.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const rays = pass(quad, QUAD_VERTEX, RAYS_FRAGMENT);
    const ringState = ringGeometry();
    const rings = pass(ringState.geometry, RING_VERTEX, RING_FRAGMENT, {}, T.NormalBlending);
    const a = new T.WebGLRenderTarget(1, 1, { depthBuffer: false }),
      b = new T.WebGLRenderTarget(1, 1, { depthBuffer: false });
    targets.push(a, b);
    const blur = pass(quad, QUAD_VERTEX, BLUR_FRAGMENT, {
      uTexture: { value: a.texture },
      uStep: { value: new T.Vector2() },
    });
    const bloom = pass(quad, QUAD_VERTEX, BLOOM_FRAGMENT, { uTexture: { value: a.texture } }, T.CustomBlending);
    Object.assign(bloom.material, {
      blendSrc: T.OneFactor,
      blendDst: T.OneFactor,
      blendSrcAlpha: T.OneFactor,
      blendDstAlpha: T.OneMinusSrcAlphaFactor,
    });
    const sparksGeometry = new T.InstancedBufferGeometry();
    const plane = new T.PlaneGeometry(1, 1);
    sparksGeometry.index = plane.index;
    sparksGeometry.attributes = plane.attributes;
    sparksGeometry.setAttribute(
      'aSeed',
      new T.InstancedBufferAttribute(
        Float32Array.from({ length: 48 }, (_, i) => ((i * 137) % 479) / 479),
        1,
      ),
    );
    sparksGeometry.instanceCount = 48;
    const sparks = pass(sparksGeometry, SPARK_VERTEX, SPARK_FRAGMENT, {}, T.NormalBlending);
    plane.dispose();
    let frameCount = 0,
      measuredAt = performance.now(),
      fps = 0;
    draw = () => {
      if (disposed || lost) return;
      ringState.update(time);
      uniforms.uTime.value = time;
      renderer.info.reset();
      uniforms.uBloom.value = 1;
      renderer.setRenderTarget(a);
      renderer.clear();
      renderer.render(rings.scene, camera);
      blur.material.uniforms.uTexture.value = a.texture;
      blur.material.uniforms.uStep.value.set(1 / a.width, 0);
      renderer.setRenderTarget(b);
      renderer.clear();
      renderer.render(blur.scene, camera);
      blur.material.uniforms.uTexture.value = b.texture;
      blur.material.uniforms.uStep.value.set(0, 1 / b.height);
      renderer.setRenderTarget(a);
      renderer.clear();
      renderer.render(blur.scene, camera);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(rays.scene, camera);
      renderer.render(bloom.scene, camera);
      uniforms.uBloom.value = 0;
      renderer.render(rings.scene, camera);
      renderer.render(sparks.scene, camera);
      if (import.meta.env.DEV) {
        frameCount++;
        const now = performance.now();
        if (now - measuredAt > 1000) {
          fps = (frameCount * 1000) / (now - measuredAt);
          frameCount = 0;
          measuredAt = now;
        }
        Object.assign(el, {
          heroDebug: {
            time,
            fps,
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            renderer,
            camera,
            rings: rings.mesh,
            targets,
            uniforms,
          },
        });
      }
    };
    resize = () => {
      const art = el.getBoundingClientRect();
      if (!art.width || !art.height || disposed) return;
      const width = document.documentElement.clientWidth;
      const height = art.height * 2;
      const scale = 1440 / art.width;
      // Expand the drawing surface without moving or scaling the wordmark's disk.
      Object.assign(renderer.domElement.style, {
        left: `${-art.left}px`,
        top: `${-art.height / 2}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      uniforms.uView.value.set(-art.left * scale, (-art.height * scale) / 2, width * scale, height * scale);
      renderer.setSize(width, height, false);
      const ratio = renderer.getPixelRatio();
      for (const target of targets)
        target.setSize(Math.max(2, Math.round((width * ratio) / 4)), Math.max(2, Math.round((height * ratio) / 4)));
      draw();
    };
    const applyTheme = () => {
      uniforms.uLight.value = document.documentElement.dataset.theme === 'dark' ? 0 : 1;
      uniforms.uPaper.value
        .set(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())
        .convertLinearToSRGB();
      draw();
    };
    intersection = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        stop();
        resume();
      },
      { threshold: 0.02 },
    );
    sizing = new ResizeObserver(resize);
    theme = new MutationObserver(applyTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    intersection.observe(renderer.domElement);
    sizing.observe(el);
    window.addEventListener('resize', resize);
    reduced.addEventListener('change', motion);
    document.addEventListener('visibilitychange', motion);
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    resize();
    applyTheme();
    el.dataset.heroReady = 'true';
    return {
      setMoving(value: boolean) {
        moving = value;
        stop();
        resume();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
