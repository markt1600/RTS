// three.js renderer: procedural terrain, instanced procedural unit meshes, particles, beams, fog of war.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEF_LIST, Model, TEAM_COLORS, UnitDef } from './defs';
import { CELL, GameMap, VS } from './map';
import { Game, Team, Unit, Wreck } from './sim';
import { angDiff, clamp, hash2, lerp, vnoise } from './util';
import { makeWater, noiseTexture, normalTexture, Scenery, tile } from './scenery';
import { TICK } from './sim';

const PAL: Record<string, number> = { D: 0x2b3038, M: 0x868d98, L: 0xc8ced8, K: 0x14161a, P: 0x16305e };
const GLOW: Record<string, [number, number]> = { Y: [0xffc840, 3.2], R: [0xff4020, 3.4] };

type Geos = { b: THREE.BufferGeometry | null; t: THREE.BufferGeometry | null; s: THREE.BufferGeometry | null };
const geoCache = new Map<string, Geos>();

/** box-projected UVs in model units so the plating texture has a constant scale on every part */
function boxUV(g: THREE.BufferGeometry, off: number) {
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2), k = 1 / 14;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u: number, v: number;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * k + off; uv[i * 2 + 1] = v * k + off * 1.7;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
function buildGeos(model: Model, teamCol: number): Geos {
  const groups: Record<string, THREE.BufferGeometry[]> = { b: [], t: [], s: [] };
  const col = new THREE.Color(), e = new THREE.Euler(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  const paint = (g: THREE.BufferGeometry, code: string, pi: number, shade = 1) => {
    let k = 1;
    if (code === 'T') col.setHex(teamCol);
    else if (code === 'G') { col.setHex(teamCol); col.lerp(new THREE.Color(0xffffff), 0.35); k = 3.2; }
    else if (GLOW[code]) { col.setHex(GLOW[code][0]); k = GLOW[code][1]; }
    else col.setHex(PAL[code] ?? 0x808080);
    const n = g.attributes.position.count, ca = new Float32Array(n * 3), nrm = g.attributes.normal, ps = g.attributes.position;
    for (let i = 0; i < n; i++) {
      let f = shade;
      if (code === 'P') f *= 0.75 + 0.9 * hash2((i / 4) | 0, pi, 29) * hash2((i / 4) | 0, pi, 31) + nrm.getY(i) * 0.25;
      else if (k === 1) {
        // per-face plate tint, sky-facing surfaces catch more light, and a grounded contact shadow
        f *= 0.93 + 0.14 * hash2(pi, n, 17) + nrm.getY(i) * 0.08;
        f *= 0.62 + 0.38 * clamp((ps.getY(i) + 0.5) / 3.5, 0, 1);
      }
      ca[i * 3] = col.r * k * f; ca[i * 3 + 1] = col.g * k * f; ca[i * 3 + 2] = col.b * k * f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
  };
  let pi = 0;
  for (const p of model.parts) {
    pi++;
    const list: [THREE.BufferGeometry, string, number][] = [];
    if (p.s === 0) {
      const [w, h, l] = p.d;
      const md = Math.min(w, h, l);
      list.push([p.c === 'P' ? new THREE.BoxGeometry(w, h, l, 5, 1, 5) : md >= 1.4 && p.c !== 'K' ? new RoundedBoxGeometry(w, h, l, 1, Math.min(0.5, md * 0.22)) : new THREE.BoxGeometry(w, h, l), p.c, 1]);
      const plain = !GLOW[p.c] && p.c !== 'G' && p.c !== 'K' && p.c !== 'P';
      if (plain && Math.min(w, l) >= 2.2 && h >= 0.7) {
        // greebles: raised deck plate, vents, side hatches, corner bolts
        const r = (k: number) => hash2(pi * 7 + k, Math.round(w * 10 + l * 3), 23), dk = p.c === 'D' ? 'M' : 'D';
        const pl = new THREE.BoxGeometry(w * (0.5 + r(1) * 0.25), 0.16, l * (0.45 + r(2) * 0.3)); pl.translate((r(3) - 0.5) * w * 0.15, h / 2 + 0.08, (r(4) - 0.5) * l * 0.15); list.push([pl, p.c, 0.8]);
        if (w * l > 14) for (let k = 0; k < 3; k++) { const v = new THREE.BoxGeometry(Math.min(1.6, w * 0.18), 0.22, 0.28); v.translate((r(5) - 0.5) * w * 0.4, h / 2 + 0.2, (k - 1) * 0.5 + (r(6) - 0.5) * l * 0.3); list.push([v, 'K', 1]); }
        if (h >= 2 && l >= 3) for (const sx of [-1, 1]) { const ht = new THREE.BoxGeometry(0.14, h * 0.5, l * (0.3 + r(7) * 0.25)); ht.translate(sx * (w / 2 + 0.07), (r(8) - 0.5) * h * 0.2, (r(9) - 0.5) * l * 0.3); list.push([ht, dk, 0.9]); }
        if (h >= 2 && w >= 3) { const ht = new THREE.BoxGeometry(w * (0.3 + r(10) * 0.3), h * 0.45, 0.14); ht.translate((r(11) - 0.5) * w * 0.25, (r(12) - 0.5) * h * 0.2, -(l / 2 + 0.07)); list.push([ht, dk, 0.9]); }
        if (w * l > 40) for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const bt = new THREE.CylinderGeometry(0.3, 0.3, 0.3, 6); bt.translate(sx * (w / 2 - 0.7), h / 2 + 0.15, sz * (l / 2 - 0.7)); list.push([bt, 'L', 0.9]); }
        if (w * l > 60 && r(13) > 0.4) { const an = new THREE.CylinderGeometry(0.07, 0.07, 3.2, 4); an.translate((r(14) - 0.5) * w * 0.7, h / 2 + 1.6, (r(15) - 0.5) * l * 0.7); list.push([an, 'L', 1]); }
      }
    } else if (p.s === 1) {
      list.push([new THREE.CylinderGeometry(p.d[0], p.d[1], p.d[2], 12), p.c, 1]);
      if (!GLOW[p.c] && p.c !== 'G' && p.d[2] >= 3 && Math.max(p.d[0], p.d[1]) >= 0.5) {
        const rr = (p.d[0] + p.d[1]) / 2 + 0.09; // reinforcing bands
        for (const fy of [-0.3, 0.3]) { const bd = new THREE.CylinderGeometry(rr, rr, Math.min(0.5, p.d[2] * 0.07), 12); bd.translate(0, fy * p.d[2], 0); list.push([bd, p.c === 'D' ? 'M' : 'D', 1]); }
      }
    } else if (p.s === 2) list.push([new THREE.SphereGeometry(p.d[0], 12, 8), p.c, 1]);
    else list.push([new THREE.ConeGeometry(p.d[0], p.d[1], 10), p.c, 1]);
    const grp = p.g || 'b';
    const piv = grp === 't' ? model.tp! : grp === 's' ? [0, 0, 0] : [0, 0, 0];
    e.set(p.r ? p.r[0] : 0, p.r ? p.r[1] : 0, p.r ? p.r[2] : 0);
    q.setFromEuler(e); pos.set(p.p[0] - piv[0], p.p[1] - piv[1], p.p[2] - piv[2]);
    m.compose(pos, q, one);
    for (let [g, code, shade] of list) {
      if (g.index) g = g.toNonIndexed();
      g.applyMatrix4(m);
      if (grp !== 'b') g.translate(0, grp === 't' ? model.tp![1] : model.sp![1], 0); // shade by true height…
      paint(g, code, pi, shade);
      if (grp !== 'b') g.translate(0, -(grp === 't' ? model.tp![1] : model.sp![1]), 0);
      boxUV(g, hash2(pi, 3, 5));
      groups[grp].push(g);
    }
  }
  const mk = (a: THREE.BufferGeometry[]) => (a.length ? mergeGeometries(a) : null);
  return { b: mk(groups.b), t: mk(groups.t), s: mk(groups.s) };
}
function geosFor(def: UnitDef, team: number): Geos {
  const key = def.id + '|' + team;
  let g = geoCache.get(key);
  if (!g) { g = buildGeos(def.model, TEAM_COLORS[team]); geoCache.set(key, g); }
  return g;
}

let plateCache: { map: THREE.Texture; normal: THREE.Texture } | null = null;
/** Procedural hull plating: panels, grooves, rivets, scratches and grime, plus a matching normal map. */
export function platingTextures() {
  if (plateCache) return plateCache;
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const hgt = document.createElement('canvas'); hgt.width = hgt.height = S;
  const x = c.getContext('2d')!, hx = hgt.getContext('2d')!;
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, S, S);
  const split = (px: number, py: number, w: number, h: number, d: number) => {
    if (d === 0 || (w < 64 && h < 64) || (d < 4 && rnd() < 0.14)) {
      const v = 214 + rnd() * 34; x.fillStyle = `rgb(${v},${v},${v + 2})`; x.fillRect(px, py, w, h);
      const hv = 118 + rnd() * 26; hx.fillStyle = `rgb(${hv},${hv},${hv})`; hx.fillRect(px, py, w, h);
      x.strokeStyle = 'rgba(0,0,0,0.42)'; x.lineWidth = 1.6; x.strokeRect(px + 0.5, py + 0.5, w, h);
      hx.strokeStyle = '#282828'; hx.lineWidth = 2.2; hx.strokeRect(px + 0.5, py + 0.5, w, h);
      x.strokeStyle = 'rgba(255,255,255,0.22)'; x.lineWidth = 1; x.beginPath(); x.moveTo(px + 3, py + h - 3); x.lineTo(px + 3, py + 3); x.lineTo(px + w - 3, py + 3); x.stroke();
      if (w > 40 && h > 40) for (const [rx, ry] of [[7, 7], [w - 7, 7], [7, h - 7], [w - 7, h - 7]]) {
        x.fillStyle = 'rgba(0,0,0,0.45)'; x.beginPath(); x.arc(px + rx, py + ry, 2.2, 0, 7); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.arc(px + rx - 0.6, py + ry - 0.6, 1, 0, 7); x.fill();
        hx.fillStyle = '#d0d0d0'; hx.beginPath(); hx.arc(px + rx, py + ry, 2.4, 0, 7); hx.fill();
      }
      if (rnd() < 0.22 && w > 50 && h > 30) { // vent slats
        for (let i = 0; i < 4; i++) { x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(px + w * 0.25, py + h * 0.3 + i * 6, w * 0.5, 3); hx.fillStyle = '#303030'; hx.fillRect(px + w * 0.25, py + h * 0.3 + i * 6, w * 0.5, 3); }
      }
      if (rnd() < 0.12) { x.fillStyle = 'rgba(255,190,40,0.35)'; for (let i = 0; i < w; i += 14) x.fillRect(px + i, py + h - 9, 7, 5); } // hazard ticks
      return;
    }
    if (w >= h) { const k = Math.round(w * (0.35 + rnd() * 0.3)); split(px, py, k, h, d - 1); split(px + k, py, w - k, h, d - 1); }
    else { const k = Math.round(h * (0.35 + rnd() * 0.3)); split(px, py, w, k, d - 1); split(px, py + k, w, h - k, d - 1); }
  };
  split(0, 0, S, S, 6);
  for (let i = 0; i < 260; i++) { // scratches and chips
    const sx = rnd() * S, sy = rnd() * S, a = rnd() * 6.28, l = 4 + rnd() * 26;
    x.strokeStyle = rnd() < 0.6 ? `rgba(255,255,255,${0.08 + rnd() * 0.14})` : `rgba(0,0,0,${0.1 + rnd() * 0.15})`; x.lineWidth = 0.6 + rnd();
    x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); x.stroke();
  }
  const img = x.getImageData(0, 0, S, S), d = img.data;
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) { // grime and streaks
    const i = (py * S + px) * 4, g = 0.88 + 0.12 * tile(px, py, S, 9, 61) - 0.1 * Math.pow(tile(px, py * 0.25, S, 40, 63), 3);
    d[i] *= g; d[i + 1] *= g; d[i + 2] *= g;
  }
  x.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8; map.colorSpace = THREE.SRGBColorSpace;
  const hd = hx.getImageData(0, 0, S, S).data;
  const normal = normalTexture(S, (px, py) => hd[(py * S + px) * 4] / 255, 2.4);
  return (plateCache = { map, normal });
}

class Particles {
  max: number; pts: THREE.Points; pos: Float32Array; col: Float32Array; size: Float32Array; seed: Float32Array;
  vel: Float32Array; life: Float32Array; ml: Float32Array; s0: Float32Array; grow: Float32Array; drag: Float32Array; grav: Float32Array; base: Float32Array; ramp: Uint8Array;
  head = 0; mat: THREE.ShaderMaterial; windX = 0; windZ = 0;
  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max); this.seed = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ml = new Float32Array(max);
    this.s0 = new Float32Array(max); this.grow = new Float32Array(max); this.drag = new Float32Array(max); this.grav = new Float32Array(max); this.base = new Float32Array(max * 4); this.ramp = new Uint8Array(max);
    for (let i = 0; i < max; i++) this.seed[i] = Math.random();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcol', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('pseed', new THREE.BufferAttribute(this.seed, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 }, uLit: { value: additive ? 0 : 1 } },
      vertexShader: `attribute vec4 pcol; attribute float psize; attribute float pseed; varying vec4 vc; varying float vs; uniform float scale;
        void main(){ vc=pcol; vs=pseed; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=min(700.0, psize*scale/max(1.0,-mv.z)); }`,
      fragmentShader: `varying vec4 vc; varying float vs; uniform float uLit;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 uv=gl_PointCoord-0.5; float an=vs*6.283; float c=cos(an), s=sin(an); vec2 r=vec2(uv.x*c-uv.y*s, uv.x*s+uv.y*c);
          float nz=n(r*5.0+vs*37.0)*0.65+n(r*11.0+vs*91.0)*0.35;
          float d=length(uv)+(nz-0.5)*0.24;
          float a=smoothstep(0.5,0.12,d)*vc.a; if(a<0.004) discard;
          vec3 col=vc.rgb*(0.75+0.5*nz);
          col*=mix(1.0, 0.72+0.5*(0.5-gl_PointCoord.y), uLit);
          gl_FragColor=vec4(col,a); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.pts = new THREE.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 12 : 11;
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, a: number, grow = 0, drag = 0, grav = 0, ramp = 0) {
    const i = this.head; this.head = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.ml[i] = life; this.s0[i] = size; this.grow[i] = grow; this.drag[i] = drag; this.grav[i] = grav; this.ramp[i] = ramp;
    this.base[i * 4] = r; this.base[i * 4 + 1] = g; this.base[i * 4 + 2] = b; this.base[i * 4 + 3] = a;
  }
  update(dt: number) {
    const { pos, vel, life, ml, size, col, base, ramp } = this, wx = this.windX * dt, wz = this.windZ * dt;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) { if (size[i] !== 0) size[i] = 0; continue; }
      life[i] -= dt;
      const k = Math.max(0, life[i] / ml[i]), dr = 1 - this.drag[i] * dt;
      vel[i * 3] = vel[i * 3] * dr + wx; vel[i * 3 + 1] = vel[i * 3 + 1] * dr - this.grav[i] * dt; vel[i * 3 + 2] = vel[i * 3 + 2] * dr + wz;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      size[i] = this.s0[i] * (1 + this.grow[i] * (1 - k));
      if (ramp[i]) { // hot white-yellow -> orange -> deep red as it cools
        col[i * 4] = base[i * 4]; col[i * 4 + 1] = base[i * 4 + 1] * (0.15 + 0.85 * k); col[i * 4 + 2] = base[i * 4 + 2] * k * k;
        col[i * 4 + 3] = base[i * 4 + 3] * Math.min(1, k * 3) * Math.min(1, (1 - k) * 8 + 0.3);
      } else {
        col[i * 4] = base[i * 4]; col[i * 4 + 1] = base[i * 4 + 1]; col[i * 4 + 2] = base[i * 4 + 2];
        col[i * 4 + 3] = base[i * 4 + 3] * Math.min(1, k * 2.2) * Math.min(1, (1 - k) * 10 + 0.25);
      }
    }
    const g = this.pts.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.pcol.needsUpdate = true; g.attributes.psize.needsUpdate = true;
  }
}

interface Beam { ax: number; ay: number; az: number; bx: number; by: number; bz: number; life: number; max: number; w: number; c: THREE.Color }
interface Ring { x: number; y: number; z: number; life: number; max: number; size: number }
interface Frame { group: THREE.Group; solid: THREE.MeshStandardMaterial; plane: THREE.Plane; turret: THREE.Object3D | null }

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3(), _v = new THREE.Vector3(), _c = new THREE.Color();
const _yAxis = new THREE.Vector3(0, 1, 0), _zAxis = new THREE.Vector3(0, 0, 1), _xAxis = new THREE.Vector3(1, 0, 0);

export class Renderer {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null = null;
  game: Game; map: GameMap; me: Team;
  cam = { x: 0, z: 0, dist: 260, yaw: 0, pitch: 1.0 };
  time = 0; quality: number;
  private sun: THREE.DirectionalLight;
  private unitMat: THREE.MeshStandardMaterial;
  private ims = new Map<string, THREE.InstancedMesh>();
  private frames = new Map<Unit, Frame>();
  private fogTex: THREE.DataTexture; private fogData: Uint8Array; private fogCur: Float32Array;
  private water: THREE.Mesh | null = null; private waterTex: THREE.Texture | null = null; private waterUni: any = null;
  scenery!: Scenery; private terrainCol!: THREE.BufferAttribute; private terrainPos!: THREE.BufferAttribute; private terrainNrm!: THREE.BufferAttribute; private uTime = { value: 0 };
  private lights: { l: THREE.PointLight; life: number; max: number; peak: number }[] = []; private fireLight!: THREE.PointLight;
  private debris!: THREE.InstancedMesh; private dPos = new Float32Array(360 * 3); private dVel = new Float32Array(360 * 3); private dRot = new Float32Array(360 * 4); private dLife = new Float32Array(360); private dSize = new Float32Array(360); private dHead = 0;
  private later: { t: number; fn: () => void }[] = []; shake = 0; private sunDir = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
  private grade: ShaderPass | null = null; private plate!: { map: THREE.Texture; normal: THREE.Texture }; private cleared = new WeakSet<Unit>();
  fire: Particles; smoke: Particles;
  private beams: Beam[] = []; private beamIM: THREE.InstancedMesh;
  private projIM: THREE.InstancedMesh; private ringIM: THREE.InstancedMesh; private rings: Ring[] = [];
  private selIM: THREE.InstancedMesh; private wreckIM: THREE.InstancedMesh; private spotIM: THREE.InstancedMesh;
  private scorchIM: THREE.InstancedMesh; private scorchN = 0;
  ghost: THREE.Group; private ghostDef: UnitDef | null = null; private ghostMat: THREE.MeshBasicMaterial;
  private rangeRing: THREE.Mesh;
  onEvent: ((e: any, vis: boolean) => void) | null = null;
  private ray = new THREE.Raycaster();

  constructor(canvas: HTMLCanvasElement, game: Game, me: Team, quality: number) {
    this.game = game; this.map = game.map; this.me = me; this.quality = quality;
    const map = this.map, bio = map.biome;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 0, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, quality >= 2 ? 2 : 1.25));
    r.shadowMap.enabled = quality >= 1; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.localClippingEnabled = true;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(42, 1, 2, 4000);
    this.scene.background = new THREE.Color(bio.sky).multiplyScalar(0.35);
    this.scene.fog = new THREE.Fog(new THREE.Color(bio.sky).multiplyScalar(0.35).getHex(), 900, 3200);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    this.scene.add(new THREE.HemisphereLight(bio.sky, 0x30281e, bio.lava ? 0.7 : 0.95));
    const sun = this.sun = new THREE.DirectionalLight(bio.sun, bio.lava ? 1.6 : 2.4);
    sun.castShadow = quality >= 1; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
    this.scene.add(sun, sun.target);

    const plate = platingTextures();
    this.unitMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.45, map: plate.map, normalMap: plate.normal, normalScale: new THREE.Vector2(1.1, 1.1), roughnessMap: plate.map, envMapIntensity: 1.4 });
    this.plate = plate;

    // ── terrain ──
    const hn = map.hn, H = map.heights;
    const pos = new Float32Array(hn * hn * 3), col = new Float32Array(hn * hn * 3), uv = new Float32Array(hn * hn * 2);
    const cl = new THREE.Color(bio.low), cm = new THREE.Color(bio.mid), ch = new THREE.Color(bio.high), cr = new THREE.Color(bio.rock), cs = new THREE.Color(bio.shore), tmp = new THREE.Color();
    const ore = new THREE.Color(0x9aa4b4);
    for (let j = 0; j < hn; j++) for (let i = 0; i < hn; i++) {
      const k = j * hn + i, h = H[k], x = i * VS, z = j * VS;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / map.size; uv[k * 2 + 1] = z / map.size;
      const hx = H[j * hn + Math.min(hn - 1, i + 1)] - H[j * hn + Math.max(0, i - 1)], hz = H[Math.min(hn - 1, j + 1) * hn + i] - H[Math.max(0, j - 1) * hn + i];
      const slope = Math.hypot(hx, hz) / (2 * VS);
      const t = clamp(h / 64, 0, 1), nz = vnoise(x * 0.05, z * 0.05, 7) * 0.5 + vnoise(x * 0.4, z * 0.4, 9) * 0.5;
      if (t < 0.5) tmp.copy(cl).lerp(cm, t * 2); else tmp.copy(cm).lerp(ch, (t - 0.5) * 2);
      if (map.waterY > -50) { const sh = clamp(1 - (h - map.waterY) / 4, 0, 1); tmp.lerp(cs, sh); }
      tmp.lerp(cr, clamp((slope - 0.42) * 3, 0, 1));
      tmp.multiplyScalar(0.8 + nz * 0.4);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
    }
    for (const s of map.spots) {
      for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
        const d = Math.hypot(i, j); if (d > 4.2) continue;
        const k = (s.cz * 2 + j) * hn + s.cx * 2 + i; if (k < 0 || k >= hn * hn) continue;
        const w = (1 - d / 4.4) * (0.5 + 0.5 * hash2(i + s.cx * 9, j + s.cz * 5, 3));
        tmp.setRGB(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]).lerp(ore, clamp(w * 1.3, 0, 0.9));
        col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      }
    }
    const idx = new Uint32Array((hn - 1) * (hn - 1) * 6); let q = 0;
    for (let j = 0; j < hn - 1; j++) for (let i = 0; i < hn - 1; i++) {
      const a = j * hn + i, b = a + 1, c = a + hn, d = c + 1;
      if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
      else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('color', new THREE.BufferAttribute(col, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(new THREE.BufferAttribute(idx, 1)); tg.computeVertexNormals();
    const detail = noiseTexture(256, (x, y) => { const v = 150 + 105 * (tile(x, y, 256, 16, 3) * 0.5 + tile(x, y, 256, 64, 5) * 0.5); return [v, v, v, 255]; });
    detail.repeat.set(map.size / 48, map.size / 48); detail.colorSpace = THREE.SRGBColorSpace;
    this.terrainCol = tg.attributes.color as THREE.BufferAttribute; this.terrainPos = tg.attributes.position as THREE.BufferAttribute; this.terrainNrm = tg.attributes.normal as THREE.BufferAttribute;
    const tnrm = normalTexture(256, (x, y) => tile(x, y, 256, 10, 31) + tile(x, y, 256, 28, 33) * 0.5 + tile(x, y, 256, 70, 35) * 0.25, 5);
    tnrm.repeat.set(map.size / 30, map.size / 30);
    const cloud = noiseTexture(256, (x, y) => {
      const lo = tile(x, y, 256, 4, 41) * 0.6 + tile(x, y, 256, 9, 43) * 0.3 + tile(x, y, 256, 20, 45) * 0.1, hi = tile(x, y, 256, 24, 47) * 0.6 + tile(x, y, 256, 60, 49) * 0.4;
      return [lo * 255, hi * 255, 0, 255];
    });
    const tmat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, normalMap: tnrm, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.94, metalness: 0, envMapIntensity: 0.2 });
    tmat.onBeforeCompile = sh => {
      sh.uniforms.uTime = this.uTime; sh.uniforms.uCloud = { value: cloud };
      sh.vertexShader = 'varying vec2 vWxz;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWxz = position.xz;');
      sh.fragmentShader = 'varying vec2 vWxz; uniform sampler2D uCloud; uniform float uTime;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        float cl = smoothstep(0.42, 0.68, texture2D(uCloud, vWxz/1100.0 + uTime*vec2(0.0035, 0.002)).r);
        diffuseColor.rgb *= mix(1.0, 0.6, cl);
        diffuseColor.rgb *= 0.78 + 0.44*texture2D(uCloud, vWxz/53.0).g;`);
    };
    const terrain = new THREE.Mesh(tg, tmat);
    terrain.receiveShadow = true; this.scene.add(terrain);
    // skirt
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshBasicMaterial({ color: new THREE.Color(bio.fogCol) }));
    skirt.rotation.x = -Math.PI / 2; skirt.position.set(map.size / 2, Math.min(-2, map.waterY - 3), map.size / 2); this.scene.add(skirt);

    // ── fog of war ──
    const n = map.n;
    this.fogData = new Uint8Array(n * n * 4); this.fogCur = new Float32Array(n * n).fill(235);
    this.fogTex = new THREE.DataTexture(this.fogData as any, n, n, THREE.RGBAFormat);
    this.fogTex.magFilter = this.fogTex.minFilter = THREE.LinearFilter; this.fogTex.needsUpdate = true;
    const fogMat = new THREE.MeshBasicMaterial({ color: bio.fogCol, alphaMap: this.fogTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, fog: false });
    const fogMesh = new THREE.Mesh(tg, fogMat); fogMesh.renderOrder = 5; this.scene.add(fogMesh);

    // ── water / lava ──
    if (map.waterY > -50) {
      if (bio.lava) {
        const wg = new THREE.PlaneGeometry(map.size, map.size);
        this.waterTex = noiseTexture(256, (x, y) => {
          const v = tile(x, y, 256, 8, 11) * 0.6 + tile(x, y, 256, 32, 13) * 0.4, c = Math.pow(clamp((v - 0.3) * 2, 0, 1), 2);
          return [60 + 195 * c, 10 + 150 * c * c, 4 + 30 * c * c, 255];
        });
        this.waterTex.repeat.set(map.size / 160, map.size / 160); this.waterTex.colorSpace = THREE.SRGBColorSpace;
        const lm = new THREE.MeshBasicMaterial({ map: this.waterTex, fog: false }); lm.color.setScalar(2.4);
        this.water = new THREE.Mesh(wg, lm); this.water.rotation.x = -Math.PI / 2; this.water.position.set(map.size / 2, map.waterY, map.size / 2);
        this.water.renderOrder = 2; this.scene.add(this.water);
        const fuv = new Float32Array(wg.attributes.uv.count * 2);
        for (let i = 0; i < fuv.length / 2; i++) { fuv[i * 2] = wg.attributes.uv.getX(i); fuv[i * 2 + 1] = 1 - wg.attributes.uv.getY(i); }
        const wg2 = wg.clone(); wg2.setAttribute('uv', new THREE.BufferAttribute(fuv, 2));
        const wf = new THREE.Mesh(wg2, new THREE.MeshBasicMaterial({ color: bio.fogCol, alphaMap: this.fogTex, transparent: true, depthWrite: false, fog: false }));
        wf.rotation.x = -Math.PI / 2; wf.position.set(map.size / 2, map.waterY + 0.15, map.size / 2); wf.renderOrder = 6; this.scene.add(wf);
      } else {
        const w = makeWater(map, this.fogTex, this.sunDir, bio.sun);
        this.water = w.mesh; this.waterUni = w.uni; this.scene.add(w.mesh);
      }
    }

    this.scenery = new Scenery(this.scene, map, quality, map.seed);
    // dynamic lights (fixed pool so shaders never recompile)
    for (let i = 0; i < (quality >= 1 ? 3 : 1); i++) {
      const l = new THREE.PointLight(0xffa050, 0, 320, 1.4); this.scene.add(l); this.lights.push({ l, life: 0, max: 1, peak: 0 });
    }
    this.fireLight = new THREE.PointLight(0xff7a28, 0, 260, 1.5); this.scene.add(this.fireLight);
    const dm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 1.4), new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.6, metalness: 0.6, flatShading: true }), 360);
    dm.frustumCulled = false; dm.castShadow = true; dm.count = 360; this.debris = dm; this.scene.add(dm);
    _m.makeScale(0, 0, 0); for (let i = 0; i < 360; i++) dm.setMatrixAt(i, _m);

    // ── instanced helpers ──
    const addIM = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, order = 0) => {
      const im = new THREE.InstancedMesh(geo, mat, cap); im.frustumCulled = false; im.count = 0; im.renderOrder = order;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(im); return im;
    };
    const ringGeo = new THREE.RingGeometry(0.955, 1, 64); ringGeo.rotateX(-Math.PI / 2);
    this.selIM = addIM(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, fog: false }), 600, 8);
    this.selIM.setColorAt(0, _c.set(0xffffff));
    const ring2 = new THREE.RingGeometry(0.7, 1, 40); ring2.rotateX(-Math.PI / 2);
    this.ringIM = addIM(ring2, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }), 48, 10);
    this.ringIM.setColorAt(0, _c.set(0xffffff));
    const bg = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.beamIM = addIM(bg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }), 400, 10);
    this.beamIM.setColorAt(0, _c.set(0xffffff));
    this.projIM = addIM(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), 1200);
    this.projIM.setColorAt(0, _c.set(0xffffff));
    // wrecks
    const wparts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const g = new THREE.BoxGeometry(0.3 + hash2(i, 1, 5) * 0.7, 0.2 + hash2(i, 2, 5) * 0.5, 0.3 + hash2(i, 3, 5) * 0.8);
      g.rotateY(hash2(i, 4, 5) * 6); g.rotateZ((hash2(i, 5, 5) - 0.5) * 0.9); g.translate((hash2(i, 6, 5) - 0.5) * 1.3, 0.15, (hash2(i, 7, 5) - 0.5) * 1.3);
      wparts.push(g);
    }
    for (let i = 0; i < wparts.length; i++) { wparts[i] = wparts[i].toNonIndexed(); boxUV(wparts[i], 0.3); }
    this.wreckIM = addIM(mergeGeometries(wparts), new THREE.MeshStandardMaterial({ color: 0x4a3d34, roughness: 0.85, metalness: 0.55, map: plate.map, normalMap: plate.normal }), 1500);
    this.wreckIM.castShadow = true; this.wreckIM.receiveShadow = true;
    // ore crystals
    const sparts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.ConeGeometry(0.8 + hash2(i, 1, 9) * 0.9, 1.6 + hash2(i, 2, 9) * 2.6, 5);
      g.rotateZ((hash2(i, 3, 9) - 0.5) * 0.8); g.rotateY(hash2(i, 4, 9) * 6); g.translate((hash2(i, 5, 9) - 0.5) * 9, 0.6, (hash2(i, 6, 9) - 0.5) * 9);
      sparts.push(g);
    }
    this.spotIM = addIM(mergeGeometries(sparts), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.9, flatShading: true }), map.spots.length);
    this.spotIM.setColorAt(0, _c.set(0xffffff));
    const scTex = noiseTexture(64, (x, y) => { const d = Math.hypot(x - 32, y - 32) / 32; return [0, 0, 0, 255 * clamp(1 - d, 0, 1) ** 1.5 * 0.85]; });
    const sg = new THREE.PlaneGeometry(2, 2); sg.rotateX(-Math.PI / 2);
    this.scorchIM = addIM(sg, new THREE.MeshBasicMaterial({ map: scTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }), 700, 3);

    this.fire = new Particles(quality >= 1 ? 9000 : 4000, true); this.smoke = new Particles(quality >= 1 ? 4000 : 1500, false);
    this.scene.add(this.smoke.pts, this.fire.pts);

    this.ghost = new THREE.Group(); this.ghost.visible = false; this.scene.add(this.ghost);
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x40ff80, transparent: true, opacity: 0.45, depthWrite: false });
    const rr = new THREE.RingGeometry(0.992, 1, 96); rr.rotateX(-Math.PI / 2);
    this.rangeRing = new THREE.Mesh(rr, new THREE.MeshBasicMaterial({ color: 0xff6040, transparent: true, opacity: 0.6, depthTest: false, fog: false }));
    this.rangeRing.visible = false; this.rangeRing.renderOrder = 9; this.scene.add(this.rangeRing);

    if (quality >= 1) {
      const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(r, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.6, 0.92));
      this.composer.addPass(new OutputPass());
      this.grade = new ShaderPass({
        uniforms: { tDiffuse: { value: null }, uHeat: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `uniform sampler2D tDiffuse; uniform float uHeat; varying vec2 vUv;
          void main(){ vec3 c=texture2D(tDiffuse, vUv).rgb; vec2 d=vUv-0.5; float v=smoothstep(0.85, 0.25, length(d*vec2(1.0,0.82)));
            float l=dot(c, vec3(0.299,0.587,0.114)); c=mix(vec3(l), c, 1.12); c=(c-0.5)*1.06+0.5;
            c*=mix(0.62, 1.0, v); c.r+=uHeat*(1.0-v)*0.12; gl_FragColor=vec4(max(c,0.0),1.0); }`,
      });
      this.composer.addPass(this.grade);
    }
    this.cam.x = me.startX; this.cam.z = me.startZ;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
    const sc = h * this.renderer.getPixelRatio() / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    this.fire.mat.uniforms.scale.value = sc; this.smoke.mat.uniforms.scale.value = sc;
  }
  dispose() { this.renderer.dispose(); }

  // ───────────── camera / picking ─────────────
  private updateCamera() {
    const c = this.cam, S = this.map.size;
    c.x = clamp(c.x, 0, S); c.z = clamp(c.z, 0, S); c.dist = clamp(c.dist, 50, 1500); c.pitch = clamp(c.pitch, 0.45, 1.5);
    const ty = this.map.groundY(c.x, c.z);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    this.camera.position.set(c.x + Math.sin(c.yaw) * cp * c.dist, ty + sp * c.dist, c.z + Math.cos(c.yaw) * cp * c.dist);
    this.camera.lookAt(c.x, ty, c.z);
    if (this.shake > 0.01) { const k = this.shake * c.dist * 0.004; this.camera.position.x += (Math.random() - 0.5) * k; this.camera.position.y += (Math.random() - 0.5) * k; this.camera.position.z += (Math.random() - 0.5) * k; }
    this.camera.updateMatrixWorld();
    const sd = clamp(c.dist * 0.8, 140, 560);
    this.sun.target.position.set(c.x, ty, c.z);
    this.sun.position.set(c.x + this.sunDir.x * 700, ty + this.sunDir.y * 700, c.z + this.sunDir.z * 700);
    const sc = this.sun.shadow.camera; sc.left = -sd; sc.right = sd; sc.top = sd; sc.bottom = -sd; sc.near = 50; sc.far = 1400; sc.updateProjectionMatrix();
    this.sun.castShadow = this.quality >= 1 && c.dist < 800;
  }
  /** screen px → ground point */
  pick(sx: number, sy: number): { x: number; z: number } | null {
    this.ray.setFromCamera(new THREE.Vector2(sx / window.innerWidth * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction, map = this.map;
    if (d.y >= -0.01) return null;
    let t = Math.max(0, (80 - o.y) / d.y), px = 0, pz = 0, prev = t;
    for (let i = 0; i < 600; i++) {
      px = o.x + d.x * t; pz = o.z + d.z * t;
      const y = o.y + d.y * t;
      if (y <= map.groundY(px, pz)) {
        let a = prev, b = t;
        for (let k = 0; k < 8; k++) { const mid = (a + b) / 2; if (o.y + d.y * mid <= map.groundY(o.x + d.x * mid, o.z + d.z * mid)) b = mid; else a = mid; }
        return { x: clamp(o.x + d.x * b, 0, map.size), z: clamp(o.z + d.z * b, 0, map.size) };
      }
      prev = t; t += 3;
    }
    return null;
  }
  project(x: number, y: number, z: number, out: { x: number; y: number; ok: boolean }) {
    _v.set(x, y, z).project(this.camera);
    out.x = (_v.x + 1) / 2 * window.innerWidth; out.y = (1 - _v.y) / 2 * window.innerHeight; out.ok = _v.z < 1 && _v.z > -1;
  }
  shown(u: Unit) {
    if (u.team.ally === this.me.ally) return true;
    if (u.def.cls === 'building') return ((u.seen >> this.me.id) & 1) === 1;
    return (this.me.vis[this.map.cellOf(u.x, u.z)] & 2) !== 0;
  }

  setGhost(def: UnitDef | null, x = 0, z = 0, ok = true) {
    if (def !== this.ghostDef) {
      this.ghost.clear(); this.ghostDef = def;
      if (def) {
        const g = geosFor(def, this.me.id);
        if (g.b) this.ghost.add(new THREE.Mesh(g.b, this.ghostMat));
        if (g.t) { const m = new THREE.Mesh(g.t, this.ghostMat); m.position.fromArray(def.model.tp!); this.ghost.add(m); }
        if (g.s) { const m = new THREE.Mesh(g.s, this.ghostMat); m.position.fromArray(def.model.sp!); this.ghost.add(m); }
      }
    }
    this.ghost.visible = !!def; this.rangeRing.visible = false;
    if (def) {
      const y = this.map.groundY(x, z);
      this.ghost.position.set(x, y + 0.3, z); this.ghostMat.color.setHex(ok ? 0x40ff80 : 0xff4030);
      const rg = def.weapons[0]?.range || def.radar;
      if (rg) { this.rangeRing.visible = true; this.rangeRing.position.set(x, y + 2, z); this.rangeRing.scale.setScalar(rg); }
    }
  }

  // ───────────── effects ─────────────
  private flash(x: number, y: number, z: number, peak: number, dur: number, color = 0xffa050) {
    let best = this.lights[0], bv = 1e9;
    for (const L of this.lights) { const v = L.life > 0 ? L.peak * L.life / L.max : 0; if (v < bv) { bv = v; best = L; } }
    if (!best || bv > peak) return;
    best.l.position.set(x, y, z); best.l.color.setHex(color); best.life = best.max = dur; best.peak = peak;
  }
  private throwDebris(x: number, y: number, z: number, n: number, size: number, speed: number) {
    for (let k = 0; k < n; k++) {
      const i = this.dHead; this.dHead = (i + 1) % 360;
      const a = Math.random() * 6.283, e = 0.4 + Math.random() * 1.0, v = speed * (0.4 + Math.random() * 0.9);
      this.dPos[i * 3] = x; this.dPos[i * 3 + 1] = y + 1; this.dPos[i * 3 + 2] = z;
      this.dVel[i * 3] = Math.cos(a) * Math.cos(e) * v; this.dVel[i * 3 + 1] = Math.sin(e) * v; this.dVel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * v;
      _q.setFromAxisAngle(_v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * 6);
      this.dRot[i * 4] = _q.x; this.dRot[i * 4 + 1] = _q.y; this.dRot[i * 4 + 2] = _q.z; this.dRot[i * 4 + 3] = _q.w;
      this.dLife[i] = 1e9; this.dSize[i] = size * (0.4 + Math.random() * 0.9);
    }
  }
  private updateDebris(dt: number) {
    const map = this.map, P = this.dPos, V = this.dVel, R = this.dRot;
    for (let i = 0; i < 360; i++) {
      if (this.dLife[i] <= 0) continue;
      const moving = Math.abs(V[i * 3 + 1]) + Math.abs(V[i * 3]) + Math.abs(V[i * 3 + 2]) > 0.5;
      if (moving) {
        V[i * 3 + 1] -= 70 * dt;
        P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
        const gy = map.heightAt(P[i * 3], P[i * 3 + 2]) + this.dSize[i] * 0.25;
        if (P[i * 3 + 1] < gy) {
          if (gy < map.waterY) { this.dLife[i] = 0; this.smoke.spawn(P[i * 3], map.waterY + 0.5, P[i * 3 + 2], 0, 9, 0, 0.6, 2.5, 0.9, 0.95, 1, 0.5, 1.5, 1, 20); }
          P[i * 3 + 1] = gy;
          if (Math.abs(V[i * 3 + 1]) > 12) { V[i * 3 + 1] *= -0.32; V[i * 3] *= 0.55; V[i * 3 + 2] *= 0.55; } else { V[i * 3] = V[i * 3 + 1] = V[i * 3 + 2] = 0; }
        } else {
          // tumble + smoke trail
          _q.set(R[i * 4], R[i * 4 + 1], R[i * 4 + 2], R[i * 4 + 3]); _q2.setFromAxisAngle(_zAxis, dt * 9); _q.multiply(_q2);
          R[i * 4] = _q.x; R[i * 4 + 1] = _q.y; R[i * 4 + 2] = _q.z; R[i * 4 + 3] = _q.w;
          if (Math.random() < 0.35) this.smoke.spawn(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0, 1, 0, 0.9, 1.4, 0.16, 0.15, 0.14, 0.4, 2, 0.5);
          if (Math.random() < 0.2) this.fire.spawn(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0, 0, 0, 0.25, 1.6, 3, 1.6, 0.5, 0.8, 0, 0, 0, 1);
        }
      }
      const sc = this.dSize[i] * Math.min(1, this.dLife[i]);
      _q.set(R[i * 4], R[i * 4 + 1], R[i * 4 + 2], R[i * 4 + 3]); _p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); _v.setScalar(this.dLife[i] > 0 ? sc : 0);
      _m.compose(_p, _q, _v); this.debris.setMatrixAt(i, _m);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  private boom(x: number, y: number, z: number, size: number, c = 0xffa040, heavy = false) {
    const f = this.fire, s = this.smoke, q = this.quality >= 1 ? 1 : 0.5, map = this.map;
    const n = Math.min(70, 8 + size * 2.4) * q;
    const wet = map.heightAt(x, z) < map.waterY - 0.5 && y < map.waterY + 6;
    const cd = Math.hypot(x - this.cam.x, z - this.cam.z);
    this.shake = Math.min(3, this.shake + size * size * 0.012 / (1 + cd / (this.cam.dist * 0.5 + 60)));
    this.flash(x, y + 4 + size * 0.3, z, clamp(size * 110, 300, 7000), 0.25 + size * 0.02, wet ? 0xcfe8ff : 0xffa860);
    if (wet) {
      // water plume
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, v = size * (0.3 + Math.random() * 1.2);
        s.spawn(x + Math.cos(a) * size * 0.2, map.waterY + 0.5, z + Math.sin(a) * size * 0.2, Math.cos(a) * v, size * (2.5 + Math.random() * 5), Math.sin(a) * v, 0.8 + Math.random() * 0.8, size * 0.9, 0.9, 0.96, 1, 0.75, 1.4, 0.8, 40);
      }
      for (let i = 0; i < n * 0.5; i++) { const a = Math.random() * 6.283, v = size * (1.5 + Math.random() * 2); s.spawn(x, map.waterY + 0.3, z, Math.cos(a) * v, 1, Math.sin(a) * v, 1.2, size * 1.1, 0.85, 0.93, 1, 0.5, 2.2, 2.2); }
      if (this.rings.length < 40) this.rings.push({ x, y: map.waterY + 0.4, z, life: 0.9, max: 0.9, size: size * 3 });
      return;
    }
    // white-hot core, rolling fireball, sparks
    f.spawn(x, y + size * 0.3, z, 0, 0, 0, 0.12, size * 6, 3, 2.4, 1.6, 0.9, 0.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, e = Math.random() * 1.5, v = size * (1 + Math.random() * 3.2);
      f.spawn(x, y + 1, z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v * 1.1 + size * 0.6, Math.sin(a) * Math.cos(e) * v, 0.35 + Math.random() * 0.6 + size * 0.012, size * (0.8 + Math.random() * 1.0), 2.5, 1.4, 0.45, 0.8, 0.9, 3.2, -4, 1);
    }
    for (let i = 0; i < n * 0.6; i++) {
      const a = Math.random() * 6.283, v = size * (3 + Math.random() * 7);
      f.spawn(x, y + 1, z, Math.cos(a) * v, size * (2 + Math.random() * 6), Math.sin(a) * v, 0.5 + Math.random() * 0.9, 1.1 + Math.random(), 3.4, 2.4, 1, 1, 0, 0.7, 65, 1);
    }
    // smoke: rising column plus a low dust skirt
    for (let i = 0; i < n * 0.55; i++) {
      const a = Math.random() * 6.283, v = size * (0.3 + Math.random() * 1.2), g = 0.06 + Math.random() * 0.08;
      s.spawn(x + Math.cos(a) * size * 0.35, y + 1 + Math.random() * size * 0.4, z + Math.sin(a) * size * 0.35, Math.cos(a) * v, size * (0.7 + Math.random() * 1.3), Math.sin(a) * v, 1.4 + Math.random() * 1.8 + size * 0.05, size * 1.5, g, g, g, 0.62, 2.2, 1.1, -1.5);
    }
    _c.setHex(map.biome.low);
    for (let i = 0; i < n * 0.4; i++) {
      const a = Math.random() * 6.283, v = size * (2 + Math.random() * 2.5);
      s.spawn(x, y + 0.6, z, Math.cos(a) * v, 1 + Math.random() * 2, Math.sin(a) * v, 0.9 + Math.random() * 0.7, size * 1.1, _c.r * 0.8 + 0.1, _c.g * 0.8 + 0.1, _c.b * 0.8 + 0.1, 0.3, 2.6, 2.4);
    }
    if (heavy || size > 9) for (let i = 0; i < 14 * q; i++) { // mushroom stem
      const g = 0.05 + Math.random() * 0.06;
      s.spawn(x + (Math.random() - 0.5) * size * 0.4, y + 2, z + (Math.random() - 0.5) * size * 0.4, 0, size * (1.5 + Math.random() * 2.2), 0, 2.5 + Math.random() * 2, size * 1.3, g, g, g, 0.7, 2.6, 0.9, -2);
    }
    if (this.rings.length < 40) this.rings.push({ x, y: y + 0.8, z, life: 0.45, max: 0.45, size: size * 3.4 });
    if (y < map.groundY(x, z) + 8) {
      const i = this.scorchN++ % 700; map.normalAt(x, z, _n);
      _q.setFromUnitVectors(_up, _n); _p.set(x, map.heightAt(x, z) + 0.15, z); _s.setScalar(size * 1.5);
      _m.compose(_p, _q, _s); this.scorchIM.setMatrixAt(i, _m); this.scorchIM.count = Math.min(700, this.scorchN); this.scorchIM.instanceMatrix.needsUpdate = true;
      _s.set(1, 1, 1);
    }
  }
  private consumeEvents() {
    const g = this.game, me = this.me, map = this.map;
    for (const e of g.events) {
      const vis = (me.vis[map.cellOf(e.x, e.z)] & 2) !== 0 || (e.tx !== undefined && (me.vis[map.cellOf(e.tx, e.tz!)] & 2) !== 0);
      if (this.onEvent) this.onEvent(e, vis);
      if (!vis) continue;
      switch (e.t) {
        case 'beam': {
          const c = new THREE.Color(e.c!);
          this.beams.push({ ax: e.x, ay: e.y, az: e.z, bx: e.tx!, by: e.ty!, bz: e.tz!, life: e.big ? 0.55 : 0.14, max: e.big ? 0.55 : 0.14, w: e.big ? 1.6 : 0.32, c: c.clone().multiplyScalar(e.big ? 5 : 3.2) });
          this.fire.spawn(e.x, e.y, e.z, 0, 0, 0, 0.08, e.big ? 16 : 4.5, c.r * 3, c.g * 3, c.b * 3, 0.9);
          this.fire.spawn(e.tx!, e.ty!, e.tz!, 0, 0, 0, 0.14, e.big ? 26 : 6, c.r * 2, c.g * 2, c.b * 2, 0.8);
          if (e.big) { this.boom(e.tx!, e.ty!, e.tz!, 9, e.c); this.flash(e.x, e.y, e.z, 5000, 0.4, e.c); }
          else {
            for (let i = 0; i < 3; i++) this.fire.spawn(e.tx!, e.ty!, e.tz!, (Math.random() - 0.5) * 34, Math.random() * 28, (Math.random() - 0.5) * 34, 0.35, 1.1, 3, 2.2, 1, 1, 0, 1, 60, 1);
            if (Math.random() < 0.3) this.smoke.spawn(e.tx!, e.ty!, e.tz!, 0, 4, 0, 0.7, 2, 0.2, 0.2, 0.2, 0.3, 2, 1);
          }
          break;
        }
        case 'muzzle': {
          const s = e.size || 1;
          this.fire.spawn(e.x, e.y, e.z, 0, 0, 0, 0.09, 8 * s, 3.4, 2.6, 1.4, 1, 0, 0, 0, 1);
          for (let i = 0; i < 4 * s; i++) this.smoke.spawn(e.x, e.y, e.z, (Math.random() - 0.5) * 8, 2 + Math.random() * 5, (Math.random() - 0.5) * 8, 0.8 + Math.random() * 0.5, 2.2 * s, 0.45, 0.44, 0.42, 0.32, 2.4, 1.4);
          if (s > 1.5) { this.flash(e.x, e.y + 2, e.z, 2600, 0.14); this.shake = Math.min(3, this.shake + 0.25 / (1 + Math.hypot(e.x - this.cam.x, e.z - this.cam.z) / 200)); }
          break;
        }
        case 'boom': this.boom(e.x, e.y, e.z, e.size!, e.c); break;
        case 'die': {
          const u = e.u!, d = u.def, big = !!d.blast, sz = e.size! * (big ? 5 : 1.6);
          this.boom(e.x, e.y + 2, e.z, sz, 0xffa040, big);
          this.throwDebris(e.x, e.y + d.h * 0.4, e.z, Math.min(26, 3 + d.r * 1.4) * (this.quality >= 1 ? 1 : 0.4), Math.min(3.2, 0.7 + d.r * 0.14), 18 + d.r * 2.2 + (big ? 30 : 0));
          if (d.cls === 'building' || big) {
            const k = big ? 7 : 2 + (d.r > 12 ? 2 : 0);
            for (let i = 0; i < k; i++) {
              const ox = (Math.random() - 0.5) * d.r * (big ? 5 : 1.6), oz = (Math.random() - 0.5) * d.r * (big ? 5 : 1.6);
              this.later.push({ t: 0.1 + Math.random() * (big ? 0.9 : 0.6), fn: () => this.boom(e.x + ox, this.map.groundY(e.x + ox, e.z + oz) + 2, e.z + oz, sz * (0.35 + Math.random() * 0.35)) });
            }
          }
          if (d.naval || d.water) for (let i = 0; i < 12; i++) this.smoke.spawn(e.x + (Math.random() - 0.5) * d.r, this.map.waterY + 0.4, e.z + (Math.random() - 0.5) * d.r, 0, 6 + Math.random() * 10, 0, 1.2, d.r * 0.5, 0.9, 0.96, 1, 0.6, 1.6, 0.8, 26);
          break;
        }
        case 'built': {
          for (let i = 0; i < 18; i++) { const a = i / 18 * 6.283, r = e.u!.def.r; this.fire.spawn(e.x + Math.cos(a) * r, e.y + 1, e.z + Math.sin(a) * r, 0, 14, 0, 0.6, 2, 0.4, 2.2, 1.4, 0.9); }
          break;
        }
      }
    }
    g.events.length = 0;
  }

  // ───────────── frame ─────────────
  private im(def: UnitDef, team: number, part: 'b' | 't' | 's', geo: THREE.BufferGeometry): THREE.InstancedMesh {
    const key = def.id + '|' + team + '|' + part;
    let im = this.ims.get(key);
    if (!im || im.count >= im.instanceMatrix.count) {
      const cap = im ? im.instanceMatrix.count * 2 : 24;
      if (im) { this.scene.remove(im); im.dispose(); }
      im = new THREE.InstancedMesh(geo, this.unitMat, cap);
      im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(im); this.ims.set(key, im);
      (im as any)._n = 0;
    }
    return im;
  }

  private frameFor(u: Unit): Frame {
    let f = this.frames.get(u);
    if (!f) {
      const g = geosFor(u.def, u.team.id), group = new THREE.Group();
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
      const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.45, map: this.plate.map, normalMap: this.plate.normal, clippingPlanes: [plane] });
      const wire = new THREE.MeshBasicMaterial({ color: 0x40ffb0, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false });
      let turret: THREE.Object3D | null = null;
      const add = (geo: THREE.BufferGeometry | null, piv?: number[]) => {
        if (!geo) return null;
        const o = new THREE.Group(); if (piv) o.position.fromArray(piv);
        o.add(new THREE.Mesh(geo, solid), new THREE.Mesh(geo, wire)); group.add(o); return o;
      };
      add(g.b); turret = add(g.t, u.def.model.tp); add(g.s, u.def.model.sp);
      this.scene.add(group);
      f = { group, solid, plane, turret }; this.frames.set(u, f);
    }
    return f;
  }

  frame(alpha: number, dt: number, selected: Set<Unit>, paused: boolean) {
    const g = this.game, map = this.map, me = this.me;
    this.time += dt;
    this.updateCamera();
    this.consumeEvents();
    for (const im of this.ims.values()) (im as any)._n = 0;
    let nSel = 0;
    const seenFrames = new Set<Unit>();
    const T = this.time, fireP = this.fire;
    for (const u of g.units) {
      if (u.dead || !this.shown(u)) continue;
      const d = u.def;
      if (d.cls === 'building' && !this.cleared.has(u)) { this.cleared.add(u); this.scenery.clear(u.cx, u.cz, d.fw, d.fh); }
      const x = lerp(u.px, u.x, alpha), z = lerp(u.pz, u.z, alpha);
      let y = lerp(u.py, u.y, alpha);
      const h = u.ph + angDiff(u.ph, u.heading) * alpha;
      if (!u.built) {
        const f = this.frameFor(u); seenFrames.add(u);
        f.group.position.set(x, y, z); f.group.rotation.y = h;
        f.plane.constant = y + 0.2 + u.progress * d.h * 1.25;
        if (!paused && Math.random() < 0.3) {
          const a = Math.random() * 6.283, r = Math.random() * d.r * 0.8;
          fireP.spawn(x + Math.cos(a) * r, y + u.progress * d.h * 1.1, z + Math.sin(a) * r, 0, 5, 0, 0.35, 1.3, 0.3, 2.4, 1.5, 0.9);
        }
      } else {
        if (d.naval) {
          _q.setFromAxisAngle(_yAxis, h); _q2.setFromAxisAngle(_zAxis, Math.sin(T * 1.1 + u.id) * 0.035); _q.multiply(_q2);
          _q2.setFromAxisAngle(_xAxis, Math.sin(T * 0.8 + u.id * 2) * 0.025); _q.multiply(_q2); y += Math.sin(T * 1.3 + u.id) * 0.3;
        } else if (d.cls === 'ground') {
          if (d.bot) { if (u.speed > 1) y += Math.abs(Math.sin(T * 9 + u.id)) * 0.5; _q.setFromAxisAngle(_yAxis, h); }
          else { map.normalAt(x, z, _n); _q.setFromUnitVectors(_up, _n); _q2.setFromAxisAngle(_yAxis, h); _q.multiply(_q2); }
        } else if (d.cls === 'air') {
          _q.setFromAxisAngle(_yAxis, h); _q2.setFromAxisAngle(_zAxis, -u.bank); _q.multiply(_q2);
          if (d.hover) y += Math.sin(T * 2 + u.id) * 0.8;
        } else _q.setFromAxisAngle(_yAxis, h);
        _p.set(x, y, z); _m.compose(_p, _q, _s);
        const geo = geosFor(d, u.team.id);
        if (geo.b) { const im = this.im(d, u.team.id, 'b', geo.b); im.setMatrixAt((im as any)._n++, _m); im.count = (im as any)._n; }
        if (geo.t) {
          const tp = d.model.tp!, th = u.pturret + angDiff(u.pturret, u.turret) * alpha;
          _q2.setFromAxisAngle(_yAxis, th - h); _p.set(tp[0], tp[1], tp[2]); _m2.compose(_p, _q2, _s); _m2.premultiply(_m);
          const im = this.im(d, u.team.id, 't', geo.t); im.setMatrixAt((im as any)._n++, _m2); im.count = (im as any)._n;
        }
        if (geo.s) {
          const sp = d.model.sp!, rate = d.wind ? g.wind * 1.5 + 0.1 : d.extract && u.team.lowPower ? 0.2 : 1;
          _q2.setFromAxisAngle(d.model.sa === 'z' ? _zAxis : _yAxis, T * (d.model.ss || 1) * rate + u.id);
          _p.set(sp[0], sp[1], sp[2]); _m2.compose(_p, _q2, _s); _m2.premultiply(_m);
          const im = this.im(d, u.team.id, 's', geo.s); im.setMatrixAt((im as any)._n++, _m2); im.count = (im as any)._n;
        }
        if (!paused) {
          // nano spray
          if (u.nano && u.nanoTick >= g.tick - 2) {
            const n = u.nano, ty = n.y + (n.def ? n.def.h * 0.5 * Math.random() : 1), sy = y + d.h * 0.7;
            const tx = n.x + (Math.random() - 0.5) * (n.def ? n.def.r : 3), tz = n.z + (Math.random() - 0.5) * (n.def ? n.def.r : 3);
            const dd = Math.hypot(tx - x, ty - sy, tz - z) || 1, sp = 90, life = dd / sp;
            for (let i = 0; i < 2; i++) fireP.spawn(x, sy, z, (tx - x) / dd * sp, (ty - sy) / dd * sp, (tz - z) / dd * sp, life * (0.7 + Math.random() * 0.3), 1.5, 0.3, 2.4, 1.3, 0.9);
          }
          if (u.hp < d.hp * 0.5) {
            const sev = 1 - u.hp / (d.hp * 0.5), ox = (Math.random() - 0.5) * d.r, oz = (Math.random() - 0.5) * d.r;
            if (Math.random() < 0.1 + sev * 0.2) this.smoke.spawn(x + ox, y + d.h * 0.7, z + oz, (Math.random() - 0.5) * 3, 7 + Math.random() * 4, (Math.random() - 0.5) * 3, 1.6 + Math.random(), 3 + d.r * 0.2, 0.08, 0.08, 0.08, 0.55, 2, 0.4, -1);
            if (sev > 0.3 && Math.random() < sev * 0.35) fireP.spawn(x + ox * 0.7, y + d.h * 0.5, z + oz * 0.7, 0, 8 + Math.random() * 6, 0, 0.4 + Math.random() * 0.3, 2.5 + d.r * 0.25, 2.2, 1.1, 0.3, 0.7, -0.4, 0.5, -5, 1);
          }
          if (d.cls === 'ground' && u.speed > 4) {
            const bx = x - Math.sin(h) * d.r * 0.9, bz = z - Math.cos(h) * d.r * 0.9;
            if (d.naval) {
              if (Math.random() < 0.7) this.smoke.spawn(bx + (Math.random() - 0.5) * d.r * 0.6, map.waterY + 0.25, bz + (Math.random() - 0.5) * d.r * 0.6, (Math.random() - 0.5) * 2, 0.4, (Math.random() - 0.5) * 2, 1.8 + Math.random(), d.r * 0.55, 0.88, 0.95, 1, 0.34, 2.4, 1);
              if (Math.random() < 0.3) this.smoke.spawn(x + Math.sin(h) * d.r, map.waterY + 0.6, z + Math.cos(h) * d.r, Math.cos(h) * 4 * (Math.random() < 0.5 ? 1 : -1), 4, -Math.sin(h) * 4 * (Math.random() < 0.5 ? 1 : -1), 0.6, d.r * 0.3, 0.95, 0.98, 1, 0.5, 1.5, 1, 18);
            } else if (!d.bot && Math.random() < 0.3) { _c.setHex(map.biome.low); this.smoke.spawn(bx, y + 0.6, bz, (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.9 + Math.random() * 0.6, 2 + d.r * 0.25, _c.r * 0.7 + 0.15, _c.g * 0.7 + 0.15, _c.b * 0.7 + 0.15, 0.2, 2.6, 1.2); }
          }
          if (d.cls === 'air' && !d.hover && Math.random() < 0.5) fireP.spawn(x - Math.sin(h) * d.r, y, z - Math.cos(h) * d.r, 0, 0, 0, 0.25, 1.6, 2.4, 1.4, 0.5, 0.7);
        }
      }
      if (selected.has(u) && nSel < 600) {
        _q.identity(); _p.set(x, (d.cls === 'air' ? map.groundY(x, z) : y) + 0.6, z); const r = d.r * 1.3; _v.set(r, 1, r);
        _m.compose(_p, _q, _v); this.selIM.setMatrixAt(nSel, _m);
        this.selIM.setColorAt(nSel, _c.setHex(u.team === me ? 0x60ff90 : u.team.ally === me.ally ? 0xffe060 : 0xff5040)); nSel++;
      }
    }
    for (const im of this.ims.values()) { im.count = (im as any)._n; im.instanceMatrix.needsUpdate = true; }
    this.selIM.count = nSel; this.selIM.instanceMatrix.needsUpdate = true; if (this.selIM.instanceColor) this.selIM.instanceColor.needsUpdate = true;
    for (const [u, f] of this.frames) if (!seenFrames.has(u)) { this.scene.remove(f.group); f.solid.dispose(); this.frames.delete(u); }

    // wrecks
    let nw = 0;
    for (const w of g.wrecks) {
      if (nw >= 1500 || !(me.vis[map.cellOf(w.x, w.z)] & 1)) continue;
      _q.setFromAxisAngle(_yAxis, w.rot); _p.set(w.x, w.y, w.z); _v.setScalar(w.r * (0.6 + 0.4 * w.metal / w.max));
      _m.compose(_p, _q, _v); this.wreckIM.setMatrixAt(nw++, _m);
      const age = (g.tick - w.born) / TICK;
      if (!paused && age < 50 && (me.vis[map.cellOf(w.x, w.z)] & 2)) {
        if (Math.random() < 0.09 * (1 - age / 50)) this.smoke.spawn(w.x, w.y + 1.5, w.z, (Math.random() - 0.5) * 2, 6 + Math.random() * 4, (Math.random() - 0.5) * 2, 2.4 + Math.random() * 1.5, 2.5 + w.r * 0.3, 0.07, 0.07, 0.07, 0.5, 2.4, 0.3, -0.8);
        if (age < 16 && Math.random() < 0.18) fireP.spawn(w.x + (Math.random() - 0.5) * w.r * 0.6, w.y + 1, w.z + (Math.random() - 0.5) * w.r * 0.6, 0, 7 + Math.random() * 5, 0, 0.35 + Math.random() * 0.3, 2 + w.r * 0.25, 2.2, 1.1, 0.3, 0.7, -0.4, 0.5, -5, 1);
      }
    }
    this.wreckIM.count = nw; this.wreckIM.instanceMatrix.needsUpdate = true;
    // ore spots
    let ns = 0;
    for (const s of map.spots) {
      const v = me.vis[map.cellOf(s.x, s.z)];
      if (!(v & 1) || s.taken) continue;
      _q.setFromAxisAngle(_yAxis, s.id); _p.set(s.x, map.heightAt(s.x, s.z), s.z); _v.setScalar(1);
      _m.compose(_p, _q, _v); this.spotIM.setMatrixAt(ns, _m);
      const pulse = 0.85 + 0.25 * Math.sin(T * 2 + s.id);
      this.spotIM.setColorAt(ns, _c.setRGB(0.75, 0.85, 1).multiplyScalar(v & 2 ? pulse * (s.rich > 3 ? 1.6 : 1) : 0.3)); ns++;
    }
    this.spotIM.count = ns; this.spotIM.instanceMatrix.needsUpdate = true; if (this.spotIM.instanceColor) this.spotIM.instanceColor.needsUpdate = true;

    // projectiles
    let np = 0;
    for (const p of g.projs) {
      if (np >= 1200) break;
      const x = lerp(p.px, p.x, alpha), y = lerp(p.py, p.y, alpha), z = lerp(p.pz, p.z, alpha);
      if (!(me.vis[map.cellOf(x, z)] & 2)) continue;
      const big = p.w.dmg > 250;
      _q.identity(); _p.set(x, y, z); _v.setScalar(p.k === 1 ? 0.7 : big ? 1.7 : p.k === 2 ? 1.2 : 0.9);
      _m.compose(_p, _q, _v); this.projIM.setMatrixAt(np, _m);
      this.projIM.setColorAt(np, _c.setHex(p.w.color).multiplyScalar(p.k === 2 ? 0.6 : 3.5)); np++;
      if (!paused) {
        if (p.k === 1) {
          this.smoke.spawn(x, y, z, (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.6, 1.5, 0.75, 0.75, 0.75, 0.35, 1.6, 0.5);
          fireP.spawn(x, y, z, 0, 0, 0, 0.1, 2.6, 3, 1.6, 0.5, 0.9);
        } else if (p.k === 0) fireP.spawn(x, y, z, 0, 0, 0, big ? 0.3 : 0.14, big ? 3.4 : 1.8, 2.6, 1.3, 0.4, 0.6);
      }
    }
    this.projIM.count = np; this.projIM.instanceMatrix.needsUpdate = true; if (this.projIM.instanceColor) this.projIM.instanceColor.needsUpdate = true;

    // beams
    let nb = 0;
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]; b.life -= dt;
      if (b.life <= 0) { this.beams.splice(i, 1); continue; }
      if (nb >= 400) continue;
      const dx = b.bx - b.ax, dy = b.by - b.ay, dz = b.bz - b.az, len = Math.hypot(dx, dy, dz) || 1, k = b.life / b.max;
      _n.set(dx / len, dy / len, dz / len); _q.setFromUnitVectors(_up, _n);
      _p.set((b.ax + b.bx) / 2, (b.ay + b.by) / 2, (b.az + b.bz) / 2); _v.set(b.w * k, len, b.w * k);
      _m.compose(_p, _q, _v); this.beamIM.setMatrixAt(nb, _m); this.beamIM.setColorAt(nb, _c.copy(b.c).multiplyScalar(0.3 + 0.7 * k)); nb++;
    }
    this.beamIM.count = nb; this.beamIM.instanceMatrix.needsUpdate = true; if (this.beamIM.instanceColor) this.beamIM.instanceColor.needsUpdate = true;
    // shock rings
    let nr = 0;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.life -= dt;
      if (r.life <= 0) { this.rings.splice(i, 1); continue; }
      const k = 1 - r.life / r.max, sc = r.size * (0.2 + k);
      _q.identity(); _p.set(r.x, r.y, r.z); _v.set(sc, 1, sc); _m.compose(_p, _q, _v);
      this.ringIM.setMatrixAt(nr, _m); this.ringIM.setColorAt(nr, _c.setRGB(1.6, 1.1, 0.6).multiplyScalar((1 - k) * (1 - k))); nr++;
    }
    this.ringIM.count = nr; this.ringIM.instanceMatrix.needsUpdate = true; if (this.ringIM.instanceColor) this.ringIM.instanceColor.needsUpdate = true;

    // ── spreading fires ──
    const burning = g.burning, n = map.n;
    let fx = 0, fy = 0, fz = 0, fn = 0;
    if (burning.length) {
      const prob = Math.min(1, (this.quality >= 1 ? 170 : 50) / burning.length) * Math.min(1, dt * 60);
      for (let k = 0; k < burning.length; k++) {
        const c = burning[k]; if (!(me.vis[c] & 2)) continue;
        const cx = (c % n + 0.5) * CELL, cz = (((c / n) | 0) + 0.5) * CELL;
        if (Math.abs(cx - this.cam.x) + Math.abs(cz - this.cam.z) < 420) { fx += cx; fz += cz; fn++; }
        if (paused || Math.random() > prob) continue;
        const tall = this.scenery.tallAt(c), blk = map.block[c] > 0;
        const x = cx + (Math.random() - 0.5) * CELL * 1.1, z = cz + (Math.random() - 0.5) * CELL * 1.1;
        const y = map.groundY(x, z) + (blk ? 2 + Math.random() * 7 : tall ? Math.random() * 6 : 0.5);
        const sz = (tall ? 8 : blk ? 7 : 5) * (0.7 + Math.random() * 0.7);
        fireP.spawn(x, y, z, (Math.random() - 0.5) * 4, 9 + Math.random() * 10, (Math.random() - 0.5) * 4, 0.45 + Math.random() * 0.45, sz * 0.55, 1.9, 0.62, 0.1, 0.6, -0.6, 0.4, -12, 1);
        if (Math.random() < 0.4) fireP.spawn(x, y + 0.6, z, 0, 5, 0, 0.28, sz * 0.3, 2.6, 1.7, 0.5, 0.5, 0, 0, 0, 1);
        if (Math.random() < 0.3) { const gcol = 0.05 + Math.random() * 0.07; this.smoke.spawn(x, y + 5 + Math.random() * 4, z, 0, 9 + Math.random() * 6, 0, 3 + Math.random() * 2.5, sz * 1.1, gcol, gcol, gcol, 0.5, 2.6, 0.25, -1.2); }
        if (Math.random() < 0.12) fireP.spawn(x, y + 2, z, (Math.random() - 0.5) * 10, 16 + Math.random() * 14, (Math.random() - 0.5) * 10, 1.4 + Math.random(), 0.9, 3.4, 2.2, 0.8, 1, 0, 0.3, 6, 1);
      }
    }
    if (fn) {
      fx /= fn; fz /= fn; fy = map.groundY(fx, fz) + 14;
      this.fireLight.position.set(fx, fy, fz);
      this.fireLight.intensity = lerp(this.fireLight.intensity, Math.min(1, fn / 6) * 700 * (0.75 + 0.25 * Math.sin(T * 17) * Math.sin(T * 7.3)), 0.2);
    } else this.fireLight.intensity *= 0.9;
    if (g.craters.length) {
      const pos = this.terrainPos, nrm = this.terrainNrm, col = this.terrainCol.array as Float32Array, hn = map.hn, H = map.heights;
      for (const cr of g.craters) {
        const i0 = Math.max(1, Math.floor((cr.x - cr.r) / VS) - 1), i1 = Math.min(hn - 2, Math.ceil((cr.x + cr.r) / VS) + 1);
        const j0 = Math.max(1, Math.floor((cr.z - cr.r) / VS) - 1), j1 = Math.min(hn - 2, Math.ceil((cr.z + cr.r) / VS) + 1);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * hn + i; pos.setY(k, H[k]);
          const dx = H[k + 1] - H[k - 1], dz = H[k + hn] - H[k - hn], l = Math.hypot(dx, 2 * VS, dz);
          nrm.setXYZ(k, -dx / l, 2 * VS / l, -dz / l);
          const d = Math.hypot(i * VS - cr.x, j * VS - cr.z) / cr.r;
          if (d < 1) { const w = (1 - d) * 0.8, a = 0.05 + Math.random() * 0.04; col[k * 3] = lerp(col[k * 3], a * 1.2, w); col[k * 3 + 1] = lerp(col[k * 3 + 1], a, w); col[k * 3 + 2] = lerp(col[k * 3 + 2], a * 0.85, w); }
        }
      }
      g.craters.length = 0; pos.needsUpdate = true; nrm.needsUpdate = true; this.terrainCol.needsUpdate = true;
    }
    if (g.burnt.length) {
      const col = this.terrainCol.array as Float32Array, hn = map.hn;
      for (const c of g.burnt) {
        this.scenery.burn(c);
        const cx = c % n, cz = (c / n) | 0;
        for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) {
          const k = ((cz * 2 + j) * hn + cx * 2 + i) * 3, w = i === 1 && j === 1 ? 0.85 : 0.6, a = 0.035 + Math.random() * 0.03;
          col[k] = lerp(col[k], a * 1.15, w); col[k + 1] = lerp(col[k + 1], a, w); col[k + 2] = lerp(col[k + 2], a * 0.9, w);
        }
      }
      g.burnt.length = 0; this.terrainCol.needsUpdate = true;
    }
    for (const L of this.lights) { if (L.life > 0) { L.life -= dt; const k = Math.max(0, L.life / L.max); L.l.intensity = L.peak * k * k; } else L.l.intensity = 0; }
    this.shake *= Math.exp(-dt * 7);
    this.uTime.value = T; if (this.waterUni) this.waterUni.uTime.value = T;
    this.scenery.update(dt, T, me.vis);
    if (this.grade) this.grade.uniforms.uHeat.value = lerp(this.grade.uniforms.uHeat.value, Math.min(1, fn / 30), 0.05);
    if (!paused) {
      for (let i = this.later.length - 1; i >= 0; i--) { const l = this.later[i]; l.t -= dt; if (l.t <= 0) { this.later.splice(i, 1); l.fn(); } }
      this.smoke.windX = Math.sin(g.windDir) * g.wind * 7; this.smoke.windZ = Math.cos(g.windDir) * g.wind * 7;
      this.updateDebris(dt); this.fire.update(dt); this.smoke.update(dt);
    }
    // fog texture
    const vis = me.vis, cur = this.fogCur, fd = this.fogData, k = Math.min(1, dt * 6);
    for (let i = 0; i < vis.length; i++) {
      const v = vis[i], target = v & 2 ? 0 : v & 1 ? 118 : 235;
      const c = cur[i] + (target - cur[i]) * k; cur[i] = c; fd[i * 4 + 1] = c;
    }
    this.fogTex.needsUpdate = true;
    if (this.waterTex) { this.waterTex.offset.x = T * 0.006; this.waterTex.offset.y = T * 0.004; }

    if (this.composer) this.composer.render(dt); else this.renderer.render(this.scene, this.camera);
  }
}

/** Renders every unit definition to a small icon (data URL) for the build menu. */
export function makeIcons(): Record<string, string> {
  const out: Record<string, string> = {};
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 112;
  let r: THREE.WebGLRenderer;
  try { r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return out; }
  r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.5));
  const dl = new THREE.DirectionalLight(0xffffff, 2.6); dl.position.set(3, 6, 4); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  const pt = platingTextures();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25, map: pt.map, normalMap: pt.normal });
  const grp = new THREE.Group(); scene.add(grp);
  for (const def of DEF_LIST) {
    grp.clear();
    const g = buildGeos(def.model, TEAM_COLORS[0]);
    if (g.b) grp.add(new THREE.Mesh(g.b, mat));
    if (g.t) { const m = new THREE.Mesh(g.t, mat); m.position.fromArray(def.model.tp!); grp.add(m); }
    if (g.s) { const m = new THREE.Mesh(g.s, mat); m.position.fromArray(def.model.sp!); grp.add(m); }
    const box = new THREE.Box3().setFromObject(grp), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()).length();
    cam.position.set(c.x + sz * 0.9, c.y + sz * 0.8, c.z + sz * 1.25); cam.lookAt(c);
    r.render(scene, cam);
    out[def.id] = canvas.toDataURL('image/png');
    g.b?.dispose(); g.t?.dispose(); g.s?.dispose();
  }
  r.dispose(); r.forceContextLoss();
  return out;
}

export type { Wreck };
