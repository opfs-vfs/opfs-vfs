import * as T from 'three';

export function createLayerScene(_renderer: T.WebGLRenderer, dark: boolean) {
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-8, 8, 4, -4, 0.1, 60);
  const resources: { dispose(): void }[] = [];
  const own = <V extends { dispose(): void }>(value: V): V => {
    resources.push(value);
    return value;
  };
  const volume = new T.Group();
  volume.position.set(2.7, 0.1, 0.2);
  volume.rotation.y = -0.3;
  scene.add(volume);
  scene.add(new T.HemisphereLight(0xffffff, 0x86959a, 2));
  const light = new T.DirectionalLight(0xffffff, 3);
  light.position.set(-4, 8, 6);
  scene.add(light);

  const shape = new T.Shape();
  const w = 1.9,
    h = 1.35,
    r = 0.18;
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const slabGeometry = own(
    new T.ExtrudeGeometry(shape, {
      depth: 0.045,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.018,
      bevelThickness: 0.014,
      curveSegments: 16,
    }),
  );
  slabGeometry.rotateX(-Math.PI / 2);
  const slabMaterial = own(
    new T.MeshPhysicalMaterial({
      color: dark ? 0x243b40 : 0xc3d2d4,
      metalness: 0.08,
      envMapIntensity: dark ? 0.3 : 0.8,
      roughness: 0.3,
      transparent: true,
      opacity: dark ? 0.76 : 0.78,
      side: T.DoubleSide,
      depthWrite: false,
      clearcoat: 0.5,
    }),
  );
  const borderMaterial = own(
    new T.LineBasicMaterial({ color: dark ? 0xa5c8cd : 0x729197, transparent: true, opacity: 0.62 }),
  );
  const borderGeometry = own(
    new T.BufferGeometry().setFromPoints(shape.getPoints(96).map((p) => new T.Vector3(p.x, 0.075, -p.y))),
  );
  const gridMaterial = own(
    new T.LineBasicMaterial({ color: dark ? 0xabc7cb : 0x789498, transparent: true, opacity: dark ? 0.2 : 0.22 }),
  );
  const gridPoints: T.Vector3[] = [];
  for (let i = 0; i < 7; i++) {
    const x = -1.5 + i * 0.5;
    gridPoints.push(new T.Vector3(x, 0.077, -1), new T.Vector3(x, 0.077, 1));
  }
  for (let i = 0; i < 5; i++) {
    const z = -1 + i * 0.5;
    gridPoints.push(new T.Vector3(-1.5, 0.077, z), new T.Vector3(1.5, 0.077, z));
  }
  const gridGeometry = own(new T.BufferGeometry().setFromPoints(gridPoints));
  const cellGeometry = own(new T.PlaneGeometry(0.38, 0.34));
  cellGeometry.rotateX(-Math.PI / 2);
  const cellMaterial = own(
    new T.MeshBasicMaterial({
      color: dark ? 0xb3d2d2 : 0x607f83,
      transparent: true,
      opacity: 0.23,
      depthWrite: false,
      side: T.DoubleSide,
    }),
  );
  const pulseGeometry = own(new T.PlaneGeometry(0.07, 2.15));
  pulseGeometry.rotateX(-Math.PI / 2);
  const pulses: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>[] = [];
  for (let level = 0; level < 3; level++) {
    const slab = new T.Group();
    slab.renderOrder = level + 1;
    slab.position.set(level * 0.1, (level - 1) * 0.63, -level * 0.08);
    slab.add(new T.Mesh(slabGeometry, slabMaterial));
    slab.add(new T.LineLoop(borderGeometry, borderMaterial));
    slab.add(new T.LineSegments(gridGeometry, gridMaterial));
    for (let i = 0; i < 10; i++) {
      const cell = new T.Mesh(cellGeometry, cellMaterial);
      cell.position.set(-1.25 + ((i * 5 + level) % 6) * 0.5, 0.079, -0.75 + (i % 4) * 0.5);
      slab.add(cell);
    }
    const pulse = new T.Mesh(
      pulseGeometry,
      own(
        new T.MeshBasicMaterial({
          color: dark ? 0x95d7bd : 0x328565,
          transparent: true,
          opacity: 0.5,
          side: T.DoubleSide,
          depthWrite: false,
        }),
      ),
    );
    pulse.position.y = 0.09;
    slab.add(pulse);
    pulses.push(pulse);
    volume.add(slab);
  }
  volume.updateMatrixWorld(true);
  const paths = Array.from({ length: 3 }, (_, i) => {
    const end = volume.localToWorld(new T.Vector3(-1.7, -0.28 + i * 0.55, 0.05));
    return new T.CubicBezierCurve3(
      new T.Vector3(-7.3, 0.25 + i * 0.35, (i - 1) * 2.25),
      new T.Vector3(-4.8, 1.3 + i * 0.16, (i - 1) * 1.8),
      new T.Vector3(-1.8, end.y + 0.18, end.z),
      end,
    );
  });
  const guideMaterial = own(
    new T.LineBasicMaterial({ color: dark ? 0x7caba6 : 0x4b7c76, transparent: true, opacity: 0.16 }),
  );
  for (const path of paths)
    scene.add(new T.Line(own(new T.BufferGeometry().setFromPoints(path.getPoints(96))), guideMaterial));
  const accents = [0x749cc2, 0xa293bb, 0x779cb8, 0x7caa94, 0xc5a27c, 0xb69dae];
  const particleCount = 1800;
  const particles = new T.InstancedMesh(
    own(new T.PlaneGeometry(0.045, 0.065)),
    own(
      new T.MeshBasicMaterial({
        color: dark ? 0xc1cfcd : 0x73938b,
        transparent: true,
        opacity: 0.65,
        side: T.DoubleSide,
      }),
    ),
    particleCount,
  );
  particles.instanceMatrix.setUsage(T.DynamicDrawUsage);
  particles.frustumCulled = false;
  scene.add(particles);
  let seed = 8719;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const specs = Array.from({ length: particleCount }, (_, i) => ({
    phase: random(),
    speed: 0.035 + random() * 0.025,
    path: i % 3,
    spread: random() - 0.5,
    size: 0.35 + random() * 0.8,
  }));
  const color = new T.Color();
  for (let i = 0; i < particleCount; i++) particles.setColorAt(i, color.setHex(accents[i % accents.length]));
  const cardGeometry = own(new T.PlaneGeometry(0.62, 0.82));
  const cards = ['SQL', 'MD', 'TS', 'XLS', 'PDF', 'JPG'].map((kind, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = dark ? '#202f30' : '#fcfcf9';
    ctx.strokeStyle = dark ? '#7d999c' : '#9eb0b0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(3, 3, 174, 234, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = `#${accents[i].toString(16)}`;
    ctx.fillRect(20, 25, 7, 40);
    ctx.font = '600 35px ui-monospace, monospace';
    ctx.fillText(kind, 40, 58);
    ctx.globalAlpha = 0.5;
    for (let row = 0; row < 5; row++) ctx.fillRect(22, 99 + row * 21, row % 2 ? 86 : 132, 4);
    const texture = own(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    const material = own(
      new T.MeshBasicMaterial({ map: texture, transparent: true, side: T.DoubleSide, toneMapped: false }),
    );
    const mesh = new T.Mesh(cardGeometry, material);
    scene.add(mesh);
    return { mesh, phase: 0.1 + i * 0.135, path: i % 3 };
  });
  const dummy = new T.Object3D();
  const point = new T.Vector3();
  const update = (seconds: number) => {
    for (let i = 0; i < particleCount; i++) {
      const p = specs[i],
        t = (p.phase + seconds * p.speed) % 1;
      paths[p.path].getPoint(t * t * 0.35 + t * 0.65, point);
      point.z += p.spread * 0.45 * (1 - t);
      point.y += Math.sin(t * 6 + p.phase * 10) * 0.045 * (1 - t);
      dummy.position.copy(point);
      dummy.quaternion.copy(camera.quaternion);
      dummy.scale.setScalar(p.size * Math.min(1, t * 12, (1 - t) * 18));
      dummy.updateMatrix();
      particles.setMatrixAt(i, dummy.matrix);
    }
    particles.instanceMatrix.needsUpdate = true;
    cards.forEach(({ mesh, phase, path }, i) => {
      const t = (phase + seconds * 0.04) % 1;
      paths[path].getPoint(t, mesh.position);
      mesh.position.y += 0.22 * Math.sin(Math.PI * t);
      mesh.quaternion.copy(camera.quaternion);
      mesh.rotateZ(Math.sin(i * 2 + t) * 0.07);
      mesh.scale.setScalar(Math.min(1, t * 12, (1 - t) * 8));
    });
    pulses.forEach((pulse, i) => {
      const t = (seconds * 0.18 + i * 0.32) % 1;
      pulse.position.x = -1.7 + t * 3.4;
      pulse.material.opacity = Math.sin(t * Math.PI) * (dark ? 0.52 : 0.35);
    });
  };
  const resize = (width: number, height: number) => {
    const mobile = width < 700;
    const aspect = width / height;
    const half = mobile ? 4 : 3.15;
    camera.top = half;
    camera.bottom = -half;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    const focus = mobile ? 1.9 : -0.6;
    camera.position.set(focus, 7.5, 11.5);
    camera.lookAt(focus, 0, 0);
    camera.updateProjectionMatrix();
  };
  return {
    scene,
    camera,
    update,
    resize,
    labelAnchor: volume.localToWorld(new T.Vector3(0.1, -0.85, 1.8)),
    dispose: () => {
      resources.forEach((r) => r.dispose());
      scene.clear();
    },
  };
}
