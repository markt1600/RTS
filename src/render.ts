// three.js renderer: procedural terrain, instanced procedural unit meshes, particles, beams, fog of war.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEF_LIST, Model, TEAM_COLORS, UnitDef } from './defs';
import { CELL, GameMap, VS } from './map';
import { Game, Team, Unit, Wreck } from './sim';
import { angDiff, clamp, hash2, lerp, vnoise } from './util';

const PAL: Record<string, number> = { D: 0x2b3038, M: 0x868d98, L: 0xc8ced8, K: 0x14161a, P: 0x16305e };
const GLOW: Record<string, [number, number]> = { Y: [0xffc840, 3.2], R: [0xff4020, 3.4] };

type Geos = { b: THREE.BufferGeometry | null; t: THREE.BufferGeometry | null; s: THREE.BufferGeometry | null };
const geoCache = new Map<string, Geos>();

function buildGeos(model: Model, teamCol: number): Geos {
  const groups: Record<string, THREE.BufferGeometry[]> = { b: [], t: [], s: [] };
  const col = new THREE.Color(), e = new THREE.Euler(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
  for (const p of model.parts) {
    let g: THREE.BufferGeometry;
    if (p.s === 0) g = new THREE.BoxGeometry(p.d[0], p.d[1], p.d[2]);
    else if (p.s === 1) g = new THREE.CylinderGeometry(p.d[0], p.d[1], p.d[2], 10);
    else if (p.s === 2) g = new THREE.SphereGeometry(p.d[0], 10, 7);
    else g = new THREE.ConeGeometry(p.d[0], p.d[1], 8);
    const grp = p.g || 'b';
    const piv = grp === 't' ? model.tp! : grp === 's' ? model.sp! : [0, 0, 0];
    e.set(p.r ? p.r[0] : 0, p.r ? p.r[1] : 0, p.r ? p.r[2] : 0);
    q.setFromEuler(e); pos.set(p.p[0] - piv[0], p.p[1] - piv[1], p.p[2] - piv[2]);
    // spin parts are authored relative to their pivot already
    if (grp === 's') pos.set(p.p[0], p.p[1], p.p[2]);
    m.compose(pos, q, one); g.applyMatrix4(m);
    let k = 1;
    if (p.c === 'T') col.setHex(teamCol);
    else if (p.c === 'G') { col.setHex(teamCol); col.lerp(new THREE.Color(0xffffff), 0.35); k = 3.2; }
    else if (GLOW[p.c]) { col.setHex(GLOW[p.c][0]); k = GLOW[p.c][1]; }
    else col.setHex(PAL[p.c] ?? 0x808080);
    const n = g.attributes.position.count, ca = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { ca[i * 3] = col.r * k; ca[i * 3 + 1] = col.g * k; ca[i * 3 + 2] = col.b * k; }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    groups[grp].push(g);
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

function noiseTexture(size: number, fn: (x: number, y: number) => [number, number, number, number]) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!, img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = fn(x, y), i = (y * size + x) * 4;
    img.data[i] = v[0]; img.data[i + 1] = v[1]; img.data[i + 2] = v[2]; img.data[i + 3] = v[3];
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
const tile = (x: number, y: number, s: number, f: number, seed: number) => {
  // tileable value noise
  const u = x / s * f, v = y / s * f;
  const w = (a: number, b: number) => vnoise(((a % f) + f) % f, ((b % f) + f) % f, seed);
  const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(w(ix, iy), w(ix + 1, iy), sx), lerp(w(ix, iy + 1), w(ix + 1, iy + 1), sx), sy);
};

class Particles {
  max: number; pts: THREE.Points; pos: Float32Array; col: Float32Array; size: Float32Array;
  vel: Float32Array; life: Float32Array; ml: Float32Array; s0: Float32Array; grow: Float32Array; drag: Float32Array; grav: Float32Array; base: Float32Array;
  head = 0; mat: THREE.ShaderMaterial;
  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ml = new Float32Array(max);
    this.s0 = new Float32Array(max); this.grow = new Float32Array(max); this.drag = new Float32Array(max); this.grav = new Float32Array(max); this.base = new Float32Array(max * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcol', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute vec4 pcol; attribute float psize; varying vec4 vc; uniform float scale;
        void main(){ vc=pcol; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=psize*scale/max(1.0,-mv.z); }`,
      fragmentShader: `varying vec4 vc; void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.08,d)*vc.a; if(a<0.003) discard; gl_FragColor=vec4(vc.rgb,a); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.pts = new THREE.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 12 : 11;
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, a: number, grow = 0, drag = 0, grav = 0) {
    const i = this.head; this.head = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.ml[i] = life; this.s0[i] = size; this.grow[i] = grow; this.drag[i] = drag; this.grav[i] = grav;
    this.base[i * 4] = r; this.base[i * 4 + 1] = g; this.base[i * 4 + 2] = b; this.base[i * 4 + 3] = a;
  }
  update(dt: number) {
    const { pos, vel, life, ml, size, col, base } = this;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) { if (size[i] !== 0) size[i] = 0; continue; }
      life[i] -= dt;
      const k = Math.max(0, life[i] / ml[i]), dr = 1 - this.drag[i] * dt;
      vel[i * 3] *= dr; vel[i * 3 + 1] = vel[i * 3 + 1] * dr - this.grav[i] * dt; vel[i * 3 + 2] *= dr;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      size[i] = this.s0[i] * (1 + this.grow[i] * (1 - k));
      col[i * 4] = base[i * 4]; col[i * 4 + 1] = base[i * 4 + 1]; col[i * 4 + 2] = base[i * 4 + 2];
      col[i * 4 + 3] = base[i * 4 + 3] * Math.min(1, k * 2.2);
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
const _yAxis = new THREE.Vector3(0, 1, 0), _zAxis = new THREE.Vector3(0, 0, 1);

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
  private water: THREE.Mesh | null = null; private waterTex: THREE.Texture | null = null;
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

    this.unitMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.35 });

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
    const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0, envMapIntensity: 0.2 }));
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
      const wg = new THREE.PlaneGeometry(map.size, map.size);
      let wm: THREE.Material;
      if (bio.lava) {
        this.waterTex = noiseTexture(256, (x, y) => {
          const v = tile(x, y, 256, 8, 11) * 0.6 + tile(x, y, 256, 32, 13) * 0.4, c = Math.pow(clamp((v - 0.3) * 2, 0, 1), 2);
          return [60 + 195 * c, 10 + 150 * c * c, 4 + 30 * c * c, 255];
        });
        this.waterTex.repeat.set(map.size / 160, map.size / 160); this.waterTex.colorSpace = THREE.SRGBColorSpace;
        const lm = new THREE.MeshBasicMaterial({ map: this.waterTex, fog: false }); lm.color.setScalar(2.4); wm = lm;
      } else {
        this.waterTex = noiseTexture(256, (x, y) => {
          const h = (a: number, b: number) => tile(a, b, 256, 12, 21) + tile(a, b, 256, 40, 23) * 0.4;
          const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
          return [128 + dx * 600, 128 + dy * 600, 255, 255];
        });
        this.waterTex.repeat.set(map.size / 90, map.size / 90);
        wm = new THREE.MeshStandardMaterial({ color: bio.waterCol, transparent: true, opacity: 0.8, roughness: 0.12, metalness: 0.5, normalMap: this.waterTex, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 1.6 });
      }
      this.water = new THREE.Mesh(wg, wm); this.water.rotation.x = -Math.PI / 2; this.water.position.set(map.size / 2, map.waterY, map.size / 2);
      this.water.renderOrder = 2; this.scene.add(this.water);
      const wf = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: bio.fogCol, alphaMap: this.fogTex, transparent: true, depthWrite: false, fog: false }));
      // plane uv v is flipped relative to z; fix by flipping the texture lookup via a custom uv
      const puv = wg.attributes.uv as THREE.BufferAttribute; const fuv = new Float32Array(puv.count * 2);
      for (let i = 0; i < puv.count; i++) { fuv[i * 2] = puv.getX(i); fuv[i * 2 + 1] = 1 - puv.getY(i); }
      const wg2 = wg.clone(); wg2.setAttribute('uv', new THREE.BufferAttribute(fuv, 2)); wf.geometry = wg2;
      wf.rotation.x = -Math.PI / 2; wf.position.set(map.size / 2, map.waterY + 0.15, map.size / 2); wf.renderOrder = 6; this.scene.add(wf);
    }

    // ── instanced helpers ──
    const addIM = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, order = 0) => {
      const im = new THREE.InstancedMesh(geo, mat, cap); im.frustumCulled = false; im.count = 0; im.renderOrder = order;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(im); return im;
    };
    const ringGeo = new THREE.RingGeometry(0.93, 1, 48); ringGeo.rotateX(-Math.PI / 2);
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
    this.wreckIM = addIM(mergeGeometries(wparts), new THREE.MeshStandardMaterial({ color: 0x24211f, roughness: 0.8, metalness: 0.6, flatShading: true }), 1500);
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
    this.scorchIM = addIM(sg, new THREE.MeshBasicMaterial({ map: scTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }), 220, 3);

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
    this.camera.lookAt(c.x, ty, c.z); this.camera.updateMatrixWorld();
    const sd = clamp(c.dist * 0.8, 140, 560);
    this.sun.target.position.set(c.x, ty, c.z);
    this.sun.position.set(c.x + 0.55 * 600, ty + 0.75 * 600, c.z + 0.35 * 600);
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
  private boom(x: number, y: number, z: number, size: number, c = 0xffa040) {
    const f = this.fire, s = this.smoke, n = Math.min(60, 8 + size * 2.2) * (this.quality >= 1 ? 1 : 0.5);
    _c.setHex(c);
    f.spawn(x, y + size * 0.3, z, 0, 0, 0, 0.16, size * 7, 3, 2.4, 1.6, 1, 0.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, e = Math.random() * 1.4, v = size * (1.5 + Math.random() * 4);
      f.spawn(x, y + 1, z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v * 1.2, Math.sin(a) * Math.cos(e) * v, 0.3 + Math.random() * 0.5, size * (0.5 + Math.random()), 2.6, 1.1 + Math.random() * 0.8, 0.25, 0.9, 0.5, 2.5, 6);
    }
    for (let i = 0; i < n * 0.4; i++) {
      const a = Math.random() * 6.283, v = size * (0.5 + Math.random() * 1.5);
      s.spawn(x + Math.cos(a) * size * 0.3, y + 1, z + Math.sin(a) * size * 0.3, Math.cos(a) * v, size * (0.6 + Math.random()), Math.sin(a) * v, 1 + Math.random() * 1.4, size * 1.6, 0.09, 0.08, 0.08, 0.5, 1.8, 1.2, -1);
    }
    if (size > 5) for (let i = 0; i < size; i++) {
      const a = Math.random() * 6.283, v = size * (3 + Math.random() * 5);
      f.spawn(x, y + 1, z, Math.cos(a) * v, size * (3 + Math.random() * 5), Math.sin(a) * v, 0.6 + Math.random() * 0.8, 1.6, 3, 1.6, 0.4, 1, 0, 0.6, 60);
    }
    if (this.rings.length < 40) this.rings.push({ x, y: y + 0.8, z, life: 0.45, max: 0.45, size: size * 3.2 });
    // scorch
    if (y < this.map.groundY(x, z) + 8) {
      const i = this.scorchN++ % 220; this.map.normalAt(x, z, _n);
      _q.setFromUnitVectors(_up, _n); _p.set(x, this.map.heightAt(x, z) + 0.15, z); _s.setScalar(size * 1.5);
      _m.compose(_p, _q, _s); this.scorchIM.setMatrixAt(i, _m); this.scorchIM.count = Math.min(220, this.scorchN); this.scorchIM.instanceMatrix.needsUpdate = true;
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
          this.beams.push({ ax: e.x, ay: e.y, az: e.z, bx: e.tx!, by: e.ty!, bz: e.tz!, life: e.big ? 0.5 : 0.14, max: e.big ? 0.5 : 0.14, w: e.big ? 1.5 : 0.32, c: c.multiplyScalar(e.big ? 5 : 3.2) });
          this.fire.spawn(e.tx!, e.ty!, e.tz!, 0, 0, 0, 0.14, e.big ? 26 : 6, c.r, c.g, c.b, 0.8);
          if (e.big) this.boom(e.tx!, e.ty!, e.tz!, 8, e.c);
          else for (let i = 0; i < 2; i++) this.fire.spawn(e.tx!, e.ty!, e.tz!, (Math.random() - 0.5) * 30, Math.random() * 25, (Math.random() - 0.5) * 30, 0.3, 1.2, c.r, c.g, c.b, 1, 0, 1, 50);
          break;
        }
        case 'muzzle': {
          const s = e.size || 1;
          this.fire.spawn(e.x, e.y, e.z, 0, 0, 0, 0.1, 7 * s, 3, 2.2, 1.2, 1);
          for (let i = 0; i < 3 * s; i++) this.smoke.spawn(e.x, e.y, e.z, (Math.random() - 0.5) * 6, 3 + Math.random() * 4, (Math.random() - 0.5) * 6, 0.7, 2 * s, 0.4, 0.4, 0.4, 0.35, 2, 1);
          break;
        }
        case 'boom': this.boom(e.x, e.y, e.z, e.size!, e.c); break;
        case 'die': this.boom(e.x, e.y + 2, e.z, e.size! * (e.u!.def.blast ? 5 : 1.6)); break;
        case 'built': {
          for (let i = 0; i < 14; i++) { const a = i / 14 * 6.283, r = e.u!.def.r; this.fire.spawn(e.x + Math.cos(a) * r, e.y + 1, e.z + Math.sin(a) * r, 0, 14, 0, 0.6, 2, 0.4, 2.2, 1.4, 0.9); }
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
      const solid = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.3, clippingPlanes: [plane] });
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
        if (d.cls === 'ground') {
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
          if (u.hp < d.hp * 0.4 && Math.random() < 0.12) this.smoke.spawn(x, y + d.h * 0.7, z, (Math.random() - 0.5) * 3, 6, (Math.random() - 0.5) * 3, 1.4, 3, 0.1, 0.1, 0.1, 0.5, 1.5, 0.5);
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

    if (!paused) { this.fire.update(dt); this.smoke.update(dt); }
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
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.2 });
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
