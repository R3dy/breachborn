// Pooled combat FX (story 3.1): floating damage numbers, particle bursts,
// hit-stop, screen shake. Zero per-frame allocations — every sprite/particle
// is preallocated and recycled through cursors.
import * as THREE from 'three';

const FLOATER_POOL = 32;
const FLOATER_LIFE_S = 1.1;
const PARTICLE_POOL = 64;
const BURST_COUNT = 10;
const PARTICLE_LIFE_S = 0.7;

type Floater = {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  age: number;
  active: boolean;
};

type Particle = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number; vy: number; vz: number;
  age: number;
  active: boolean;
};

export class Fx {
  private floaters: Floater[] = [];
  private floatCursor = 0;
  private particles: Particle[] = [];
  private partCursor = 0;
  shakeAmp = 0;          // world-unit jitter applied to the camera, decays
  hitStopUntil = 0;      // performance.now() until which dt is scaled down

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < FLOATER_POOL; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 192; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(2.0, 0.66, 1);
      sprite.visible = false;
      sprite.renderOrder = 30;
      scene.add(sprite);
      this.floaters.push({ sprite, mat, ctx, tex, age: 0, active: false });
    }
    const geo = new THREE.TetrahedronGeometry(0.09);
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.particles.push({ mesh, mat, vx: 0, vy: 0, vz: 0, age: 0, active: false });
    }
  }

  // Reuse the next pooled floater: redraw its canvas, reposition, reset age.
  floater(at: THREE.Vector3, text: string, color: string): void {
    const f = this.floaters[this.floatCursor]!;
    this.floatCursor = (this.floatCursor + 1) % FLOATER_POOL;
    f.ctx.clearRect(0, 0, 192, 64);
    f.ctx.font = '700 36px Georgia, serif';
    f.ctx.textAlign = 'center';
    f.ctx.textBaseline = 'middle';
    f.ctx.shadowColor = '#000';
    f.ctx.shadowBlur = 8;
    f.ctx.fillStyle = color;
    f.ctx.fillText(text, 96, 34);
    f.tex.needsUpdate = true;
    f.sprite.position.set(at.x, at.y, at.z);
    f.mat.opacity = 1;
    f.age = 0;
    f.active = true;
    f.sprite.visible = true;
  }

  // Pooled death poof / hit burst.
  burst(at: THREE.Vector3, color: number): void {
    for (let i = 0; i < BURST_COUNT; i++) {
      const p = this.particles[this.partCursor]!;
      this.partCursor = (this.partCursor + 1) % PARTICLE_POOL;
      const a = (i / BURST_COUNT) * Math.PI * 2 + Math.random() * 0.6;
      p.mesh.position.set(at.x, at.y + 0.6, at.z);
      p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      p.mat.color.setHex(color);
      p.mat.opacity = 1;
      const sp = 2 + Math.random() * 2;
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = 2.5 + Math.random() * 2;
      p.age = 0;
      p.active = true;
      p.mesh.visible = true;
    }
  }

  hitStop(ms: number): void {
    this.hitStopUntil = performance.now() + ms;
  }

  shake(amp: number): void {
    this.shakeAmp = Math.min(0.09, this.shakeAmp + amp);
  }

  update(dt: number): void {
    for (const f of this.floaters) {
      if (!f.active) continue;
      f.age += dt;
      f.sprite.position.y += 1.5 * dt;
      f.mat.opacity = Math.max(0, 1 - f.age / FLOATER_LIFE_S);
      if (f.age >= FLOATER_LIFE_S) { f.active = false; f.sprite.visible = false; }
    }
    for (const p of this.particles) {
      if (!p.active) continue;
      p.age += dt;
      p.vy -= 9 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.z += dt * 5;
      p.mat.opacity = Math.max(0, 1 - p.age / PARTICLE_LIFE_S);
      if (p.age >= PARTICLE_LIFE_S) { p.active = false; p.mesh.visible = false; }
    }
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 0.35);
  }
}
