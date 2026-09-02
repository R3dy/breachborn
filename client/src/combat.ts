// Client combat (story 3.1/3.2): input intents + display. The server resolves
// every swing — this module sends `{t:'combat'}` intents, mirrors dodge
// cooldown for the HUD tick, and renders the authoritative events (floaters,
// hit-stop, shake, telegraphs, XP, DPS log, death/respawn).
import * as THREE from 'three';
import type { ClientMsg, ServerMsg } from '@breachborn/shared';
import { COMBAT, DUMMY } from '@breachborn/shared';
import type { Player } from './player.ts';
import type { Remotes } from './remote.ts';
import type { MobsView } from './mobs.ts';
import type { Hud } from './hud.ts';
import type { Fx } from './fx.ts';
import { groundHeight } from './world.ts';

const GOLD = '#E8C96A';
const WHITE = '#F5EFE0';
const CYAN = '#4BE3FF';
const TARGET_RANGE = 2.9; // client-side pick radius (server re-checks at 2.2)

type Deps = {
  send: (msg: ClientMsg) => void;
  player: Player;
  remotes: Remotes;
  mobs: MobsView;
  hud: Hud;
  fx: Fx;
};

export class CombatView {
  private myCharId = '';
  private localStage = 0;
  private lastLocalSwingAt = 0;
  private dodgeReadyAt = 0;
  private lastDpsShown = -1;

  constructor(private d: Deps) {
    document.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement === null) return; // only in pointer lock
      if (this.d.hud.isTyping()) return;
      if (e.button === 0) this.attack();
      else if (e.button === 2) this.dodge();
    });
  }

  setCharId(id: string): void {
    this.myCharId = id;
  }

  // ---- intents ----

  private pickTarget(): string | undefined {
    const p = this.d.player.pos;
    const mob = this.d.mobs.nearestTo(p.x, p.z, TARGET_RANGE);
    let bestId: string | undefined;
    let bestD = TARGET_RANGE;
    if (mob) { bestId = mob.id; bestD = mob.d; }
    const remotePos = this.nearestRemote(p);
    if (remotePos && remotePos.d < bestD) bestId = remotePos.id;
    return bestId;
  }

  private nearestRemote(p: THREE.Vector3): { id: string; d: number } | null {
    let best: { id: string; d: number } | null = null;
    // remotes exposes posOf; scan via nearestTo-style loop over known ids
    for (const id of this.d.remotes.ids()) {
      const rp = this.d.remotes.posOf(id);
      if (!rp) continue;
      const d = Math.hypot(rp.x - p.x, rp.z - p.z);
      if (d <= TARGET_RANGE && (best === null || d < best.d)) best = { id, d };
    }
    return best;
  }

  attack(): void {
    if (this.d.player.dead) return;
    const now = performance.now();
    // mirror the server's combo pacing for the local anim (server confirms)
    this.localStage = now - this.lastLocalSwingAt <= COMBAT.COMBO_WINDOW_MS
      ? (this.localStage + 1) % COMBAT.COMBO_STAGES
      : 0;
    this.lastLocalSwingAt = now;
    const target = this.pickTarget();
    this.d.player.swing(this.localStage);
    this.d.send({ t: 'combat', kind: 'attack', target });
  }

  dodge(): void {
    if (this.d.player.dead) return;
    const now = performance.now();
    if (now < this.dodgeReadyAt) return; // local mirror — server double-checks
    this.d.send({ t: 'combat', kind: 'dodge' });
    this.dodgeReadyAt = now + COMBAT.DODGE_COOLDOWN_MS;
  }

  // ---- per-frame ----

  update(): void {
    const now = performance.now();
    if (this.dodgeReadyAt > now) this.d.hud.setDodgeCd(this.dodgeReadyAt - now);
    else this.d.hud.clearDodgeCd();
  }

  // ---- server events ----

  private victimPos(targetId: string | undefined): THREE.Vector3 | null {
    if (!targetId) return null;
    if (targetId === this.myCharId) return this.d.player.pos;
    return this.d.remotes.posOf(targetId) ?? this.d.mobs.posOf(targetId);
  }

  onServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'combat': this.onCombat(msg); break;
      case 'hp':
        if (msg.charId === this.myCharId) this.d.hud.setVigor((msg.hp / msg.maxHp) * 100);
        break;
      case 'xp':
        this.d.fx.floater(this.d.player.pos, `+${msg.amount} XP`, GOLD);
        break;
      case 'death':
        if (msg.respawnInMs > 0) {
          this.d.hud.showDeath(msg.respawnInMs);
          this.d.player.setDead(true);
          this.d.fx.hitStop(70);
          this.d.fx.shake(0.07);
        }
        break;
      case 'respawn': {
        this.d.player.pos.set(msg.pos.x, groundHeight(msg.pos.x, msg.pos.z) + 2.2, msg.pos.z);
        this.d.player.setDead(false);
        this.d.hud.hideDeath();
        this.d.hud.setVigor(100);
        this.d.hud.chatSystem('you rematerialize at the spire base — the unlogged drift clings to you');
        break;
      }
    }
  }

  private onCombat(msg: Extract<ServerMsg, { t: 'combat' }>): void {
    switch (msg.kind) {
      case 'attack': {
        if (msg.charId && msg.charId !== this.myCharId) this.d.remotes.swing(msg.charId);
        break; // own swings are predicted locally
      }
      case 'hit': {
        const pos = this.victimPos(msg.target);
        if (!pos || msg.amount === undefined) break;
        const mine = msg.target === this.myCharId || msg.charId === this.myCharId;
        if (msg.crit) {
          this.d.fx.floater(pos, `${msg.amount}!`, GOLD);
        } else {
          this.d.fx.floater(pos, `${msg.amount}`, WHITE);
        }
        if (mine) {
          this.d.fx.hitStop(40 + Math.random() * 30); // 40-70ms
          this.d.fx.shake(msg.crit ? 0.06 : 0.035);
        }
        break;
      }
      case 'dodge': {
        const victimId = msg.target;
        if (victimId === this.myCharId) {
          this.d.player.setIframes(true);
          window.setTimeout(() => this.d.player.setIframes(false), COMBAT.DODGE_IFRAMES_MS);
          this.d.fx.floater(this.d.player.pos, 'dodge', CYAN);
        } else if (victimId) {
          const pos = this.victimPos(victimId);
          if (pos) this.d.fx.floater(pos, 'dodge', CYAN);
        }
        break;
      }
      case 'death': {
        if (msg.mobId) {
          const accent = this.d.mobs.accentOf(msg.mobId);
          this.d.mobs.death(msg.mobId, accent);
          this.d.fx.shake(0.03);
        } else if (msg.charId && msg.charId !== this.myCharId) {
          this.d.remotes.setVisible(msg.charId, false);
        }
        break;
      }
      case 'respawn': {
        if (msg.charId && msg.charId !== this.myCharId) this.d.remotes.setVisible(msg.charId, true);
        break;
      }
      case 'dps': {
        if (msg.amount === undefined) break;
        const at = this.d.mobs.posOf(DUMMY.ID) ?? this.d.player.pos;
        this.d.fx.floater(at, `${msg.amount.toFixed(1)} DPS`, CYAN);
        // throttle the chat log: only when the readout moves a full point
        if (Math.abs(msg.amount - this.lastDpsShown) >= 1) {
          this.lastDpsShown = msg.amount;
          this.d.hud.chatSystem(`training dummy — ${msg.amount.toFixed(1)} dps (rolling 10s)`);
        }
        break;
      }
    }
  }
}
