import * as THREE from 'three';

type HeroStudyVariant = 'ribbon' | 'arc';

const TAU = Math.PI * 2;

export function createRibbonScene(_renderer: THREE.WebGLRenderer, dark: boolean, variant: HeroStudyVariant = 'ribbon') {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(value: T): T => {
    disposables.push(value);
    return value;
  };

  const ink = dark ? 0xe8edf1 : 0x26313a;
  const graphite = dark ? 0x343c42 : 0x69747b;
  const silver = dark ? 0x9aa4a9 : 0xb8c0c3;
  const edge = dark ? 0xcbd2d5 : 0xe2e6e5;
  const mouth = dark ? 0x07100e : 0x15201d;
  const emerald = dark ? 0x4d9b78 : 0x36785d;
  const accents = [0x7795b2, 0xc09968, 0x9484ad, 0x6f9d7e, 0xa68c77];

  const physical = (color: number, metalness: number, roughness: number) => {
    const material = track(new THREE.MeshStandardMaterial({ color, metalness, roughness }));
    return material;
  };
  const graphiteMat = physical(graphite, 0.72, 0.31);
  const silverMat = physical(silver, 0.86, 0.22);
  const edgeMat = physical(edge, 0.9, 0.18);
  const darkMat = physical(mouth, 0.35, 0.45);
  const emeraldMat = physical(emerald, 0.62, 0.26);

  scene.add(new THREE.HemisphereLight(dark ? 0xd8e2e7 : 0xffffff, dark ? 0x15191c : 0xaab0b2, dark ? 1.7 : 2.2));
  const key = new THREE.DirectionalLight(0xffffff, dark ? 3.1 : 3.7);
  key.position.set(-4, 9, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(dark ? 0x9db2bf : 0xdde8ee, 1.45);
  rim.position.set(8, 4, -5);
  scene.add(rim);

  const disk = new THREE.Group();
  disk.position.set(3.15, -0.55, 0.25);
  disk.rotation.set(variant === 'arc' ? -0.04 : -0.1, 0, variant === 'arc' ? -0.2 : -0.11);
  scene.add(disk);

  const cylinder = (radius: number, height: number, material: THREE.Material, y: number, segments = 96) => {
    const mesh = new THREE.Mesh(
      track(new THREE.CylinderGeometry(radius, radius, height, segments, 1, false)),
      material,
    );
    mesh.position.y = y;
    disk.add(mesh);
    return mesh;
  };
  cylinder(2.12, 0.78, graphiteMat, 0);
  cylinder(2.09, 0.08, silverMat, 0.43);
  cylinder(2.04, 0.035, edgeMat, 0.49);
  cylinder(2.09, 0.055, silverMat, -0.43);
  cylinder(1.66, 0.02, graphiteMat, 0.515);
  cylinder(0.31, 0.12, edgeMat, 0.57, 48);
  cylinder(0.12, 0.15, graphiteMat, 0.66, 40);

  const torusGeometry = track(new THREE.TorusGeometry(1, 0.012, 6, 96));
  for (const radius of [0.62, 0.98, 1.31, 1.62, 1.89]) {
    const groove = new THREE.Mesh(torusGeometry, darkMat);
    groove.scale.setScalar(radius);
    groove.rotation.x = Math.PI / 2;
    groove.position.y = 0.535;
    disk.add(groove);
  }

  const screwGeometry = track(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 16));
  for (let i = 0; i < 6; i++) {
    const screw = new THREE.Mesh(screwGeometry, edgeMat);
    const angle = (i / 6) * TAU + 0.18;
    screw.position.set(Math.cos(angle) * 1.84, 0.57, Math.sin(angle) * 1.84);
    disk.add(screw);
  }

  const ventGeometry = track(new THREE.BoxGeometry(0.48, 0.075, 0.045));
  for (let i = 0; i < 11; i++) {
    const vent = new THREE.Mesh(ventGeometry, darkMat);
    const angle = -0.58 + i * 0.116;
    vent.position.set(Math.cos(angle) * 2.105, 0.02, Math.sin(angle) * 2.105);
    vent.rotation.y = -angle;
    disk.add(vent);
  }

  const intake = new THREE.Group();
  intake.position.set(-2.04, 0.13, 0.18);
  intake.rotation.z = 0.08;
  disk.add(intake);
  const frame = new THREE.Mesh(track(new THREE.BoxGeometry(0.52, 0.32, 0.92)), silverMat);
  intake.add(frame);
  const opening = new THREE.Mesh(track(new THREE.BoxGeometry(0.565, 0.18, 0.7)), darkMat);
  opening.position.x = -0.02;
  opening.position.y = 0.025;
  intake.add(opening);
  const status = new THREE.Mesh(track(new THREE.BoxGeometry(0.58, 0.045, 0.19)), emeraldMat);
  status.position.set(-0.02, 0.19, -0.23);
  intake.add(status);
  const lip = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.14, 0.52)), graphiteMat);
  lip.position.set(-0.32, -0.02, 0);
  intake.add(lip);

  disk.updateMatrixWorld(true);
  const intakeTarget = opening.getWorldPosition(new THREE.Vector3());
  const labelAnchor = disk.localToWorld(new THREE.Vector3(0, -0.72, 2.18));

  const ribbonPoints =
    variant === 'arc'
      ? [
          [-8.8, -3.0, 1.5],
          [-7.0, -2.55, 1.15],
          [-5.4, -1.65, 0.45],
          [-3.8, -0.42, -0.35],
          [-2.0, 0.38, -0.5],
          [-0.2, 0.46, -0.1],
          [intakeTarget.x, intakeTarget.y, intakeTarget.z],
        ]
      : [
          [-8.8, 0.75, 1.5],
          [-7.4, 1.75, 0.85],
          [-5.55, 1.55, -0.45],
          [-4.0, 0.12, -1.05],
          [-2.35, -1.1, -0.65],
          [-0.65, -0.82, 0.05],
          [intakeTarget.x, intakeTarget.y, intakeTarget.z],
        ];
  const offsets =
    variant === 'arc'
      ? [
          [0, 0, -0.62],
          [0, 0.22, 0],
          [0, -0.14, 0.7],
          [0, 0.5, 1.3],
        ]
      : [
          [0, -0.43, -0.75],
          [0, 0, -0.18],
          [0, 0.42, 0.55],
          [0, -0.16, 1.25],
        ];
  const curves = offsets.map(
    ([x, y, z]) =>
      new THREE.CatmullRomCurve3(
        ribbonPoints.map(([px, py, pz], index) => {
          const taper = 1 - index / (ribbonPoints.length - 1);
          return new THREE.Vector3(px + x * taper, py + y * taper, pz + z * taper);
        }),
        false,
        'catmullrom',
        0.42,
      ),
  );

  const guideMaterial = track(
    new THREE.LineBasicMaterial({ color: emerald, transparent: true, opacity: dark ? 0.1 : 0.07 }),
  );
  for (const curve of curves) {
    const line = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(curve.getPoints(120))), guideMaterial);
    scene.add(line);
  }

  let seed = variant === 'arc' ? 0x51f15e : 0x7a11ce;
  const random = () => (
    (seed = Math.imul(seed ^ (seed >>> 15), 1 | seed)),
    ((seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed)), ((seed ^ (seed >>> 14)) >>> 0) / 4294967296)
  );
  const fileCount = 1450;
  const fileGeometry = track(new THREE.BoxGeometry(0.115, 0.008, 0.082));
  fileGeometry.translate(0, 0.004, 0);
  const fileMaterial = physical(dark ? 0xb7c0c5 : 0x778187, 0.18, 0.64);
  const files = new THREE.InstancedMesh(fileGeometry, fileMaterial, fileCount);
  files.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(files);
  const phases = new Float32Array(fileCount);
  const speeds = new Float32Array(fileCount);
  const paths = new Uint8Array(fileCount);
  const scales = new Float32Array(fileCount);
  const lift = new Float32Array(fileCount);
  const drift = new Float32Array(fileCount);
  const color = new THREE.Color();
  for (let i = 0; i < fileCount; i++) {
    phases[i] = random();
    speeds[i] = 0.032 + random() * 0.016;
    paths[i] = Math.floor(random() * curves.length);
    scales[i] = 0.48 + random() * 0.8;
    lift[i] = (random() - 0.5) * 0.23;
    drift[i] = (random() - 0.5) * 0.22;
    files.setColorAt(i, color.setHex(accents[Math.floor(random() * accents.length)]).lerp(new THREE.Color(ink), 0.34));
  }
  files.instanceColor!.needsUpdate = true;

  const pointCount = 700;
  const pointPositions = new Float32Array(pointCount * 3);
  for (let i = 0; i < pointCount; i++) {
    const p = curves[Math.floor(random() * curves.length)].getPoint(random());
    pointPositions[i * 3] = p.x + (random() - 0.5) * 0.45;
    pointPositions[i * 3 + 1] = p.y + (random() - 0.5) * 0.34;
    pointPositions[i * 3 + 2] = p.z + (random() - 0.5) * 0.5;
  }
  const pointGeometry = track(new THREE.BufferGeometry());
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
  const pointMaterial = track(
    new THREE.PointsMaterial({
      color: dark ? 0x8e9da3 : 0x607077,
      size: 0.026,
      transparent: true,
      opacity: 0.46,
      sizeAttenuation: true,
    }),
  );
  scene.add(new THREE.Points(pointGeometry, pointMaterial));

  const makeCardTexture = (label: string, accent: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 168;
    const context = canvas.getContext('2d')!;
    context.fillStyle = dark ? '#252b2f' : '#f6f7f5';
    context.beginPath();
    context.roundRect(5, 5, 246, 158, 18);
    context.fill();
    context.strokeStyle = dark ? '#667078' : '#aab2b4';
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = `#${accent.toString(16).padStart(6, '0')}`;
    context.fillRect(20, 19, 14, 130);
    context.fillStyle = dark ? '#eef1f2' : '#20282e';
    context.font = '600 42px ui-monospace, SFMono-Regular, monospace';
    context.fillText(label, 55, 72);
    context.fillStyle = dark ? '#758087' : '#b9c0c2';
    context.fillRect(56, 94, 156, 5);
    context.fillRect(56, 112, 126, 5);
    context.fillRect(56, 130, 145, 5);
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  };
  const labels = ['SQL', 'MD', 'TS', 'XLS', 'PDF', 'JPG'];
  const cards = labels.map((label, index) => {
    const material = track(
      new THREE.MeshBasicMaterial({
        map: makeCardTexture(label, accents[index % accents.length]),
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(0.88, 0.58)), material);
    scene.add(mesh);
    return { mesh, path: index % curves.length, phase: 0.08 + index * 0.125 };
  });

  const dummy = new THREE.Object3D();
  const position = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 1, 0);
  const cardTarget = new THREE.Vector3();
  const update = (seconds: number) => {
    for (let i = 0; i < fileCount; i++) {
      const t = (phases[i] + seconds * speeds[i]) % 1;
      const curve = curves[paths[i]];
      curve.getPointAt(t, position);
      curve.getTangentAt(t, tangent).normalize();
      normal.crossVectors(tangent, axis).normalize();
      position.addScaledVector(normal, drift[i] * Math.sin(t * TAU * 3 + phases[i] * TAU));
      position.y += lift[i] * Math.sin(t * TAU * 2 + i);
      dummy.position.copy(position);
      const fade = Math.min(1, t * 18, (1 - t) * 18);
      dummy.scale.setScalar(scales[i] * fade * (0.72 + Math.sin(Math.PI * t) * 0.28));
      dummy.rotation.set(
        0.12 * Math.sin(t * TAU + i),
        Math.atan2(tangent.x, tangent.z),
        0.3 * Math.sin(t * TAU * 2 + phases[i]),
      );
      dummy.updateMatrix();
      files.setMatrixAt(i, dummy.matrix);
    }
    files.instanceMatrix.needsUpdate = true;
    cards.forEach(({ mesh, path, phase }, index) => {
      const t = (phase + seconds * (0.028 + index * 0.0008)) % 1;
      curves[path].getPointAt(t, mesh.position);
      mesh.position.y += 0.34 + (index % 2) * 0.16;
      mesh.lookAt(cardTarget.copy(camera.position));
      mesh.rotateZ(0.08 * Math.sin(seconds * 0.7 + index));
      const fade = Math.min(1, t * 12, (1 - t) * 13);
      mesh.scale.setScalar(fade * (index < 3 ? 1 : 0.8));
    });
    disk.rotation.y = Math.sin(seconds * 0.22) * 0.035;
    const top = disk.children[4];
    if (top) top.rotation.y = seconds * 0.035;
  };

  const resize = (width: number, height: number) => {
    camera.aspect = Math.max(0.1, width / Math.max(1, height));
    const mobile = width < 700 || camera.aspect < 1.4;
    if (variant === 'arc') {
      camera.position.set(mobile ? 0.2 : -0.5, mobile ? 14.8 : 13.4, mobile ? 13.2 : 10.4);
      camera.lookAt(mobile ? 1.25 : -0.2, -0.3, 0.05);
      camera.fov = mobile ? 42 : 30;
    } else {
      camera.position.set(mobile ? 0.5 : -0.9, mobile ? 10.5 : 8.2, mobile ? 17.8 : 14.4);
      camera.lookAt(mobile ? 1.2 : -0.2, 0.05, 0.1);
      camera.fov = mobile ? 42 : 30;
    }
    camera.updateProjectionMatrix();
  };

  return {
    scene,
    camera,
    labelAnchor,
    update,
    resize,
    dispose: () => disposables.forEach((value) => value.dispose()),
  };
}
