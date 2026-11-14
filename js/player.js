import { isBlack, noteName, octaveOf } from './util.js';
import { piano } from './audio.js';
import { computeFingering } from './fingering.js';

const COLORS = {
  R: { fill: '#1e90ff', top: '#5bb4ff', edge: '#0b5fc0', label: '#0a3d7a' },
  L: { fill: '#15c9a0', top: '#5ef0cc', edge: '#0b8f72', label: '#065a48' },
  glow: '#2ff5d0',
  press: '#8b3dff',
  wrong: '#ff3d6e',
};
// Smart-piano style chromatic rainbow (C red → B violet)
const HUES = [0, 15, 30, 42, 55, 120, 160, 195, 218, 240, 262, 285];
const rainbowCache = new Map();
export function rainbow(p, dark = false) {
  const key = p % 12 + (dark ? 12 : 0);
  if (!rainbowCache.has(key)) {
    const h = HUES[p % 12], l = dark ? 44 : 56;
    rainbowCache.set(key, { fill: `hsl(${h} 95% ${l}%)`, top: `hsl(${h} 100% ${l + 18}%)`, edge: `hsl(${h} 90% ${l - 22}%)`, label: `hsl(${h} 90% 22%)`, hue: h });
  }
  return rainbowCache.get(key);
}
// thumb … pinky (same colours on notes, keys and the hand diagram)
export const FINGER_COLORS = ['#ff5d7a', '#ffb340', '#ffe14d', '#4dd97a', '#4db8ff'];
const LEAD_IN = 2.0;
const LIGHT_AHEAD = 1.2; // seconds of key-light preview // seconds before first note
const HIT_EARLY = 0.3, HIT_LATE = 0.3;

export class Player {
  constructor(canvas, song, settings, hooks = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.song = song;
    this.settings = settings;
    this.hooks = hooks;
    this.notes = computeFingering(song.notes.map((n, i) => ({ ...n, i, oi: n.oi ?? i, state: 0 })));
    this.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    this.duration = song.duration;
    this.time = -LEAD_IN;
    this.playing = false;
    this.speed = 1;
    this.mode = 'play'; // 'play' (Play-Along) | 'wait'
    this.hands = { L: true, R: true }; // practiced hands
    this.userDown = new Map(); // p -> source
    this.flash = new Map(); // p -> {color, until}
    this.autoDown = new Map(); // p -> {hand, until}
    this.particles = [];
    this.stats = { hit: 0, miss: 0, wrong: 0, streak: 0, best: 0 };
    this.waiting = false;
    this.loop = null; // {a, b}
    this._nextAuto = 0;
    this._lastFrame = performance.now();
    this.computeRange();
    this.resize();
    this._raf = requestAnimationFrame((t) => this.frame(t));
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    piano.stopAll();
  }

  // ---------- layout ----------
  computeRange() {
    const kb = this.settings.keyboard || 'auto';
    if (kb === '88' || !this.notes.length) { this.lo = 21; this.hi = 108; }
    else if (kb === '61') { this.lo = 36; this.hi = 96; }
    else {
      let lo = 108, hi = 21;
      for (const n of this.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
      lo = Math.max(21, lo - (lo % 12) - 0); // down to C
      hi = Math.min(108, hi + (11 - (hi % 12)) + 1); // up to next C
      while (hi - lo < 36) { if (lo > 24) lo -= 12; else hi = Math.min(108, hi + 12); if (lo <= 24 && hi >= 108) break; }
      this.lo = lo; this.hi = hi;
    }
    if (isBlack(this.lo)) this.lo--;
    if (isBlack(this.hi)) this.hi++;
    this.whites = [];
    for (let p = this.lo; p <= this.hi; p++) if (!isBlack(p)) this.whites.push(p);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.cv.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.kbH = Math.min(Math.max(this.h * 0.24, 70), 180);
    this.hitY = this.h - this.kbH;
    this.ww = this.w / this.whites.length;
    this.pps = (this.hitY / 3.2) * (this.settings.zoom || 1); // pixels per second
  }

  keyRect(p) {
    if (!isBlack(p)) {
      const idx = this.whites.indexOf(p);
      return { x: idx * this.ww, w: this.ww, black: false };
    }
    const idx = this.whites.indexOf(p - 1);
    const bw = this.ww * 0.6;
    const pc = p % 12;
    const shift = { 1: -0.08, 3: 0.08, 6: -0.1, 8: 0, 10: 0.1 }[pc] * this.ww;
    return { x: (idx + 1) * this.ww - bw / 2 + shift, w: bw, black: true };
  }

  keyAt(x, y) {
    if (y < this.hitY) return null;
    const ky = y - this.hitY;
    if (ky < this.kbH * 0.62) {
      for (let p = this.lo; p <= this.hi; p++) {
        if (!isBlack(p)) continue;
        const r = this.keyRect(p);
        if (x >= r.x && x <= r.x + r.w) return p;
      }
    }
    const idx = Math.floor(x / this.ww);
    return this.whites[Math.max(0, Math.min(this.whites.length - 1, idx))];
  }

  // ---------- transport ----------
  play() {
    piano.ensure();
    if (this.time >= this.duration) this.seek(-LEAD_IN);
    this.playing = true;
    this.hooks.onState?.();
  }

  pause() {
    this.playing = false;
    piano.stopAll();
    this.autoDown.clear();
    this.hooks.onState?.();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = Math.max(-LEAD_IN, Math.min(this.duration, t));
    this._passStart = { ...this.stats };
    // notes before the seek point are "skipped" (3) so they don't count as misses
    for (const n of this.notes) n.state = n.t >= this.time - 0.01 ? 0 : n.state || 3;
    this._nextAuto = this.notes.findIndex((n) => n.t >= this.time);
    if (this._nextAuto < 0) this._nextAuto = this.notes.length;
    piano.stopAll();
    this.autoDown.clear();
    this.waiting = false;
  }

  restart() {
    this.stats = { hit: 0, miss: 0, wrong: 0, streak: 0, best: 0 };
    this.seek(this.loop ? this.loop.a : -LEAD_IN);
  }

  practiced(n) { return this.hands[n.h]; }

  /** What happens with the hand you are not practising: 'auto' (plays), 'mute' (silent), 'hide' (invisible + silent). */
  get otherHand() { return this.settings.otherHand || 'auto'; }

  /** Recompute fingering after a manual change. */
  refinger() { computeFingering(this.notes); }

  /** Note under a canvas point (for editing fingers). */
  noteAt(x, y) {
    const tTop = this.time + this.hitY / this.pps;
    let best = null;
    for (const n of this.notes) {
      if (n.t > tTop) break;
      if (n.t + n.d < this.time - 0.1 || n.p < this.lo || n.p > this.hi) continue;
      if (!this.practiced(n) && this.otherHand === 'hide') continue;
      const r = this.keyRect(n.p);
      const y1 = this.hitY - (n.t - this.time) * this.pps;
      const y0 = Math.min(y1 - 8, this.hitY - (n.t + n.d - this.time) * this.pps);
      if (x >= r.x - 4 && x <= r.x + r.w + 4 && y >= y0 - 4 && y <= y1 + 4) best = !best || r.black ? n : best; // prefer black (on top)
    }
    return best;
  }

  colorFor(n) {
    return this.settings.colors === 'rainbow' ? rainbow(n.p, n.h === 'L') : COLORS[n.h] || COLORS.R;
  }

  /** Keys that should be lit right now (upcoming/awaited practiced notes) → p → {k: intensity 0..1, h, f}. */
  lights() {
    const out = new Map();
    for (let i = Math.max(0, this._nextAuto - 64); i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > this.time + LIGHT_AHEAD) break;
      if (n.state !== 0 || !this.practiced(n) || n.t + Math.max(n.d, 0.15) < this.time) continue;
      const k = n.t <= this.time + 0.05 ? 1 : 0.25 + 0.75 * (1 - (n.t - this.time) / LIGHT_AHEAD);
      const cur = out.get(n.p);
      if (!cur || k > cur.k) out.set(n.p, { k, h: n.h, f: n.f, now: n.t <= this.time + 0.05 });
    }
    return out;
  }

  // ---------- input from user ----------
  noteOn(p, v, source) {
    this.userDown.set(p, source);
    const playSound = source === 'touch' || source === 'keyboard' || (source === 'midi' && this.settings.midiSound);
    if (playSound) piano.play(p, v, null, 'user' + p, 'user');

    // find a matching pending note for a practiced hand
    let best = null, bd = 1e9;
    for (let i = Math.max(0, this._nextAuto - 64); i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > this.time + HIT_EARLY) break;
      if (n.state !== 0 || n.p !== p || !this.practiced(n)) continue;
      if (this.mode === 'play' && n.t < this.time - HIT_LATE) continue;
      const d = Math.abs(n.t - this.time);
      if (d < bd) { bd = d; best = n; }
    }
    if (best) {
      best.state = 1;
      this.stats.hit++;
      this.stats.streak++;
      this.stats.best = Math.max(this.stats.best, this.stats.streak);
      this.spark(p, this.colorFor(best).top, 18);
      this.flash.set(p, { color: this.settings.colors === 'rainbow' ? rainbow(p).top : COLORS.press, until: performance.now() + 150 });
    } else if (this.playing || this.waiting) {
      this.stats.wrong++;
      this.stats.streak = 0;
      this.flash.set(p, { color: COLORS.wrong, until: performance.now() + 300 });
    }
  }

  noteOff(p, source) {
    this.userDown.delete(p);
    piano.stop('user' + p);
  }

  // ---------- main loop ----------
  frame(now) {
    const dt = Math.min(0.1, (now - this._lastFrame) / 1000);
    this._lastFrame = now;
    if (this.playing) this.advance(dt * this.speed);
    this.draw(now);
    this._raf = requestAnimationFrame((t) => this.frame(t));
  }

  advance(dt) {
    let target = this.time + dt;
    this.waiting = false;

    if (this.mode === 'wait') {
      // freeze at the earliest unplayed practiced note
      for (let i = Math.max(0, this._nextAuto - 64); i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.t > target) break;
        if (n.state === 0 && this.practiced(n) && n.t >= this.time - 0.05) {
          target = Math.max(this.time, n.t);
          this.waiting = true;
          break;
        }
      }
    }

    // trigger notes that start between time and target
    while (this._nextAuto < this.notes.length && this.notes[this._nextAuto].t <= target) {
      const n = this.notes[this._nextAuto++];
      if (n.t < this.time - 0.05) continue;
      const practiced = this.practiced(n);
      const audible = !practiced ? this.otherHand === 'auto' : this.mode === 'play' && this.settings.guideSound && !this.settings.micActive;
      if (audible && !this.settings.muteSong) {
        piano.play(n.p, n.v * (practiced ? 0.8 : 0.7), n.d / this.speed + 0.05, null, n.h === 'L' ? 'L' : 'R');
      }
      if (!practiced && this.otherHand === 'auto') {
        this.autoDown.set(n.p, { hand: n.h, until: n.t + n.d, color: this.colorFor(n).fill });
        this.spark(n.p, this.colorFor(n).top, 6);
      }
    }

    // metronome
    if (this.settings.metronome && this.song.bpm) {
      const spb = 60 / this.song.bpm;
      const b0 = Math.floor(this.time / spb), b1 = Math.floor(target / spb);
      if (b1 > b0 && target >= 0) piano.click(b1 % 4 === 0);
    }

    this.time = target;

    // misses (play-along)
    if (this.mode === 'play') {
      for (let i = Math.max(0, this._nextAuto - 128); i < this._nextAuto; i++) {
        const n = this.notes[i];
        if (n.state === 0 && this.practiced(n) && n.t < this.time - HIT_LATE) {
          n.state = 2;
          this.stats.miss++;
          this.stats.streak = 0;
        }
      }
    }
    for (const [p, a] of this.autoDown) if (a.until < this.time) this.autoDown.delete(p);

    if (this.loop && this.time >= this.loop.b) {
      this.hooks.onLoopPass?.(this.passResult());
      this.seek(Math.max(-LEAD_IN, this.loop.a - 1)); // 1 s run-up before the section
      return;
    }
    if (this.time >= this.duration + 0.5) {
      this.time = this.duration;
      this.pause();
      this.hooks.onEnd?.(this.result());
    }
    this.hooks.onTime?.(this.time);
  }

  /** Accuracy of the current pass through the loop section. */
  passResult() {
    const { a, b } = this.loop;
    let hit = 0, total = 0;
    for (const n of this.notes) {
      if (n.t < a || n.t >= b || !this.practiced(n)) continue;
      total++;
      if (n.state === 1) hit++;
    }
    const wrong = this.stats.wrong - (this._passStart?.wrong || 0);
    return { hit, total, wrong, accuracy: total ? Math.round((hit / (total + wrong * 0.5)) * 100) : 100 };
  }

  /** Split the song into practice sections of ~8 s, cutting at natural pauses. */
  sections(target = 8) {
    const onsets = [...new Set(this.notes.map((n) => +n.t.toFixed(3)))].sort((x, y) => x - y);
    if (!onsets.length) return [];
    const spb = this.song.bpm ? 60 / this.song.bpm : null;
    if (spb) target = Math.max(4, Math.round(target / (spb * 4)) * spb * 4); // whole bars for built-ins
    const out = [];
    let start = 0;
    while (start < this.duration - 1) {
      const ideal = start + target;
      if (ideal >= this.duration - target * 0.4) { out.push({ a: start, b: this.duration + 0.3 }); break; }
      let best = ideal, bestScore = -Infinity;
      for (const t of onsets) {
        if (t < ideal - target * 0.3) continue;
        if (t > ideal + target * 0.3) break;
        let endBefore = 0;
        for (const n of this.notes) { if (n.t >= t) break; endBefore = Math.max(endBefore, n.t + n.d); }
        const score = (t - endBefore) * 3 - Math.abs(t - ideal) * 0.3; // prefer silence before the cut
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (spb) best = ideal;
      out.push({ a: start, b: best - 0.02 });
      start = best - 0.02;
    }
    return out;
  }

  result() {
    const practicedTotal = this.notes.filter((n) => this.practiced(n)).length;
    const acc = practicedTotal ? Math.round((this.stats.hit / Math.max(1, this.stats.hit + this.stats.miss + this.stats.wrong * 0.5)) * 100) : 100;
    return { ...this.stats, total: practicedTotal, accuracy: Math.min(100, acc) };
  }

  spark(p, color, count) {
    if (!this.settings.effects) return;
    const r = this.keyRect(p);
    if (!r) return;
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: r.x + r.w / 2, y: this.hitY,
        vx: (Math.random() - 0.5) * 160, vy: -Math.random() * 220 - 40,
        life: 0.5 + Math.random() * 0.4, age: 0, color,
      });
    }
  }

  // ---------- rendering ----------
  draw(now) {
    const { ctx, w, h, hitY } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, hitY);

    // octave guide lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (const p of this.whites) {
      if (p % 12 !== 0) continue;
      const x = Math.round(this.keyRect(p).x) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hitY); ctx.stroke();
    }

    // loop markers
    if (this.loop) {
      for (const t of [this.loop.a, this.loop.b]) {
        const y = hitY - (t - this.time) * this.pps;
        if (y > 0 && y < hitY) { ctx.fillStyle = 'rgba(139,61,255,0.6)'; ctx.fillRect(0, y - 1, w, 2); }
      }
    }

    // falling notes
    const tTop = this.time + hitY / this.pps;
    const labels = this.settings.labels;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = Math.max(0, this._nextAuto - 200); i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > tTop) break;
      if (n.t + n.d < this.time - 0.1) continue;
      if (n.p < this.lo || n.p > this.hi) continue;
      if (!this.practiced(n) && this.otherHand === 'hide') continue;
      const r = this.keyRect(n.p);
      const y1 = hitY - (n.t - this.time) * this.pps;
      const y0 = hitY - (n.t + n.d - this.time) * this.pps;
      const nh = Math.max(8, y1 - y0);
      const pad = r.black ? 1 : 2;
      const x = r.x + pad, nw = r.w - pad * 2;
      const c = this.colorFor(n);
      const practiced = this.practiced(n);
      ctx.globalAlpha = practiced ? (n.state === 2 ? 0.35 : 1) : 0.4;
      const grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, c.top);
      grad.addColorStop(1, n.state === 1 ? '#ffffff' : c.fill);
      ctx.fillStyle = grad;
      roundRect(ctx, x, y1 - nh, nw, nh, Math.min(5, nw / 3));
      ctx.fill();
      ctx.strokeStyle = c.edge;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (labels !== 'none' && nh > 16 && nw > 9) {
        const nm = labels === 'solfege' ? noteName(n.p, true) : noteName(n.p).replace('#', '♯');
        const txt = labels === 'fingers' ? String(n.f || '') : labels === 'both' && n.f ? `${nm} ${n.f}` : nm;
        const fs = Math.min(13, nw * 0.6);
        ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
        const bh = fs + 5, bw = Math.min(nw - 4, ctx.measureText(txt).width + 6);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        roundRect(ctx, x + nw / 2 - bw / 2, y1 - bh - 3, bw, bh, 3);
        ctx.fill();
        ctx.fillStyle = c.label;
        ctx.fillText(txt, x + nw / 2, y1 - bh / 2 - 3 + 0.5);
      }
      if (this.settings.fingers && n.f && nh > 22 && nw > 9 && labels !== 'fingers' && labels !== 'both') {
        const r0 = Math.min(8, nw / 2 - 1), cy = y1 - nh + r0 + 3;
        ctx.fillStyle = this.settings.fingerColors !== false ? FINGER_COLORS[n.f - 1] : 'rgba(0,0,0,0.55)';
        ctx.beginPath(); ctx.arc(x + nw / 2, cy, r0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = this.settings.fingerColors !== false ? '#111' : '#fff';
        ctx.font = `700 ${Math.round(r0 * 1.4)}px Inter, system-ui, sans-serif`;
        ctx.fillText(String(n.f), x + nw / 2, cy + 0.5);
        if (n.fm) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + nw / 2, cy, r0 + 1.5, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;

    // keyboard
    this._lights = this.lights();
    this.hooks.onLights?.(this._lights);
    this.drawKeyboard(now);

    // glowing hit line
    ctx.save();
    ctx.shadowColor = COLORS.glow;
    ctx.shadowBlur = 18;
    ctx.fillStyle = COLORS.glow;
    ctx.fillRect(0, hitY - 2, w, 3);
    ctx.restore();
    const g = ctx.createLinearGradient(0, hitY - 26, 0, hitY);
    g.addColorStop(0, 'rgba(47,245,208,0)');
    g.addColorStop(1, 'rgba(47,245,208,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(0, hitY - 26, w, 26);

    // particles
    const dt = 1 / 60;
    this.particles = this.particles.filter((pt) => (pt.age += dt) < pt.life);
    for (const pt of this.particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 400 * dt;
      ctx.globalAlpha = 1 - pt.age / pt.life;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x, pt.y, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;

    if (this.waiting) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '600 13px Inter, system-ui, sans-serif';
      ctx.fillText('Waiting for you…', w / 2, hitY - 40);
    }
  }

  keyColor(p, now) {
    const f = this.flash.get(p);
    if (f && f.until > now) return f.color;
    if (this.userDown.has(p)) return this.settings.colors === 'rainbow' ? rainbow(p).fill : COLORS.press;
    const a = this.autoDown.get(p);
    if (a) return a.color || COLORS[a.hand].fill;
    // hint: in wait mode highlight the awaited keys
    if (this.waiting) {
      for (let i = Math.max(0, this._nextAuto - 64); i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.t > this.time + 0.02) break;
        if (n.p === p && n.state === 0 && this.practiced(n) && n.t >= this.time - 0.02) return this.settings.colors === 'rainbow' ? `hsl(${rainbow(p).hue} 90% 72%)` : COLORS[n.h].fill + '99';
      }
    }
    return null;
  }

  drawKeyboard(now) {
    const { ctx, hitY, kbH, ww } = this;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, hitY, this.w, kbH);
    for (let i = 0; i < this.whites.length; i++) {
      const p = this.whites[i];
      const x = i * ww;
      const col = this.keyColor(p, now);
      const g = ctx.createLinearGradient(0, hitY, 0, hitY + kbH);
      g.addColorStop(0, col || '#e9e9ee');
      g.addColorStop(1, col || '#ffffff');
      ctx.fillStyle = g;
      roundRect(ctx, x + 0.75, hitY, ww - 1.5, kbH - 1, [0, 0, 4, 4]);
      ctx.fill();
      if (this.settings.colors === 'rainbow' && !col) {
        // coloured learning sticker at the bottom of each white key
        const rc = rainbow(p);
        ctx.fillStyle = rc.fill;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, x + ww * 0.18, hitY + kbH - Math.min(ww * 0.9, 16) - 5, ww * 0.64, Math.min(ww * 0.9, 16), 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (ww > 9 && this.settings.labels !== 'none') {
          ctx.fillStyle = '#fff';
          ctx.font = `700 ${Math.min(10, ww * 0.55)}px Inter, system-ui, sans-serif`;
          ctx.fillText(noteName(p, this.settings.labels === 'solfege').slice(0, 2), x + ww / 2, hitY + kbH - Math.min(ww * 0.9, 16) / 2 - 5);
        }
      }
      if (p % 12 === 0 && ww > 11) {
        ctx.fillStyle = col ? '#fff' : '#555';
        ctx.font = `600 ${Math.min(11, ww * 0.5)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText('C' + octaveOf(p), x + 3, hitY + kbH - (this.settings.colors === 'rainbow' ? kbH * 0.45 : 10));
        ctx.textAlign = 'center';
      }
    }
    for (let p = this.lo; p <= this.hi; p++) {
      if (!isBlack(p)) continue;
      const r = this.keyRect(p);
      const col = this.keyColor(p, now);
      const g = ctx.createLinearGradient(0, hitY, 0, hitY + kbH * 0.62);
      g.addColorStop(0, col || '#1b1b1f');
      g.addColorStop(1, col || '#3a3a42');
      ctx.fillStyle = g;
      roundRect(ctx, r.x, hitY, r.w, kbH * 0.62, [0, 0, 3, 3]);
      ctx.fill();
      if (this.settings.colors === 'rainbow' && !col) {
        ctx.fillStyle = rainbow(p).edge;
        ctx.fillRect(r.x + r.w * 0.2, hitY + kbH * 0.62 - 6, r.w * 0.6, 3);
      }
    }
    // smart-piano LED strip: upcoming notes light up their key in advance
    if (this.settings.keyLights !== false) {
      for (const [p, { k }] of this._lights || []) {
        if (p < this.lo || p > this.hi) continue;
        const r = this.keyRect(p);
        const c = this.settings.colors === 'rainbow' ? rainbow(p).top : COLORS.glow;
        ctx.save();
        ctx.globalAlpha = k;
        ctx.shadowColor = c;
        ctx.shadowBlur = 12 * k;
        ctx.fillStyle = c;
        ctx.fillRect(r.x + 1, hitY + 2, r.w - 2, 5);
        ctx.restore();
      }
    }
    // finger number on the key that has to be played (now or next)
    if (this.settings.fingers) {
      for (const [p, l] of this._lights || []) {
        if (!l.f || p < this.lo || p > this.hi || l.k < 0.5) continue;
        const r = this.keyRect(p);
        const rad = Math.min(9, r.w / 2 - 1);
        if (rad < 4) continue;
        const cy = r.black ? hitY + kbH * 0.62 - rad - 4 : hitY + kbH * 0.62 + rad + 2;
        ctx.globalAlpha = 0.4 + 0.6 * l.k;
        ctx.fillStyle = this.settings.fingerColors !== false ? FINGER_COLORS[l.f - 1] : '#fff';
        ctx.beginPath(); ctx.arc(r.x + r.w / 2, cy, rad, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.font = `800 ${Math.round(rad * 1.3)}px Inter, system-ui, sans-serif`;
        ctx.fillText(String(l.f), r.x + r.w / 2, cy + 0.5);
        ctx.globalAlpha = 1;
      }
    }
    if (this.settings.fingers && this.settings.handDiagram !== false) this.drawHands();
  }

  /** Two small hands above the keyboard; the fingers needed now (bright) or next (dim) light up. */
  drawHands() {
    const { ctx } = this;
    const want = { L: new Map(), R: new Map() };
    for (const [, l] of this._lights || []) if (l.f && (l.h === 'L' || l.h === 'R')) want[l.h].set(l.f, Math.max(want[l.h].get(l.f) || 0, l.k));
    if (!want.L.size && !want.R.size && !this.waiting && !this.playing) return;
    const fw = 9, gap = 3, palmW = 5 * fw + 4 * gap, palmH = 14;
    const baseY = this.hitY - 18;
    const lens = [16, 24, 27, 24, 19]; // thumb … pinky
    const drawHand = (h, cx) => {
      // palm
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, cx - palmW / 2, baseY - palmH, palmW, palmH, 5); ctx.fill();
      for (let f = 1; f <= 5; f++) {
        // left hand: pinky … thumb from left to right; right hand: thumb … pinky
        const slot = h === 'L' ? 5 - f : f - 1;
        const x = cx - palmW / 2 + slot * (fw + gap);
        const len = lens[f - 1] - (f === 1 ? 6 : 0);
        const y = baseY - palmH - len + (f === 1 ? 8 : 0);
        const k = want[h].get(f) || 0;
        ctx.globalAlpha = k ? 0.35 + 0.65 * k : 1;
        ctx.fillStyle = k ? FINGER_COLORS[f - 1] : 'rgba(255,255,255,0.18)';
        roundRect(ctx, x, y, fw, len, 4.5); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = k ? '#111' : 'rgba(255,255,255,0.6)';
        ctx.font = '700 8px Inter, system-ui, sans-serif';
        ctx.fillText(String(f), x + fw / 2, y + 7);
      }
      ctx.fillStyle = h === 'L' ? '#5ef0cc' : '#5bb4ff';
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.fillText(h, cx, baseY - palmH / 2);
    };
    const mid = this.w / 2;
    if (this.hands.L || this.otherHand !== 'hide') drawHand('L', mid - palmW / 2 - 14);
    if (this.hands.R || this.otherHand !== 'hide') drawHand('R', mid + palmW / 2 + 14);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
