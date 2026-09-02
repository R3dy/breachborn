// Mob + dummy views (story 3.2): distinct low-poly silhouettes per canon type,
// snapshot interpolation (same pattern as remote.ts / interp.ts), telegraph
// emissive pulse during windup, death poof via the pooled FX module.
import * as THREE from 'three';
import type { MobType, Vec3 } from '@breachborn/shared';
import { MOB_TYPES } from '@breachborn/shared';
import { INTERP_MS, pushSnap, sampleSnaps, type Snap } from './interp.ts';
import type { Fx } from './fx.ts';

type MobView = {
  group: THREE.Group;
  body: THREE.Group;
  accentMat: THREE.MeshStandardMaterial;
  snaps: Snap[];
  pos: THREE.Vector3;
  hover: boolean;
  telegraphUntil: number;
  baseScale: number;
};

export class MobsView {
  private map = new Map<string, MobView>();
  private sample: Snap = { x: 0, y: 0, z: 0, yaw: 0, t: 0 };

  constructor(private scene: THREE.Scene, private fx: Fx) {}

  spawn(mobId: string, type: MobType | 'dummy', pos: Vec3): void {
    if (this.map.has(mobId)) return;
    if (type === 'dummy') {
      this.spawnDummy(mobId, pos);
      return;
    }
    const stats = MOB_TYPES[type];
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    const bodyMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, color: stats.body });
    const accentMat = new THREE.MeshStandardMaterial({
      flatShading: true, roughness: 0.5, color: stats.accent, emissive: stats.accent, emissiveIntensity: 0.6,
    });

    if (type === 'glimmerling') {
      // withered-green imp: squat faceted body, snouted head, ear spikes, glimmer eyes
      const torso = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 0), bodyMat);
      torso.position.y = 0.42; torso.scale.set(1, 0.82, 1.15);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 5), bodyMat);
      head.position.set(0, 0.62, 0.42); head.rotation.x = Math.PI / 2;
      const earL = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 4), bodyMat);
      earL.position.set(-0.24, 0.88, 0.3); earL.rotation.z = 0.7;
      const earR = earL.clone(); earR.position.x = 0.24; earR.rotation.z = -0.7;
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), accentMat);
      eyeL.position.set(-0.12, 0.62, 0.66);
      const eyeR = eyeL.clone(); eyeR.position.x = 0.12;
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 4), bodyMat);
      tail.position.set(0, 0.5, -0.55); tail.rotation.x = -Math.PI / 2.4;
      const legFL = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 4), bodyMat);
      legFL.position.set(-0.2, 0.12, 0.28); legFL.rotation.x = Math.PI;
      const legFR = legFL.clone(); legFR.position.x = 0.2;
      const legBL = legFL.clone(); legBL.position.z = -0.28;
      const legBR = legFR.clone(); legBR.position.z = -0.28;
      body.add(torso, head, earL, earR, eyeL, eyeR, tail, legFL, legFR, legBL, legBR);
      group.scale.setScalar(stats.scale);
    } else {
      // warden drone: obsidian octahedron core, cyan rune ring, single eye — hovering
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), bodyMat);
      core.position.y = 1.15;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.045, 6, 22), accentMat);
      ring.position.y = 1.15; ring.rotation.x = Math.PI / 2.6;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), accentMat);
      eye.position.set(0, 1.15, 0.42);
      body.add(core, ring, eye);
      group.scale.setScalar(stats.scale);
    }

    group.position.set(pos.x, pos.y, pos.z);
    this.scene.add(group);
    this.map.set(mobId, {
      group, body, accentMat,
      snaps: [],
      pos: new THREE.Vector3(pos.x, pos.y, pos.z),
      hover: type === 'warden-drone',
      telegraphUntil: 0,
      baseScale: stats.scale,
    });
  }

  private spawnDummy(mobId: string, pos: Vec3): void {
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    const wood = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, color: 0x6b4a2f });
    const straw = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95, color: 0xc9a86a });
    const accentMat = new THREE.MeshStandardMaterial({
      flatShading: true, color: 0xE8C96A, emissive: 0xE8C96A, emissiveIntensity: 0.35,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.18, 8), wood);
    base.position.y = 0.09;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.7, 6), wood);
    post.position.y = 0.95;
    const cross = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.14, 0.14), wood);
    cross.position.y = 1.45;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 7, 6), straw);
    head.position.y = 1.85;
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.035, 5, 14), accentMat);
    sash.position.y = 1.2; sash.rotation.x = Math.PI / 2;
    body.add(base, post, cross, head, sash);
    group.position.set(pos.x, pos.y, pos.z);
    this.scene.add(group);
    this.map.set(mobId, {
      group, body, accentMat,
      snaps: [],
      pos: new THREE.Vector3(pos.x, pos.y, pos.z),
      hover: false, telegraphUntil: 0, baseScale: 1,
    });
  }

  apply(mobId: string, pos: Vec3, yaw: number, now: number): void {
    const v = this.map.get(mobId);
    if (!v) return;
    pushSnap(v.snaps, pos.x, pos.y, pos.z, yaw, now);
  }

  telegraph(mobId: string, ms: number, now: number): void {
    const v = this.map.get(mobId);
    if (v) v.telegraphUntil = now + ms;
  }

  // Death: pooled poof burst at the mob's last position, then despawn.
  death(mobId: string, accentFallback = 0x8fbf7a): void {
    const v = this.map.get(mobId);
    if (!v) return;
    this.fx.burst(v.pos, accentFallback);
    this.scene.remove(v.group);
    this.map.delete(mobId);
  }

  accentOf(mobId: string): number {
    return this.map.get(mobId)?.accentMat.emissive.getHex() ?? 0x8fbf7a;
  }

  posOf(mobId: string): THREE.Vector3 | null {
    return this.map.get(mobId)?.pos ?? null;
  }

  update(now: number, dt: number): void {
    const renderT = now - INTERP_MS;
    for (const v of this.map.values()) {
      if (v.snaps.length > 0) {
        sampleSnaps(v.snaps, renderT, this.sample);
        v.pos.set(this.sample.x, this.sample.y, this.sample.z);
        v.group.position.copy(v.pos);
        v.group.rotation.y = this.sample.yaw;
      }
      if (v.hover) {
        v.body.position.y = Math.sin(now * 0.0022) * 0.12;
      }
      // telegraph: emissive pulse + scale swell while the windup is live
      if (now < v.telegraphUntil) {
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.024);
        v.accentMat.emissiveIntensity = 0.6 + pulse * 2.2;
        const s = v.baseScale * (1 + pulse * 0.12);
        v.group.scale.setScalar(s);
      } else {
        v.accentMat.emissiveIntensity = 0.6;
        v.group.scale.setScalar(v.baseScale);
      }
    }
    void dt;
  }

  nearestTo(x: number, z: number, maxDist: number): { id: string; d: number } | null {
    let best: { id: string; d: number } | null = null;
    for (const [id, v] of this.map) {
      const d = Math.hypot(v.pos.x - x, v.pos.z - z);
      if (d <= maxDist && (best === null || d < best.d)) best = { id, d };
    }
    return best;
  }

  count(): number {
    return this.map.size;
  }
}
