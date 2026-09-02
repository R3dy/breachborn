// HUD bindings: bars, FPS, fullscreen, boot overlay, quest tracker, chat, net banner.
import { TRACE } from '@breachborn/shared';

export type Hud = {
  setFps: (fps: number, rttMs?: number) => void;
  setTrace: (v: number) => void;
  setVigor: (v: number) => void;
  setWill: (v: number) => void;
  completeQuest: (id: string) => void;
  chatLine: (from: string, text: string, channel?: 'local' | 'party') => void;
  chatSystem: (text: string) => void;
  setNetOffline: (offline: boolean) => void;
  onEnterWorld: (cb: (soul: { name: string; race: string }) => void) => void;
  setCharName: (name: string) => void;
  setParty: (members: string[]) => void;
  showInvite: (from: string, accept: () => void) => void;
  onChat: (cb: (text: string) => void) => void;
  isTyping: () => boolean;
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export function createHud(): Hud {
  const fpsEl = $('fps');
  const traceFill = document.querySelector('.bar.trace .fill') as HTMLElement;
  const tracePct = document.querySelector('.bar.trace .pct') as HTMLElement;
  const hpFill = document.querySelector('.bar.hp .fill') as HTMLElement;
  const hpPct = document.querySelector('.bar.hp .pct') as HTMLElement;
  const mpFill = document.querySelector('.bar.mp .fill') as HTMLElement;
  const mpPct = document.querySelector('.bar.mp .pct') as HTMLElement;
  const questList = $('questList');
  const chatbox = $('chatbox');
  const banner = $('netbanner');
  const chatInput = $<HTMLInputElement>('chatInput');
  const invtoast = $('invtoast');
  const invFrom = $('invFrom');
  const invAccept = $('invAccept');
  const partyFrame = $('party');

  // FPS visibility toggle (F3) — inactive while typing in chat
  let fpsVisible = true;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      if (document.activeElement === chatInput) return;
      e.preventDefault();
      fpsVisible = !fpsVisible;
      fpsEl.style.display = fpsVisible ? '' : 'none';
    }
  });

  // Fullscreen (F1 + button) — inactive while typing in chat
  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F1') {
      if (document.activeElement === chatInput) return;
      e.preventDefault();
      toggleFullscreen();
    }
  });
  $('fsbtn').addEventListener('click', toggleFullscreen);

  // Boot overlay
  let enterCb: ((soul: { name: string; race: string }) => void) | null = null;
  let race = localStorage.getItem('breachborn.race') ?? 'Aelfon';
  const nameInput = $<HTMLInputElement>('nameInput');
  nameInput.value = localStorage.getItem('breachborn.soul') ?? '';
  document.querySelectorAll<HTMLButtonElement>('.race').forEach((b) => {
    if (b.dataset.race === race) b.classList.add('sel');
    b.addEventListener('click', () => {
      race = b.dataset.race ?? 'Aelfon';
      document.querySelectorAll<HTMLButtonElement>('.race').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    });
  });
  function enterWorld(): void {
    const name = nameInput.value.trim() || `wraith-${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem('breachborn.soul', name);
    localStorage.setItem('breachborn.race', race);
    $('clicklay').classList.remove('show');
    setCharName(name);
    enterCb?.({ name, race });
  }
  $('enterBtn').addEventListener('click', enterWorld);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterWorld(); });

  // Char plate + party frame — server name (with dedupe suffix) is authoritative.
  let charName = '';
  function setCharName(name: string): void {
    charName = name;
    $('charplate').textContent = `${name.toUpperCase()} — LVL 1`;
  }
  function setParty(members: string[]): void {
    const frame = $('party');
    frame.replaceChildren();
    const you = document.createElement('div');
    you.className = 'p you';
    you.textContent = `✦ ${charName || 'you'} (you)`;
    frame.appendChild(you);
    for (const m of members) {
      const d = document.createElement('div');
      d.className = 'p';
      d.textContent = m; // textContent — server-sanitized or not, inert
      frame.appendChild(d);
    }
  }
  setParty([]);

  let chatCb: ((text: string) => void) | null = null; // must precede the returned object (TDZ)

  return {
    setFps: (fps, rttMs) => {
      fpsEl.textContent = `FPS ${fps}${rttMs !== undefined ? ` · ${Math.round(rttMs)}ms` : ''}`;
    },
    setTrace: (v) => {
      const pct = Math.round(v);
      traceFill.style.width = `${pct}%`;
      tracePct.textContent = `${pct}%`;
      const watching = v >= TRACE.WATCHING_THRESHOLD;
      traceFill.style.background = watching
        ? 'linear-gradient(90deg,#8a3d1f,#ff4d2e)'
        : 'linear-gradient(90deg,#3d3d1f,#F5A623)';
    },
    setVigor: (v) => { hpFill.style.width = `${v}%`; hpPct.textContent = `${Math.round(v)}`; },
    setWill: (v) => { mpFill.style.width = `${v}%`; mpPct.textContent = `${Math.round(v)}`; },
    completeQuest: (id) => {
      const li = questList.querySelector<HTMLLIElement>(`li[data-q="${id}"]`);
      if (li) li.classList.add('done');
    },
    chatLine: (from, text, channel) => {
      const d = document.createElement('div');
      d.className = channel === 'party' ? 'line party' : 'line';
      const b = document.createElement('b'); b.textContent = from;
      d.appendChild(b); d.appendChild(document.createTextNode(`: ${text}`));
      chatbox.appendChild(d);
      while (chatbox.children.length > 8) chatbox.firstChild?.remove();
    },
    chatSystem: (text) => {
      const d = document.createElement('div');
      d.className = 'line sys';
      d.textContent = `> ${text}`;
      chatbox.appendChild(d);
      while (chatbox.children.length > 8) chatbox.firstChild?.remove();
    },
    setNetOffline: (offline) => { banner.classList.toggle('show', offline); },
    onEnterWorld: (cb) => { enterCb = cb; },
    setCharName,
    setParty,
    showInvite,
    onChat: (cb) => { chatCb = cb; },
    isTyping: () => document.activeElement === chatInput,
  };

  // Chat input: Enter opens (when not booting), Enter sends, Esc cancels.
  function openChat(): void { chatInput.classList.add('show'); chatInput.focus(); }
  function closeChat(): void { chatInput.classList.remove('show'); chatInput.value = ''; chatInput.blur(); }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') {
      const booting = $('clicklay').classList.contains('show');
      if (document.activeElement === chatInput) {
        e.preventDefault();
        const v = chatInput.value;
        closeChat();
        if (v.trim()) chatCb?.(v);
      } else if (!booting) {
        e.preventDefault();
        openChat();
      }
    } else if (e.code === 'Escape' && document.activeElement === chatInput) {
      closeChat();
    }
  });
  chatInput.addEventListener('keydown', (e) => {
    // Keep the event from reaching game handlers via target checks there;
    // this listener only prevents browser quirks on the focused input.
    if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });

  // Party invite toast (auto-hides after 15s)
  let inviteCb: (() => void) | null = null;
  let inviteTimer = 0;
  function showInvite(from: string, accept: () => void): void {
    invFrom.textContent = from;
    inviteCb = accept;
    invtoast.classList.add('show');
    window.clearTimeout(inviteTimer);
    inviteTimer = window.setTimeout(hideInvite, 15000);
  }
  function hideInvite(): void {
    invtoast.classList.remove('show');
    inviteCb = null;
  }
  invAccept.addEventListener('click', () => {
    const cb = inviteCb;
    hideInvite();
    cb?.();
  });
}
