// World: terrain, sky, water, foliage, spire, beacon, day cycle.
import * as THREE from 'three';

export function noise2(x: number, z: number): number {
  return (
    Math.sin(x * 0.031 + z * 0.017) * 0.6 +
    Math.sin(x * 0.011 - z * 0.043) * 0.9 +
    Math.sin(x * 0.071 + z * 0.089) * 0.35 +
    Math.sin((x + z) * 0.024) * 0.5
  );
}

export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  return noise2(x, z) * 4.2 + Math.max(0, 1 - r / 190) * 5;
}

export type World = {
  group: THREE.Group;
  update: (t: number, dt: number, camera: THREE.Camera) => void;
  spirePos: THREE.Vector3;
  beaconPos: THREE.Vector3;
};

export function createWorld(scene: THREE.Scene): World {
  const group = new THREE.Group();
  scene.add(group);

  // ---- Sky dome ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(640, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        topC: { value: new THREE.Color(0x3a2350) },
        midC: { value: new THREE.Color(0x8a4a5e) },
        botC: { value: new THREE.Color(0xffa25e) },
        sunDir: { value: new THREE.Vector3(0.4, 0.22, -0.6).normalize() },
        sunC: { value: new THREE.Color(0xffd9a0) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 topC, midC, botC, sunC, sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -0.1, 1.0);
          vec3 c = h < 0.2 ? mix(botC, midC, h/0.2) : mix(midC, topC, (h-0.2)/0.8);
          float s = pow(max(dot(normalize(vDir), sunDir), 0.0), 90.0);
          float glow = pow(max(dot(normalize(vDir), sunDir), 0.0), 6.0);
          c += sunC * (s * 1.4 + glow * 0.28);
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
  );
  group.add(sky);

  // ---- Lights ----
  const hemi = new THREE.HemisphereLight(0xffc9a0, 0x33283c, 1.2);
  const sun = new THREE.DirectionalLight(0xffb877, 2.5);
  sun.position.set(60, 34, -90);
  const rim = new THREE.DirectionalLight(0x4b7bff, 0.35);
  rim.position.set(-40, 20, 60);
  group.add(hemi, sun, rim);

  // ---- Terrain ----
  const SZ = 420, SEG = 150;
  const geo = new THREE.PlaneGeometry(SZ, SZ, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const cSand = new THREE.Color(0xc9a86a), cGrass = new THREE.Color(0x4f6b3a),
        cHi = new THREE.Color(0x7a8a58), cRock = new THREE.Color(0x6b6f78);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)!, z = pos.getZ(i)!;
    const r = Math.hypot(x, z);
    let h = noise2(x, z) * 4.2;
    h += Math.max(0, 1 - r / 190) * 5;
    h = Math.max(h, -1.2 + Math.min(1.5, r / 200));
    pos.setY(i, h);
    const c = h > 5.2 ? cRock : h > 3.4 ? cHi : h > 0.6 ? cGrass : cSand;
    const v = 0.92 + Math.sin(x * 12.9 + z * 4.7) * 0.08;
    colors[i * 3] = c.r * v; colors[i * 3 + 1] = c.g * v; colors[i * 3 + 2] = c.b * v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  group.add(terrain);

  // ---- Water ----
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(SZ * 4, SZ * 4, 1, 1).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true, opacity: 0.86,
      uniforms: { t: { value: 0 }, deep: { value: new THREE.Color(0x0e3a4a) }, foam: { value: new THREE.Color(0x9be6ff) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform float t; uniform vec3 deep, foam; varying vec3 vP;
        void main(){
          float w = sin(vP.x*0.35 + t*1.4)*0.5 + sin(vP.z*0.27 - t*1.1)*0.5;
          vec3 c = mix(deep, foam, 0.18 + w*0.10);
          gl_FragColor = vec4(c, 0.86);
        }`,
    })
  );
  water.position.y = 0;
  group.add(water);

  // ---- Instanced foliage + rocks ----
  const pineGeo = new THREE.ConeGeometry(1.9, 5.4, 6); pineGeo.translate(0, 4.4, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 5); trunkGeo.translate(0, 1.1, 0);
  const rockGeo = new THREE.DodecahedronGeometry(1.1, 0);
  const pineMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95 });
  const trunkMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, color: 0x4a3a2c });
  const rockMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, color: 0x6b6f78 });

  const spots: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 62; i++) {
    const a = Math.random() * Math.PI * 2, r = 14 + Math.random() * 150;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = groundHeight(x, z);
    if (h > 1.1) spots.push([x, h, z, 0.8 + Math.random() * 0.9]);
  }
  const pines = new THREE.InstancedMesh(pineGeo, pineMat, spots.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, Math.ceil(spots.length / 2));
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3();
  const pineColors = [new THREE.Color(0x2f4d33), new THREE.Color(0x3c5c38), new THREE.Color(0x51694a)];
  let rockIdx = 0;
  spots.forEach(([x, y, z, s], i) => {
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
    M.compose(V.set(x, y - 0.15, z), rot, S.set(s, s, s)); pines.setMatrixAt(i, M);
    M.compose(V.set(x, y - 0.15, z), rot, S.set(s * 0.92, s, s * 0.92)); trunks.setMatrixAt(i, M);
    pines.setColorAt(i, pineColors[(Math.random() * 3) | 0]!);
    if (i % 2 === 0) {
      rocks.setMatrixAt(rockIdx++, M.compose(V.set(x + 3.5, y, z - 2.5), Q, S.set(s * 0.7, s * 0.55, s * 0.7)));
    }
  });
  group.add(pines, trunks, rocks);

  // ---- Spire + beacon ----
  const spire = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, color: 0x3a3f4c });
  ([[9, 8, 6], [7, 10, 7.4], [5.6, 11, 12], [4.2, 12, 16.4], [3, 14, 20]] as const).forEach(([r0, h, y]) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.86, r0, h, 7), stoneMat);
    c.position.y = y + h / 2; spire.add(c);
  });
  const runeMat = new THREE.MeshBasicMaterial({ color: 0x4be3ff });
  const rings: THREE.Mesh[] = [];
  ([[7.4, 9.2], [12, 13.6], [16.4, 17.6]] as const).forEach(([y, r]: readonly [number, number]) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.16, 6, 28), runeMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = y; spire.add(ring); rings.push(ring);
  });
  const crystal = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.5, 0),
    new THREE.MeshBasicMaterial({ color: 0x9beeff, wireframe: true })
  );
  crystal.position.y = 23.4; spire.add(crystal);
  const spirePos = new THREE.Vector3(14, 0, -52);
  spire.position.copy(spirePos);
  group.add(spire);

  const beaconPos = new THREE.Vector3(16, 21, -46);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.4, 42, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x4be3ff, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  beacon.position.copy(beaconPos);
  const beaconCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 42, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  beaconCore.position.copy(beaconPos);
  const beaconLight = new THREE.PointLight(0x4be3ff, 26, 70);
  beaconLight.position.set(beaconPos.x, 24, beaconPos.z);
  group.add(beacon, beaconCore, beaconLight);

  // ---- Day cycle ----
  let cycleT = 0;
  const update = (t: number, dt: number, camera: THREE.Camera) => {
    cycleT = (cycleT + dt * 0.008) % 1; // full cycle ~2 min for demo; tune later
    const ang = cycleT * Math.PI * 2;
    const sx = Math.cos(ang) * 120, sy = 34 + Math.sin(ang) * 26, sz = -Math.sin(ang) * 120;
    sun.position.set(sx, Math.max(8, sy), sz);
    (sky.material as THREE.ShaderMaterial).uniforms.sunDir!.value.set(sx, sy, sz).normalize();
    const day = Math.max(0, Math.min(1, (sy - 8) / 40));
    hemi.intensity = 0.9 + day * 0.35;
    sun.intensity = 1.9 + day * 0.7;
    water.material.uniforms.t!.value = t;
    sky.position.copy(camera.position);
    crystal.rotation.y += dt * 0.6; crystal.rotation.x += dt * 0.2;
    for (let i = 0; i < rings.length; i++) rings[i]!.rotation.z += dt * (0.2 + i * 0.1);
    beaconLight.intensity = 22 + Math.sin(t * 2.2) * 6;
  };

  return { group, update, spirePos, beaconPos };
}
