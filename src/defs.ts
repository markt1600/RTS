// Unit / structure definitions and procedural model recipes.
// Everything in the game is data-driven from this file.

export interface WeaponDef {
  k: 'laser' | 'beam' | 'cannon' | 'missile' | 'bomb';
  range: number; min?: number; reload: number; dmg: number;
  splash?: number; speed?: number;
  tg: number; // 1 ground, 2 air, 3 both
  color: number;
  burst?: number; gap?: number; spread?: number; eShot?: number;
  free?: boolean; // does not need turret alignment
  arc?: number; turn?: number;
}
/** s: 0 box [w,h,l] | 1 cylinder [rTop,rBot,h] | 2 sphere [r] | 3 cone [r,h] */
export interface Part { s: number; d: number[]; p: number[]; r?: number[]; c: string; g?: string }
export interface Model { parts: Part[]; tp?: number[]; sp?: number[]; sa?: 'y' | 'z'; ss?: number }

export interface UnitDef {
  id: string; name: string; desc: string; tier: number;
  cls: 'building' | 'ground' | 'air';
  hp: number; m: number; e: number; work: number;
  speed: number; turn: number; r: number; h: number;
  fw: number; fh: number;
  sight: number; radar: number;
  bp: number; buildRange: number; builds: string[]; factory: boolean;
  mkM: number; mkE: number; useE: number; stM: number; stE: number;
  extract: number; wind: number; conv: number;
  weapons: WeaponDef[];
  alt: number; hover: boolean;
  blast: { r: number; d: number } | null;
  commander: boolean; bot: boolean; noChase: boolean; naval: boolean; water: boolean;
  model: Model;
}

const H = Math.PI / 2;
const B = (w: number, h: number, l: number, x: number, y: number, z: number, c: string, g?: string, r?: number[]): Part =>
  ({ s: 0, d: [w, h, l], p: [x, y, z], c, g, r });
const C = (rt: number, rb: number, h: number, x: number, y: number, z: number, c: string, g?: string, r?: number[]): Part =>
  ({ s: 1, d: [rt, rb, h], p: [x, y, z], c, g, r });
const S = (r: number, x: number, y: number, z: number, c: string, g?: string): Part =>
  ({ s: 2, d: [r], p: [x, y, z], c, g });
const K = (r: number, h: number, x: number, y: number, z: number, c: string, g?: string, rot?: number[]): Part =>
  ({ s: 3, d: [r, h], p: [x, y, z], c, g, r: rot });
/** barrel pointing forward (+z) starting at z */
const BR = (rad: number, len: number, x: number, y: number, z: number, c = 'M', g = 't'): Part =>
  C(rad, rad, len, x, y, z + len / 2, c, g, [H, 0, 0]);
const legs = (sp: number, h: number, w: number): Part[] => [
  B(w, h, w * 1.1, -sp, h / 2 + 0.4, 0, 'D'), B(w, h, w * 1.1, sp, h / 2 + 0.4, 0, 'D'),
  B(w * 1.25, 0.8, w * 1.8, -sp, 0.4, w * 0.25, 'M'), B(w * 1.25, 0.8, w * 1.8, sp, 0.4, w * 0.25, 'M'),
];
const tracks = (w: number, l: number, h = 1.6): Part[] => [
  B(1.6, h, l, -w / 2, h / 2, 0, 'K'), B(1.6, h, l, w / 2, h / 2, 0, 'K'),
];
const pad = (w: number, l: number, hh = 1): Part[] => [
  B(w, hh, l, 0, hh / 2, 0, 'D'), B(w - 1.5, 0.3, l - 1.5, 0, hh + 0.15, 0, 'M'),
];

const base = {
  tier: 1, speed: 0, turn: 0, r: 4, h: 5, fw: 1, fh: 1, sight: 150, radar: 0, bp: 0, buildRange: 42,
  builds: [] as string[], factory: false, mkM: 0, mkE: 0, useE: 0, stM: 0, stE: 0, extract: 0, wind: 0, conv: 0,
  weapons: [] as WeaponDef[], alt: 0, hover: false, blast: null, commander: false, bot: false, noChase: false, naval: false, water: false,
};
export const DEFS: Record<string, UnitDef> = {};
export const DEF_LIST: UnitDef[] = [];
function U(d: Partial<UnitDef> & { id: string; name: string; desc: string; cls: UnitDef['cls']; hp: number; m: number; e: number; work: number; model: Model }) {
  const def = { ...base, ...d } as UnitDef;
  if (def.cls === 'building') { def.r = Math.max(def.fw, def.fh) * 4; }
  DEFS[def.id] = def; DEF_LIST.push(def);
}

const T1_BUILD = ['extractor', 'solar', 'wind', 'tidal', 'estore', 'mstore', 'foundry', 'works', 'aerodrome', 'shipyard', 'sentry', 'flak', 'radar'];
const CON_BUILD = ['extractor', 'solar', 'wind', 'tidal', 'estore', 'mstore', 'converter', 'foundry', 'works', 'aerodrome', 'shipyard', 'advforge', 'sentry', 'bastion', 'flak', 'radar'];
const T2_BUILD = ['deepext', 'fusion', 'tidal', 'estore', 'mstore', 'converter', 'advforge', 'foundry', 'works', 'aerodrome', 'shipyard', 'sunlance', 'thunderhead', 'bastion', 'flak', 'radar', 'colossus'];

// ───────────────────────── Commander ─────────────────────────
U({
  id: 'prime', name: 'Prime', desc: 'Command unit. Builds your base. If it falls, you fall.', cls: 'ground',
  hp: 3600, m: 2500, e: 25000, work: 20000, speed: 12.5, turn: 3.2, r: 5.5, h: 13, sight: 210,
  bp: 30, buildRange: 55, builds: T1_BUILD, mkM: 1.5, mkE: 30, stM: 1000, stE: 1000,
  commander: true, bot: true, noChase: true, blast: { r: 110, d: 2600 },
  weapons: [{ k: 'laser', range: 135, reload: 0.5, dmg: 44, tg: 3, color: 0x66ffd0 }],
  model: {
    tp: [0, 6.6, 0],
    parts: [
      ...legs(2, 5, 2.2), B(5.6, 1.6, 3.2, 0, 6, 0, 'M'),
      B(6.6, 4.4, 4.2, 0, 9, 0, 'T', 't'), B(2.4, 1.2, 0.4, 0, 9.4, 2.15, 'G', 't'),
      B(2.4, 1.8, 2.4, 0, 12, 0.2, 'L', 't'), B(2, 0.5, 0.3, 0, 12.1, 1.4, 'G', 't'),
      B(1.7, 3.8, 2.2, -4.2, 9, 0, 'D', 't'), B(1.7, 3.8, 2.2, 4.2, 9, 0, 'D', 't'),
      BR(0.6, 4.2, 4.2, 7.8, 0.6), BR(0.9, 2.4, -4.2, 7.8, 0.6, 'Y'),
      B(4.2, 3.2, 1.6, 0, 9.4, -2.8, 'D', 't'), B(0.25, 3.4, 0.25, 2, 13, -2.8, 'L', 't'),
      B(7.4, 0.8, 2, 0, 11.4, -0.4, 'T', 't'),
    ],
  },
});

// ───────────────────────── Economy ─────────────────────────
U({
  id: 'extractor', name: 'Extractor', desc: 'Draws metal from an ore vein.', cls: 'building',
  hp: 320, m: 50, e: 500, work: 240, fw: 2, fh: 2, h: 8, extract: 1, useE: 3, sight: 90,
  model: {
    sp: [0, 7, 0], sa: 'y', ss: 2.2,
    parts: [...pad(14, 14), C(4, 5.5, 4, 0, 3, 0, 'T'), C(1.2, 1.2, 4, 0, 6, 0, 'M'),
      B(11, 0.8, 1.4, 0, 0.4, 0, 'L', 's'), B(1.4, 0.8, 11, 0, 0.4, 0, 'L', 's'), S(1.3, 0, 1, 0, 'G', 's')],
  },
});
U({
  id: 'solar', name: 'Solar Array', desc: 'Steady energy. +20', cls: 'building',
  hp: 360, m: 150, e: 0, work: 420, fw: 2, fh: 2, h: 5, mkE: 20, sight: 90,
  model: {
    parts: [...pad(15, 15, 0.8), C(1.2, 1.6, 2.4, 0, 2, 0, 'M'),
      B(6.6, 0.4, 6.6, -3.6, 3.6, -3.6, 'P', undefined, [0.25, 0, 0.25]), B(6.6, 0.4, 6.6, 3.6, 3.6, -3.6, 'P', undefined, [0.25, 0, -0.25]),
      B(6.6, 0.4, 6.6, -3.6, 3.6, 3.6, 'P', undefined, [-0.25, 0, 0.25]), B(6.6, 0.4, 6.6, 3.6, 3.6, 3.6, 'P', undefined, [-0.25, 0, -0.25]),
      B(2, 1.4, 2, 0, 3.6, 0, 'T')],
  },
});
U({
  id: 'wind', name: 'Wind Turbine', desc: 'Cheap, variable energy. +0–25', cls: 'building',
  hp: 210, m: 40, e: 180, work: 210, h: 15, wind: 25, sight: 90,
  model: {
    sp: [0, 13, 1.4], sa: 'z', ss: 5,
    parts: [C(2.4, 3, 1, 0, 0.5, 0, 'D'), C(0.6, 1, 12, 0, 7, 0, 'L'), B(1.6, 1.6, 3, 0, 13, 0, 'T'),
      B(0.9, 6.5, 0.25, 0, 3.25, 0, 'L', 's'), B(0.9, 6.5, 0.25, -2.815, -1.625, 0, 'L', 's', [0, 0, 2.094]), B(0.9, 6.5, 0.25, 2.815, -1.625, 0, 'L', 's', [0, 0, -2.094]),
      S(0.8, 0, 13, 1.5, 'T')],
  },
});
U({
  id: 'estore', name: 'Energy Cell', desc: 'Stores 6000 energy.', cls: 'building',
  hp: 1200, m: 170, e: 1700, work: 500, fw: 2, fh: 2, h: 8, stE: 6000, sight: 90,
  model: { parts: [...pad(15, 15), C(3, 3, 6, -3.4, 4, -3.4, 'T'), C(3, 3, 6, 3.4, 4, -3.4, 'T'), C(3, 3, 6, -3.4, 4, 3.4, 'T'), C(3, 3, 6, 3.4, 4, 3.4, 'T'),
    C(3.1, 3.1, 0.8, -3.4, 5, -3.4, 'Y'), C(3.1, 3.1, 0.8, 3.4, 5, -3.4, 'Y'), C(3.1, 3.1, 0.8, -3.4, 5, 3.4, 'Y'), C(3.1, 3.1, 0.8, 3.4, 5, 3.4, 'Y'), B(3, 5, 3, 0, 3.5, 0, 'M')] },
});
U({
  id: 'mstore', name: 'Metal Depot', desc: 'Stores 3000 metal.', cls: 'building',
  hp: 1500, m: 320, e: 600, work: 500, fw: 2, fh: 2, h: 7, stM: 3000, sight: 90,
  model: { parts: [...pad(15, 15), B(12, 5, 12, 0, 3.5, 0, 'T'), B(13, 1, 13, 0, 6.2, 0, 'M'), B(4, 1.4, 4, -3, 7, -3, 'L'), B(4, 1.4, 4, 3, 7, 3, 'L'), B(12.4, 1, 3, 0, 2.4, 0, 'D')] },
});
U({
  id: 'converter', name: 'Transmuter', desc: 'Converts 70 energy into 1 metal.', cls: 'building',
  hp: 220, m: 1, e: 1200, work: 350, fw: 2, fh: 2, h: 8, conv: 70, sight: 90,
  model: { parts: [...pad(14, 14), C(4.5, 5.5, 3, 0, 2.5, 0, 'T'), C(2, 4, 3, 0, 5.5, 0, 'M'), S(2.4, 0, 8, 0, 'Y'), B(1, 6, 1, -5, 4, -5, 'L'), B(1, 6, 1, 5, 4, -5, 'L'), B(1, 6, 1, -5, 4, 5, 'L'), B(1, 6, 1, 5, 4, 5, 'L')] },
});
U({
  id: 'fusion', name: 'Fusion Core', desc: 'Massive energy output. +600. Volatile.', cls: 'building', tier: 2,
  hp: 4200, m: 3500, e: 20000, work: 7500, fw: 4, fh: 3, h: 13, mkE: 600, stE: 2000, sight: 110, blast: { r: 140, d: 1800 },
  model: { parts: [...pad(31, 23, 1.2), C(8, 8, 18, 0, 8, 0, 'T', undefined, [0, 0, H]), C(8.4, 8.4, 3, 0, 8, 0, 'Y', undefined, [0, 0, H]),
    C(9, 9, 2, -8, 8, 0, 'M', undefined, [0, 0, H]), C(9, 9, 2, 8, 8, 0, 'M', undefined, [0, 0, H]),
    B(5, 8, 20, -12.5, 5, 0, 'D'), B(5, 8, 20, 12.5, 5, 0, 'D'), B(2, 3, 2, -12.5, 10, -6, 'L'), B(2, 3, 2, 12.5, 10, 6, 'L')] },
});
U({
  id: 'deepext', name: 'Deep Extractor', desc: 'Quadruple yield. Can replace an Extractor.', cls: 'building', tier: 2,
  hp: 1600, m: 600, e: 8000, work: 3000, fw: 2, fh: 2, h: 12, extract: 4, useE: 20, sight: 100,
  model: {
    sp: [0, 10.5, 0], sa: 'y', ss: 3.5,
    parts: [...pad(15.5, 15.5, 1.4), C(5, 6.5, 6, 0, 4.4, 0, 'T'), C(2, 3, 3.5, 0, 8.6, 0, 'M'),
      B(13, 1, 2, 0, 0.4, 0, 'L', 's'), B(2, 1, 13, 0, 0.4, 0, 'L', 's'), S(1.8, 0, 1.2, 0, 'G', 's'),
      B(2, 7, 2, -6, 4.5, -6, 'D'), B(2, 7, 2, 6, 4.5, -6, 'D'), B(2, 7, 2, -6, 4.5, 6, 'D'), B(2, 7, 2, 6, 4.5, 6, 'D')],
  },
});

// ───────────────────────── Factories ─────────────────────────
const facParts = (w: number, c: string): Part[] => {
  const e = w / 2 - 2.5;
  return [B(w, 0.8, w, 0, 0.4, 0, 'D'), B(w - 12, 0.3, w - 6, 0, 0.95, 0, 'M'),
    B(5, 9, w - 2, -e, 5, 0, c), B(5, 9, w - 2, e, 5, 0, c), B(w - 2, 9, 5, 0, 5, -e, c),
    B(5.4, 1, w - 1.6, -e, 9.8, 0, 'M'), B(5.4, 1, w - 1.6, e, 9.8, 0, 'M'),
    B(w - 9, 1.6, 2, 0, 11, -e + 4, 'D'), B(w - 9, 1.6, 2, 0, 11, 6, 'D'),
    B(1, 0.5, w - 4, -e + 3, 1.1, 0, 'Y'), B(1, 0.5, w - 4, e - 3, 1.1, 0, 'Y')];
};
U({
  id: 'foundry', name: 'Bot Foundry', desc: 'Produces bots: fast, agile walkers.', cls: 'building',
  hp: 2700, m: 620, e: 1100, work: 1300, fw: 5, fh: 5, h: 12, bp: 20, factory: true, sight: 110,
  builds: ['wright', 'jackal', 'brawler', 'lancer', 'skewer'],
  model: { parts: [...facParts(39, 'T'), C(2, 2.6, 4, -17, 12, -17, 'L'), C(2, 2.6, 4, 17, 12, -17, 'L')] },
});
U({
  id: 'works', name: 'Vehicle Works', desc: 'Produces vehicles: tough and heavy-hitting.', cls: 'building',
  hp: 3000, m: 680, e: 1300, work: 1400, fw: 5, fh: 5, h: 12, bp: 20, factory: true, sight: 110,
  builds: ['hauler', 'dart', 'maul', 'howl'],
  model: { parts: [...facParts(39, 'T'), B(8, 3, 8, 0, 12, -15, 'M'), B(3, 5, 3, 0, 14, -15, 'L')] },
});
U({
  id: 'aerodrome', name: 'Aerodrome', desc: 'Produces aircraft.', cls: 'building',
  hp: 2300, m: 800, e: 1600, work: 1600, fw: 5, fh: 5, h: 10, bp: 20, factory: true, sight: 130,
  builds: ['kestrel', 'talon', 'anvil', 'vulture'],
  model: {
    sp: [-15, 14.6, -15], sa: 'y', ss: 1.6,
    parts: [B(39, 1, 39, 0, 0.5, 0, 'D'), C(13, 13, 0.4, 0, 1.2, 2, 'M'), C(10, 10, 0.3, 0, 1.4, 2, 'D'), B(1.2, 0.2, 14, 0, 1.6, 2, 'L'), B(14, 0.2, 1.2, 0, 1.6, 2, 'L'),
      B(8, 12, 8, -15, 7, -15, 'T'), B(6, 0.6, 1.4, 0, 0, 0, 'L', 's'), B(2, 2.4, 2, 0, -0.8, 0, 'M', 's'),
      B(10, 4, 6, 14, 3, -16, 'T'), B(1, 0.6, 1, 17, 1.4, 17, 'Y'), B(1, 0.6, 1, -17, 1.4, 17, 'Y')],
  },
});
U({
  id: 'advforge', name: 'Advanced Forge', desc: 'Produces heavy tier-2 war machines.', cls: 'building', tier: 2,
  hp: 5000, m: 2600, e: 6000, work: 4200, fw: 6, fh: 6, h: 15, bp: 40, factory: true, sight: 120,
  builds: ['archwright', 'reaver', 'goliath', 'tempest'],
  model: { parts: [...facParts(47, 'T'), B(8, 6, 8, -19, 12, -19, 'D'), B(8, 6, 8, 19, 12, -19, 'D'), C(1.6, 1.6, 6, -19, 17, -19, 'Y'), C(1.6, 1.6, 6, 19, 17, -19, 'Y'),
    B(30, 2, 3, 0, 12.6, -14, 'T'), B(30, 2, 3, 0, 12.6, 10, 'T')] },
});

// ───────────────────────── Defences ─────────────────────────
U({
  id: 'sentry', name: 'Sentry', desc: 'Light laser turret. Anti-ground.', cls: 'building',
  hp: 1150, m: 250, e: 2200, work: 900, h: 9, sight: 215,
  weapons: [{ k: 'laser', range: 195, reload: 0.35, dmg: 21, tg: 1, color: 0xff5540 }],
  model: { tp: [0, 6, 0], parts: [C(3, 3.8, 1.2, 0, 0.6, 0, 'D'), C(1.6, 2.4, 4.6, 0, 3.4, 0, 'M'),
    B(4.4, 2.6, 4.4, 0, 7, 0, 'T', 't'), BR(0.5, 5, -1.1, 7, 1.5), BR(0.5, 5, 1.1, 7, 1.5), B(1, 0.6, 0.3, 0, 7.6, 2.25, 'R', 't')] },
});
U({
  id: 'bastion', name: 'Bastion', desc: 'Heavy plasma battery. Long range.', cls: 'building',
  hp: 3300, m: 800, e: 6000, work: 2600, fw: 2, fh: 2, h: 10, sight: 260,
  weapons: [{ k: 'cannon', range: 315, min: 40, reload: 2.4, dmg: 300, splash: 30, speed: 210, arc: 0.18, spread: 0.03, tg: 1, color: 0xffb040, turn: 1.6 }],
  model: { tp: [0, 5, 0], parts: [C(7, 7.6, 2, 0, 1, 0, 'D'), C(5, 6, 3, 0, 3.5, 0, 'M'),
    B(8, 4.4, 8, 0, 7.2, -0.5, 'T', 't'), BR(1.2, 10, 0, 7.6, 3), C(1.6, 1.6, 1.6, 0, 7.6, 12.6, 'D', 't', [H, 0, 0]), B(6, 1.4, 3, 0, 9.6, -2.5, 'D', 't')] },
});
U({
  id: 'flak', name: 'Flak Spire', desc: 'Anti-air missile battery.', cls: 'building',
  hp: 850, m: 180, e: 1800, work: 700, h: 10, sight: 300,
  weapons: [{ k: 'missile', range: 295, reload: 1.4, dmg: 115, speed: 330, tg: 2, color: 0xfff0a0, free: true }],
  model: { tp: [0, 7, 0], parts: [C(3, 3.6, 1.2, 0, 0.6, 0, 'D'), B(2.4, 5, 2.4, 0, 3.6, 0, 'M'),
    B(2.4, 2.4, 5, -2, 8, 0, 'T', 't', [-0.6, 0, 0]), B(2.4, 2.4, 5, 2, 8, 0, 'T', 't', [-0.6, 0, 0]), B(1.6, 1.6, 1.6, 0, 7.4, 0, 'D', 't'),
    B(1.6, 1.6, 0.3, -2, 9.5, 2.1, 'R', 't', [-0.6, 0, 0]), B(1.6, 1.6, 0.3, 2, 9.5, 2.1, 'R', 't', [-0.6, 0, 0])] },
});
U({
  id: 'radar', name: 'Radar Mast', desc: 'Detects distant units on the minimap.', cls: 'building',
  hp: 160, m: 60, e: 600, work: 280, h: 14, radar: 560, useE: 8, sight: 70,
  model: { sp: [0, 12, 0], sa: 'y', ss: 1.8, parts: [C(2.6, 3.2, 1, 0, 0.5, 0, 'D'), C(0.5, 1, 11, 0, 6.5, 0, 'L'),
    B(7, 3, 0.5, 0, 1, 0, 'T', 's'), B(1, 1, 2, 0, 1, 1, 'M', 's'), S(0.6, 0, 1, 2.2, 'G', 's')] },
});
U({
  id: 'sunlance', name: 'Sunlance', desc: 'Devastating energy lance. Drains energy per shot.', cls: 'building', tier: 2,
  hp: 4300, m: 2200, e: 16000, work: 6000, fw: 2, fh: 2, h: 13, sight: 360,
  weapons: [{ k: 'beam', range: 345, reload: 5, dmg: 1500, tg: 1, color: 0x70b8ff, eShot: 1200, turn: 1.3 }],
  model: { tp: [0, 7, 0], parts: [C(7, 7.6, 2.4, 0, 1.2, 0, 'D'), C(4, 6, 4.6, 0, 4.7, 0, 'M'),
    B(6, 5, 9, 0, 10, -1, 'T', 't'), BR(1.6, 8, 0, 10, 3.5, 'D'), BR(0.9, 11, 0, 10, 3.5, 'G'), B(7.4, 1, 4, 0, 13, -2, 'D', 't'), B(1, 3, 1, -3.6, 10, 2, 'G', 't'), B(1, 3, 1, 3.6, 10, 2, 'G', 't')] },
});
U({
  id: 'thunderhead', name: 'Thunderhead', desc: 'Strategic artillery. Shells half the map.', cls: 'building', tier: 2,
  hp: 3900, m: 4000, e: 30000, work: 9000, fw: 3, fh: 3, h: 14, sight: 200,
  weapons: [{ k: 'cannon', range: 1150, min: 220, reload: 9, dmg: 760, splash: 52, speed: 270, arc: 0.42, spread: 0.035, tg: 1, color: 0xffd070, eShot: 1500, turn: 0.6 }],
  model: { tp: [0, 6, 0], parts: [C(11, 11.6, 2.4, 0, 1.2, 0, 'D'), C(8, 9.6, 3.6, 0, 4.2, 0, 'M'),
    B(11, 6, 12, 0, 9, -2, 'T', 't'), C(1.7, 2.2, 24, 0, 15.4, 12, 'M', 't', [1.05, 0, 0]), C(2.4, 2.4, 3, 0, 20.6, 21, 'D', 't', [1.05, 0, 0]),
    B(12.4, 2, 5, 0, 12.4, -5.5, 'D', 't'), B(2, 4, 8, -6.4, 8, -2, 'D', 't'), B(2, 4, 8, 6.4, 8, -2, 'D', 't')] },
});

// ───────────────────────── Tier 1 bots ─────────────────────────
U({
  id: 'wright', name: 'Wright', desc: 'Construction bot. Unlocks the Advanced Forge.', cls: 'ground',
  hp: 520, m: 120, e: 1500, work: 700, speed: 14, turn: 4, r: 3.4, h: 8, bp: 10, builds: CON_BUILD, bot: true, sight: 160,
  model: { tp: [0, 4, 0], parts: [...legs(1.4, 3, 1.4), B(4.4, 3, 3.6, 0, 5.2, 0, 'T', 't'), B(3, 1.6, 2, 0, 5.4, -2.4, 'D', 't'),
    BR(0.7, 2.6, -2.6, 5.4, 0.4, 'Y'), BR(0.7, 2.6, 2.6, 5.4, 0.4, 'Y'), B(2, 1, 1.6, 0, 7.2, 0.4, 'L', 't'), B(1.6, 0.4, 0.2, 0, 7.2, 1.3, 'Y', 't')] },
});
U({
  id: 'jackal', name: 'Jackal', desc: 'Fast light skirmisher bot.', cls: 'ground',
  hp: 330, m: 55, e: 700, work: 280, speed: 23, turn: 5, r: 2.8, h: 6.5, bot: true, sight: 180,
  weapons: [{ k: 'laser', range: 115, reload: 0.4, dmg: 11, tg: 1, color: 0xffe060 }],
  model: { tp: [0, 3.4, 0], parts: [...legs(1.1, 2.6, 1.1), B(3.2, 2.4, 2.6, 0, 4.6, 0, 'T', 't'), B(1.4, 1, 1.4, 0, 6.2, 0.2, 'L', 't'),
    BR(0.35, 3, -2, 4.6, 0), BR(0.35, 3, 2, 4.6, 0), B(0.9, 1.6, 1.6, -2, 4.6, 0, 'D', 't'), B(0.9, 1.6, 1.6, 2, 4.6, 0, 'D', 't')] },
});
U({
  id: 'brawler', name: 'Brawler', desc: 'Sturdy assault bot with a plasma cannon.', cls: 'ground',
  hp: 980, m: 130, e: 1300, work: 520, speed: 14.5, turn: 3.6, r: 3.6, h: 8.5, bot: true, sight: 170,
  weapons: [{ k: 'cannon', range: 128, reload: 1.6, dmg: 72, splash: 12, speed: 175, spread: 0.03, tg: 1, color: 0xffa040 }],
  model: { tp: [0, 4.4, 0], parts: [...legs(1.7, 3.4, 1.7), B(5.4, 3.6, 3.8, 0, 6.2, 0, 'T', 't'), B(2, 1.2, 2, 0, 8.6, 0, 'L', 't'),
    BR(0.9, 4.4, 3.3, 6, 0.4), B(1.6, 2.6, 3, 3.3, 6, 0, 'D', 't'), B(1.6, 3, 2.4, -3.3, 6.2, 0, 'D', 't'), B(3.4, 2.4, 1.2, 0, 6.6, -2.3, 'D', 't')] },
});
U({
  id: 'lancer', name: 'Lancer', desc: 'Long-range rocket bot. Fragile.', cls: 'ground',
  hp: 430, m: 110, e: 1000, work: 450, speed: 13.5, turn: 3.6, r: 3.2, h: 8, bot: true, sight: 190,
  weapons: [{ k: 'missile', range: 208, reload: 3.2, dmg: 118, splash: 10, speed: 160, tg: 1, color: 0xff9060, free: true }],
  model: { tp: [0, 4, 0], parts: [...legs(1.4, 3, 1.3), B(3.6, 2.6, 3, 0, 5.4, 0, 'T', 't'),
    B(2, 2, 5.4, -2.8, 6.8, 0, 'D', 't', [-0.3, 0, 0]), B(2, 2, 5.4, 2.8, 6.8, 0, 'D', 't', [-0.3, 0, 0]),
    B(1.4, 1.4, 0.3, -2.8, 7.6, 2.6, 'R', 't', [-0.3, 0, 0]), B(1.4, 1.4, 0.3, 2.8, 7.6, 2.6, 'R', 't', [-0.3, 0, 0]), B(1.4, 1, 1.4, 0, 7.2, 0.4, 'L', 't')] },
});
U({
  id: 'skewer', name: 'Skewer', desc: 'Anti-air missile bot.', cls: 'ground',
  hp: 500, m: 100, e: 1100, work: 420, speed: 15.5, turn: 4, r: 3.2, h: 8, bot: true, sight: 240,
  weapons: [{ k: 'missile', range: 245, reload: 1.6, dmg: 82, speed: 280, tg: 2, color: 0xfff0a0, free: true }],
  model: { tp: [0, 4, 0], parts: [...legs(1.4, 3, 1.3), B(3.8, 2.4, 3, 0, 5.2, 0, 'T', 't'),
    C(0.7, 0.7, 5, -1.2, 7.6, 0, 'L', 't', [0.9, 0, 0]), C(0.7, 0.7, 5, 1.2, 7.6, 0, 'L', 't', [0.9, 0, 0]), B(4, 1.2, 2, 0, 6.8, -0.8, 'D', 't'), K(0.7, 1.4, 0, 9, 0, 'R', 't')] },
});

// ───────────────────────── Tier 1 vehicles ─────────────────────────
U({
  id: 'hauler', name: 'Hauler', desc: 'Construction vehicle. Unlocks the Advanced Forge.', cls: 'ground',
  hp: 820, m: 140, e: 1800, work: 800, speed: 16, turn: 2.2, r: 4.2, h: 6.5, bp: 14, builds: CON_BUILD, sight: 160,
  model: { tp: [0, 3.4, -1], parts: [...tracks(6, 9), B(5.4, 2.2, 8.4, 0, 2.2, 0, 'T'), B(4, 2, 3, 0, 4.2, 2.4, 'L'), B(3.6, 0.6, 0.2, 0, 4.6, 3.95, 'Y'),
    C(1.6, 1.8, 1.2, 0, 4, -1, 'D', 't'), B(1, 1, 5, 0, 5, 0.6, 'M', 't', [-0.5, 0, 0]), S(0.9, 0, 6.3, 2.8, 'Y', 't')] },
});
U({
  id: 'dart', name: 'Dart', desc: 'Very fast scout buggy.', cls: 'ground',
  hp: 160, m: 35, e: 400, work: 160, speed: 44, turn: 3.4, r: 2.6, h: 3.5, sight: 240,
  weapons: [{ k: 'laser', range: 90, reload: 0.5, dmg: 5, tg: 1, color: 0xffe060 }],
  model: { tp: [0, 2.6, -0.4], parts: [B(1, 1.6, 1.6, -2, 0.8, 2, 'K'), B(1, 1.6, 1.6, 2, 0.8, 2, 'K'), B(1, 1.6, 1.6, -2, 0.8, -2, 'K'), B(1, 1.6, 1.6, 2, 0.8, -2, 'K'),
    B(3.2, 1.2, 6, 0, 1.6, 0, 'T'), K(1.6, 2.4, 0, 1.7, 3.6, 'T', undefined, [H, 0, 0]), B(1.6, 0.9, 1.6, 0, 2.8, -0.4, 'L', 't'), BR(0.25, 2.2, 0, 2.8, 0.2)] },
});
U({
  id: 'maul', name: 'Maul', desc: 'Main battle tank.', cls: 'ground',
  hp: 1550, m: 190, e: 1800, work: 700, speed: 17.5, turn: 2, r: 4.6, h: 6, sight: 180,
  weapons: [{ k: 'cannon', range: 138, reload: 1.4, dmg: 96, splash: 14, speed: 195, spread: 0.025, tg: 1, color: 0xffa040, turn: 3 }],
  model: { tp: [0, 3.6, -0.4], parts: [...tracks(7, 10.4, 2), B(6, 2.2, 9.6, 0, 2.6, 0, 'T'), B(6.6, 0.8, 3, 0, 3, 3.6, 'D', undefined, [0.5, 0, 0]),
    B(4.4, 2, 5, 0, 4.7, -0.4, 'T', 't'), BR(0.6, 6, 0, 4.8, 2), B(4.8, 0.6, 2.4, 0, 5.9, -1.6, 'D', 't'), B(1.2, 0.8, 1.2, 1.2, 6.1, 0, 'L', 't')] },
});
U({
  id: 'howl', name: 'Howl', desc: 'Mobile artillery. Outranges turrets, helpless up close.', cls: 'ground',
  hp: 540, m: 170, e: 2200, work: 800, speed: 12.5, turn: 1.8, r: 4.4, h: 7, sight: 170,
  weapons: [{ k: 'cannon', range: 345, min: 90, reload: 4.5, dmg: 205, splash: 32, speed: 150, arc: 0.36, spread: 0.05, tg: 1, color: 0xffb860, turn: 1.6 }],
  model: { tp: [0, 3.2, -1.4], parts: [...tracks(6.4, 10), B(5.4, 1.8, 9.4, 0, 2.2, 0, 'T'), B(4.6, 1.4, 3, 0, 3.6, 3, 'D'),
    B(4, 1.8, 4, 0, 4.2, -1.4, 'D', 't'), C(0.7, 0.9, 9, 0, 7, 1.6, 'M', 't', [0.95, 0, 0]), C(1, 1, 1.2, 0, 9.5, 5, 'D', 't', [0.95, 0, 0])] },
});

// ───────────────────────── Aircraft ─────────────────────────
const wing = (span: number, chord: number, y: number, z: number, c: string): Part[] => [
  B(span, 0.3, chord, 0, y, z, c), B(span * 0.4, 0.34, chord * 1.3, 0, y, z + 0.3, c)];
U({
  id: 'kestrel', name: 'Kestrel', desc: 'Unarmed scout plane with huge vision.', cls: 'air',
  hp: 130, m: 45, e: 1300, work: 300, speed: 78, turn: 1.9, r: 3.4, h: 2, alt: 62, sight: 330,
  model: { parts: [B(1.2, 1, 6, 0, 0, 0, 'L'), ...wing(8, 1.6, 0, 0.2, 'T'), B(3, 0.25, 1, 0, 0.2, -2.8, 'T'), B(0.25, 1.4, 1.2, 0, 0.8, -2.8, 'T'), S(0.6, 0, 0.5, 1.6, 'G'), B(0.6, 0.6, 0.3, 0, 0, -3.1, 'Y')] },
});
U({
  id: 'talon', name: 'Talon', desc: 'Interceptor. Dominates the sky, harasses the ground.', cls: 'air',
  hp: 310, m: 95, e: 2600, work: 600, speed: 68, turn: 2.2, r: 3.8, h: 2, alt: 60, sight: 240,
  weapons: [{ k: 'missile', range: 155, reload: 1.0, dmg: 50, speed: 310, tg: 3, color: 0xfff0a0, free: true }],
  model: { parts: [B(1.6, 1.2, 8, 0, 0, 0, 'T'), K(0.9, 2.4, 0, 0, 5.2, 'L', undefined, [H, 0, 0]), B(9, 0.3, 3, 0, 0, -1.4, 'T', undefined, [0, 0, 0]), B(4, 0.3, 2, 0, 0, 1, 'D'),
    B(0.3, 1.8, 1.8, -1.6, 0.9, -3, 'D'), B(0.3, 1.8, 1.8, 1.6, 0.9, -3, 'D'), S(0.7, 0, 0.7, 1.6, 'G'), B(1, 0.7, 0.3, 0, 0, -4.1, 'Y'), B(0.4, 0.4, 2.4, -4.3, 0, -1, 'R'), B(0.4, 0.4, 2.4, 4.3, 0, -1, 'R')] },
});
U({
  id: 'anvil', name: 'Anvil', desc: 'Bomber. Carpet-bombs ground targets.', cls: 'air',
  hp: 640, m: 160, e: 4000, work: 900, speed: 52, turn: 1.3, r: 5, h: 2.4, alt: 66, sight: 200, noChase: true,
  weapons: [{ k: 'bomb', range: 78, reload: 6, dmg: 135, splash: 30, burst: 5, gap: 0.12, tg: 1, color: 0xffb040, free: true }],
  model: { parts: [B(2.6, 2, 10, 0, 0, 0, 'T'), ...wing(14, 3, 0.2, 0, 'T'), B(5, 0.3, 1.6, 0, 0.3, -4.4, 'D'), B(0.3, 2.2, 2, 0, 1.3, -4.4, 'D'),
    C(0.9, 0.9, 3, -3.6, -0.4, 0.4, 'D', undefined, [H, 0, 0]), C(0.9, 0.9, 3, 3.6, -0.4, 0.4, 'D', undefined, [H, 0, 0]), S(1, 0, 0.7, 3.4, 'G'),
    B(0.8, 0.8, 0.3, -3.6, -0.4, -1.2, 'Y'), B(0.8, 0.8, 0.3, 3.6, -0.4, -1.2, 'Y')] },
});
U({
  id: 'vulture', name: 'Vulture', desc: 'Heavy gunship. Hovers and shreds ground forces.', cls: 'air', tier: 2,
  hp: 1150, m: 320, e: 6000, work: 1700, speed: 38, turn: 2.6, r: 5, h: 3, alt: 44, hover: true, sight: 220,
  weapons: [{ k: 'missile', range: 138, reload: 0.45, dmg: 34, speed: 230, tg: 1, color: 0xff9060, free: true }],
  model: {
    sp: [0, 2.6, -0.5], sa: 'y', ss: 26,
    parts: [B(3, 2.4, 8, 0, 0, 0, 'T'), K(1.5, 2.6, 0, -0.2, 5.2, 'L', undefined, [H, 0, 0]), B(0.8, 0.8, 5, 0, 0.4, -6, 'D'), B(0.3, 2, 1.4, 0, 1.2, -8, 'T'),
      B(7, 0.5, 2, 0, -0.4, 0.5, 'D'), B(1.4, 1.4, 3.4, -3.6, -0.8, 0.8, 'D'), B(1.4, 1.4, 3.4, 3.6, -0.8, 0.8, 'D'), B(1, 1, 0.3, -3.6, -0.8, 2.6, 'R'), B(1, 1, 0.3, 3.6, -0.8, 2.6, 'R'),
      C(0.5, 0.5, 1.6, 0, 1.9, -0.5, 'M'), B(13, 0.15, 0.9, 0, 0, 0, 'K', 's'), B(0.9, 0.15, 13, 0, 0, 0, 'K', 's')],
  },
});

// ───────────────────────── Tier 2 ─────────────────────────
U({
  id: 'archwright', name: 'Archwright', desc: 'Advanced constructor. Builds tier-2 structures.', cls: 'ground', tier: 2,
  hp: 1350, m: 420, e: 5500, work: 2400, speed: 12.5, turn: 2.8, r: 4.4, h: 10, bp: 25, buildRange: 50, builds: T2_BUILD, bot: true, sight: 170,
  model: { tp: [0, 5, 0], parts: [...legs(2, 3.8, 1.8), B(6, 3.6, 4.6, 0, 6.6, 0, 'T', 't'), B(4.4, 2.6, 2, 0, 7, -3, 'D', 't'),
    BR(0.9, 3.4, -3.6, 6.6, 0.6, 'Y'), BR(0.9, 3.4, 3.6, 6.6, 0.6, 'Y'), B(1.4, 2.6, 2.6, -3.6, 6.6, 0, 'D', 't'), B(1.4, 2.6, 2.6, 3.6, 6.6, 0, 'D', 't'),
    B(2.4, 1.4, 2, 0, 9, 0.4, 'L', 't'), B(2, 0.5, 0.2, 0, 9, 1.5, 'Y', 't'), C(0.3, 0.3, 3, 2, 10, -3, 'L', 't')] },
});
U({
  id: 'reaver', name: 'Reaver', desc: 'Assault mech with twin pulse lasers.', cls: 'ground', tier: 2,
  hp: 3300, m: 520, e: 6500, work: 2400, speed: 15.5, turn: 3, r: 5, h: 11, bot: true, sight: 200,
  weapons: [{ k: 'laser', range: 148, reload: 0.3, dmg: 35, tg: 1, color: 0x60d0ff }],
  model: { tp: [0, 5.6, 0], parts: [...legs(2.4, 4.4, 2.2), B(5, 1.4, 3.4, 0, 5.4, 0, 'M'), B(7, 4.4, 5, 0, 8, 0, 'T', 't'), B(3, 1.4, 0.4, 0, 8.6, 2.55, 'G', 't'),
    B(2.2, 3, 5, -4.8, 8, 0.4, 'D', 't'), B(2.2, 3, 5, 4.8, 8, 0.4, 'D', 't'), BR(0.5, 3, -4.8, 8.4, 2.8), BR(0.5, 3, 4.8, 8.4, 2.8), BR(0.5, 3, -4.8, 7.4, 2.8), BR(0.5, 3, 4.8, 7.4, 2.8),
    B(2.4, 1.6, 2.6, 0, 11, 0, 'L', 't'), B(5, 2.4, 1.6, 0, 8.6, -3.2, 'D', 't')] },
});
U({
  id: 'goliath', name: 'Goliath', desc: 'Super-heavy tank. Slow, nearly unstoppable.', cls: 'ground', tier: 2,
  hp: 6400, m: 850, e: 9000, work: 3200, speed: 11.5, turn: 1.4, r: 6.6, h: 8.5, sight: 200,
  weapons: [{ k: 'cannon', range: 172, reload: 2.2, dmg: 390, splash: 24, speed: 205, spread: 0.02, tg: 1, color: 0xff8030, turn: 2 }],
  model: { tp: [0, 4.8, -0.6], parts: [B(2.6, 2.8, 15, -4.6, 1.4, 0, 'K'), B(2.6, 2.8, 15, 4.6, 1.4, 0, 'K'), B(8.6, 3, 14, 0, 3.4, 0, 'T'), B(9, 1, 4, 0, 4, 5.6, 'D', undefined, [0.5, 0, 0]),
    B(3, 1, 15.4, -4.6, 3.2, 0, 'D'), B(3, 1, 15.4, 4.6, 3.2, 0, 'D'),
    B(6.6, 2.8, 7.6, 0, 6.4, -0.6, 'T', 't'), BR(0.9, 8.6, -1.4, 6.6, 3), BR(0.9, 8.6, 1.4, 6.6, 3), B(7, 0.8, 3.6, 0, 8.1, -2.4, 'D', 't'), B(1.6, 1, 1.6, -1.8, 8.4, 0.6, 'L', 't')] },
});
U({
  id: 'tempest', name: 'Tempest', desc: 'Rocket artillery. Saturates an area from afar.', cls: 'ground', tier: 2,
  hp: 1150, m: 700, e: 10000, work: 3000, speed: 11.5, turn: 1.6, r: 5.6, h: 9, sight: 190,
  weapons: [{ k: 'missile', range: 435, min: 110, reload: 9, dmg: 138, splash: 28, burst: 6, gap: 0.18, speed: 175, tg: 1, color: 0xff9060, free: true }],
  model: { tp: [0, 4, -1.6], parts: [...tracks(8, 13, 2.2), B(7, 2.2, 12.4, 0, 2.8, 0, 'T'), B(5.6, 2.2, 3.4, 0, 5, 4.2, 'L'), B(5, 0.8, 0.2, 0, 5.4, 5.95, 'Y'),
    B(7, 3.4, 8, 0, 6.8, -1.6, 'D', 't', [-0.4, 0, 0]),
    B(1.6, 1.6, 0.3, -2.2, 9.2, 1.6, 'R', 't', [-0.4, 0, 0]), B(1.6, 1.6, 0.3, 0, 9.2, 1.6, 'R', 't', [-0.4, 0, 0]), B(1.6, 1.6, 0.3, 2.2, 9.2, 1.6, 'R', 't', [-0.4, 0, 0]),
    B(1.6, 1.6, 0.3, -2.2, 7.4, 2.4, 'R', 't', [-0.4, 0, 0]), B(1.6, 1.6, 0.3, 0, 7.4, 2.4, 'R', 't', [-0.4, 0, 0]), B(1.6, 1.6, 0.3, 2.2, 7.4, 2.4, 'R', 't', [-0.4, 0, 0])] },
});
U({
  id: 'colossus', name: 'Colossus', desc: 'Experimental titan. Ends wars.', cls: 'ground', tier: 3,
  hp: 44000, m: 9000, e: 90000, work: 24000, speed: 9.5, turn: 1.2, r: 13, h: 30, bot: true, sight: 280, fw: 3, fh: 3,
  blast: { r: 90, d: 1500 },
  weapons: [
    { k: 'beam', range: 235, reload: 2, dmg: 950, tg: 1, color: 0xff5040, turn: 1.6 },
    { k: 'missile', range: 270, reload: 0.9, dmg: 110, speed: 320, tg: 2, color: 0xfff0a0, free: true },
    { k: 'cannon', range: 200, reload: 1.2, dmg: 240, splash: 26, speed: 220, spread: 0.04, tg: 1, color: 0xffa040, free: true },
  ],
  model: { tp: [0, 15, 0], parts: [
    B(5, 12, 6, -6, 6.6, 0, 'D'), B(5, 12, 6, 6, 6.6, 0, 'D'), B(7, 1.6, 10, -6, 0.8, 1, 'M'), B(7, 1.6, 10, 6, 0.8, 1, 'M'),
    B(6, 4, 7, -6, 9, 0, 'T'), B(6, 4, 7, 6, 9, 0, 'T'), B(14, 4, 8, 0, 14, 0, 'M'),
    B(18, 10, 11, 0, 21, 0, 'T', 't'), B(8, 3, 0.6, 0, 22, 5.6, 'G', 't'), B(6, 4, 6, 0, 28, 0.6, 'L', 't'), B(5, 1, 0.4, 0, 28.4, 3.7, 'R', 't'),
    B(5, 9, 7, -12, 21, 0, 'D', 't'), B(5, 9, 7, 12, 21, 0, 'D', 't'), B(6.4, 3, 8, -12, 26, 0, 'T', 't'), B(6.4, 3, 8, 12, 26, 0, 'T', 't'),
    BR(1.6, 11, -12, 19, 3, 'M'), BR(1, 13, -12, 19, 3, 'R'), BR(1.4, 9, 12, 20, 3), BR(1.4, 9, 12, 17.6, 3),
    B(12, 8, 4, 0, 22, -7, 'D', 't'), C(0.5, 0.5, 8, 6, 30, -7, 'L', 't'), B(4, 4, 6, -5, 28.6, -4, 'D', 't', [-0.5, 0, 0]),
  ] },
});

// ───────────────────────── Naval ─────────────────────────
const hull = (w: number, l: number, h: number, c: string): Part[] => [
  B(w, h, l * 0.7, 0, h / 2 - 0.6, -l * 0.1, 'D'), B(w * 0.72, h, w * 0.72, 0, h / 2 - 0.6, l * 0.25, 'D', undefined, [0, Math.PI / 4, 0]),
  B(w * 0.86, 0.6, l * 0.68, 0, h - 0.4, -l * 0.1, c), B(w * 0.6, 0.6, w * 0.6, 0, h - 0.4, l * 0.24, c, undefined, [0, Math.PI / 4, 0]),
];
U({
  id: 'tidal', name: 'Tidal Turbine', desc: 'Offshore generator. Steady +22. Water only.', cls: 'building', water: true,
  hp: 420, m: 110, e: 300, work: 380, fw: 2, fh: 2, h: 6, mkE: 22, sight: 90,
  model: { sp: [0, 3.4, 0], sa: 'y', ss: 2.4, parts: [C(6.5, 7, 1.6, 0, 0.4, 0, 'D'), C(5.6, 6.2, 1, 0, 1.6, 0, 'T'), C(1.4, 2, 2, 0, 2.8, 0, 'M'),
    B(10, 0.5, 1.6, 0, 0.4, 0, 'L', 's'), B(1.6, 0.5, 10, 0, 0.4, 0, 'L', 's'), S(1.2, 0, 0.9, 0, 'G', 's')] },
});
U({
  id: 'shipyard', name: 'Shipyard', desc: 'Builds warships. Must be placed on water near shore.', cls: 'building', water: true,
  hp: 3200, m: 700, e: 1400, work: 1500, fw: 5, fh: 5, h: 12, bp: 22, factory: true, sight: 130,
  builds: ['skiff', 'corsair', 'leviathan'],
  model: { parts: [B(6, 3, 38, -16.5, 1, 0, 'D'), B(6, 3, 38, 16.5, 1, 0, 'D'), B(39, 3, 6, 0, 1, -16.5, 'D'),
    B(5, 0.5, 37, -16.5, 2.7, 0, 'T'), B(5, 0.5, 37, 16.5, 2.7, 0, 'T'), B(38, 0.5, 5, 0, 2.7, -16.5, 'T'),
    B(2, 10, 2, -16.5, 7.5, -12, 'M'), B(2, 10, 2, 16.5, 7.5, -12, 'M'), B(36, 2, 3, 0, 12, -12, 'Y'), B(3, 3, 5, 6, 10, -12, 'D'),
    B(6, 5, 7, -16.5, 5, 8, 'T'), B(4, 1.4, 5, -16.5, 8, 8, 'L'), C(1.2, 1.2, 5, 16.5, 5, 10, 'L'), B(1, 0.5, 1, 16.5, 3.2, 17, 'R'), B(1, 0.5, 1, -16.5, 3.2, 17, 'R')] },
});
U({
  id: 'skiff', name: 'Skiff', desc: 'Fast patrol boat.', cls: 'ground', naval: true,
  hp: 620, m: 90, e: 900, work: 400, speed: 31, turn: 2.4, r: 4.4, h: 5, sight: 220,
  weapons: [{ k: 'laser', range: 135, reload: 0.4, dmg: 13, tg: 1, color: 0xffe060 }],
  model: { tp: [0, 3.2, -0.5], parts: [...hull(4.4, 11, 2.4, 'T'), B(2.8, 1.6, 3.4, 0, 3, -2.4, 'L'), B(2.4, 0.5, 0.2, 0, 3.2, -0.65, 'G'),
    B(2, 1, 2, 0, 3.7, -0.5, 'D', 't'), BR(0.3, 2.6, -0.5, 3.8, 0.3), BR(0.3, 2.6, 0.5, 3.8, 0.3), B(0.2, 2.4, 0.2, 0, 5, -3.4, 'L')] },
});
U({
  id: 'corsair', name: 'Corsair', desc: 'Destroyer. Deck gun and anti-air missiles.', cls: 'ground', naval: true,
  hp: 3400, m: 420, e: 3800, work: 1500, speed: 21, turn: 1.5, r: 8, h: 8, sight: 260,
  weapons: [
    { k: 'cannon', range: 265, reload: 1.6, dmg: 150, splash: 18, speed: 220, arc: 0.14, spread: 0.03, tg: 1, color: 0xffa040, turn: 2.2 },
    { k: 'missile', range: 250, reload: 1.3, dmg: 85, speed: 300, tg: 2, color: 0xfff0a0, free: true },
  ],
  model: { tp: [0, 4.2, 3], parts: [...hull(7.4, 22, 3.4, 'T'), B(4.6, 3, 7, 0, 4.6, -3.4, 'L'), B(4, 0.6, 0.3, 0, 5.2, 0.15, 'G'), B(3, 2, 3.4, 0, 7, -4, 'D'), B(0.3, 4, 0.3, 0, 10, -4, 'L'), B(2.4, 0.3, 0.5, 0, 10.4, -4, 'L'),
    C(1.2, 1.5, 3, 0, 5, -8.4, 'D'), B(4, 1.6, 4.4, 0, 4.2, 3, 'T', 't'), BR(0.5, 5.4, 0, 4.4, 5), B(2.2, 2.2, 2.6, 0, 4.2, -11.2, 'D', undefined, [-0.5, 0, 0]), B(1.6, 1.6, 0.3, 0, 5, -10.2, 'R', undefined, [-0.5, 0, 0])] },
});
U({
  id: 'leviathan', name: 'Leviathan', desc: 'Battleship. Shore-shattering long-range guns.', cls: 'ground', naval: true, tier: 2,
  hp: 15000, m: 2400, e: 22000, work: 7000, speed: 13.5, turn: 0.9, r: 13, h: 12, sight: 320,
  weapons: [
    { k: 'cannon', range: 520, min: 60, reload: 3, dmg: 520, splash: 36, speed: 250, arc: 0.24, spread: 0.035, tg: 1, color: 0xffb050, turn: 1.2 },
    { k: 'cannon', range: 480, min: 60, reload: 3.4, dmg: 520, splash: 36, speed: 250, arc: 0.24, spread: 0.04, tg: 1, color: 0xffb050, free: true },
    { k: 'missile', range: 280, reload: 0.9, dmg: 100, speed: 320, tg: 2, color: 0xfff0a0, free: true },
  ],
  model: { tp: [0, 6, 9], parts: [...hull(12, 38, 5, 'T'), B(8, 4, 12, 0, 7, -4, 'L'), B(6, 3, 7, 0, 10.4, -5, 'D'), B(5, 0.8, 0.3, 0, 11, -1.4, 'G'), B(3.4, 3, 3.4, 0, 13.4, -5, 'L'),
    B(0.4, 6, 0.4, 0, 18, -5, 'L'), B(4, 0.4, 0.6, 0, 19, -5, 'L'), C(1.8, 2.2, 5, 0, 8, -11.5, 'D'), C(1.5, 1.8, 4, 0, 7.6, -15.5, 'D'),
    B(7, 2.6, 7.4, 0, 6.2, 9, 'T', 't'), BR(0.8, 9, -1.8, 6.6, 12), BR(0.8, 9, 0, 6.6, 12), BR(0.8, 9, 1.8, 6.6, 12), B(7.4, 0.6, 3, 0, 7.8, 7.4, 'D', 't'),
    B(6, 2.2, 6, 0, 5.8, -20.5, 'T'), BR(0.7, 6, -1.4, 6.2, -26, 'M', 'b'), BR(0.7, 6, 1.4, 6.2, -26, 'M', 'b'),
    B(2.4, 2.4, 3, -4.4, 6.6, -4, 'D', undefined, [-0.5, 0, 0]), B(2.4, 2.4, 3, 4.4, 6.6, -4, 'D', undefined, [-0.5, 0, 0])] },
});

export const TEAM_COLORS = [0x2f8cff, 0xff4030, 0x38d058, 0xffc020];
export const TEAM_NAMES = ['Azure', 'Crimson', 'Verdant', 'Amber'];
