// HUD bindings: bars, FPS, fullscreen, boot overlay, quest tracker, chat, net banner.
import { TRACE } from '@breachborn/shared';

export type Hud = {
  setFps: (fps: number) => void;
  setTrace: (v: number) => void;
  setVigor: (v: number) => void;
  setWill: (v: number) => void;
  completeQuest: (id: string) => void;
  chatLine: (from: string, text: string) => void;
  chatSystem: (text: string) => void;
  setNetOffline: (offline: boolean) => void;
  onEnterWorld: (cb: (soul: { name: string; race: string }) => void) => void;
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

  // FPS visibility toggle (F3)
  let fpsVisible = true;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      fpsVisible = !fpsVisible;
      fpsEl.style.display = fpsVisible ? '' : 'none';
    }
  });

  // Fullscreen (F1 + button)
  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F1') { e.preventDefault(); toggleFullscreen(); }
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
    $('charplate').textContent = `${name.toUpperCase()} — LVL 1`;
    $('partyYou').textContent = name;
    enterCb?.({ name, race });
  }
  $('enterBtn').addEventListener('click', enterWorld);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterWorld(); });

  return {
    setFps: (fps) => { fpsEl.textContent = `FPS ${fps}`; },
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
    chatLine: (from, text) => {
      const d = document.createElement('div');
      d.className = 'line';
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
  };
}
