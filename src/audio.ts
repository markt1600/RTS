// Fully synthesized sound effects (WebAudio). No samples.
export class Audio {
  ctx: AudioContext | null = null; private master!: GainNode; private noise!: AudioBuffer;
  private last: Record<string, number> = {}; private voices = 0; volume = 0.5; music: Music | null = null;

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    try {
      const C = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new C();
      const comp = this.ctx.createDynamicsCompressor(); comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(comp);
      const n = this.ctx.sampleRate; this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.music = new Music(this.ctx, comp, this.noise);
      this.master.connect(this.music.reverbIn(0.22));
    } catch { this.ctx = null; }
  }
  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }
  private ok(key: string, gap: number) {
    if (!this.ctx || this.ctx.state !== 'running' || this.voices > 14) return false;
    const t = this.ctx.currentTime; if (t - (this.last[key] || -9) < gap) return false;
    this.last[key] = t; return true;
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number) {
    const c = this.ctx!, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
    this.voices++; o.onended = () => this.voices--;
  }
  private burst(dur: number, vol: number, f0: number, f1: number, q = 0.7) {
    const c = this.ctx!, t = c.currentTime, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; s.loop = true; f.type = 'lowpass'; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t, Math.random()); s.stop(t + dur + 0.02);
    this.voices++; s.onended = () => this.voices--;
  }
  /** v: 0..1 loudness from distance */
  laser(v: number, big = false) {
    if (v < 0.03 || !this.ok(big ? 'lz2' : 'lz', big ? 0.1 : 0.05)) return;
    if (big) { this.tone('sawtooth', 320, 60, 0.6, 0.3 * v); this.tone('sine', 1400, 200, 0.5, 0.2 * v); }
    else this.tone('sawtooth', 1500 + Math.random() * 500, 300, 0.11, 0.07 * v);
  }
  cannon(v: number, big: boolean) {
    if (v < 0.03 || !this.ok('cn', 0.06)) return;
    this.burst(big ? 0.5 : 0.22, (big ? 0.5 : 0.28) * v, big ? 900 : 1600, 90); this.tone('sine', big ? 90 : 140, 40, big ? 0.4 : 0.18, 0.4 * v);
  }
  missile(v: number) { if (v < 0.03 || !this.ok('ms', 0.07)) return; this.burst(0.35, 0.14 * v, 600, 3000, 2); }
  boom(v: number, size: number) {
    if (v < 0.03 || !this.ok('bm', 0.05)) return;
    const s = Math.min(1, size / 20);
    this.burst(0.35 + s * 1.2, (0.3 + s * 0.5) * v, 1400 - s * 700, 40); this.tone('sine', 110 - s * 50, 28, 0.3 + s * 0.8, (0.35 + s * 0.4) * v);
  }
  ui(kind: 'click' | 'order' | 'error' | 'done' | 'alert' | 'place') {
    if (!this.ok('ui' + kind, kind === 'alert' ? 4 : 0.04)) return;
    switch (kind) {
      case 'click': this.tone('square', 900, 700, 0.04, 0.05); break;
      case 'order': this.tone('triangle', 520, 780, 0.07, 0.09); break;
      case 'place': this.tone('triangle', 300, 200, 0.1, 0.12); break;
      case 'error': this.tone('square', 180, 120, 0.14, 0.08); break;
      case 'done': this.tone('sine', 660, 660, 0.09, 0.1); setTimeout(() => this.ctx && this.tone('sine', 990, 990, 0.14, 0.1), 90); break;
      case 'alert': this.tone('square', 740, 740, 0.12, 0.09); setTimeout(() => this.ctx && this.tone('square', 560, 560, 0.18, 0.09), 150); break;
    }
  }
}

// ───────────────────────── dynamic orchestral score ─────────────────────────
// A small generative orchestra: every instrument is synthesized, the piece is composed on the fly
// from one recurring theme, and tempo/orchestration follow the battle intensity (0 calm … 1 all-out war).
const SCALE = [0, 2, 3, 5, 7, 8, 10]; // D natural minor
const CH: Record<string, { r: number; t: number[]; maj?: boolean }> = {
  i: { r: 0, t: [0, 3, 7] }, VI: { r: 5, t: [8, 12, 15] }, III: { r: 2, t: [3, 7, 10] }, VII: { r: 6, t: [10, 14, 17] },
  iv: { r: 3, t: [5, 8, 12] }, V: { r: 4, t: [7, 11, 14], maj: true },
};
const PROG = [
  [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VI', 'V'], ['VI', 'III', 'iv', 'V']],
  [['i', 'i', 'VI', 'V'], ['iv', 'i', 'VII', 'V'], ['i', 'III', 'iv', 'V']],
  [['i', 'VI', 'VII', 'i'], ['i', 'III', 'VII', 'V'], ['iv', 'VI', 'V', 'V'], ['i', 'VII', 'VI', 'V']],
];
const THEME = [0, 2, 4, 2, 5, 4, 2, 1, 0, 2, 4, 7, 6, 4, 5, 4];
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private ctx: AudioContext; private out: GainNode; private dry: GainNode; private rev: ConvolverNode; private wet: GainNode; private noise: AudioBuffer;
  private timer = 0; private next = 0; private step = 0; private bar = 0; private level = 0; private prog: string[] = PROG[0][0]; private cycle = 0;
  intensity = 0; private smoothI = 0; volume = 0.42; private on = false;

  constructor(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer) {
    this.ctx = ctx; this.noise = noise;
    this.out = ctx.createGain(); this.out.gain.value = this.volume; this.out.connect(dest);
    this.dry = ctx.createGain(); this.dry.gain.value = 0.75; this.dry.connect(this.out);
    // concert-hall impulse response, generated
    const len = Math.floor(ctx.sampleRate * 3.2), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len, env = Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1);
        lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.4 * t); d[i] = lp * env;
      }
    }
    this.rev = ctx.createConvolver(); this.rev.buffer = ir;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.55; this.rev.connect(this.wet); this.wet.connect(this.out);
  }
  reverbIn(amount: number): AudioNode { const g = this.ctx.createGain(); g.gain.value = amount; g.connect(this.rev); return g; }
  setVolume(v: number) { this.volume = v; this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1); }
  start() {
    if (this.on) return; this.on = true; this.intensity = this.smoothI = 0;
    this.next = this.ctx.currentTime + 0.15; this.step = 0; this.bar = 0;
    this.timer = window.setInterval(() => this.pump(), 90);
  }
  stop() { this.on = false; clearInterval(this.timer); }
  finale(win: boolean) {
    if (!this.on) return; this.stop();
    const t = this.ctx.currentTime + 0.2;
    if (win) {
      const ch = [[38, 50, 57, 62, 66, 69], [43, 55, 59, 62, 67, 71], [45, 57, 61, 64, 69, 73], [38, 50, 62, 66, 69, 74]];
      ch.forEach((c, i) => { for (const m of c) { this.brass(m, t + i * 0.9, i === 3 ? 4 : 0.85, 0.5); this.strings(m + 12, t + i * 0.9, i === 3 ? 4.2 : 0.9, 0.4, false); } this.timp(38, t + i * 0.9, 0.8); });
      this.cymbal(t + 2.7, 0.5, 3); [74, 78, 81, 86].forEach((m, i) => this.brass(m, t + 2.7 + i * 0.22, 2.4 - i * 0.2, 0.5));
    } else {
      [[38, 45, 53, 56], [37, 44, 52, 56], [36, 43, 51, 55], [26, 38, 41, 45, 50]].forEach((c, i) => { for (const m of c) { this.strings(m + 12, t + i * 1.5, i === 3 ? 6 : 1.7, 0.5, false); this.horn(m, t + i * 1.5, i === 3 ? 5 : 1.6, 0.35); } this.timp(26, t + i * 1.5, 0.7); });
    }
  }

  // ── orchestra ──
  private env(g: GainNode, t: number, a: number, peak: number, dur: number, rel: number) {
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + Math.max(a, dur)); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a, dur) + rel);
  }
  private voice(type: OscillatorType, m: number, det: number[], t: number, end: number, node: AudioNode, vib = 0) {
    for (const d of det) {
      const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = hz(m); o.detune.value = d + (Math.random() - 0.5) * 6;
      if (vib) { const l = this.ctx.createOscillator(), lg = this.ctx.createGain(); l.frequency.value = 5.2 + Math.random() * 0.6; lg.gain.value = vib; l.connect(lg); lg.connect(o.detune); l.start(t + 0.12); l.stop(end); }
      o.connect(node); o.start(t); o.stop(end);
    }
  }
  private bus(g: AudioNode, wet: number) { g.connect(this.dry); const w = this.ctx.createGain(); w.gain.value = wet; g.connect(w); w.connect(this.rev); }
  private strings(m: number, t: number, dur: number, vel: number, stacc: boolean) {
    const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = Math.min(9000, hz(m) * (stacc ? 5 : 3.2) + 500 + vel * 1600); f.Q.value = 0.5;
    if (stacc) this.env(g, t, 0.012, vel * 0.11, 0.05, Math.min(0.2, dur)); else this.env(g, t, Math.min(0.35, dur * 0.3), vel * 0.085, dur, 0.5);
    f.connect(g); this.bus(g, 0.9);
    this.voice('sawtooth', m, stacc ? [-6, 7] : [-9, 0, 8], t, t + dur + 0.8, f, stacc ? 0 : 5);
  }
  private brass(m: number, t: number, dur: number, vel: number) {
    const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.Q.value = 1.6; f.frequency.setValueAtTime(350, t); f.frequency.exponentialRampToValueAtTime(900 + vel * 3600, t + 0.07); f.frequency.exponentialRampToValueAtTime(700 + vel * 1500, t + dur + 0.1);
    this.env(g, t, 0.04, vel * 0.1, dur, 0.22); f.connect(g); this.bus(g, 0.8);
    this.voice('sawtooth', m, [-4, 5], t, t + dur + 0.4, f, 3);
  }
  private horn(m: number, t: number, dur: number, vel: number) {
    const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.Q.value = 0.8; f.frequency.setValueAtTime(260, t); f.frequency.exponentialRampToValueAtTime(600 + vel * 900, t + 0.12);
    this.env(g, t, 0.09, vel * 0.13, dur, 0.35); f.connect(g); this.bus(g, 1.1);
    this.voice('sawtooth', m, [-3, 4], t, t + dur + 0.5, f, 4);
  }
  private flute(m: number, t: number, dur: number, vel: number) {
    const g = this.ctx.createGain(); this.env(g, t, 0.07, vel * 0.09, dur, 0.25); this.bus(g, 1.1);
    this.voice('sine', m, [0], t, t + dur + 0.4, g, 9); this.voice('triangle', m + 12, [3], t, t + dur + 0.4, (() => { const q = this.ctx.createGain(); q.gain.value = 0.12; q.connect(g); return q; })());
  }
  private harp(m: number, t: number, vel: number) {
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vel * 0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4); this.bus(g, 1);
    this.voice('triangle', m, [0], t, t + 1.5, g); this.voice('sine', m + 12, [2], t, t + 0.5, (() => { const q = this.ctx.createGain(); q.gain.value = 0.3; q.connect(g); return q; })());
  }
  private choir(m: number, t: number, dur: number, vel: number) {
    const c = this.ctx, g = c.createGain(); this.env(g, t, 0.5, vel * 0.1, dur, 0.9); this.bus(g, 1.3);
    for (const [fq, q, a] of [[650, 5, 1], [1080, 6, 0.6], [2600, 8, 0.25]] as number[][]) {
      const f = c.createBiquadFilter(), fg = c.createGain(); f.type = 'bandpass'; f.frequency.value = fq; f.Q.value = q; fg.gain.value = a; f.connect(fg); fg.connect(g);
      this.voice('sawtooth', m, [-11, 0, 10], t, t + dur + 1, f, 6);
    }
  }
  private nz(t: number, dur: number, vel: number, type: BiquadFilterType, freq: number, q = 0.7, wet = 0.6, attack = 0.002) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; s.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    s.connect(f); f.connect(g); this.bus(g, wet); s.start(t, Math.random()); s.stop(t + attack + dur + 0.05);
  }
  private drum(f0: number, f1: number, t: number, dur: number, vel: number) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); this.bus(g, 0.7); o.start(t); o.stop(t + dur + 0.05);
  }
  private timp(m: number, t: number, vel: number) { this.drum(hz(m) * 1.06, hz(m) * 0.97, t, 1.3, vel * 0.5); this.drum(hz(m) * 2.02, hz(m) * 1.96, t, 0.5, vel * 0.14); this.nz(t, 0.12, vel * 0.2, 'lowpass', 500); }
  private taiko(t: number, vel: number) { this.drum(92, 44, t, 0.42, vel * 0.7); this.nz(t, 0.09, vel * 0.3, 'lowpass', 700, 1); }
  private snare(t: number, vel: number) { this.nz(t, 0.11, vel * 0.22, 'highpass', 1800, 0.8); this.drum(210, 170, t, 0.07, vel * 0.12); }
  private cymbal(t: number, vel: number, dur = 1.8, swell = false) { this.nz(t, dur, vel * 0.16, 'highpass', 5200, 0.5, 0.8, swell ? dur * 0.9 : 0.004); }

  // ── composer ──
  private note(ch: string, k: number, oct: number) {
    const c = CH[ch], idx = c.r + k, deg = SCALE[((idx % 7) + 7) % 7]; let s = deg + 12 * Math.floor(idx / 7);
    if (c.maj && deg === 10) s += 1; // leading tone over the dominant
    return 38 + 12 * oct + s;
  }
  private pump() {
    const c = this.ctx; if (c.state !== 'running') return;
    if (this.next < c.currentTime) this.next = c.currentTime + 0.05;
    while (this.next < c.currentTime + 0.28) {
      this.smoothI += (this.intensity - this.smoothI) * 0.06;
      const I = this.smoothI, bpm = 64 + 78 * Math.pow(I, 0.8), sd = 60 / bpm / 4;
      if (this.step === 0) this.newBar(I);
      this.playStep(this.next, sd, I);
      this.next += sd; this.step = (this.step + 1) % 16;
    }
  }
  private newBar(I: number) {
    const want = I < 0.26 ? 0 : I < 0.6 ? 1 : 2, esc = want > this.level;
    if (this.bar % 4 === 0 || esc) {
      if (esc) this.bar = 0;
      this.level = want; const p = PROG[want]; this.prog = p[(this.cycle++) % p.length];
    }
  }
  private playStep(t: number, sd: number, I: number) {
    const s = this.step, L = this.level, bar = this.bar % 4, ch = this.prog[bar], c = CH[ch], barDur = sd * 16;
    const hum = () => t + Math.random() * 0.012, phrase = (this.cycle + (this.bar >> 2)) % 2;
    if (s === 0) {
      // sustained harmony: celli/basses + violas, voiced low to high
      const v = 0.45 + I * 0.5;
      this.strings(38 + c.t[0] - 12 + (c.t[0] > 7 ? -12 : 0), t, barDur * 0.98, v * 1.1, false);
      this.strings(38 + c.t[0] + 12, t, barDur * 0.98, v * 0.8, false);
      this.strings(38 + c.t[1] + 12, hum(), barDur * 0.98, v * 0.7, false);
      this.strings(38 + c.t[2] + 12, hum(), barDur * 0.98, v * 0.7, false);
      if (L >= 1) this.horn(38 + c.t[0], t, barDur * 0.95, 0.4 + I * 0.4);
      if (L === 2) { this.choir(38 + c.t[0] + 12, t, barDur * 0.9, 0.5 + I * 0.4); this.choir(38 + c.t[2] + 12, t, barDur * 0.9, 0.4 + I * 0.3); this.brass(38 + c.t[0] - 12, t, barDur * 0.9, 0.5); }
      if (bar === 0 && L === 2) this.cymbal(t, 0.7);
      if (bar === 0 && L === 0 && Math.random() < 0.5) this.timp(38 + c.t[0] - 12, t, 0.35);
      if (bar === 3 && L >= 1) this.cymbal(t + barDur * 0.45, 0.45, barDur * 0.55, true);
    }
    if (L === 0) {
      // harp arpeggios and a slow woodwind/horn statement of the theme
      if (s % 2 === 0) { const k = [0, 2, 4, 7, 9, 7, 4, 2][s / 2]; this.harp(this.note(ch, k, 1), hum(), 0.3 + (s === 0 ? 0.25 : 0) + Math.random() * 0.1); }
      if (phrase === 0 && s % 4 === 0) { const n = THEME[(bar * 4 + s / 4) % 16]; (this.cycle % 4 < 2 ? this.flute : this.horn).call(this, this.note(ch, n, this.cycle % 4 < 2 ? 3 : 2), hum(), sd * 3.7, 0.55); }
    } else if (L === 1) {
      if (s % 2 === 0) { const k = [0, 4, 0, 7, 0, 4, 2, 4][s / 2]; this.strings(this.note(ch, k, 1), hum(), sd * 1.6, 0.5 + (s % 8 === 0 ? 0.3 : 0), true); this.strings(this.note(ch, k, 0), hum(), sd * 1.6, 0.4, true); }
      if (s === 0 || s === 8 || (s === 14 && bar === 3)) this.taiko(t, s === 0 ? 0.75 : 0.5);
      if (s === 0) this.timp(38 + c.t[0] - 12, t, 0.5);
      if (s % 4 === 0) { const n = THEME[(bar * 4 + s / 4) % 16]; this.horn(this.note(ch, n, 2), hum(), sd * 3.6, 0.6); if (phrase) this.flute(this.note(ch, n, 3), hum(), sd * 3.6, 0.4); }
    } else {
      // battle: driving 16ths, brass theme in octaves, full percussion
      const pat = [0, 0, 4, 0, 7, 0, 4, 0, 0, 0, 4, 0, 7, 4, 2, 4][s], acc = s % 4 === 0 ? 0.35 : s % 2 === 0 ? 0.12 : 0;
      this.strings(this.note(ch, pat, 1), hum(), sd * 0.9, 0.55 + acc, true); this.strings(this.note(ch, pat, 2), hum(), sd * 0.9, 0.4 + acc, true);
      if (s % 2 === 0) {
        const n = THEME[(bar * 8 + s / 2) % 16], long = s % 4 === 0 ? 1.9 : 0.95;
        this.brass(this.note(ch, n, 2), hum(), sd * long, 0.7 + I * 0.25); this.brass(this.note(ch, n, 3), hum(), sd * long, 0.5 + I * 0.2);
      }
      if ([0, 3, 6, 8, 12, 14].includes(s)) this.taiko(t, s === 0 || s === 8 ? 1 : 0.6);
      if (s === 4 || s === 12 || (bar === 3 && s >= 10)) this.snare(t, 0.7 + (s >= 10 ? (s - 10) * 0.05 : 0));
      if (s === 0 || s === 8) this.timp(38 + c.t[0] - 12, t, 0.7);
    }
    if (s === 15) this.bar++;
  }
}
