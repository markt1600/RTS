// Deterministic-ish fixed-step simulation. No rendering imports here so it can run headless.
import { CELL, GameMap, Spot } from './map';
import { DEFS, UnitDef, WeaponDef } from './defs';
import { angDiff, clamp, lerp, mulberry32, Rng, turnToward } from './util';

export const TICK = 30;
export const DT = 1 / TICK;

export type OType = 'move' | 'attack' | 'fight' | 'patrol' | 'build' | 'repair' | 'reclaim' | 'guard';
export interface Order {
  type: OType; x: number; z: number;
  target?: Unit | null; wreck?: Wreck; def?: UnitDef; cx?: number; cz?: number; x2?: number; z2?: number;
  s?: boolean; n?: number;
}
export interface Wreck { id: number; x: number; y: number; z: number; r: number; metal: number; max: number; dead: boolean; rot: number }
export interface Proj {
  k: number; // 0 cannon, 1 missile, 2 bomb
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  sx: number; sy: number; sz: number; tx: number; ty: number; tz: number;
  t: number; T: number; arc: number; target: Unit | null; w: WeaponDef; team: Team; dead: boolean;
}
export interface GameEvent { t: 'beam' | 'muzzle' | 'boom' | 'die' | 'built' | 'alert'; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number; c?: number; size?: number; big?: boolean; u?: Unit; k?: string }

export class Team {
  id: number; ally: number; ai: boolean; level: number; mult = 1;
  metal = 1000; energy = 1000; stM = 1000; stE = 1000;
  incM = 0; incE = 0; useM = 0; useE = 0;
  reqM = 0; reqE = 0; spentM = 0; spentE = 0; stall = 1; lowPower = false;
  pM = 0; pE = 0; uE = 0; sM = 0; sE = 0;
  vis: Uint8Array; dead = false; prime: Unit | null = null;
  alerts: { x: number; z: number; tick: number; b: boolean }[] = []; lastAlert = -99;
  startX = 0; startZ = 0;
  stats = { built: 0, lost: 0, kills: 0, metal: 0 };
  constructor(id: number, ally: number, ai: boolean, level: number, n: number) {
    this.id = id; this.ally = ally; this.ai = ai; this.level = level; this.vis = new Uint8Array(n * n);
  }
}

export class Unit {
  id = 0; def: UnitDef; team: Team;
  x = 0; y = 0; z = 0; px = 0; py = 0; pz = 0; heading = 0; ph = 0;
  hp = 1; built = true; progress = 1;
  orders: Order[] = [];
  path: number[] | null = null; pi = 0; pathPending = false;
  goal = false; gx = 0; gz = 0; gr = 4; speed = 0;
  stuckX = 0; stuckZ = 0; stuck = 0;
  turret = 0; pturret = 0;
  cd: number[]; wt: (Unit | null)[]; burst: number[]; burstT: number[];
  forced: Unit | null = null; engageT: Unit | null = null; homeX = 0; homeZ = 0;
  queue: UnitDef[] = []; repeat = false; buildee: Unit | null = null; rally: { x: number; z: number } | null = null;
  inFactory = false; ejectZ = -1;
  dead = false; spot: Spot | null = null;
  nano: { x: number; y: number; z: number; def?: UnitDef; r?: number } | null = null; nanoTick = -9;
  seen = 0; lastHit = -999; bank = 0; cx = 0; cz = 0;
  constructor(def: UnitDef, team: Team) {
    this.def = def; this.team = team;
    const n = def.weapons.length;
    this.cd = new Array(n).fill(0); this.wt = new Array(n).fill(null);
    this.burst = new Array(n).fill(0); this.burstT = new Array(n).fill(0);
  }
}

export interface GameOpts { n: number; seed: number; biome: number; players: { ai: boolean; level: number; ally: number }[] }

const GS = 32; // spatial hash cell
const bit = (u: Unit) => (u.def.cls === 'air' ? 2 : 1);

export class Game {
  map: GameMap; teams: Team[] = []; units: Unit[] = []; wrecks: Wreck[] = []; projs: Proj[] = [];
  events: GameEvent[] = []; tick = 0; nextId = 1; rng: Rng; wind = 0.5;
  over = false; winner = -1;
  occ = new Map<number, Unit>();
  private grid: Unit[][]; private gw: number;
  private pathQ: Unit[] = []; private anyDead = false;
  private blasts: { x: number; z: number; r: number; d: number }[] = [];
  private qbuf: Unit[] = [];

  constructor(opts: GameOpts) {
    this.rng = mulberry32(opts.seed * 31 + 7);
    this.map = new GameMap(opts.n, opts.seed, opts.biome);
    this.gw = Math.ceil(this.map.size / GS);
    this.grid = []; for (let i = 0; i < this.gw * this.gw; i++) this.grid.push([]);
    const order = opts.players.length === 2 ? [0, 2] : [0, 1, 2, 3];
    opts.players.forEach((p, i) => {
      const t = new Team(i, p.ally, p.ai, p.level, opts.n);
      if (p.ai) t.mult = [0.7, 1, 1.2, 1.6][p.level];
      const s = this.map.starts[order[i]];
      t.startX = s.x; t.startZ = s.z;
      this.teams.push(t);
      const u = this.spawn(DEFS.prime, t, s.x, s.z, true);
      u.heading = Math.atan2(this.map.size / 2 - s.x, this.map.size / 2 - s.z); u.turret = u.heading;
      t.prime = u;
    });
    this.rebuildGrid(); this.updateVision();
  }

  // ───────────── creation ─────────────
  spawn(def: UnitDef, team: Team, x: number, z: number, built: boolean): Unit {
    const u = new Unit(def, team);
    u.id = this.nextId++; u.x = u.px = x; u.z = u.pz = z;
    u.y = u.py = this.map.groundY(x, z);
    u.built = built; u.progress = built ? 1 : 0; u.hp = built ? def.hp : def.hp * 0.05;
    u.homeX = x; u.homeZ = z; u.stuckX = x; u.stuckZ = z;
    this.units.push(u);
    return u;
  }
  spotAt(cx: number, cz: number): Spot | null {
    for (const s of this.map.spots) if (s.cx === cx + 1 && s.cz === cz + 1) return s;
    return null;
  }
  nearestSpot(x: number, z: number, maxD: number): Spot | null {
    let b: Spot | null = null, bd = maxD;
    for (const s of this.map.spots) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; b = s; } }
    return b;
  }
  canPlace(def: UnitDef, cx: number, cz: number, team: Team): boolean {
    const m = this.map, n = m.n;
    if (def.cls !== 'building') return m.cellPass(cx + 1, cz + 1);
    let upgrade = false;
    if (def.extract) {
      const s = this.spotAt(cx, cz); if (!s) return false;
      if (s.taken) {
        const o = s.taken as Unit;
        if (def.id === 'deepext' && o.team === team && o.def.id === 'extractor') upgrade = true; else return false;
      }
    }
    let lo = 1e9, hi = -1e9;
    for (let j = 0; j < def.fh; j++) for (let i = 0; i < def.fw; i++) {
      const x = cx + i, z = cz + j;
      if (x < 1 || z < 1 || x >= n - 1 || z >= n - 1) return false;
      if (!m.pass[z * n + x]) return false;
      if (m.block[z * n + x] && !upgrade) return false;
    }
    for (let j = 0; j <= def.fh; j++) for (let i = 0; i <= def.fw; i++) {
      const h = m.heights[(cz + j) * 2 * m.hn + (cx + i) * 2];
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return hi - lo < 7;
  }
  placeBuilding(def: UnitDef, team: Team, cx: number, cz: number, built: boolean): Unit {
    const m = this.map;
    if (def.cls !== 'building') {
      const u = this.spawn(def, team, (cx + 1.5) * CELL, (cz + 1.5) * CELL, built);
      u.heading = u.turret = 0; return u;
    }
    const s = def.extract ? this.spotAt(cx, cz) : null;
    if (s && s.taken) this.kill(s.taken as Unit, null, true);
    const u = this.spawn(def, team, (cx + def.fw / 2) * CELL, (cz + def.fh / 2) * CELL, built);
    u.cx = cx; u.cz = cz;
    for (let j = 0; j < def.fh; j++) for (let i = 0; i < def.fw; i++) m.block[(cz + j) * m.n + cx + i]++;
    this.occ.set(cz * m.n + cx, u);
    if (s) { s.taken = u; u.spot = s; }
    // seat on average ground
    let h = 0; for (let j = 0; j <= def.fh; j++) for (let i = 0; i <= def.fw; i++) h = Math.max(h, m.heights[(cz + j) * 2 * m.hn + (cx + i) * 2]);
    u.y = u.py = h;
    return u;
  }

  // ───────────── orders API ─────────────
  give(u: Unit, o: Order, queue = false) {
    if (u.dead || !u.built && !u.inFactory) return;
    if (!queue) { u.orders.length = 0; this.stop(u); u.engageT = null; }
    u.orders.push(o);
  }
  clearOrders(u: Unit) { u.orders.length = 0; this.stop(u); u.engageT = null; u.homeX = u.x; u.homeZ = u.z; }
  giveBuild(u: Unit, def: UnitDef, cx: number, cz: number, queue = false) {
    this.give(u, { type: 'build', def, cx, cz, x: (cx + def.fw / 2) * CELL, z: (cz + def.fh / 2) * CELL }, queue);
  }
  moveGroup(us: Unit[], x: number, z: number, type: 'move' | 'fight' | 'patrol', queue: boolean) {
    const mob = us.filter(u => u.def.cls !== 'building' && !u.dead);
    const nU = mob.length; if (!nU) return;
    let sp = 0; for (const u of mob) sp = Math.max(sp, u.def.r); sp = sp * 2.5 + 2;
    const cols = Math.ceil(Math.sqrt(nU)), rows = Math.ceil(nU / cols), S = this.map.size;
    mob.forEach((u, i) => {
      let tx = x + ((i % cols) - (cols - 1) / 2) * sp, tz = z + (Math.floor(i / cols) - (rows - 1) / 2) * sp;
      if (u.def.cls === 'ground' && !this.map.passAt(tx, tz)) { tx = x; tz = z; }
      tx = clamp(tx, 10, S - 10); tz = clamp(tz, 10, S - 10);
      this.give(u, { type, x: tx, z: tz, x2: u.x, z2: u.z }, queue);
    });
  }

  // ───────────── helpers ─────────────
  canSee(team: Team, u: Unit) { return u.team.ally === team.ally || (team.vis[this.map.cellOf(u.x, u.z)] & 6) !== 0; }
  visible(team: Team, u: Unit) { return u.team.ally === team.ally || (team.vis[this.map.cellOf(u.x, u.z)] & 2) !== 0; }

  private rebuildGrid() {
    const g = this.grid; for (let i = 0; i < g.length; i++) g[i].length = 0;
    const gw = this.gw;
    for (const u of this.units) {
      if (u.dead) continue;
      const gx = clamp((u.x / GS) | 0, 0, gw - 1), gz = clamp((u.z / GS) | 0, 0, gw - 1);
      g[gz * gw + gx].push(u);
    }
  }
  /** units whose centre lies within r (approx: cell bbox) — result buffer is reused */
  query(x: number, z: number, r: number): Unit[] {
    const out = this.qbuf; out.length = 0; const gw = this.gw;
    const x0 = clamp(((x - r) / GS) | 0, 0, gw - 1), x1 = clamp(((x + r) / GS) | 0, 0, gw - 1);
    const z0 = clamp(((z - r) / GS) | 0, 0, gw - 1), z1 = clamp(((z + r) / GS) | 0, 0, gw - 1);
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const c = this.grid[j * gw + i];
      for (let k = 0; k < c.length; k++) out.push(c[k]);
    }
    return out;
  }
  findEnemy(u: Unit, x: number, z: number, range: number, tg: number, minR: number, lx = 0, lz = 0, lr = 1e9): Unit | null {
    const list = this.query(x, z, range + 16);
    let best: Unit | null = null, bs = 1e9;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.dead || o.team.ally === u.team.ally || o.inFactory || !(tg & bit(o))) continue;
      const d = Math.hypot(o.x - x, o.z - z) - o.def.r;
      if (d > range || d < minR) continue;
      if (lr < 1e8 && Math.hypot(o.x - lx, o.z - lz) > lr) continue;
      if (!this.canSee(u.team, o)) continue;
      const s = d * (o.def.weapons.length ? 1 : 1.7) * (o.built ? 1 : 1.3);
      if (s < bs) { bs = s; best = o; }
    }
    return best;
  }
  setGoal(u: Unit, x: number, z: number, r: number) {
    if (u.goal && Math.abs(u.gx - x) < 1 && Math.abs(u.gz - z) < 1) { u.gr = r; return; }
    u.goal = true; u.gx = x; u.gz = z; u.gr = r; u.path = null; u.pi = 0; u.stuck = 0;
  }
  chase(u: Unit, x: number, z: number, r: number) {
    if (!u.goal || Math.hypot(u.gx - x, u.gz - z) > 16) this.setGoal(u, x, z, r); else u.gr = r;
  }
  stop(u: Unit) { u.goal = false; u.path = null; }
  private shift(u: Unit) {
    u.orders.shift();
    if (!u.orders.length) { u.homeX = u.x; u.homeZ = u.z; this.stop(u); }
  }

  // ───────────── main tick ─────────────
  step() {
    if (this.over) return;
    this.tick++;
    const t = this.tick;
    this.wind = clamp(0.5 + 0.34 * Math.sin(t * 0.004) + 0.16 * Math.sin(t * 0.0131 + 2), 0, 1);
    // economy pass
    for (const tm of this.teams) { tm.pM = tm.pE = tm.uE = tm.sM = tm.sE = 0; }
    for (const u of this.units) {
      if (!u.built || u.dead) continue;
      const tm = u.team, d = u.def;
      tm.sM += d.stM; tm.sE += d.stE;
      tm.pE += d.wind ? d.wind * this.wind : d.mkE;
      tm.pM += d.mkM; tm.uE += d.useE;
      if (d.extract && u.spot) tm.pM += u.spot.rich * d.extract * (tm.lowPower ? 0.3 : 1);
      if (d.conv && !tm.lowPower && tm.energy > tm.stE * 0.55) { tm.uE += d.conv; tm.pM += 1; }
    }
    for (const tm of this.teams) {
      if (tm.dead) continue;
      tm.stM = tm.sM; tm.stE = tm.sE;
      const up = tm.uE * DT;
      tm.energy += tm.pE * tm.mult * DT;
      tm.lowPower = tm.energy < up;
      if (!tm.lowPower) tm.energy -= up;
      tm.metal += tm.pM * tm.mult * DT;
      tm.stats.metal += tm.pM * tm.mult * DT;
      tm.stall = Math.min(1, tm.reqM > 1e-6 ? tm.metal / tm.reqM : 1, tm.reqE > 1e-6 ? tm.energy / tm.reqE : 1);
      tm.incM = lerp(tm.incM, tm.pM * tm.mult, 0.08); tm.incE = lerp(tm.incE, tm.pE * tm.mult, 0.08);
      tm.useM = lerp(tm.useM, tm.spentM / DT, 0.08); tm.useE = lerp(tm.useE, tm.spentE / DT + (tm.lowPower ? 0 : tm.uE), 0.08);
      tm.reqM = tm.reqE = tm.spentM = tm.spentE = 0;
      if (tm.metal > tm.stM) tm.metal = tm.stM;
      if (tm.energy > tm.stE) tm.energy = tm.stE;
    }
    this.rebuildGrid();
    // pathfinding budget
    for (let k = 0; k < 10 && this.pathQ.length; k++) {
      const u = this.pathQ.shift()!; u.pathPending = false;
      if (u.dead || !u.goal) continue;
      u.path = this.map.findPath(u.x, u.z, u.gx, u.gz); u.pi = 0;
      if (!u.path) u.goal = false;
    }
    // blasts queued last tick
    if (this.blasts.length) {
      const bl = this.blasts; this.blasts = [];
      for (const b of bl) {
        const list = this.query(b.x, b.z, b.r + 20).slice();
        for (const o of list) {
          if (o.dead) continue;
          const d = Math.hypot(o.x - b.x, o.z - b.z) - o.def.r * 0.5;
          if (d < b.r) this.damage(o, b.d * (1 - 0.7 * Math.max(0, d) / b.r), null);
        }
      }
    }
    const len = this.units.length;
    for (let i = 0; i < len; i++) { const u = this.units[i]; if (!u.dead) this.updateUnit(u); }
    this.updateProjs();
    if (t % 8 === 0) this.updateVision();
    // defeated teams collapse
    for (const tm of this.teams) {
      if (!tm.dead) continue;
      let k = 0;
      for (const u of this.units) if (u.team === tm && !u.dead) { this.kill(u, null); if (++k >= 2) break; }
    }
    if (this.anyDead) {
      this.units = this.units.filter(u => !u.dead);
      this.wrecks = this.wrecks.filter(w => !w.dead);
      this.anyDead = false;
    }
    const alive = new Set<number>(); for (const tm of this.teams) if (!tm.dead) alive.add(tm.ally);
    if (alive.size <= 1) { this.over = true; this.winner = alive.size ? [...alive][0] : -1; }
  }

  private updateVision() {
    const m = this.map, n = m.n;
    for (const tm of this.teams) { const v = tm.vis; for (let i = 0; i < v.length; i++) v[i] &= 1; }
    const stamp = (v: Uint8Array, x: number, z: number, R: number, bits: number) => {
      const r = R / CELL, cx = x / CELL, cz = z / CELL;
      const z0 = Math.max(0, Math.ceil(cz - r)), z1 = Math.min(n - 1, Math.floor(cz + r));
      for (let j = z0; j <= z1; j++) {
        const dz = j + 0.5 - cz, sp = Math.sqrt(Math.max(0, r * r - dz * dz));
        const x0 = Math.max(0, Math.round(cx - sp)), x1 = Math.min(n - 1, Math.round(cx + sp) - 1);
        const row = j * n;
        for (let i = x0; i <= x1; i++) v[row + i] |= bits;
      }
    };
    for (const u of this.units) {
      if (u.dead || u.inFactory) continue;
      const tm = u.team;
      stamp(tm.vis, u.x, u.z, u.built ? u.def.sight : 30, 3);
      if (u.built && u.def.radar && !tm.lowPower) stamp(tm.vis, u.x, u.z, u.def.radar, 4);
    }
    for (const u of this.units) {
      if (u.def.cls !== 'building') continue;
      const c = m.cellOf(u.x, u.z);
      for (const tm of this.teams) if (tm.vis[c] & 2) u.seen |= 1 << tm.id;
    }
  }

  // ───────────── building / economy actions ─────────────
  applyBuild(builder: Unit, target: Unit, bp: number) {
    const d = target.def, t = builder.team;
    const f = Math.min(bp / d.work * DT, 1 - target.progress);
    builder.nano = target; builder.nanoTick = this.tick;
    if (f > 0) {
      t.reqM += d.m * f; t.reqE += d.e * f;
      let g = f * t.stall;
      const m = d.m * g, e = d.e * g;
      if (m > t.metal + 1e-9 || e > t.energy + 1e-9) g *= Math.max(0, Math.min(m > 0 ? t.metal / m : 1, e > 0 ? t.energy / e : 1));
      t.metal -= d.m * g; t.energy -= d.e * g; t.spentM += d.m * g; t.spentE += d.e * g;
      if (t.metal < 0) t.metal = 0; if (t.energy < 0) t.energy = 0;
      target.progress += g; target.hp = Math.min(d.hp, target.hp + g * d.hp);
    }
    if (target.progress >= 1 - 1e-6 && !target.built) {
      target.progress = 1; target.built = true; target.team.stats.built++;
      target.homeX = target.x; target.homeZ = target.z;
      this.events.push({ t: 'built', x: target.x, y: target.y, z: target.z, u: target });
    }
  }

  private updateFactory(u: Unit) {
    const d = u.def;
    if (u.buildee) {
      const b = u.buildee;
      if (b.dead) { u.buildee = null; return; }
      this.applyBuild(u, b, d.bp);
      if (b.built) {
        u.buildee = null; b.inFactory = false;
        const exitZ = u.z + d.fh * CELL / 2 + b.def.r + 5;
        if (b.def.cls === 'ground') b.ejectZ = exitZ;
        const r = u.rally;
        if (r) b.orders.push({ type: 'move', x: r.x + (this.rng() - 0.5) * 30, z: r.z + (this.rng() - 0.5) * 30 });
        else b.orders.push({ type: 'move', x: u.x + (this.rng() - 0.5) * 50, z: Math.min(this.map.size - 12, exitZ + 22 + this.rng() * 26) });
        const def = u.queue.shift(); if (def && u.repeat) u.queue.push(def);
      }
    } else if (u.queue.length) {
      const b = this.spawn(u.queue[0], u.team, u.x, u.z, false);
      b.inFactory = true; b.heading = b.turret = 0; b.y = b.py = u.y + 1;
      u.buildee = b;
    }
  }

  // ───────────── per-unit update ─────────────
  private updateUnit(u: Unit) {
    u.px = u.x; u.py = u.y; u.pz = u.z; u.ph = u.heading; u.pturret = u.turret;
    if (!u.built) return;
    const d = u.def;
    if (u.ejectZ >= 0) {
      u.z += Math.max(d.speed, 12) * DT; u.heading = turnToward(u.heading, 0, 4 * DT); u.turret = u.heading;
      u.y = Math.max(u.y - 4 * DT, this.map.groundY(u.x, u.z));
      if (u.z >= u.ejectZ) u.ejectZ = -1;
      return;
    }
    if (d.factory) this.updateFactory(u);
    this.updateOrders(u);
    if (d.cls === 'ground') this.moveGround(u); else if (d.cls === 'air') this.moveAir(u);
    if (d.weapons.length) this.updateWeapons(u);
  }

  private engage(u: Unit, lx: number, lz: number, lr: number): boolean {
    const w = u.def.weapons[0]; if (!w) return false;
    let t = u.engageT;
    if (t && (t.dead || t.team.ally === u.team.ally || !(w.tg & bit(t)) || !this.canSee(u.team, t) || Math.hypot(t.x - lx, t.z - lz) > lr + w.range)) t = null;
    if (!t && (this.tick + u.id) % 10 === 0) t = this.findEnemy(u, u.x, u.z, Math.max(u.def.sight, w.range), w.tg, 0, lx, lz, lr);
    u.engageT = t; if (!t) return false;
    if (u.def.cls === 'air' && !u.def.hover) { this.setGoal(u, t.x, t.z, 0); return true; }
    const dd = Math.hypot(t.x - u.x, t.z - u.z) - t.def.r;
    if (dd > w.range * 0.9) this.chase(u, t.x, t.z, w.range * 0.75 + t.def.r);
    else this.stop(u);
    return true;
  }

  private approach(u: Unit, o: Order, x: number, z: number, reach: number): boolean {
    const d = Math.hypot(x - u.x, z - u.z);
    if (d <= reach) { this.stop(u); o.n = 0; return true; }
    if (!u.goal) { o.n = (o.n || 0) + 1; if (o.n > 8) { this.shift(u); return false; } }
    this.chase(u, x, z, reach * 0.8);
    return false;
  }

  private updateOrders(u: Unit) {
    const o = u.orders[0], d = u.def;
    u.forced = null;
    if (!o) {
      if (d.cls === 'building') return;
      if (d.weapons.length && !d.noChase) {
        if (!this.engage(u, u.homeX, u.homeZ, 200)) {
          if (d.cls === 'ground' || d.hover) {
            if (Math.hypot(u.x - u.homeX, u.z - u.homeZ) > 34) this.setGoal(u, u.homeX, u.homeZ, 14);
          } else this.stop(u);
        }
      } else if (d.bp && (this.tick + u.id) % 40 === 0) {
        // idle builders lend a hand nearby
        const list = this.query(u.x, u.z, 110);
        for (const b of list) if (b.team === u.team && !b.dead && !b.built && !b.inFactory && Math.hypot(b.x - u.x, b.z - u.z) < 110) {
          u.orders.push({ type: 'repair', target: b, x: b.x, z: b.z }); break;
        }
      }
      return;
    }
    switch (o.type) {
      case 'move':
        if (!o.s) { o.s = true; this.setGoal(u, o.x, o.z, 5); }
        else if (!u.goal) this.shift(u);
        break;
      case 'fight': case 'patrol':
        if (d.weapons.length && this.engage(u, u.x, u.z, 1e9)) { o.s = false; break; }
        if (!o.s) { o.s = true; this.setGoal(u, o.x, o.z, d.cls === 'air' && !d.hover ? 30 : 12); }
        else if (!u.goal) {
          if (o.type === 'patrol') u.orders.push({ type: 'patrol', x: o.x2!, z: o.z2!, x2: o.x, z2: o.z });
          this.shift(u);
        }
        break;
      case 'attack': {
        const t = o.target;
        if (!t || t.dead || t.team.ally === u.team.ally || !d.weapons.length) { this.shift(u); break; }
        let w: WeaponDef | null = null;
        for (const ww of d.weapons) if (ww.tg & bit(t)) { w = ww; break; }
        if (!w) { this.shift(u); break; }
        u.forced = t;
        if (!this.canSee(u.team, t)) {
          if (!o.s) { o.s = true; this.setGoal(u, o.x, o.z, 12); } else if (!u.goal) this.shift(u);
          break;
        }
        o.s = false; o.x = t.x; o.z = t.z;
        if (d.cls === 'building') break;
        if (d.cls === 'air' && !d.hover) { this.setGoal(u, t.x, t.z, 0); break; }
        const dd = Math.hypot(t.x - u.x, t.z - u.z) - t.def.r;
        if (dd > w.range * 0.92) {
          if (!u.goal) { o.n = (o.n || 0) + 1; if (o.n > 12) { this.shift(u); break; } }
          this.chase(u, t.x, t.z, w.range * 0.8 + t.def.r);
        } else { this.stop(u); o.n = 0; }
        break;
      }
      case 'build': {
        const def = o.def!;
        if (!d.bp) { this.shift(u); break; }
        let t = o.target;
        const reach = d.buildRange + def.r;
        if (!t) {
          if (!this.approach(u, o, o.x, o.z, reach)) break;
          const ex = def.cls === 'building' ? this.occ.get(o.cz! * this.map.n + o.cx!) : undefined;
          if (ex && ex.def === def && ex.team === u.team && !ex.built) { o.target = ex; break; }
          if (!this.canPlace(def, o.cx!, o.cz!, u.team)) { this.shift(u); break; }
          o.target = this.placeBuilding(def, u.team, o.cx!, o.cz!, false);
          break;
        }
        if (t.dead || t.built) { this.shift(u); break; }
        if (!this.approach(u, o, t.x, t.z, reach)) break;
        this.applyBuild(u, t, d.bp);
        break;
      }
      case 'repair': {
        const t = o.target;
        if (!t || t.dead || !d.bp || t.inFactory) { this.shift(u); break; }
        if (t.built && t.hp >= t.def.hp) { this.shift(u); break; }
        if (!this.approach(u, o, t.x, t.z, d.buildRange + t.def.r)) break;
        if (!t.built) this.applyBuild(u, t, d.bp);
        else { t.hp = Math.min(t.def.hp, t.hp + t.def.hp * d.bp / t.def.work * 1.5 * DT); u.nano = t; u.nanoTick = this.tick; }
        break;
      }
      case 'reclaim': {
        const w = o.wreck;
        if (!w || w.dead || !d.bp) { this.shift(u); break; }
        if (!this.approach(u, o, w.x, w.z, d.buildRange + w.r)) break;
        const amt = Math.min(w.metal, d.bp * 0.25 * DT);
        w.metal -= amt; u.team.metal += amt; u.team.stats.metal += amt;
        u.nano = w; u.nanoTick = this.tick;
        if (w.metal <= 0.001) { w.dead = true; this.anyDead = true; }
        break;
      }
      case 'guard': {
        const t = o.target;
        if (!t || t.dead) { this.shift(u); break; }
        if (d.bp) {
          let job: Unit | null = null;
          if (t.def.factory && t.buildee) job = t.buildee;
          else if (t.nanoTick >= this.tick - 2 && t.nano && (t.nano as any).def && !(t.nano as Unit).built && !(t.nano as Unit).dead) job = t.nano as Unit;
          else if (!t.built) job = t;
          if (job) {
            const anchor = job.inFactory ? t : job;
            if (Math.hypot(anchor.x - u.x, anchor.z - u.z) > d.buildRange + anchor.def.r) this.chase(u, anchor.x, anchor.z, (d.buildRange + anchor.def.r) * 0.8);
            else { this.stop(u); this.applyBuild(u, job, d.bp); }
          } else if (t.hp < t.def.hp && Math.hypot(t.x - u.x, t.z - u.z) <= d.buildRange + t.def.r) {
            t.hp = Math.min(t.def.hp, t.hp + t.def.hp * d.bp / t.def.work * 1.5 * DT); u.nano = t; u.nanoTick = this.tick;
          } else if (Math.hypot(t.x - u.x, t.z - u.z) > 34 + t.def.r + d.r) this.chase(u, t.x, t.z, 24 + t.def.r + d.r);
        } else if (d.cls !== 'building') {
          if (!(d.weapons.length && this.engage(u, t.x, t.z, 170))) {
            if (Math.hypot(t.x - u.x, t.z - u.z) > 50 + t.def.r) this.chase(u, t.x, t.z, 34 + t.def.r);
          }
        }
        break;
      }
    }
  }

  private moveGround(u: Unit) {
    const d = u.def, map = this.map, n = map.n;
    const ccx = Math.floor(u.x / CELL), ccz = Math.floor(u.z / CELL);
    if (!map.cellPass(ccx, ccz)) {
      const p = map.nearestPass(ccx, ccz, 8);
      if (p >= 0) {
        const tx = (p % n + 0.5) * CELL, tz = (((p / n) | 0) + 0.5) * CELL, dd = Math.hypot(tx - u.x, tz - u.z) || 1;
        u.x += (tx - u.x) / dd * 26 * DT; u.z += (tz - u.z) / dd * 26 * DT;
      }
      u.y = map.groundY(u.x, u.z); return;
    }
    let sp = 0;
    if (u.goal) {
      const dg = Math.hypot(u.gx - u.x, u.gz - u.z);
      if (dg <= u.gr || (u.stuck >= 1 && dg < 26 + u.gr)) { u.goal = false; u.path = null; }
      else if (!u.path) { if (!u.pathPending) { u.pathPending = true; this.pathQ.push(u); } }
      else {
        const p = u.path; let wx = p[u.pi], wz = p[u.pi + 1];
        const last = u.pi >= p.length - 2;
        if (Math.hypot(wx - u.x, wz - u.z) < (last ? 3 : 7)) {
          if (last) { u.goal = false; u.path = null; } else { u.pi += 2; wx = p[u.pi]; wz = p[u.pi + 1]; }
        }
        if (u.goal) {
          const want = Math.atan2(wx - u.x, wz - u.z);
          u.heading = turnToward(u.heading, want, d.turn * DT);
          const df = Math.abs(angDiff(u.heading, want));
          sp = d.speed * (df < 0.4 ? 1 : df < 1.2 ? 0.45 : 0.08);
        }
      }
    }
    u.speed += clamp(sp - u.speed, -d.speed * 4 * DT, d.speed * 2.5 * DT);
    let nx = u.x + Math.sin(u.heading) * u.speed * DT, nz = u.z + Math.cos(u.heading) * u.speed * DT;
    const list = this.query(nx, nz, d.r + 16);
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === u || o.def.cls !== 'ground' || o.inFactory || o.dead) continue;
      const dx = nx - o.x, dz = nz - o.z, min = d.r + o.def.r, dist = Math.hypot(dx, dz);
      if (dist < min && dist > 0.01) {
        const wgt = !o.built ? 1 : o.def.r / (d.r + o.def.r);
        const k = (min - dist) * wgt * 0.6 / dist;
        nx += dx * k; nz += dz * k;
      } else if (dist <= 0.01) { nx += (this.rng() - 0.5); nz += (this.rng() - 0.5); }
    }
    if (map.passAt(nx, nz)) { u.x = nx; u.z = nz; }
    else if (map.passAt(nx, u.z)) u.x = nx;
    else if (map.passAt(u.x, nz)) u.z = nz;
    u.y = map.heightAt(u.x, u.z);
    if (u.goal && u.path && (this.tick + u.id) % 30 === 0) {
      if (Math.hypot(u.x - u.stuckX, u.z - u.stuckZ) < d.speed * 0.25) {
        u.stuck++;
        if (u.stuck >= 6) { u.goal = false; u.path = null; }
        else if (u.stuck % 2 === 0) u.path = null;
      } else u.stuck = 0;
      u.stuckX = u.x; u.stuckZ = u.z;
    }
  }

  private moveAir(u: Unit) {
    const d = u.def, map = this.map, S = map.size;
    const gy = map.groundY(u.x, u.z) + d.alt;
    u.y += (gy - u.y) * 0.05;
    if (d.hover) {
      let sp = 0;
      if (u.goal) {
        const dg = Math.hypot(u.gx - u.x, u.gz - u.z);
        if (dg <= Math.max(u.gr, 6)) u.goal = false;
        else {
          const want = Math.atan2(u.gx - u.x, u.gz - u.z);
          u.heading = turnToward(u.heading, want, d.turn * DT);
          sp = Math.abs(angDiff(u.heading, want)) < 0.8 ? d.speed * Math.min(1, dg / 30 + 0.25) : d.speed * 0.2;
        }
      } else if (u.wt[0]) {
        const t = u.wt[0]; u.heading = turnToward(u.heading, Math.atan2(t.x - u.x, t.z - u.z), d.turn * DT);
      }
      u.speed += clamp(sp - u.speed, -d.speed * 2 * DT, d.speed * 1.5 * DT);
      let nx = u.x + Math.sin(u.heading) * u.speed * DT, nz = u.z + Math.cos(u.heading) * u.speed * DT;
      const list = this.query(nx, nz, d.r + 12);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === u || !o.def.hover || !o.built || o.dead) continue;
        const dx = nx - o.x, dz = nz - o.z, dist = Math.hypot(dx, dz), min = (d.r + o.def.r) * 1.2;
        if (dist < min && dist > 0.01) { nx += dx / dist * (min - dist) * 0.3; nz += dz / dist * (min - dist) * 0.3; }
      }
      u.x = clamp(nx, 6, S - 6); u.z = clamp(nz, 6, S - 6);
      u.bank = lerp(u.bank, 0, 0.1); u.turret = u.heading;
      return;
    }
    const tx = u.goal ? u.gx : u.homeX, tz = u.goal ? u.gz : u.homeZ;
    const dg = Math.hypot(tx - u.x, tz - u.z);
    let want = Math.atan2(tx - u.x, tz - u.z);
    if (u.goal) {
      if (u.gr > 0 && dg < Math.max(u.gr, 30)) { u.goal = false; u.homeX = u.gx; u.homeZ = u.gz; }
      else if (dg < 45) want = u.heading;
    } else if (dg < 60) want = u.heading + 0.7;
    if (u.x < 16 || u.z < 16 || u.x > S - 16 || u.z > S - 16) want = Math.atan2(S / 2 - u.x, S / 2 - u.z);
    const df = angDiff(u.heading, want);
    u.heading = turnToward(u.heading, want, d.turn * DT);
    u.bank = lerp(u.bank, clamp(df, -1, 1) * 0.8, 0.08);
    u.speed = d.speed;
    u.x += Math.sin(u.heading) * d.speed * DT; u.z += Math.cos(u.heading) * d.speed * DT;
    u.turret = u.heading;
  }

  // ───────────── combat ─────────────
  private inRange(u: Unit, t: Unit, w: WeaponDef) {
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    return d - t.def.r <= w.range && d >= (w.min || 0);
  }
  private updateWeapons(u: Unit) {
    const d = u.def, ws = d.weapons;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (u.cd[i] > 0) u.cd[i] -= DT;
      let t = u.wt[i];
      if (t && (t.dead || t.inFactory || !this.inRange(u, t, w) || !this.canSee(u.team, t))) t = null;
      const f = u.forced;
      if (f && (w.tg & bit(f)) && this.inRange(u, f, w) && this.canSee(u.team, f)) t = f;
      else if (!t && (this.tick + u.id + i * 3) % 6 === 0) t = this.findEnemy(u, u.x, u.z, w.range, w.tg, w.min || 0);
      u.wt[i] = t;
      if (u.burst[i] > 0) {
        u.burstT[i] -= DT;
        if (u.burstT[i] <= 0) { if (t) this.fire(u, w, t); u.burst[i]--; u.burstT[i] = w.gap || 0.1; }
      }
      if (!t) continue;
      let aimed = true;
      const want = Math.atan2(t.x - u.x, t.z - u.z);
      if (i === 0 && !w.free) {
        u.turret = turnToward(u.turret, want, (w.turn || 4) * DT);
        aimed = Math.abs(angDiff(u.turret, want)) < 0.12;
      } else if (i === 0 && d.cls !== 'air') u.turret = turnToward(u.turret, want, 4 * DT);
      if (w.k === 'bomb' && Math.abs(angDiff(u.heading, want)) > 0.5) aimed = false;
      if (aimed && u.cd[i] <= 0 && u.burst[i] <= 0) {
        if (w.eShot) { if (u.team.energy < w.eShot) continue; u.team.energy -= w.eShot; u.team.spentE += w.eShot; }
        u.cd[i] = w.reload * (0.94 + this.rng() * 0.12);
        this.fire(u, w, t);
        if (w.burst && w.burst > 1) { u.burst[i] = w.burst - 1; u.burstT[i] = w.gap || 0.1; }
      }
    }
    if (!u.wt[0] && d.cls === 'ground') u.turret = turnToward(u.turret, u.heading, 2 * DT);
  }

  private fire(u: Unit, w: WeaponDef, t: Unit) {
    const d = u.def;
    const mx = u.x + Math.sin(u.turret) * d.r * 0.7, mz = u.z + Math.cos(u.turret) * d.r * 0.7, my = u.y + d.h * (d.cls === 'air' ? 0 : 0.75);
    const ty = t.y + (t.def.cls === 'air' ? 0 : t.def.h * 0.5);
    const dist = Math.hypot(t.x - u.x, t.z - u.z);
    const mk = (k: number): Proj => ({ k, x: mx, y: my, z: mz, px: mx, py: my, pz: mz, vx: 0, vy: 0, vz: 0, sx: mx, sy: my, sz: mz, tx: t.x, ty, tz: t.z, t: 0, T: 1, arc: 0, target: null, w, team: u.team, dead: false });
    switch (w.k) {
      case 'laser': case 'beam':
        this.events.push({ t: 'beam', x: mx, y: my, z: mz, tx: t.x, ty, tz: t.z, c: w.color, big: w.k === 'beam' });
        this.damage(t, w.dmg, u);
        break;
      case 'cannon': {
        const p = mk(0);
        p.T = Math.max(0.15, dist / w.speed!);
        const lead = t.def.cls === 'building' ? 0 : p.T * 0.85;
        const sp = (w.spread || 0.02) * dist;
        p.tx = t.x + (t.x - t.px) / DT * lead + (this.rng() - 0.5) * 2 * sp;
        p.tz = t.z + (t.z - t.pz) / DT * lead + (this.rng() - 0.5) * 2 * sp;
        p.ty = this.map.groundY(p.tx, p.tz) + 1;
        p.arc = dist * (w.arc || 0.07);
        this.projs.push(p);
        this.events.push({ t: 'muzzle', x: mx, y: my, z: mz, c: w.color, size: w.dmg > 250 ? 2.2 : 1, k: 'cannon' });
        break;
      }
      case 'missile': {
        const p = mk(1); p.target = t;
        const s = w.speed! * 0.5, up = d.cls === 'air' ? -0.1 : 0.9;
        p.vx = Math.sin(u.turret) * s * 0.6 + (this.rng() - 0.5) * 20; p.vz = Math.cos(u.turret) * s * 0.6 + (this.rng() - 0.5) * 20; p.vy = s * up;
        p.T = 7;
        this.projs.push(p);
        this.events.push({ t: 'muzzle', x: mx, y: my, z: mz, c: w.color, size: 0.6, k: 'missile' });
        break;
      }
      case 'bomb': {
        const p = mk(2);
        const fall = Math.sqrt(2 * Math.max(4, u.y - t.y) / 70);
        const ax = t.x + (this.rng() - 0.5) * 30, az = t.z + (this.rng() - 0.5) * 30;
        let vx = (ax - u.x) / fall, vz = (az - u.z) / fall; const v = Math.hypot(vx, vz), mxv = d.speed * 1.4;
        if (v > mxv) { vx *= mxv / v; vz *= mxv / v; }
        p.vx = vx; p.vz = vz; p.vy = 0; p.y = u.y - 1;
        this.projs.push(p);
        break;
      }
    }
  }

  private updateProjs() {
    const ps = this.projs; let dead = false;
    for (const p of ps) {
      p.px = p.x; p.py = p.y; p.pz = p.z; p.t += DT;
      if (p.k === 0) {
        const s = Math.min(1, p.t / p.T);
        p.x = lerp(p.sx, p.tx, s); p.z = lerp(p.sz, p.tz, s); p.y = lerp(p.sy, p.ty, s) + 4 * p.arc * s * (1 - s);
        if (s >= 1) { this.explode(p, p.tx, p.ty, p.tz); p.dead = dead = true; }
      } else if (p.k === 1) {
        const t = p.target;
        if (t && !t.dead) { p.tx = t.x; p.tz = t.z; p.ty = t.y + (t.def.cls === 'air' ? 0 : t.def.h * 0.5); }
        const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z, dd = Math.hypot(dx, dy, dz) || 1;
        const sp = p.w.speed!, k = Math.min(1, 0.06 + p.t * 0.25);
        p.vx = lerp(p.vx, dx / dd * sp, k); p.vy = lerp(p.vy, dy / dd * sp, k); p.vz = lerp(p.vz, dz / dd * sp, k);
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        const hitR = sp * DT + (t && !t.dead ? t.def.r * 0.6 : 2);
        if (dd < hitR || p.t > p.T || p.y < this.map.heightAt(p.x, p.z) - 1) { this.explode(p, p.x, p.y, p.z); p.dead = dead = true; }
      } else {
        p.vy -= 70 * DT;
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        const gy = this.map.groundY(p.x, p.z);
        if (p.y <= gy) { this.explode(p, p.x, gy + 1, p.z); p.dead = dead = true; }
      }
    }
    if (dead) this.projs = ps.filter(p => !p.dead);
  }

  private explode(p: Proj, x: number, y: number, z: number) {
    const w = p.w, sp = w.splash || 0;
    this.events.push({ t: 'boom', x, y, z, size: sp ? sp * 0.5 : 4 + w.dmg * 0.02, c: w.color });
    if (sp > 0) {
      const list = this.query(x, z, sp + 20).slice();
      for (const o of list) {
        if (o.dead || o.team.ally === p.team.ally || o.inFactory) continue;
        if (Math.abs(o.y - y) > sp + o.def.h + 8) continue;
        const d = Math.hypot(o.x - x, o.z - z) - o.def.r;
        if (d < sp) this.damage(o, w.dmg * (d <= 0 ? 1 : 1 - 0.65 * d / sp), null, p.team);
      }
    } else if (p.target && !p.target.dead && Math.hypot(p.target.x - x, p.target.z - z) < p.target.def.r + 14) {
      this.damage(p.target, w.dmg, null, p.team);
    }
  }

  damage(t: Unit, dmg: number, src: Unit | null, by: Team | null = null) {
    if (t.dead) return;
    t.hp -= dmg; t.lastHit = this.tick;
    const tm = t.team;
    if (this.tick - tm.lastAlert > 20) {
      tm.lastAlert = this.tick;
      tm.alerts.push({ x: t.x, z: t.z, tick: this.tick, b: t.def.cls === 'building' || !!t.def.bp });
      if (tm.alerts.length > 24) tm.alerts.shift();
      this.events.push({ t: 'alert', x: t.x, y: t.y, z: t.z, u: t });
    }
    if (t.hp <= 0) this.kill(t, src ? src.team : by);
    else if (src && !t.orders.length && !t.engageT && t.def.weapons.length && t.def.cls !== 'building' && !t.def.noChase) t.engageT = src;
  }

  kill(u: Unit, by: Team | null, silent = false) {
    if (u.dead) return;
    u.dead = true; this.anyDead = true;
    const m = this.map, d = u.def;
    if (d.cls === 'building') {
      for (let j = 0; j < d.fh; j++) for (let i = 0; i < d.fw; i++) m.block[(u.cz + j) * m.n + u.cx + i]--;
      if (this.occ.get(u.cz * m.n + u.cx) === u) this.occ.delete(u.cz * m.n + u.cx);
      if (u.spot && u.spot.taken === u) u.spot.taken = null;
    }
    if (u.buildee && !u.buildee.dead) this.kill(u.buildee, by, true);
    if (silent) return;
    this.events.push({ t: 'die', x: u.x, y: u.y, z: u.z, size: d.r, u });
    if (u.built) {
      u.team.stats.lost++; if (by && by !== u.team) by.stats.kills++;
      if (d.cls !== 'air' && !u.team.dead) this.wrecks.push({ id: this.nextId++, x: u.x, y: m.groundY(u.x, u.z), z: u.z, r: Math.min(d.r, 9), metal: d.m * 0.5, max: d.m * 0.5, dead: false, rot: this.rng() * 6.28 });
      if (d.blast) this.blasts.push({ x: u.x, z: u.z, r: d.blast.r, d: d.blast.d });
    }
    if (u === u.team.prime) { u.team.dead = true; u.team.prime = null; }
  }
}
