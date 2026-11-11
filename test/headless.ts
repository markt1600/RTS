// Headless AI-vs-AI soak test: `npm run sim`
import { Game, TICK } from '../src/sim';
import { AI } from '../src/ai';

const levels = (process.argv[2] || '1,2').split(',').map(Number);
const minutes = Number(process.argv[3] || 25);
const seed = Number(process.argv[4] || 1234);
const g = new Game({ n: 128, seed, biome: 0, players: levels.map((l, i) => ({ ai: true, level: l, ally: i })) });
const m = g.map;
let pass = 0; for (let i = 0; i < m.n * m.n; i++) pass += m.pass[i];
console.log(`map n=${m.n} passable=${(pass / m.n / m.n * 100).toFixed(0)}% spots=${m.spots.length} water=${m.waterY.toFixed(1)}`);
const ais = g.teams.map(t => new AI(g, t));
const t0 = Date.now();
let maxMs = 0;
for (let i = 0; i < minutes * 60 * TICK && !g.over; i++) {
  const s = performance.now();
  for (const a of ais) a.update();
  g.step();
  maxMs = Math.max(maxMs, performance.now() - s);
  if (i % (TICK * 120) === 0) {
    console.log(`t=${(i / TICK / 60).toFixed(0)}m units=${g.units.length} projs=${g.projs.length} wrecks=${g.wrecks.length}`);
    for (const t of g.teams) {
      const c: Record<string, number> = {};
      for (const u of g.units) if (u.team === t) c[u.def.id] = (c[u.def.id] || 0) + 1;
      console.log(`  T${t.id} L${t.level} ${t.dead ? 'DEAD' : ''} M ${t.metal.toFixed(0)}/${t.stM} +${t.incM.toFixed(1)} -${t.useM.toFixed(1)} | E ${t.energy.toFixed(0)}/${t.stE} +${t.incE.toFixed(0)} -${t.useE.toFixed(0)} | k${t.stats.kills} l${t.stats.lost} | ` +
        Object.entries(c).map(([k, v]) => k + ':' + v).join(' '));
    }
  }
}
console.log(`done tick=${g.tick} (${(g.tick / TICK / 60).toFixed(1)} min) over=${g.over} winner=${g.winner} wall=${Date.now() - t0}ms maxTick=${maxMs.toFixed(1)}ms`);
