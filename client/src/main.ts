// BREACHBORN client entry — render loop, input, boot.
import * as THREE from 'three';
import { createWorld, groundHeight } from './world.ts';
import { createPlayer, type Input } from './player.ts';
import { createHud } from './hud.ts';
import { connectNet, startPing } from './net.ts';

// WebGL2 check (graceful fallback)
const canvasProbe = document.createElement('canvas');
if (!canvasProbe.getContext('webgl2')) {
  document.getElementById('nogl')!.style.display = 'grid';
  throw new Error('WebGL2 unavailable');
}

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x3a2a38, 0.0062);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);

const world = createWorld(scene);
const hud = createHud();

const spawn = new THREE.Vector3(4, 0, -12);
spawn.y = groundHeight(spawn.x, spawn.z) + 2.2;
const player = createPlayer(scene, spawn);

// pointer lock + input
const input: Input = { keys: new Set(), mouseDX: 0, mouseDY: 0, scroll: 0 };
const clicklay = document.getElementById('clicklay')!;
let booted = false;
renderer.domElement.addEventListener('click', () => { if (booted) void renderer.domElement.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (booted) clicklay.classList.toggle('show', !locked);
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  input.mouseDX += e.movementX; input.mouseDY += e.movementY;
});
window.addEventListener('keydown', (e) => input.keys.add(e.code));
window.addEventListener('keyup', (e) => input.keys.delete(e.code));
window.addEventListener('wheel', (e) => { input.scroll += e.deltaY; }, { passive: true });
window.addEventListener('contextmenu', (e) => e.preventDefault());

// net (offline-tolerant in M1)
const net = connectNet(`ws://${location.hostname}:8080`, (offline) => hud.setNetOffline(offline));
startPing(net);

// visibility re-sync hook (M2 wires server reconciliation)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) net.send({ t: 'ping', ts: performance.now() });
});

// boot
hud.onEnterWorld(({ name }) => {
  booted = true;
  hud.chatSystem(`Soul "${name}" written into the Weave. The Registry has no record of you.`);
  void renderer.domElement.requestPointerLock();
});

// render loop
const clock = new THREE.Clock();
let frames = 0, fpsLast = performance.now(), infoLast = 0;
function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  frames++;
  const now = performance.now();
  if (now - fpsLast > 500) {
    hud.setFps(Math.round((frames * 1000) / (now - fpsLast)));
    frames = 0; fpsLast = now;
  }
  if (now - infoLast > 5000 && import.meta.env.DEV) {
    infoLast = now;
    const i = renderer.info.render;
    console.log(`[perf] calls=${i.calls} tris=${i.triangles}`);
  }
  player.update(dt, input, camera);
  world.update(t, dt, camera);
  renderer.render(scene, camera);
  (window as unknown as { __frames: number }).__frames =
    ((window as unknown as { __frames?: number }).__frames ?? 0) + 1;
}
tick();

// resize
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
