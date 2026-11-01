// Canvas renderers: scrolling 3-band waveform with beat grid, cues and loops,
// plus the full-track overview strip.

import { HOTCUE_COLORS } from './deck.js';

export const DECK_COLORS = ['#22d3ee', '#ff9f1c', '#a3e635', '#f472b6'];

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

// band colours: low = deep violet/blue, mid = cyan/teal, high = near white
const LOW = [86, 70, 255], MID = [32, 214, 230], HIGH = [235, 245, 255];

export class ScrollingWave {
  constructor(canvas, deck) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.deck = deck;
    this.zoom = 1;   // multiplier of base seconds-on-screen
  }

  draw() {
    const { w, h, dpr } = fit(this.canvas);
    const g = this.ctx;
    const d = this.deck;
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const cx = Math.round(w * 0.5);
    if (!d.loaded || !d.info?.wave) {
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(0, mid - 0.5 * dpr, w, dpr);
      if (d.loading) {
        g.fillStyle = DECK_COLORS[d.index];
        g.fillRect(0, h - 3 * dpr, w * d.loading, 3 * dpr);
      }
      return;
    }
    const wave = d.info.wave;
    const secOnScreen = 7 * this.zoom;
    const pxPerSec = w / secOnScreen;
    const pos = d.position;
    const t0 = pos - cx / pxPerSec;
    const binsPerPx = wave.rate / pxPerSec;

    // loop region
    if (d.loop.on || d.loop.end > d.loop.start) {
      const x1 = (d.loop.start - t0) * pxPerSec, x2 = (d.loop.end - t0) * pxPerSec;
      g.fillStyle = d.loop.on ? 'rgba(61,220,132,0.16)' : 'rgba(61,220,132,0.05)';
      g.fillRect(x1, 0, x2 - x1, h);
    }

    // beat grid
    if (d.bpm) {
      const beat = 60 / d.bpm;
      const first = Math.ceil((t0 - d.info.beatOffset) / beat);
      for (let b = first; ; b++) {
        const t = d.info.beatOffset + b * beat;
        const x = (t - t0) * pxPerSec;
        if (x > w) break;
        const bar = ((b % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
        g.fillRect(Math.round(x), 0, bar ? 2 * dpr : dpr, h);
      }
    }

    // waveform columns
    const amp = (h / 2) * 0.94;
    const { low, mid: mi, high } = wave;
    const nb = low.length;
    const step = Math.max(1, Math.floor(dpr));
    for (let x = 0; x < w; x += step) {
      const bf = (t0 + x / pxPerSec) * wave.rate;
      const b0 = Math.floor(bf), b1 = Math.max(b0 + 1, Math.floor(bf + binsPerPx * step));
      if (b1 < 0 || b0 >= nb) continue;
      let l = 0, m = 0, hi = 0;
      for (let b = Math.max(0, b0); b < Math.min(nb, b1); b++) {
        if (low[b] > l) l = low[b];
        if (mi[b] > m) m = mi[b];
        if (high[b] > hi) hi = high[b];
      }
      const past = x < cx;
      const a = past ? 0.45 : 1;
      const hl = (l / 255) * amp, hm = (m / 255) * amp * 0.8, hh = (hi / 255) * amp * 0.55;
      g.fillStyle = `rgba(${LOW[0]},${LOW[1]},${LOW[2]},${a})`;
      g.fillRect(x, mid - hl, step, hl * 2);
      g.fillStyle = `rgba(${MID[0]},${MID[1]},${MID[2]},${a})`;
      g.fillRect(x, mid - hm, step, hm * 2);
      g.fillStyle = `rgba(${HIGH[0]},${HIGH[1]},${HIGH[2]},${a * 0.9})`;
      g.fillRect(x, mid - hh, step, hh * 2);
    }

    // cue + hot cues
    const marker = (t, color, label) => {
      const x = (t - t0) * pxPerSec;
      if (x < -20 || x > w + 20) return;
      g.fillStyle = color;
      g.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h);
      if (label) {
        g.beginPath();
        g.moveTo(x - dpr, 0);
        g.lineTo(x + 14 * dpr, 0);
        g.lineTo(x + 14 * dpr, 12 * dpr);
        g.lineTo(x - dpr, 12 * dpr);
        g.fill();
        g.fillStyle = '#0b0d12';
        g.font = `700 ${9 * dpr}px Inter, system-ui, sans-serif`;
        g.fillText(label, x + 3 * dpr, 9.5 * dpr);
      }
    };
    marker(d.cuePoint, 'rgba(255,255,255,0.8)', '');
    d.hotcues.forEach((t, i) => t != null && marker(t, HOTCUE_COLORS[i], String(i + 1)));

    // playhead
    g.fillStyle = '#ffffff';
    g.fillRect(cx - dpr, 0, 2 * dpr, h);
    g.fillStyle = DECK_COLORS[d.index];
    g.beginPath();
    g.moveTo(cx - 6 * dpr, 0); g.lineTo(cx + 6 * dpr, 0); g.lineTo(cx, 7 * dpr); g.fill();
    g.beginPath();
    g.moveTo(cx - 6 * dpr, h); g.lineTo(cx + 6 * dpr, h); g.lineTo(cx, h - 7 * dpr); g.fill();
  }
}

export class Overview {
  constructor(canvas, deck, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.deck = deck;
    this.cache = null;
    this.cacheKey = '';
    const seek = (e) => {
      if (!deck.loaded) return;
      const r = canvas.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * deck.duration);
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      seek(e);
      const move = (ev) => seek(ev);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), { once: true });
    });
  }

  renderCache(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const wave = this.deck.info.wave;
    const n = wave.low.length;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * n), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * n));
      let l = 0, m = 0, hi = 0;
      for (let b = b0; b < b1; b++) {
        if (wave.low[b] > l) l = wave.low[b];
        if (wave.mid[b] > m) m = wave.mid[b];
        if (wave.high[b] > hi) hi = wave.high[b];
      }
      const amp = mid * 0.95;
      g.fillStyle = `rgb(${LOW})`;
      g.fillRect(x, mid - (l / 255) * amp, 1, (l / 255) * amp * 2);
      g.fillStyle = `rgb(${MID})`;
      g.fillRect(x, mid - (m / 255) * amp * 0.8, 1, (m / 255) * amp * 1.6);
      g.fillStyle = `rgb(${HIGH})`;
      g.fillRect(x, mid - (hi / 255) * amp * 0.5, 1, (hi / 255) * amp);
    }
    return c;
  }

  draw() {
    const { w, h, dpr } = fit(this.canvas);
    const g = this.ctx;
    const d = this.deck;
    g.clearRect(0, 0, w, h);
    if (!d.loaded || !d.info?.wave) return;
    const key = `${d.track?.id}|${w}|${h}`;
    if (key !== this.cacheKey) {
      this.cache = this.renderCache(w, h);
      this.cacheKey = key;
    }
    const px = (d.position / d.duration) * w;
    g.globalAlpha = 0.35;
    g.drawImage(this.cache, 0, 0);
    g.globalAlpha = 1;
    g.drawImage(this.cache, px, 0, w - px, h, px, 0, w - px, h);
    if (d.loop.end > d.loop.start) {
      g.fillStyle = d.loop.on ? 'rgba(61,220,132,0.35)' : 'rgba(61,220,132,0.15)';
      g.fillRect((d.loop.start / d.duration) * w, 0, Math.max(2, ((d.loop.end - d.loop.start) / d.duration) * w), h);
    }
    d.hotcues.forEach((t, i) => {
      if (t == null) return;
      g.fillStyle = HOTCUE_COLORS[i];
      g.fillRect((t / d.duration) * w - dpr, 0, 2 * dpr, h);
    });
    g.fillStyle = '#fff';
    g.fillRect((d.cuePoint / d.duration) * w, h - 4 * dpr, 2 * dpr, 4 * dpr);
    // remaining-time warning
    const left = d.duration - d.position;
    g.fillStyle = left < 30 && Math.floor(performance.now() / 400) % 2 ? '#ff3b5c' : '#ffffff';
    g.fillRect(px - dpr, 0, 2 * dpr, h);
  }
}

// Phase meter: how far deck beat phase is from the master's.
export function drawPhase(canvas, deck, master) {
  const { w, h } = fit(canvas);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(w / 2 - 1, 0, 2, h);
  if (!deck.loaded || !deck.bpm || !master || master === deck || !master.bpm || !master.loaded) return;
  const mb = master.beatAt(master.position), db = deck.beatAt(deck.position);
  let diff = (db - Math.floor(db)) - (mb - Math.floor(mb));
  diff -= Math.round(diff);
  const x = w / 2 + diff * w;
  const ok = Math.abs(diff) < 0.03;
  g.fillStyle = ok ? '#3ddc84' : DECK_COLORS[deck.index];
  g.fillRect(Math.min(x, w / 2), 0, Math.abs(x - w / 2) || 3, h);
}
