// Remote players: simplified clone of the courier mesh + name glyph sprite,
// 100ms interpolation buffer (lerp between last two snapshots) — story 2.2.
import * as THREE from 'three';
import type { Vec3 } from '@breachborn/shared';

type Anim = 'idle' | 'walk' | 'run' | 'jump';

type Snap = { x: number; y: number; z: number; yaw: number; anim: Anim; t: number };

type Remote = {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  pos: THREE.Vector3;   // last rendered position
  snaps: Snap[];        // newest last, max 3
  animPhase: number;
};

const INTERP_MS = 100;
const MAX_SNAPS = 3;
const FLOATER_LIFE_S = 1.4;

type Floater = { sprite: THREE.Sprite; age: number };

function makeTextSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '600 30px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.4, 0.6, 1);
  return sprite;
}

function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '600 28px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#E8C96A';
    ctx.fillText(name, 128, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.95;
  return sprite;
}

// Simplified hooded-courier clone (no sword, fewer segments) — same palette
// and proportions as client/src/player.ts.
function buildMesh(name: string, pos: Vec3): Remote {
  const group = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, color: 0x2f3542 });
  const bodyMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, color: 0x8a5540 });
  const skin = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8, color: 0xd7a878 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.75, 4, 8), cloth); torso.position.y = 1.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), skin); head.position.y = 2.15;
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 8), bodyMat); hood.position.y = 2.42;
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.5, 3, 6), cloth); armL.position.set(-0.55, 1.35, 0);
  const armR = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.5, 3, 6), cloth); armR.position.set(0.55, 1.35, 0);
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.6, 3, 6), bodyMat); legL.position.set(-0.2, 0.45, 0);
  const legR = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.6, 3, 6), bodyMat); legR.position.set(0.2, 0.45, 0);
  group.add(torso, head, hood, armL, armR, legL, legR, makeNameSprite(name));
  group.position.set(pos.x, pos.y, pos.z);
  return {
    group, legL, legR, armL, armR,
    pos: new THREE.Vector3(pos.x, pos.y, pos.z),
    snaps: [], animPhase: 0,
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Remotes {
  private map = new Map<string, Remote>();
  private floaters: Floater[] = [];

  constructor(private scene: THREE.Scene) {}

  spawn(charId: string, name: string, pos: Vec3): void {
    if (this.map.has(charId)) return;
    const mesh = buildMesh(name, pos);
    this.scene.add(mesh.group);
    this.map.set(charId, mesh);
  }

  remove(charId: string): void {
    const r = this.map.get(charId);
    if (!r) return;
    this.scene.remove(r.group);
    r.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) {
        const tex = (mat as THREE.SpriteMaterial).map;
        if (tex) tex.dispose();
        mat.dispose();
      }
    });
    this.map.delete(charId);
  }

  // Feed a server snapshot; render position trails 100ms behind for smoothness.
  apply(charId: string, pos: Vec3, yaw: number, anim: Anim, now: number): void {
    const r = this.map.get(charId);
    if (!r) return;
    r.snaps.push({ x: pos.x, y: pos.y, z: pos.z, yaw, anim, t: now });
    if (r.snaps.length > MAX_SNAPS) r.snaps.shift();
  }

  // Per-frame interpolation + anim-driven limb swing. Allocation-free.
  update(now: number, dt: number): void {
    const renderT = now - INTERP_MS;
    for (const r of this.map.values()) {
      const s = r.snaps;
      if (s.length === 0) continue;
      const latest = s[s.length - 1] as Snap;
      let px: number, py: number, pz: number, yaw: number;
      if (s.length >= 2) {
        const a = s[s.length - 2] as Snap;
        const span = latest.t - a.t;
        const alpha = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
        px = a.x + (latest.x - a.x) * alpha;
        py = a.y + (latest.y - a.y) * alpha;
        pz = a.z + (latest.z - a.z) * alpha;
        yaw = lerpAngle(a.yaw, latest.yaw, alpha);
      } else {
        px = latest.x; py = latest.y; pz = latest.z; yaw = latest.yaw;
      }
      r.pos.set(px, py, pz);
      r.group.position.copy(r.pos);
      r.group.rotation.y = yaw;

      const anim = latest.anim;
      if (anim === 'walk' || anim === 'run') {
        r.animPhase += dt * (anim === 'run' ? 11 : 9);
        const sw = Math.sin(r.animPhase);
        r.legL.rotation.x = sw * 0.5;
        r.legR.rotation.x = -sw * 0.5;
        r.armL.rotation.x = -sw * 0.3;
        r.armR.rotation.x = sw * 0.3;
      } else if (anim === 'jump') {
        r.legL.rotation.x = 0.45;
        r.legR.rotation.x = 0.45;
        r.armL.rotation.x = -0.5;
        r.armR.rotation.x = -0.5;
      } else {
        r.legL.rotation.x = 0;
        r.legR.rotation.x = 0;
        r.armL.rotation.x = 0;
        r.armR.rotation.x = 0;
      }
    }

    // floaters: rise + fade, dispose at end of life
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i] as Floater;
      f.age += dt;
      f.sprite.position.y += dt * 0.9;
      const mat = f.sprite.material;
      mat.opacity = Math.max(0, 1 - f.age / FLOATER_LIFE_S);
      if (f.age >= FLOATER_LIFE_S) {
        this.scene.remove(f.sprite);
        mat.map?.dispose();
        mat.dispose();
        this.floaters.splice(i, 1);
      }
    }
  }

  posOf(charId: string): THREE.Vector3 | null {
    return this.map.get(charId)?.pos ?? null;
  }

  // Event-driven emote floater above a position (rises + fades).
  floatText(at: THREE.Vector3, text: string): void {
    const sprite = makeTextSprite(text, '#4BE3FF');
    sprite.position.set(at.x, at.y + 3.1, at.z);
    this.scene.add(sprite);
    this.floaters.push({ sprite, age: 0 });
  }

  count(): number {
    return this.map.size;
  }
}
