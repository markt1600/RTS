// Skirmish AI: economy planner, production manager and squad-based military.
import { CELL, Spot } from './map';
import { DEFS, UnitDef } from './defs';
import { Game, Team, Unit, TICK } from './sim';

interface Params {
  think: number; maxFac: number; maxCons: number; t2At: number; firstAttack: number;
  wave0: number; waveInc: number; waveMax: number; raids: boolean; retreat: boolean; air: boolean;
  defRate: number; heavy: number; expand: number;
}
const LEVELS: Params[] = [
  { think: 60, maxFac: 2, maxCons: 3, t2At: 900, firstAttack: 420, wave0: 900, waveInc: 500, waveMax: 4000, raids: false, retreat: false, air: false, defRate: 0.5, heavy: 0, expand: 1 },
  { think: 30, maxFac: 4, maxCons: 6, t2At: 540, firstAttack: 270, wave0: 800, waveInc: 500, waveMax: 7000, raids: false, retreat: false, air: true, defRate: 1, heavy: 1, expand: 2 },
  { think: 15, maxFac: 6, maxCons: 9, t2At: 380, firstAttack: 200, wave0: 700, waveInc: 450, waveMax: 10000, raids: true, retreat: true, air: true, defRate: 1.3, heavy: 2, expand: 3 },
  { think: 10, maxFac: 8, maxCons: 12, t2At: 300, firstAttack: 150, wave0: 600, waveInc: 400, waveMax: 14000, raids: true, retreat: true, air: true, defRate: 1.6, heavy: 3, expand: 4 },
];
export const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard', 'Brutal'];

interface Squad { units: Unit[]; tx: number; tz: number; start: number; raid: boolean; enemy: Team | null; idleTicks: number }

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

export class AI {
  game: Game; team: Team; P: Params;
  private phase: number; private wave = 0;
  private pool = new Set<Unit>(); private known = new Set<Unit>(); private squads: Squad[] = [];
  private scouts = new Set<Unit>();
  private claimed = new Map<Spot, number>();
  private reserved = new Set<number>();
  private cnt: Record<string, number> = {}; private pend: Record<string, number> = {};
  private builders: Unit[] = []; private factories: Unit[] = []; private frames: Unit[] = [];
  private planes: Unit[] = [];
  private enemyAir = 0; private enemyDef = 0; private lastDefend = -999; private lastRaid = 0; private lastScout = 0;
  private rallyX = 0; private rallyZ = 0; private firstFac: string;
  private rng: () => number;

  constructor(game: Game, team: Team) {
    this.game = game; this.team = team; this.P = LEVELS[team.level];
    this.phase = (team.id * 7) % this.P.think;
    this.rng = game.rng;
    this.firstFac = this.rng() < 0.5 ? 'foundry' : 'works';
    const c = game.map.size / 2, dx = c - team.startX, dz = c - team.startZ, l = Math.hypot(dx, dz) || 1;
    this.rallyX = team.startX + dx / l * 110; this.rallyZ = team.startZ + dz / l * 110;
  }

  private have(id: string) { return (this.cnt[id] || 0) + (this.pend[id] || 0); }
  private secs() { return this.game.tick / TICK; }

  update() {
    const g = this.game, tm = this.team;
    if (tm.dead || g.tick % this.P.think !== this.phase) return;
    this.census();
    for (const b of this.builders) this.manageBuilder(b);
    for (const f of this.factories) if (f.built && !f.queue.length && !f.buildee) this.produce(f);
    this.military();
  }

  private census() {
    const g = this.game, tm = this.team;
    this.cnt = {}; this.pend = {}; this.builders = []; this.factories = []; this.frames = []; this.planes = [];
    let air = 0, def = 0;
    for (const u of g.units) {
      if (u.dead) continue;
      if (u.team !== tm) {
        if (u.team.ally === tm.ally) continue;
        if (u.def.cls === 'air' && g.visible(tm, u)) air++;
        if (u.def.cls === 'building' && u.def.weapons.length && (u.seen >> tm.id) & 1) def++;
        continue;
      }
      this.cnt[u.def.id] = (this.cnt[u.def.id] || 0) + 1;
      if (!u.built) { if (!u.inFactory && u.def.cls === 'building') this.frames.push(u); continue; }
      const d = u.def;
      if (d.factory) this.factories.push(u);
      else if (d.bp) {
        this.builders.push(u);
        for (const o of u.orders) if (o.type === 'build' && !o.target) this.pend[o.def!.id] = (this.pend[o.def!.id] || 0) + 1;
      } else if (d.cls !== 'building' && d.weapons.length || d.id === 'kestrel') {
        if (!this.known.has(u)) {
          this.known.add(u);
          if (d.cls === 'air' && !d.hover) { /* planes managed separately */ }
          else { this.pool.add(u); g.give(u, { type: 'fight', x: this.rallyX + (this.rng() - 0.5) * 60, z: this.rallyZ + (this.rng() - 0.5) * 60 }); }
        }
        if (d.cls === 'air' && !d.hover) this.planes.push(u);
      }
    }
    this.enemyAir = Math.max(this.enemyAir * 0.995, air); this.enemyDef = def;
    for (const u of this.pool) if (u.dead) this.pool.delete(u);
    for (const u of this.known) if (u.dead) this.known.delete(u);
    for (const u of this.scouts) if (u.dead) this.scouts.delete(u);
  }

  // ─────────────── economy ───────────────
  private siteOk(def: UnitDef, cx: number, cz: number, margin: number): boolean {
    const g = this.game, m = g.map, n = m.n;
    if (!g.canPlace(def, cx, cz, this.team)) return false;
    for (let j = -margin; j < def.fh + margin; j++) for (let i = -margin; i < def.fw + margin; i++) {
      const x = cx + i, z = cz + j;
      if (!m.inCells(x, z)) return false;
      const idx = z * n + x;
      if (m.block[idx] || this.reserved.has(idx)) return false;
      if (i >= 0 && j >= 0 && i < def.fw && j < def.fh && m.region[idx] !== m.mainRegion) return false;
    }
    for (const s of m.spots) if (s.cx >= cx - 1 && s.cx <= cx + def.fw + 1 && s.cz >= cz - 1 && s.cz <= cz + def.fh + 1) return false;
    return true;
  }
  private findSite(def: UnitDef, ox: number, oz: number, r0: number, r1: number): { cx: number; cz: number } | null {
    const a0 = this.rng() * 6.283;
    for (let r = r0; r <= r1; r++) {
      const steps = Math.max(8, Math.floor(r * 5));
      for (let k = 0; k < steps; k++) {
        const a = a0 + k / steps * 6.283;
        const cx = Math.round(ox / CELL + Math.cos(a) * r - def.fw / 2), cz = Math.round(oz / CELL + Math.sin(a) * r - def.fh / 2);
        if (this.siteOk(def, cx, cz, 1)) return { cx, cz };
      }
    }
    return null;
  }
  private tryBuild(b: Unit, id: string, ox?: number, oz?: number, r0 = 3, r1 = 26): boolean {
    if (!b.def.builds.includes(id)) return false;
    const def = DEFS[id], tm = this.team;
    const s = this.findSite(def, ox ?? tm.startX, oz ?? tm.startZ, r0, r1);
    if (!s) return false;
    if (def.factory) {
      const n = this.game.map.n;
      for (let j = def.fh; j < def.fh + 5; j++) for (let i = 0; i < def.fw; i++) this.reserved.add((s.cz + j) * n + s.cx + i);
    }
    this.game.giveBuild(b, def, s.cx, s.cz);
    this.pend[id] = (this.pend[id] || 0) + 1;
    return true;
  }
  private tryMex(b: Unit, maxD: number): boolean {
    const g = this.game, tm = this.team, t = g.tick;
    let best: Spot | null = null, bs = 1e9, up = false;
    const t2 = b.def.builds.includes('deepext');
    for (const s of g.map.spots) {
      const cl = this.claimed.get(s);
      if (cl && t - cl < 45 * TICK) continue;
      let upgrade = false;
      if (s.taken) {
        const o = s.taken as Unit;
        if (t2 && o.team === tm && o.def.id === 'extractor' && o.built && tm.incE > 150) upgrade = true; else continue;
      }
      const db = dist(b.x, b.z, s.x, s.z), dh = dist(tm.startX, tm.startZ, s.x, s.z);
      if (dh > maxD) continue;
      // avoid spots next to known enemy positions
      let danger = false;
      for (const e of g.teams) if (e.ally !== tm.ally && !e.dead && dist(e.startX, e.startZ, s.x, s.z) < 190) danger = true;
      if (danger) continue;
      const sc = db + dh * 0.6 + (upgrade ? 150 : 0);
      if (sc < bs) { bs = sc; best = s; up = upgrade; }
    }
    if (!best) return false;
    const id = up ? 'deepext' : b.def.builds.includes('extractor') ? 'extractor' : 'deepext';
    this.claimed.set(best, t);
    g.giveBuild(b, DEFS[id], best.cx - 1, best.cz - 1);
    this.pend[id] = (this.pend[id] || 0) + 1;
    return true;
  }
  private tryEnergy(b: Unit): boolean {
    const tm = this.team;
    if (b.def.builds.includes('fusion') && tm.incM > 8 && this.have('fusion') < 1 + Math.floor(tm.incM / 14) && (this.pend.fusion || 0) < 1) {
      if (this.tryBuild(b, 'fusion', undefined, undefined, 6, 30)) return true;
    }
    if ((this.pend.solar || 0) + (this.pend.wind || 0) >= 3) return false;
    return this.tryBuild(b, this.rng() < 0.3 ? 'wind' : 'solar') || this.tryBuild(b, 'solar');
  }

  private manageBuilder(b: Unit) {
    const g = this.game, tm = this.team, P = this.P;
    const o0 = b.orders[0];
    if (o0 && !(o0.type === 'guard' && (g.tick + b.id * 13) % (TICK * 6) < P.think)) return;
    const prime = b.def.commander;
    const reach = prime ? 330 : 240 + P.expand * 330 + this.secs() * 0.8;
    const secs = this.secs();
    // prime self-preservation
    if (prime && b.hp < b.def.hp * 0.5 && dist(b.x, b.z, tm.startX, tm.startZ) > 120) { g.give(b, { type: 'move', x: tm.startX, z: tm.startZ }); return; }
    // orphaned frames
    for (const f of this.frames) {
      if (dist(b.x, b.z, f.x, f.z) < (prime ? 200 : 500) && !this.builders.some(o => o !== b && o.orders[0] && o.orders[0].target === f)) {
        g.give(b, { type: 'repair', target: f, x: f.x, z: f.z }); return;
      }
    }
    const mex = this.have('extractor') + this.have('deepext');
    const pendE = (this.pend.solar || 0) * 20 + (this.pend.wind || 0) * 12 + (this.pend.fusion || 0) * 600;
    const eProj = tm.incE + pendE;
    const nFac = this.have('foundry') + this.have('works') + this.have('aerodrome') + this.have('advforge');
    const pendMex = (this.pend.extractor || 0) + (this.pend.deepext || 0);
    const eNeed = 45 + nFac * 65 + this.builders.length * 12;
    const eLow = eProj < eNeed || eProj < tm.useE * 1.15 + 15 || (tm.energy < tm.stE * 0.15 && tm.incE < tm.useE + pendE);

    if (mex < 2 && this.tryMex(b, reach)) return;
    if (eProj < 45 && this.tryEnergy(b)) return;
    if (nFac === 0 && this.tryBuild(b, this.firstFac, undefined, undefined, 6, 24)) return;
    if (mex < 4 && pendMex < 2 && this.tryMex(b, reach)) return;
    if (eLow && this.tryEnergy(b)) return;
    if (pendMex < 1 + P.expand && tm.metal < tm.stM * 0.9 && this.tryMex(b, reach)) return;

    const t2 = b.def.builds.includes('fusion');
    if (t2) {
      if (tm.incM > 14 && tm.incE > 500 && this.have('sunlance') < P.heavy && this.tryBuild(b, 'sunlance', this.rallyX, this.rallyZ, 1, 14)) return;
      if (P.heavy >= 2 && tm.incM > 20 && tm.incE > 900 && this.have('thunderhead') < P.heavy - 1 && this.tryBuild(b, 'thunderhead', undefined, undefined, 5, 26)) return;
      if (P.heavy >= 2 && tm.incM > 24 && tm.incE > 1100 && this.have('colossus') < 1 + (P.heavy - 2) && this.tryBuild(b, 'colossus', this.rallyX, this.rallyZ, 2, 14)) return;
      if (tm.incE < 2400 && tm.energy < tm.stE * 0.6 && this.tryEnergy(b)) return;
    }
    // factories
    const floatM = tm.metal > Math.min(700, tm.stM * 0.7);
    if (nFac < P.maxFac && !(this.pend.foundry || this.pend.works || this.pend.aerodrome || this.pend.advforge) && (tm.incM > 3 + nFac * 5 || floatM) && tm.incE > 40 + nFac * 55) {
      let id = '';
      if (!this.have('foundry')) id = 'foundry';
      else if (!this.have('works')) id = 'works';
      else if (!this.have('advforge') && secs > P.t2At && tm.incM > 9 && tm.incE > 220) id = 'advforge';
      else if (P.air && !this.have('aerodrome') && secs > 240) id = 'aerodrome';
      else if (this.have('advforge') && this.have('advforge') < 2 && tm.incM > 22) id = 'advforge';
      else if (floatM) id = this.rng() < 0.5 ? 'foundry' : 'works';
      if (id && this.tryBuild(b, id, undefined, undefined, 6, 30)) return;
    }
    // defences
    const nDef = this.have('sentry') + this.have('bastion') * 2 + this.have('flak');
    const wantDef = Math.floor((secs / 150) * P.defRate) + (tm.alerts.length ? 1 : 0);
    if (nDef < Math.min(wantDef, 14) && tm.incM > 5 && !(this.pend.sentry || this.pend.bastion || this.pend.flak)) {
      let id = this.enemyAir >= 1 && this.have('flak') < 1 + this.enemyAir / 3 ? 'flak' : this.have('sentry') >= 3 && secs > 420 && this.rng() < 0.5 ? 'bastion' : 'sentry';
      if (!b.def.builds.includes(id)) id = 'sentry';
      const a = this.rng() * 6.283, r = 30 + this.rng() * 90;
      const ox = this.rng() < 0.6 ? this.rallyX + Math.cos(a) * r : tm.startX + Math.cos(a) * (r + 60);
      const oz = this.rng() < 0.6 ? this.rallyZ + Math.sin(a) * r : tm.startZ + Math.sin(a) * (r + 60);
      if (this.tryBuild(b, id, ox, oz, 0, 8)) return;
    }
    if (!this.have('radar') && secs > 200 && this.tryBuild(b, 'radar')) return;
    if (tm.metal > tm.stM * 0.92 && this.have('mstore') < 2 && !this.pend.mstore && this.tryBuild(b, 'mstore')) return;
    if (tm.energy > tm.stE * 0.92 && tm.incE > tm.useE + 30) {
      if (this.have('estore') < 1 + Math.floor(tm.incE / 400) && !this.pend.estore && this.tryBuild(b, 'estore')) return;
      if (tm.incE - tm.useE > 100 && this.have('converter') < 12 && !this.pend.converter && this.tryBuild(b, 'converter')) return;
    }
    if (o0) return; // already guarding
    // nothing urgent: assist production
    if (!prime || secs > 60) {
      let best: Unit | null = null, bd = 1e9;
      for (const f of this.factories) {
        const d = dist(b.x, b.z, f.x, f.z) - (f.def.tier > 1 ? 200 : 0);
        if (d < bd && (!prime || d < 220)) { bd = d; best = f; }
      }
      if (best) g.give(b, { type: 'guard', target: best, x: best.x, z: best.z });
    }
  }

  // ─────────────── production ───────────────
  private produce(f: Unit) {
    const tm = this.team, P = this.P, secs = this.secs();
    const cons = this.have('wright') + this.have('hauler') + this.have('archwright');
    const pick = (opts: [string, number][]) => {
      let tot = 0; for (const o of opts) tot += Math.max(0, o[1]);
      let r = this.rng() * tot;
      for (const o of opts) { r -= Math.max(0, o[1]); if (r <= 0) return o[0]; }
      return opts[0][0];
    };
    let id = '';
    const wantCons = Math.min(P.maxCons, 1 + this.factories.length + Math.floor(secs / 200));
    const army = this.pool.size + this.squads.reduce((a, s) => a + s.units.length, 0);
    switch (f.def.id) {
      case 'foundry':
        if (cons < wantCons && (cons < 2 || army > cons * 2)) id = 'wright';
        else id = pick([['jackal', secs < 300 ? 4 : 1.5], ['brawler', 3.5], ['lancer', 2 + this.enemyDef * 0.3], ['skewer', this.enemyAir > 0 ? 1 + this.enemyAir * 0.6 : 0.15]]);
        break;
      case 'works':
        if (cons < wantCons && (cons < 2 || army > cons * 2)) id = 'hauler';
        else id = pick([['dart', this.have('dart') < 2 ? 1.5 : 0.1], ['maul', 4.5], ['howl', 1.2 + this.enemyDef * 0.5]]);
        break;
      case 'aerodrome':
        id = pick([['kestrel', this.have('kestrel') < 1 ? 1.5 : 0], ['talon', 1.2 + this.enemyAir * 0.5], ['anvil', 2.2], ['vulture', secs > 600 ? 2 : 0.3]]);
        break;
      case 'advforge':
        if (this.have('archwright') < Math.min(3, 1 + Math.floor(tm.incM / 12))) id = 'archwright';
        else id = pick([['reaver', 3], ['goliath', 3], ['tempest', 1.2 + this.enemyDef * 0.3]]);
        break;
    }
    if (id) f.queue.push(DEFS[id]);
    if (!f.rally) f.rally = { x: this.rallyX, z: this.rallyZ };
  }

  // ─────────────── military ───────────────
  private pickEnemy(x: number, z: number): Team | null {
    let best: Team | null = null, bd = 1e9;
    for (const e of this.game.teams) {
      if (e.dead || e.ally === this.team.ally) continue;
      let d = dist(x, z, e.startX, e.startZ);
      if (!e.ai && this.team.level === 3) d *= 0.7;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  private pickTarget(x: number, z: number, enemy: Team | null, want?: (u: Unit) => number): { x: number; z: number; u: Unit | null } | null {
    const g = this.game, tm = this.team;
    if (!enemy || enemy.dead) enemy = this.pickEnemy(x, z);
    if (!enemy) return null;
    let best: Unit | null = null, bs = 1e9;
    for (const u of g.units) {
      if (u.dead || u.team.ally === tm.ally) continue;
      const seen = u.def.cls === 'building' ? (u.seen >> tm.id) & 1 : g.visible(tm, u) && u.def.cls !== 'air';
      if (!seen) continue;
      let s = dist(x, z, u.x, u.z) * (u.team === enemy ? 1 : 1.6);
      if (want) { const w = want(u); if (w <= 0) continue; s /= w; }
      if (s < bs) { bs = s; best = u; }
    }
    if (best) return { x: best.x, z: best.z, u: best };
    if (want) return null;
    if (enemy.prime && !(tm.vis[g.map.cellOf(enemy.startX, enemy.startZ)] & 2)) return { x: enemy.startX, z: enemy.startZ, u: null };
    const sp = g.map.spots[Math.floor(this.rng() * g.map.spots.length)];
    return { x: sp.x, z: sp.z, u: null };
  }
  private str(us: Iterable<Unit>) { let s = 0; for (const u of us) s += u.def.m; return s; }

  private military() {
    const g = this.game, tm = this.team, P = this.P, secs = this.secs(), t = g.tick;
    // defend
    const al = tm.alerts[tm.alerts.length - 1];
    if (al && t - al.tick < 4 * TICK && t - this.lastDefend > 4 * TICK && (al.b || dist(al.x, al.z, tm.startX, tm.startZ) < 380)) {
      this.lastDefend = t;
      const ds: Unit[] = [];
      for (const u of this.pool) if (!this.scouts.has(u) && dist(u.x, u.z, al.x, al.z) < 700) ds.push(u);
      if (ds.length) g.moveGroup(ds, al.x, al.z, 'fight', false);
      for (const p of this.planes) if (p.def.id === 'talon' && dist(p.x, p.z, al.x, al.z) < 800) g.give(p, { type: 'fight', x: al.x, z: al.z });
    }
    // scouting
    if (t - this.lastScout > 50 * TICK) {
      this.lastScout = t;
      let sc: Unit | null = null;
      for (const u of this.scouts) { sc = u; break; }
      if (!sc) for (const u of this.pool) if (u.def.id === 'dart') { sc = u; this.pool.delete(u); this.scouts.add(u); break; }
      if (!sc) for (const u of this.planes) if (u.def.id === 'kestrel') { sc = u; this.scouts.add(u); break; }
      if (sc && !sc.orders.length) {
        const pts: { x: number; z: number }[] = [];
        for (const e of g.teams) if (!e.dead && e.ally !== tm.ally) pts.push({ x: e.startX, z: e.startZ });
        for (let i = 0; i < 4; i++) pts.push(g.map.spots[Math.floor(this.rng() * g.map.spots.length)]);
        pts.sort(() => this.rng() - 0.5);
        pts.forEach((p, i) => g.give(sc!, { type: 'move', x: p.x, z: p.z }, i > 0));
      }
    }
    // raids
    if (P.raids && secs > 150 && t - this.lastRaid > 70 * TICK) {
      const fast: Unit[] = [];
      for (const u of this.pool) if (u.def.speed >= 20 && u.def.cls === 'ground' && fast.length < 6) fast.push(u);
      if (fast.length >= 3) {
        const en = this.pickEnemy(tm.startX, tm.startZ);
        const tg = this.pickTarget(fast[0].x, fast[0].z, en, u => (u.def.extract ? 3 : u.def.mkE ? 1.5 : 0) * (en ? Math.min(3, dist(u.x, u.z, en.startX, en.startZ) / 150) : 1));
        let tx = 0, tz = 0, ok = false;
        if (tg) { tx = tg.x; tz = tg.z; ok = true; }
        else if (en) {
          const c = g.map.spots.filter(s => { const d = dist(s.x, s.z, en.startX, en.startZ); return d > 170 && d < 480; });
          if (c.length) { const s = c[Math.floor(this.rng() * c.length)]; tx = s.x; tz = s.z; ok = true; }
        }
        if (ok) {
          this.lastRaid = t;
          for (const u of fast) this.pool.delete(u);
          this.squads.push({ units: fast, tx, tz, start: this.str(fast), raid: true, enemy: en, idleTicks: 0 });
          g.moveGroup(fast, tx, tz, 'fight', false);
        }
      }
    }
    // main waves
    const poolU: Unit[] = []; for (const u of this.pool) if (!this.scouts.has(u)) poolU.push(u);
    const ps = this.str(poolU);
    const need = Math.min(P.waveMax, P.wave0 + P.waveInc * this.wave);
    if (secs > P.firstAttack && poolU.length >= 3 && (ps >= need || poolU.length > 60)) {
      let cx = 0, cz = 0; for (const u of poolU) { cx += u.x; cz += u.z; } cx /= poolU.length; cz /= poolU.length;
      const en = this.pickEnemy(tm.startX, tm.startZ);
      const tg = this.pickTarget(cx, cz, en);
      if (tg) {
        this.wave++;
        for (const u of poolU) this.pool.delete(u);
        this.squads.push({ units: poolU, tx: tg.x, tz: tg.z, start: ps, raid: false, enemy: en, idleTicks: 0 });
        g.moveGroup(poolU, tg.x, tg.z, 'fight', false);
      }
    }
    // squad upkeep
    for (let i = this.squads.length - 1; i >= 0; i--) {
      const s = this.squads[i];
      s.units = s.units.filter(u => !u.dead);
      if (!s.units.length) { this.squads.splice(i, 1); continue; }
      const cur = this.str(s.units);
      if (P.retreat && cur < s.start * (s.raid ? 0.4 : 0.28) && !s.raid) {
        g.moveGroup(s.units, this.rallyX, this.rallyZ, 'move', false);
        for (const u of s.units) this.pool.add(u);
        this.squads.splice(i, 1); continue;
      }
      let cx = 0, cz = 0, idle = 0;
      for (const u of s.units) { cx += u.x; cz += u.z; if (!u.orders.length) idle++; }
      cx /= s.units.length; cz /= s.units.length;
      if (idle >= s.units.length * 0.6) {
        const tg = this.pickTarget(cx, cz, s.enemy);
        if (tg) { s.tx = tg.x; s.tz = tg.z; g.moveGroup(s.units, tg.x, tg.z, 'fight', false); }
      } else if (idle) {
        for (const u of s.units) if (!u.orders.length) g.give(u, { type: 'fight', x: s.tx + (this.rng() - 0.5) * 40, z: s.tz + (this.rng() - 0.5) * 40 });
      }
    }
    // air wing
    if (this.planes.length) {
      const bombers: Unit[] = [];
      for (const p of this.planes) {
        if (p.orders.length || this.scouts.has(p)) continue;
        if (p.def.id === 'talon') {
          const a = this.rng() * 6.283;
          g.give(p, { type: 'patrol', x: tm.startX + Math.cos(a) * 170, z: tm.startZ + Math.sin(a) * 170, x2: tm.startX - Math.cos(a) * 170, z2: tm.startZ - Math.sin(a) * 170 });
        } else if (p.def.id === 'anvil' && dist(p.x, p.z, tm.startX, tm.startZ) < 260) bombers.push(p);
      }
      if (bombers.length >= (tm.level >= 2 ? 3 : 4)) {
        const val = (u: Unit) => u.def.cls !== 'building' ? (u.def.commander && tm.level >= 3 ? 2 : 0) : u.def.id === 'fusion' ? 6 : u.def.id === 'flak' ? 0.3 : u.def.mkE || u.def.wind ? 3 : u.def.extract ? 2.5 : u.def.factory ? 2 : 1;
        const tg = this.pickTarget(tm.startX, tm.startZ, null, val);
        if (tg && tg.u) for (const b of bombers) {
          g.give(b, { type: 'attack', target: tg.u, x: tg.x, z: tg.z });
          g.give(b, { type: 'fight', x: tg.x + (this.rng() - 0.5) * 80, z: tg.z + (this.rng() - 0.5) * 80 }, true);
          g.give(b, { type: 'move', x: tm.startX, z: tm.startZ }, true);
        }
      }
    }
  }
}
