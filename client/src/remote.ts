// Remote players: simplified clone of the courier mesh + name glyph sprite.
// Story 2.1 owns spawn/despawn; story 2.2 adds the 100ms interpolation buffer.
import * as THREE from 'three';
import type { Vec3 } from '@breachborn/shared';

type Remote = {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  pos: THREE.Vector3;
};

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
  return { group, legL, legR, armL, armR, pos: new THREE.Vector3(pos.x, pos.y, pos.z) };
}

export class Remotes {
  private map = new Map<string, Remote>();

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

  posOf(charId: string): THREE.Vector3 | null {
    return this.map.get(charId)?.pos ?? null;
  }

  count(): number {
    return this.map.size;
  }
}
