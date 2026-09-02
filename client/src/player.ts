// Player: hooded courier mesh, third-person movement + follow camera.
// M3: inner body pivot for combat anims — staged lunge swings, dodge roll,
// i-frame shimmer (client animates intent; the server owns the truth).
import * as THREE from 'three';
import { groundHeight } from './world.ts';
import { CAMERA, MOVEMENT } from '@breachborn/shared';

export type Player = {
  group: THREE.Group;
  pos: THREE.Vector3;
  yaw: number;            // camera yaw
  facing: number;         // body facing
  moving: boolean;        // updated every tick (netcode reads this)
  anim: 'idle' | 'walk' | 'run' | 'jump';
  update: (dt: number, input: Input, camera: THREE.PerspectiveCamera) => void;
  swing: (stage: number) => void;         // staged lunge (0..2)
  roll: (dirX: number, dirZ: number) => void; // dodge-roll toward a direction
  setIframes: (on: boolean) => void;      // shimmer while i-frames last
  dead: boolean;
  setDead: (dead: boolean) => void;
};

export type Input = {
  keys: Set<string>;
  mouseDX: number; mouseDY: number; scroll: number;
};

const ZOOM_LERP = 0.2;
const SWING_S = 0.28;
const ROLL_S = 0.38;

export function createPlayer(scene: THREE.Scene, spawn: THREE.Vector3): Player {
  const group = new THREE.Group();
  const body = new THREE.Group(); // combat anims pivot here, logic pos on group
  group.add(body);

  const cloth = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, color: 0x2f3542 });
  const bodyMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, color: 0x8a5540 });
  const skin = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8, color: 0xd7a878 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.75, 4, 8), cloth); torso.position.y = 1.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), skin); head.position.y = 2.15;
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 8), bodyMat); hood.position.y = 2.42;
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.5, 3, 6), cloth); armL.position.set(-0.55, 1.35, 0);
  const armR = armL.clone(); armR.position.x = 0.55;
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.6, 3, 6), bodyMat); legL.position.set(-0.2, 0.45, 0);
  const legR = legL.clone(); legR.position.x = 0.2;
  const sword = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 1.5, 0.22),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.35, metalness: 0.7, color: 0xb9c4cc })
  );
  sword.position.set(0.72, 1.1, 0.1); sword.rotation.z = -0.35;
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.75, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  body.add(torso, head, hood, armL, armR, legL, legR, sword);
  scene.add(group, blob);

  const pos = spawn.clone();
  let yaw = -0.2, pitch = 0.36, zoom = CAMERA.ZOOM_MAX * 0.75, zoomTarget = zoom;
  let facing = 0, vy = 0, grounded = true;
  let animT = 0;
  let moving = false;
  let anim: 'idle' | 'walk' | 'run' | 'jump' = 'idle';
  // combat anim state
  let swingT = -1, swingStage = 0;
  let rollT = -1, rollX = 0, rollZ = 0;
  let iframes = false;
  let dead = false;
  const camTarget = new THREE.Vector3().copy(pos).add(new THREE.Vector3(0, 1.6, 0));

  function swing(stage: number): void {
    if (dead) return;
    swingT = 0;
    swingStage = Math.max(0, Math.min(2, stage));
  }

  function roll(dirX: number, dirZ: number): void {
    if (dead || rollT >= 0) return;
    rollT = 0;
    const len = Math.hypot(dirX, dirZ);
    if (len > 0.001) { rollX = dirX / len; rollZ = dirZ / len; } else { rollX = 0; rollZ = 1; }
  }

  function setIframes(on: boolean): void {
    iframes = on;
    const g = on ? 0x4be3ff : 0x000000;
    cloth.emissive.setHex(g);
    bodyMat.emissive.setHex(g);
    cloth.emissiveIntensity = on ? 0.5 : 0;
    bodyMat.emissiveIntensity = on ? 0.5 : 0;
  }

  function setDead(d: boolean): void {
    dead = d;
    if (d) { swingT = -1; rollT = -1; setIframes(false); }
  }

  function update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
    // mouse look
    yaw -= input.mouseDX * 0.0024;
    pitch = Math.max(-0.05, Math.min(1.1, pitch + input.mouseDY * 0.0022));
    zoomTarget = Math.max(CAMERA.ZOOM_MIN, Math.min(CAMERA.ZOOM_MAX, zoomTarget + input.scroll * 0.004));
    zoom += (zoomTarget - zoom) * ZOOM_LERP;
    input.mouseDX = 0; input.mouseDY = 0; input.scroll = 0;

    // movement (frozen mid-roll: the roll itself displaces)
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const r = new THREE.Vector3(f.z, 0, -f.x);
    const mv = new THREE.Vector3();
    if (rollT < 0 && !dead) {
      if (input.keys.has('KeyW')) mv.add(f);
      if (input.keys.has('KeyS')) mv.sub(f);
      if (input.keys.has('KeyA')) mv.sub(r);
      if (input.keys.has('KeyD')) mv.add(r);
    }
    const speed = MOVEMENT.WALK_SPEED * (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight') ? MOVEMENT.SPRINT_MULT : 1);
    let movingNow = false;
    if (mv.lengthSq() > 0) {
      mv.normalize().multiplyScalar(speed * dt);
      pos.x += mv.x; pos.z += mv.z;
      facing = Math.atan2(mv.x, mv.z);
      movingNow = true;
    }
    // dodge-roll displacement (client-side feel; server clamp tolerates it)
    if (rollT >= 0) {
      rollT += dt;
      pos.x += rollX * 5.5 * dt;
      pos.z += rollZ * 5.5 * dt;
      if (rollT >= ROLL_S) { rollT = -1; body.rotation.x = 0; }
    }
    // jump + gravity
    const gy = groundHeight(pos.x, pos.z) + 2.2;
    if (input.keys.has('Space') && grounded && !dead) { vy = MOVEMENT.JUMP_VELOCITY; grounded = false; }
    vy += MOVEMENT.GRAVITY * dt;
    pos.y += vy * dt;
    if (pos.y <= gy) { pos.y = gy; vy = 0; grounded = true; }
    group.position.copy(pos);
    group.rotation.y = facing;

    // netcode-visible state
    moving = movingNow;
    anim = !grounded ? 'jump' : movingNow ? (speed > MOVEMENT.WALK_SPEED + 0.01 ? 'run' : 'walk') : 'idle';

    // leg swing (paused during roll/swing so the combat anim reads)
    if (movingNow && rollT < 0 && swingT < 0) animT += dt * (speed > MOVEMENT.WALK_SPEED ? 11 : 9);
    const walkAmp = rollT >= 0 || swingT >= 0 ? 0 : 1;
    legL.rotation.x = movingNow ? Math.sin(animT) * 0.5 * walkAmp : 0;
    legR.rotation.x = movingNow ? Math.sin(animT + Math.PI) * 0.5 * walkAmp : 0;
    armL.rotation.x = movingNow ? Math.sin(animT + Math.PI) * 0.3 * walkAmp : 0;
    armR.rotation.x = movingNow ? Math.sin(animT) * 0.3 * walkAmp : 0;

    // staged lunge swing: overhead → chop, deeper lunge on later stages
    if (swingT >= 0) {
      swingT += dt;
      const p = Math.min(1, swingT / SWING_S);
      const arc = Math.sin(p * Math.PI);
      sword.rotation.z = -0.35 - arc * 1.5;
      armR.rotation.x = -arc * 2.1;
      body.position.z = arc * (0.3 + swingStage * 0.14);
      body.rotation.y = -arc * 0.28;
      if (p >= 1) {
        swingT = -1;
        sword.rotation.z = -0.35;
        body.position.z = 0;
        body.rotation.y = 0;
      }
    }

    // dodge roll: forward flip around the body pivot
    if (rollT >= 0) {
      const p = Math.min(1, rollT / ROLL_S);
      body.rotation.x = -p * Math.PI * 2;
      body.position.y = Math.sin(p * Math.PI) * 0.35;
      legL.rotation.x = 0.9; legR.rotation.x = 0.9;
      armL.rotation.x = -0.9; armR.rotation.x = -0.9;
      if (p >= 1) { rollT = -1; body.rotation.x = 0; body.position.y = 0; }
    }

    // blob shadow
    blob.position.set(pos.x, gy - 2.15, pos.z);
    blob.visible = grounded || pos.y - gy < 0.4;

    // camera
    camTarget.lerp(new THREE.Vector3(pos.x, pos.y + 1.6, pos.z), CAMERA.LERP);
    const cp = new THREE.Vector3(
      camTarget.x + Math.sin(yaw) * zoom * Math.cos(pitch),
      camTarget.y + Math.sin(pitch) * zoom,
      camTarget.z + Math.cos(yaw) * zoom * Math.cos(pitch)
    );
    const minCamY = groundHeight(cp.x, cp.z) + 0.6;
    if (cp.y < minCamY) cp.y = minCamY;
    camera.position.lerp(cp, CAMERA.LERP);
    camera.lookAt(camTarget);
  }

  return { group, pos, yaw, facing, moving, anim, update, swing, roll, setIframes, dead, setDead };
}
