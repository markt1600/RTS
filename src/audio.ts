// Fully synthesized sound effects (WebAudio). No samples.
export class Audio {
  ctx: AudioContext | null = null; private master!: GainNode; private noise!: AudioBuffer;
  private last: Record<string, number> = {}; private voices = 0; volume = 0.5;

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    try {
      const C = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new C();
      const comp = this.ctx.createDynamicsCompressor(); comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(comp);
      const n = this.ctx.sampleRate; this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  }
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
