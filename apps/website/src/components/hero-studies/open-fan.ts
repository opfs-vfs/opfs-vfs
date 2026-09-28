import * as THREE from 'three';

type SceneHandle = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  update: (seconds: number) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
  labelAnchor: THREE.Vector3;
};

const TAU = Math.PI * 2;

export function createOpenFanScene(renderer: THREE.WebGLRenderer, dark: boolean): SceneHandle {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-7, 7, 4, -4, 0.1, 40);
  camera.position.set(0.7, 6.9, 10.5);
  camera.lookAt(0.25, 0, 0);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const geometry = <T extends THREE.BufferGeometry>(value: T) => (geometries.push(value), value);
  const material = <T extends THREE.Material>(value: T) => (materials.push(value), value);
  const add = <T extends THREE.Object3D>(value: T) => (scene.add(value), value);

  const silver = dark ? 0xb9c0c2 : 0x9ca5a8;
  const graphite = dark ? 0x1d2427 : 0x30383a;
  const emerald = dark ? 0x2da477 : 0x16805c;

  scene.add(new THREE.HemisphereLight(dark ? 0xe8f1ef : 0xffffff, dark ? 0x15201e : 0xc8d0ce, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, dark ? 3.4 : 2.8);
  key.position.set(-4, 8, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(dark ? 0x89a39d : 0xb7c9c5, 1.6);
  rim.position.set(7, 3, -5);
  scene.add(rim);

  const disk = add(new THREE.Group());
  disk.position.set(3.65, 0.12, 0.42);
  const diskMat = material(new THREE.MeshStandardMaterial({ color: silver, metalness: 0.72, roughness: 0.29 }));
  const darkMat = material(new THREE.MeshStandardMaterial({ color: graphite, metalness: 0.62, roughness: 0.34 }));
  const edgeMat = material(
    new THREE.MeshStandardMaterial({ color: dark ? 0x667174 : 0x697376, metalness: 0.82, roughness: 0.2 }),
  );
  const greenMat = material(new THREE.MeshStandardMaterial({ color: emerald, metalness: 0.18, roughness: 0.48 }));

  const cylinder = (radius: number, height: number, mat: THREE.Material, y: number, segments = 96) => {
    const mesh = new THREE.Mesh(geometry(new THREE.CylinderGeometry(radius, radius, height, segments)), mat);
    mesh.position.y = y;
    disk.add(mesh);
    return mesh;
  };

  cylinder(1.39, 0.36, darkMat, 0);
  cylinder(1.34, 0.055, edgeMat, 0.205);
  cylinder(1.29, 0.085, diskMat, 0.255);
  cylinder(1.12, 0.035, edgeMat, 0.316);
  cylinder(1.07, 0.045, diskMat, 0.344);
  cylinder(0.61, 0.055, darkMat, 0.382);
  cylinder(0.49, 0.04, diskMat, 0.421);
  cylinder(0.16, 0.052, darkMat, 0.458, 48);

  const grooveMat = material(
    new THREE.MeshStandardMaterial({ color: dark ? 0x778183 : 0x707a7c, metalness: 0.8, roughness: 0.24 }),
  );
  for (const radius of [0.76, 0.87, 0.98, 1.2]) {
    const ring = new THREE.Mesh(geometry(new THREE.TorusGeometry(radius, 0.009, 6, 96)), grooveMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.377;
    disk.add(ring);
  }

  const screwGeo = geometry(new THREE.CylinderGeometry(0.035, 0.035, 0.022, 16));
  for (let i = 0; i < 8; i++) {
    const screw = new THREE.Mesh(screwGeo, darkMat);
    const angle = (i / 8) * TAU;
    screw.position.set(Math.cos(angle) * 0.75, 0.421, Math.sin(angle) * 0.75);
    disk.add(screw);
  }

  const portGeo = geometry(new THREE.BoxGeometry(0.23, 0.07, 0.07));
  for (const z of [-0.28, 0, 0.28]) {
    const port = new THREE.Mesh(portGeo, greenMat);
    port.position.set(-1.355, 0.02, z);
    port.rotation.z = -0.08;
    disk.add(port);
  }

  const pathCount = 7;
  const particleCount = 1680;
  const pointGeo = geometry(new THREE.BoxGeometry(0.027, 0.018, 0.045));
  const pointMat = material(
    new THREE.MeshStandardMaterial({ color: dark ? 0x8d9b9a : 0x72807f, roughness: 0.7, metalness: 0.05 }),
  );
  const points = add(new THREE.InstancedMesh(pointGeo, pointMat, particleCount));
  points.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const seed = (index: number, salt: number) => {
    const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  const paths = Array.from({ length: pathCount }, (_, i) => {
    const fan = (i - (pathCount - 1) / 2) / ((pathCount - 1) / 2);
    return {
      z0: fan * 2.65,
      z1: fan * 1.55,
      bend: fan * 0.55 + (i % 2 ? 0.16 : -0.12),
      lift: 0.18 + (1 - Math.abs(fan)) * 0.2,
    };
  });
  const dummy = new THREE.Object3D();
  const setParticle = (index: number, seconds: number) => {
    const path = paths[index % pathCount];
    const speed = 0.027 + seed(index, 1) * 0.02;
    const t = (seed(index, 2) + seconds * speed) % 1;
    const eased = t * t * (3 - 2 * t);
    const x = -6.8 + 9.06 * eased;
    const z = path.z0 * (1 - t) * (1 - t) + 2 * path.bend * (1 - t) * t + path.z1 * t * (1 - t);
    const scatter = (seed(index, 3) - 0.5) * (0.42 - t * 0.28);
    dummy.position.set(x, path.lift + Math.sin(t * Math.PI) * 0.5 + (seed(index, 4) - 0.5) * 0.17, z + scatter);
    dummy.rotation.set(0.12 * Math.sin(index), -0.24 + 0.18 * path.bend, 0.15 * Math.cos(index * 0.7));
    const endpointFade = Math.min(1, t / 0.045, (1 - t) / 0.07);
    const scale = (0.65 + seed(index, 5) * 0.85) * endpointFade;
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    points.setMatrixAt(index, dummy.matrix);
  };

  const labels = [
    ['SQL', 'queries/archive.sql', 0x7ba6c9],
    ['MD', 'release-notes.md', 0x9f91c5],
    ['TS', 'worker/index.ts', 0x6aa9c8],
    ['XLS', 'forecast-q3.xlsx', 0x76a984],
    ['PDF', 'system-map.pdf', 0xd1a05f],
    ['JPG', 'receipt-042.jpg', 0xb690b5],
  ] as const;
  const cards: THREE.Group[] = [];
  const cardMaterials: THREE.MeshBasicMaterial[] = [];
  const cardPaths = [0, 6, 2, 5, 1, 4];
  const makeCardTexture = (extension: string, name: string, accent: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 288;
    const ctx = canvas.getContext('2d')!;
    const bg = dark ? '#20282a' : '#f5f7f6';
    const fg = dark ? '#e7eceb' : '#253032';
    const sub = dark ? '#8e9b99' : '#6d7877';
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 280, 22);
    ctx.fill();
    ctx.fillStyle = `#${accent.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.roundRect(24, 24, 94, 62, 13);
    ctx.fill();
    ctx.fillStyle = dark ? '#111718' : '#ffffff';
    ctx.font = '700 28px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(extension, 71, 64);
    ctx.textAlign = 'left';
    ctx.fillStyle = fg;
    ctx.font = '600 27px ui-monospace, monospace';
    ctx.fillText(name, 25, 139);
    ctx.fillStyle = sub;
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillText('local / ready', 25, 184);
    ctx.fillStyle = `#${accent.toString(16).padStart(6, '0')}`;
    ctx.fillRect(25, 225, 310, 6);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    textures.push(texture);
    return texture;
  };

  const cardGeo = geometry(new THREE.PlaneGeometry(1.34, 0.75));
  labels.forEach(([extension, name, accent], index) => {
    const group = add(new THREE.Group());
    const cardMat = material(
      new THREE.MeshBasicMaterial({
        map: makeCardTexture(extension, name, accent),
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    cardMaterials.push(cardMat);
    const card = new THREE.Mesh(cardGeo, cardMat);
    card.quaternion.copy(camera.quaternion);
    group.add(card);
    group.rotation.z = (seed(index, 8) - 0.5) * 0.08;
    cards.push(group);
  });

  const resize = (width: number, height: number) => {
    const aspect = Math.max(0.45, width / Math.max(height, 1));
    const mobile = width < 700 || aspect < 1.4;
    const halfHeight = mobile ? 5.15 : 3.65;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.position.x = mobile ? 2.25 : 0.7;
    camera.lookAt(mobile ? 1.2 : 0.25, 0, 0);
    camera.updateProjectionMatrix();
    cards.forEach((card, index) => {
      card.visible = !mobile || index === 2 || index === 4;
      card.children[0].quaternion.copy(camera.quaternion);
    });
  };

  const update = (seconds: number) => {
    for (let i = 0; i < particleCount; i++) setParticle(i, seconds);
    points.instanceMatrix.needsUpdate = true;
    disk.rotation.y = Math.sin(seconds * 0.23) * 0.018;
    disk.position.y = 0.12 + Math.sin(seconds * 0.32) * 0.018;
    for (let i = 0; i < cards.length; i++) {
      const path = paths[cardPaths[i]];
      const t = (i / cards.length + seconds * 0.026) % 1;
      const eased = t * t * (3 - 2 * t);
      const fade = Math.min(1, t / 0.09, (1 - t) / 0.12);
      cards[i].position.set(
        -6.55 + 8.81 * eased,
        path.lift + Math.sin(t * Math.PI) * 0.62 + Math.sin(seconds * 0.42 + i * 1.7) * 0.025,
        path.z0 * (1 - t) * (1 - t) + 2 * path.bend * (1 - t) * t + path.z1 * t * (1 - t),
      );
      cards[i].scale.setScalar((i > 3 ? 0.9 : 1) * fade);
      cardMaterials[i].opacity = fade;
    }
  };

  update(0);
  return {
    scene,
    camera,
    labelAnchor: new THREE.Vector3(3.65, -0.3, 1.8),
    update,
    resize,
    dispose: () => {
      geometries.forEach((value) => value.dispose());
      materials.forEach((value) => value.dispose());
      textures.forEach((value) => value.dispose());
      scene.clear();
    },
  };
}
