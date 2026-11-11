import { clamp, fbm, lerp, mulberry32, smooth, vnoise } from './util';

export const CELL = 8; // world units per pathing / building cell
export const VS = 4;   // heightmap vertex spacing

export interface Spot { id: number; x: number; z: number; cx: number; cz: number; rich: number; taken: any }

export interface Biome {
  name: string; water: number; lava: boolean;
  low: number; mid: number; high: number; rock: number; shore: number;
  waterCol: number; sky: number; sun: number; fogCol: number;
}
export const BIOMES: Biome[] = [
  { name: 'Temperate', water: 0.27, lava: false, low: 0x4c7a36, mid: 0x71903f, high: 0x9a9a7c, rock: 0x6d675e, shore: 0xbfae7c, waterCol: 0x1d5f8c, sky: 0x9fc6e6, sun: 0xfff2dd, fogCol: 0x06090d },
  { name: 'Desert', water: -1, lava: false, low: 0xc29a5e, mid: 0xd2b077, high: 0xe4cc9c, rock: 0x94694a, shore: 0xc29a5e, waterCol: 0x2a7a8c, sky: 0xe9d2a4, sun: 0xffe6b8, fogCol: 0x0c0906 },
  { name: 'Arctic', water: 0.22, lava: false, low: 0xcfdde6, mid: 0xe6eef2, high: 0xffffff, rock: 0x77828c, shore: 0x9db4c2, waterCol: 0x245a7c, sky: 0xcbdde8, sun: 0xeaf4ff, fogCol: 0x070a0d },
  { name: 'Volcanic', water: 0.2, lava: true, low: 0x3b3537, mid: 0x4d4446, high: 0x675b56, rock: 0x231e1f, shore: 0x6e2c12, waterCol: 0xff5a10, sky: 0x36211e, sun: 0xffc9a0, fogCol: 0x050303 },
];

const AMP = 64;

export class GameMap {
  n: number; size: number; hn: number;
  heights!: Float32Array;
  pass!: Uint8Array; block: Uint8Array; region!: Int32Array;
  waterY = -100;
  spots: Spot[] = [];
  starts: { x: number; z: number }[] = [];
  biome: Biome; seed: number;
  mainRegion = 0;
  // A* scratch
  private g: Float32Array; private par: Int32Array; private mark: Uint32Array; private closed: Uint32Array; private sid = 0;
  private hN: number[] = []; private hF: number[] = [];

  constructor(n: number, seed: number, biomeIdx: number) {
    this.n = n; this.size = n * CELL; this.hn = n * 2 + 1;
    this.biome = BIOMES[biomeIdx]; this.seed = seed;
    this.block = new Uint8Array(n * n);
    this.g = new Float32Array(n * n); this.par = new Int32Array(n * n);
    this.mark = new Uint32Array(n * n); this.closed = new Uint32Array(n * n);
    for (let attempt = 0; attempt < 24; attempt++) {
      if (this.generate(seed + attempt * 7919, attempt)) break;
    }
  }

  private generate(seed: number, attempt: number): boolean {
    const { n, hn, size } = this; const c = size / 2;
    const raw = new Float32Array(hn * hn), kk = new Float32Array(hn * hn);
    const F = 1 / 250, F2 = 1 / 330;
    let mn = 1e9, mx = -1e9;
    for (let j = 0; j < hn; j++) for (let i = 0; i < hn; i++) {
      let x = i * VS - c, z = j * VS - c, v = 0, k = 0;
      for (let r = 0; r < 4; r++) {
        v += fbm(x * F + 311.7, z * F + 127.3, seed, 5);
        k += vnoise(x * F2 + 57.1, z * F2 + 91.9, seed + 999);
        const t = x; x = -z; z = t;
      }
      v /= 4; k /= 4;
      raw[j * hn + i] = v; kk[j * hn + i] = k;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const H = new Float32Array(hn * hn);
    const L = 4, terrMax = Math.max(0.2, 0.95 - attempt * 0.05);
    for (let i = 0; i < hn * hn; i++) {
      const t = (raw[i] - mn) / (mx - mn);
      const tl = t * L, fl = Math.floor(tl), fr = tl - fl;
      const terr = (fl + smooth(0.3, 0.7, fr)) / L;
      const k = clamp((kk[i] - 0.42) * 6, 0, 1);
      H[i] = lerp(t, terr, 0.3 + (terrMax - 0.3) * k) * AMP;
    }
    this.waterY = this.biome.water < 0 ? -100 : this.biome.water * AMP;
    // start positions (4-fold rotational symmetry)
    const sc = Math.round(n * 0.17);
    const startCells: number[][] = [[sc, sc]];
    for (let r = 0; r < 3; r++) { const [a, b] = startCells[r]; startCells.push([n - b, a]); }
    const hAt = (x: number, z: number) => H[clamp(Math.round(z / VS), 0, hn - 1) * hn + clamp(Math.round(x / VS), 0, hn - 1)];
    const plate = Math.max(hAt(sc * CELL, sc * CELL), this.waterY + 8);
    for (const [a, b] of startCells) {
      const sx = a * CELL, sz = b * CELL, R = 150;
      const i0 = Math.max(0, Math.floor((sx - R) / VS)), i1 = Math.min(hn - 1, Math.ceil((sx + R) / VS));
      const j0 = Math.max(0, Math.floor((sz - R) / VS)), j1 = Math.min(hn - 1, Math.ceil((sz + R) / VS));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * VS - sx, j * VS - sz);
        const w = 1 - smooth(85, R, d);
        if (w > 0) H[j * hn + i] = lerp(H[j * hn + i], plate, w);
      }
    }
    this.heights = H;
    // passability
    const pass = new Uint8Array(n * n);
    let land = 0;
    for (let cz = 1; cz < n - 1; cz++) for (let cx = 1; cx < n - 1; cx++) {
      let lo = 1e9, hi = -1e9;
      for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) {
        const h = H[(cz * 2 + j) * hn + cx * 2 + i];
        if (h < lo) lo = h; if (h > hi) hi = h;
      }
      if (hi - lo < 5.2 && lo > this.waterY + 0.6) { pass[cz * n + cx] = 1; land++; }
    }
    this.pass = pass;
    // regions
    const region = new Int32Array(n * n).fill(-1);
    const stack: number[] = [];
    let rid = 0; const sizes: number[] = [];
    for (let s = 0; s < n * n; s++) {
      if (!pass[s] || region[s] >= 0) continue;
      let cnt = 0; stack.push(s); region[s] = rid;
      while (stack.length) {
        const p = stack.pop()!; cnt++;
        const px = p % n;
        if (px > 0 && pass[p - 1] && region[p - 1] < 0) { region[p - 1] = rid; stack.push(p - 1); }
        if (px < n - 1 && pass[p + 1] && region[p + 1] < 0) { region[p + 1] = rid; stack.push(p + 1); }
        if (p >= n && pass[p - n] && region[p - n] < 0) { region[p - n] = rid; stack.push(p - n); }
        if (p < n * n - n && pass[p + n] && region[p + n] < 0) { region[p + n] = rid; stack.push(p + n); }
      }
      sizes.push(cnt); rid++;
    }
    this.region = region;
    const r0 = region[startCells[0][1] * n + startCells[0][0]];
    if (r0 < 0) return false;
    for (const [a, b] of startCells) if (region[b * n + a] !== r0) return false;
    if (sizes[r0] < n * n * 0.45) return false;
    this.mainRegion = r0;
    this.starts = startCells.map(([a, b]) => ({ x: a * CELL, z: b * CELL }));
    this.placeSpots(seed, startCells[0]);
    return this.spots.length >= 24;
  }

  private placeSpots(seed: number, s0: number[]) {
    const n = this.n, rng = mulberry32(seed ^ 0x5bd1e995);
    this.spots = [];
    const ok = (cx: number, cz: number) => {
      for (let j = -2; j <= 1; j++) for (let i = -2; i <= 1; i++) {
        const x = cx + i, z = cz + j;
        if (x < 2 || z < 2 || x >= n - 2 || z >= n - 2) return false;
        if (!this.pass[z * n + x] || this.region[z * n + x] !== this.mainRegion) return false;
      }
      return true;
    };
    const far = (cx: number, cz: number, min: number) => this.spots.every(s => Math.hypot(s.cx - cx, s.cz - cz) >= min);
    const addOrbit = (cx: number, cz: number, rich: number, min: number) => {
      const o: number[][] = [[cx, cz]];
      for (let r = 0; r < 3; r++) { const [a, b] = o[r]; o.push([n - b, a]); }
      for (const [a, b] of o) if (!ok(a, b) || !far(a, b, min)) return false;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.hypot(o[i][0] - o[j][0], o[i][1] - o[j][1]) < min) return false;
      for (const [a, b] of o) this.spots.push({ id: this.spots.length, cx: a, cz: b, x: a * CELL, z: b * CELL, rich, taken: null });
      return true;
    };
    // near-start spots
    let placed = 0;
    for (let t = 0; t < 200 && placed < 3; t++) {
      const a = rng() * Math.PI * 2, d = 7 + rng() * 5;
      if (addOrbit(Math.round(s0[0] + Math.cos(a) * d), Math.round(s0[1] + Math.sin(a) * d), 2, 6)) placed++;
    }
    // second ring
    placed = 0;
    for (let t = 0; t < 300 && placed < 3; t++) {
      const a = rng() * Math.PI * 2, d = 17 + rng() * 9;
      if (addOrbit(Math.round(s0[0] + Math.cos(a) * d), Math.round(s0[1] + Math.sin(a) * d), 2, 9)) placed++;
    }
    // scattered across the quadrant
    const want = Math.round(n / 22);
    placed = 0;
    for (let t = 0; t < 600 && placed < want; t++) {
      const cx = Math.round(4 + rng() * (n / 2 - 4)), cz = Math.round(4 + rng() * (n / 2 - 4));
      if (Math.hypot(cx - s0[0], cz - s0[1]) < 28) continue;
      if (addOrbit(cx, cz, 2.2, 13)) placed++;
    }
    // rich centre
    for (let t = 0; t < 200; t++) {
      const a = rng() * Math.PI * 2, d = 5 + rng() * 8;
      if (addOrbit(Math.round(n / 2 + Math.cos(a) * d), Math.round(n / 2 + Math.sin(a) * d), 3.2, 8)) break;
    }
  }

  heightAt(x: number, z: number) {
    const hn = this.hn;
    const fx = clamp(x / VS, 0, hn - 1.001), fz = clamp(z / VS, 0, hn - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const H = this.heights, i = iz * hn + ix;
    return (H[i] * (1 - tx) + H[i + 1] * tx) * (1 - tz) + (H[i + hn] * (1 - tx) + H[i + hn + 1] * tx) * tz;
  }
  groundY(x: number, z: number) { return Math.max(this.heightAt(x, z), this.waterY); }
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }) {
    const d = 3;
    const dx = this.heightAt(x + d, z) - this.heightAt(x - d, z), dz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    const l = Math.hypot(dx, 2 * d, dz);
    out.x = -dx / l; out.y = 2 * d / l; out.z = -dz / l;
  }
  inCells(cx: number, cz: number) { return cx >= 0 && cz >= 0 && cx < this.n && cz < this.n; }
  cellPass(cx: number, cz: number) {
    if (cx < 0 || cz < 0 || cx >= this.n || cz >= this.n) return false;
    const i = cz * this.n + cx; return this.pass[i] === 1 && this.block[i] === 0;
  }
  passAt(x: number, z: number) { return this.cellPass(Math.floor(x / CELL), Math.floor(z / CELL)); }
  cellOf(x: number, z: number) {
    return clamp(Math.floor(z / CELL), 0, this.n - 1) * this.n + clamp(Math.floor(x / CELL), 0, this.n - 1);
  }

  nearestPass(cx: number, cz: number, maxR: number): number {
    const n = this.n;
    if (this.cellPass(cx, cz)) return cz * n + cx;
    let best = -1, bd = 1e9;
    for (let r = 1; r <= maxR; r++) {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        if (!this.cellPass(cx + i, cz + j)) continue;
        const d = i * i + j * j;
        if (d < bd) { bd = d; best = (cz + j) * n + cx + i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  lineClear(x0: number, z0: number, x1: number, z1: number) {
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
    if (d < 0.01) return true;
    const steps = Math.ceil(d / 3), ox = -dz / d * 2.6, oz = dx / d * 2.6;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = x0 + dx * t, z = z0 + dz * t;
      if (!this.passAt(x, z) || !this.passAt(x + ox, z + oz) || !this.passAt(x - ox, z - oz)) return false;
    }
    return true;
  }

  private hPush(node: number, f: number) {
    const N = this.hN, Fa = this.hF; let i = N.length; N.push(node); Fa.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1; if (Fa[p] <= f) break;
      N[i] = N[p]; Fa[i] = Fa[p]; i = p;
    }
    N[i] = node; Fa[i] = f;
  }
  private hPop(): number {
    const N = this.hN, Fa = this.hF; const top = N[0];
    const ln = N.pop()!, lf = Fa.pop()!; const len = N.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1; if (c >= len) break;
        if (c + 1 < len && Fa[c + 1] < Fa[c]) c++;
        if (Fa[c] >= lf) break;
        N[i] = N[c]; Fa[i] = Fa[c]; i = c;
      }
      N[i] = ln; Fa[i] = lf;
    }
    return top;
  }

  /** Returns flat [x,z,x,z...] waypoints (excluding start) or null. */
  findPath(sx: number, sz: number, gx: number, gz: number): number[] | null {
    const n = this.n;
    let sc = this.cellOf(sx, sz), gc = this.cellOf(gx, gz);
    if (!this.cellPass(sc % n, (sc / n) | 0)) { sc = this.nearestPass(sc % n, (sc / n) | 0, 8); if (sc < 0) return null; }
    let exact = true;
    if (!this.cellPass(gc % n, (gc / n) | 0)) { gc = this.nearestPass(gc % n, (gc / n) | 0, 30); if (gc < 0) return null; exact = false; }
    const gcx = gc % n, gcz = (gc / n) | 0;
    const fx = exact ? gx : (gcx + 0.5) * CELL, fz = exact ? gz : (gcz + 0.5) * CELL;
    if (sc === gc || this.lineClear(sx, sz, fx, fz)) return [fx, fz];
    const sid = ++this.sid; const g = this.g, par = this.par, mark = this.mark, closed = this.closed;
    this.hN.length = 0; this.hF.length = 0;
    const heur = (i: number) => {
      const dx = Math.abs(i % n - gcx), dz = Math.abs(((i / n) | 0) - gcz);
      return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz);
    };
    g[sc] = 0; par[sc] = -1; mark[sc] = sid; this.hPush(sc, heur(sc));
    let best = sc, bestH = heur(sc), found = false, exp = 0;
    const pass = this.pass, block = this.block;
    while (this.hN.length) {
      const cur = this.hPop();
      if (closed[cur] === sid) continue;
      closed[cur] = sid;
      if (cur === gc) { found = true; break; }
      if (++exp > 40000) break;
      const cx = cur % n, cz = (cur / n) | 0, gcur = g[cur];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (!pass[ni] || block[ni] || closed[ni] === sid) continue;
        if (dx && dz) {
          const a = cz * n + nx, b = nz * n + cx;
          if (!pass[a] || block[a] || !pass[b] || block[b]) continue;
        }
        const ng = gcur + (dx && dz ? 1.4142 : 1);
        if (mark[ni] === sid && g[ni] <= ng) continue;
        g[ni] = ng; par[ni] = cur; mark[ni] = sid;
        const h = heur(ni);
        if (h < bestH) { bestH = h; best = ni; }
        this.hPush(ni, ng + h * 1.05);
      }
    }
    let end = found ? gc : best;
    if (end === sc) return null;
    const cells: number[] = [];
    for (let c = end; c !== -1 && c !== sc; c = par[c]) cells.push(c);
    cells.reverse();
    const pts: number[] = [];
    for (const c of cells) pts.push((c % n + 0.5) * CELL, (((c / n) | 0) + 0.5) * CELL);
    if (found) { pts[pts.length - 2] = fx; pts[pts.length - 1] = fz; }
    // string pulling
    const out: number[] = [];
    let ax = sx, az = sz, i = 0; const cnt = pts.length / 2;
    while (i < cnt) {
      let j = Math.min(cnt - 1, i + 48);
      while (j > i && !this.lineClear(ax, az, pts[j * 2], pts[j * 2 + 1])) j--;
      ax = pts[j * 2]; az = pts[j * 2 + 1]; out.push(ax, az); i = j + 1;
    }
    return out;
  }
}
