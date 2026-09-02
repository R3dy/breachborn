// BREACHBORN client entry — render loop, input, boot, netcode (M2).
import * as THREE from 'three';
import { createWorld, groundHeight } from './world.ts';
import { createPlayer, type Input } from './player.ts';
import { createHud } from './hud.ts';
import { connectNet, startPing } from './net.ts';
import { Remotes } from './remote.ts';
import type { ServerMsg } from '@breachborn/shared';

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

// net — hello/welcome/spawn/despawn (story 2.1); movement sync lands in 2.2,
// chat/emotes/party in 2.3.
const remotes = new Remotes(scene);
const TOKEN_KEY = 'breachborn.token';
let entered = false;
let myCharId = '';
let myName = '';
let myRace = 'Aelfon';

function savedToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}
function sendHello(): void {
  net.send({ t: 'hello', name: myName, race: myRace, token: savedToken() });
}

const net = connectNet(`ws://${location.hostname}:8080`, {
  offline: (offline) => hud.setNetOffline(offline),
  open: () => { if (entered) sendHello(); }, // reconnect → session restore via token
  message: (msg: ServerMsg) => onServerMsg(msg),
});
startPing(net);

function onServerMsg(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome': {
      myCharId = msg.charId;
      myName = msg.name;
      localStorage.setItem(TOKEN_KEY, msg.token);
      hud.setCharName(msg.name);
      hud.setParty(msg.roster.map((r) => r.name));
      // Server-authoritative spawn/restore position.
      player.pos.set(msg.pos.x, groundHeight(msg.pos.x, msg.pos.z) + 2.2, msg.pos.z);
      hud.chatSystem(`The Weave knows you as ${msg.name}.`);
      break;
    }
    case 'spawn':
      if (msg.charId !== myCharId) {
        remotes.spawn(msg.charId, msg.name, msg.pos);
        hud.chatSystem(`${msg.name} threads into the shard.`);
      }
      break;
    case 'despawn':
      remotes.remove(msg.charId);
      break;
    case 'error':
      hud.chatSystem(msg.message);
      break;
  }
}

// visibility re-sync hook (M2 wires server reconciliation)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) net.send({ t: 'ping', ts: performance.now() });
});

// boot
hud.onEnterWorld(({ name, race }) => {
  booted = true;
  entered = true;
  myName = name;
  myRace = race;
  hud.chatSystem(`Soul "${name}" written into the Weave. The Registry has no record of you.`);
  sendHello();
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
