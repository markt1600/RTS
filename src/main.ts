import { Game, DT, TICK, Team } from './sim';
import { AI, DIFFICULTY_NAMES } from './ai';
import { Renderer, makeIcons } from './render';
import { UI } from './ui';
import { Audio } from './audio';
import { BIOMES } from './map';
import { TEAM_COLORS, TEAM_NAMES } from './defs';
import { fmtTime } from './util';

const $ = (id: string) => document.getElementById(id)!;
const audio = new Audio();
let icons: Record<string, string> | null = null;

const opts = { diff: 1, opp: 0, size: 1, biome: 4, wet: 0, gfx: 2, seed: Math.floor(Math.random() * 99999) };
try { Object.assign(opts, JSON.parse(localStorage.getItem('ironveil-opts') || '{}'), { seed: opts.seed }); } catch { /* ignore */ }

function seg(id: string, labels: string[], key: keyof typeof opts) {
  const el = $(id); el.innerHTML = '';
  labels.forEach((l, i) => {
    const b = document.createElement('button'); b.textContent = l; if (opts[key] === i) b.className = 'on';
    b.onclick = () => { opts[key] = i; seg(id, labels, key); audio.init(); applyVol(); audio.music?.start(); audio.ui('click'); };
    el.appendChild(b);
  });
}
seg('optDiff', DIFFICULTY_NAMES, 'diff');
seg('optOpp', ['1', '2', '3'], 'opp');
seg('optSize', ['Small', 'Medium', 'Large'], 'size');
seg('optBiome', [...BIOMES.map(b => b.name), 'Random'], 'biome');
seg('optWet', ['Lakes & rivers', 'Open seas (naval)'], 'wet');
seg('optGfx', ['Low', 'Medium', 'High'], 'gfx');
const seedEl = $('optSeed') as HTMLInputElement; seedEl.value = '' + opts.seed;
$('seedRnd').onclick = () => { seedEl.value = '' + Math.floor(Math.random() * 99999); };

const vol = { music: 0.42, sfx: 0.5 };
try { Object.assign(vol, JSON.parse(localStorage.getItem('ironveil-vol') || '{}')); } catch { /* ignore */ }
function applyVol() { audio.setVolume(vol.sfx); audio.music?.setVolume(vol.music); }
for (const k of ['music', 'sfx'] as const) {
  const el = $('vol' + k) as HTMLInputElement; el.value = '' + Math.round(vol[k] * 100);
  el.oninput = () => { vol[k] = +el.value / 100; applyVol(); try { localStorage.setItem('ironveil-vol', JSON.stringify(vol)); } catch { /* ignore */ } };
}
interface Session { game: Game; r: Renderer; ui: UI; ais: AI[]; me: Team; raf: number; paused: boolean; speed: number; ended: boolean }
let S: Session | null = null;
const SPEEDS = [0.5, 1, 1.5, 2, 3];

function start() {
  audio.init(); applyVol(); audio.music?.stop(); audio.music?.start();
  const seed = (parseInt(seedEl.value, 10) || 1) >>> 0;
  try { localStorage.setItem('ironveil-opts', JSON.stringify(opts)); } catch { /* ignore */ }
  const biome = opts.biome === 4 ? seed % 4 : opts.biome;
  const players = [{ ai: false, level: 0, ally: 0 }];
  for (let i = 0; i <= opts.opp; i++) players.push({ ai: true, level: opts.diff, ally: i + 1 });
  const game = new Game({ n: [112, 144, 176][opts.size], seed, biome, wet: opts.wet, players });
  const me = game.teams[0];
  if (!icons) icons = makeIcons();
  const canvas = $('gl') as HTMLCanvasElement;
  const r = new Renderer(canvas, game, me, opts.gfx);
  const ses: Session = { game, r, ui: null as any, ais: game.teams.filter(t => t.ai).map(t => new AI(game, t)), me, raf: 0, paused: false, speed: 1, ended: false };
  ses.ui = new UI(game, r, me, audio, icons, {
    pause: () => { if (ses.ended && !$('end').classList.contains('hidden')) return; ses.paused = !ses.paused; $('pause').classList.toggle('hidden', !ses.paused); },
    speed: d => { ses.speed = Math.max(0, Math.min(SPEEDS.length - 1, ses.speed + d)); $('spdVal').textContent = SPEEDS[ses.speed] + '×'; },
  });
  $('spdVal').textContent = '1×';
  S = ses;
  $('menu').classList.add('hidden'); $('hud').classList.remove('hidden'); $('end').classList.add('hidden'); $('pause').classList.add('hidden');
  ses.ui.toast(`${BIOMES[biome].name} · ${DIFFICULTY_NAMES[opts.diff]} · seed ${seed}`);
  (window as any).__S = ses;
  let last = performance.now(), acc = 0;
  const loop = (now: number) => {
    ses.raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!ses.paused) {
      acc += dt * SPEEDS[ses.speed];
      let n = 0;
      while (acc >= DT && n < 8) { for (const a of ses.ais) a.update(); game.step(); acc -= DT; n++; }
      if (acc > DT) acc = 0;
    }
    ses.ui.update(dt, ses.paused);
    r.frame(ses.paused ? 1 : acc / DT, dt, ses.ui.selected, ses.paused);
    if (!ses.ended && (game.over || me.dead)) { ses.ended = true; setTimeout(() => showEnd(ses), 2500); }
  };
  ses.raf = requestAnimationFrame(loop);
}

function showEnd(ses: Session) {
  if (S !== ses) return;
  audio.music?.finale(!ses.me.dead);
  const g = ses.game, won = !ses.me.dead;
  $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
  ($('endTitle') as HTMLElement).style.color = won ? '#6fe08a' : '#ff6a50';
  let h = `<p>Battle time ${fmtTime(g.tick / TICK)}</p><table><tr><th>Commander</th><th>Built</th><th>Kills</th><th>Lost</th><th>Metal</th></tr>`;
  for (const t of g.teams) h += `<tr><td style="color:#${TEAM_COLORS[t.id].toString(16).padStart(6, '0')}">${TEAM_NAMES[t.id]}${t.ai ? ' (' + DIFFICULTY_NAMES[t.level] + ')' : ' (you)'}</td><td>${t.stats.built}</td><td>${t.stats.kills}</td><td>${t.stats.lost}</td><td>${Math.round(t.stats.metal)}</td></tr>`;
  $('endStats').innerHTML = h + '</table>';
  $('btnWatch').classList.toggle('hidden', g.over);
  $('end').classList.remove('hidden');
}

function quit() {
  if (!S) return;
  cancelAnimationFrame(S.raf); S.ui.dispose(); S.r.dispose(); S = null;
  audio.music?.stop(); audio.music?.start();
  $('hud').classList.add('hidden'); $('pause').classList.add('hidden'); $('end').classList.add('hidden'); $('menu').classList.remove('hidden');
  const c = ($('overlay') as HTMLCanvasElement); c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  // fresh GL canvas for the next battle
  const old = $('gl'), nw = document.createElement('canvas'); nw.id = 'gl'; old.replaceWith(nw);
  seedEl.value = '' + Math.floor(Math.random() * 99999);
}

$('btnStart').onclick = start;
$('btnResume').onclick = () => { if (S) { S.paused = false; $('pause').classList.add('hidden'); } };
$('btnQuit').onclick = quit;
$('btnAgain').onclick = quit;
$('btnWatch').onclick = () => $('end').classList.add('hidden');
window.addEventListener('resize', () => { if (S) { S.r.resize(); S.ui.resize(); } });
window.addEventListener('beforeunload', e => { if (S && !S.ended) { e.preventDefault(); } });
