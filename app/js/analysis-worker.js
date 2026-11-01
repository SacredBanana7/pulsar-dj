// Track analysis off the main thread: 3-band waveform, BPM + beat grid,
// musical key (Camelot) and loudness for auto-gain.
// Input: { id, mono: Float32Array, sr }  Output: { id, result }

const WF_RATE = 150; // waveform bins per second

self.onmessage = (e) => {
  const { id, mono, sr } = e.data;
  try {
    const result = analyze(mono, sr, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result }, [result.wave.low.buffer, result.wave.mid.buffer, result.wave.high.buffer, result.wave.peak.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

function biquad(type, f, sr, q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), a = sn / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  const a0 = 1 + a;
  const c = [b0 / a0, b1 / a0, b2 / a0, (-2 * cs) / a0, (1 - a) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function analyze(x, sr, progress) {
  const n = x.length;
  const hop = sr / WF_RATE;
  const bins = Math.ceil(n / hop);
  const low = new Float32Array(bins), mid = new Float32Array(bins), high = new Float32Array(bins), peak = new Float32Array(bins);
  const lp1 = biquad('lp', 200, sr), lp2 = biquad('lp', 200, sr);
  const hp1 = biquad('hp', 200, sr), mlp = biquad('lp', 2500, sr);
  const hh1 = biquad('hp', 2500, sr), hh2 = biquad('hp', 2500, sr);
  let sumSq = 0;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * hop), e = Math.min(n, Math.floor((b + 1) * hop));
    let el = 0, em = 0, eh = 0, pk = 0;
    for (let i = s; i < e; i++) {
      const v = x[i];
      const l = lp2(lp1(v));
      const m = mlp(hp1(v));
      const h = hh2(hh1(v));
      el += l * l; em += m * m; eh += h * h;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      sumSq += v * v;
    }
    const cnt = Math.max(1, e - s);
    low[b] = Math.sqrt(el / cnt);
    mid[b] = Math.sqrt(em / cnt);
    high[b] = Math.sqrt(eh / cnt);
    peak[b] = pk;
    if (b % 20000 === 0) progress(0.4 * b / bins);
  }

  // ---- tempo from onset strength (low + full band flux) ----
  const onset = new Float32Array(bins);
  for (let b = 1; b < bins; b++) {
    const dl = low[b] - low[b - 1];
    const dm = mid[b] - mid[b - 1];
    const dh = high[b] - high[b - 1];
    onset[b] = Math.max(0, dl) * 1.6 + Math.max(0, dm) * 0.8 + Math.max(0, dh) * 0.5;
  }
  // remove local mean
  const win = 30;
  const onsetN = new Float32Array(bins);
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += onset[b];
    if (b >= win) acc -= onset[b - win];
    onsetN[b] = Math.max(0, onset[b] - acc / Math.min(b + 1, win));
  }
  const { bpm, offsetSec, confidence } = findTempo(onsetN, WF_RATE);
  progress(0.65);

  // downbeat: which beat (mod 4) carries most low-end energy
  let downbeat = offsetSec;
  if (bpm > 0) {
    const beatSec = 60 / bpm;
    const score = [0, 0, 0, 0];
    for (let k = 0; ; k++) {
      const t = offsetSec + k * beatSec;
      const b = Math.round(t * WF_RATE);
      if (b >= bins) break;
      score[k % 4] += low[b] + (low[b + 1] || 0);
    }
    const best = score.indexOf(Math.max(...score));
    downbeat = offsetSec + best * beatSec;
    while (downbeat - 4 * beatSec >= 0) downbeat -= 4 * beatSec;
  }

  const key = detectKey(x, sr);
  progress(0.95);

  // loudness (RMS dBFS) -> gain needed to reach -14 dBFS RMS-ish
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const rmsDb = 20 * Math.log10(rms + 1e-9);

  // normalise waveform bands to 0..255
  const norm = (arr) => {
    let m = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    const out = new Uint8Array(arr.length);
    const k = m > 0 ? 255 / m : 0;
    for (let i = 0; i < arr.length; i++) out[i] = Math.min(255, Math.round(arr[i] * k));
    return out;
  };
  return {
    bpm,
    beatOffset: downbeat,
    bpmConfidence: confidence,
    key,
    rmsDb,
    duration: n / sr,
    wave: { rate: WF_RATE, low: norm(low), mid: norm(mid), high: norm(high), peak: norm(peak) },
  };
}

// Autocorrelation for a coarse period, then a fine phase-histogram search.
function findTempo(on, fps) {
  const n = on.length;
  if (n < fps * 8) return { bpm: 0, offsetSec: 0, confidence: 0 };
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxLag + 2);
  const len = Math.min(n, fps * 120);           // two minutes is plenty
  const start = Math.max(0, Math.floor((n - len) / 2));
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = start; i < start + len - lag; i++) s += on[i] * on[i + lag];
    ac[lag] = s;
  }
  // score each candidate BPM with its harmonics, prefer 85..175
  let bestBpm = 120, bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = fps * 60 / bpm;
    const at = (l) => {
      const i = Math.floor(l), f = l - i;
      if (i + 1 > maxLag + 1) return 0;
      return ac[i] * (1 - f) + ac[i + 1] * f;
    };
    let s = at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4) + 0.3 * at(lag / 2 >= minLag ? lag / 2 : lag);
    const w = bpm >= 85 && bpm <= 175 ? 1 : 0.6;
    s *= w;
    if (s > bestScore) { bestScore = s; bestBpm = bpm; }
  }
  // fine search: sharpness of phase histogram
  const H = 48;
  const hist = new Float32Array(H);
  let fineBpm = bestBpm, fineScore = -1, finePhase = 0;
  for (let bpm = bestBpm - 1.2; bpm <= bestBpm + 1.2; bpm += 0.02) {
    const period = fps * 60 / bpm;
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const v = on[i];
      if (v <= 0) continue;
      const ph = (i % period) / period;
      hist[Math.floor(ph * H) % H] += v;
    }
    let mx = 0, mi = 0, tot = 0;
    for (let h = 0; h < H; h++) {
      const v = hist[h] + 0.5 * (hist[(h + 1) % H] + hist[(h + H - 1) % H]);
      tot += hist[h];
      if (v > mx) { mx = v; mi = h; }
    }
    const score = mx / (tot + 1e-9);
    if (score > fineScore) { fineScore = score; fineBpm = bpm; finePhase = mi; }
  }
  // snap to a round value if very close (most club tracks use integer BPM)
  let bpm = fineBpm;
  const r = Math.round(bpm);
  if (Math.abs(bpm - r) < 0.06) bpm = r;
  else if (Math.abs(bpm * 2 - Math.round(bpm * 2)) < 0.06) bpm = Math.round(bpm * 2) / 2;
  // refine phase with the final bpm (center of mass around the peak)
  const period = fps * 60 / bpm;
  hist.fill(0);
  const HH = 96;
  const hist2 = new Float32Array(HH);
  for (let i = 0; i < n; i++) if (on[i] > 0) hist2[Math.floor(((i % period) / period) * HH) % HH] += on[i];
  let mx = 0, mi = 0;
  for (let h = 0; h < HH; h++) {
    const v = hist2[h] + 0.6 * (hist2[(h + 1) % HH] + hist2[(h + HH - 1) % HH]);
    if (v > mx) { mx = v; mi = h; }
  }
  let num = 0, den = 0;
  for (let d = -2; d <= 2; d++) {
    const h = (mi + d + HH) % HH;
    num += (mi + d) * hist2[h];
    den += hist2[h];
  }
  const ph = (den > 0 ? num / den : mi) / HH;
  // empirical correction: rising-edge flux peaks land slightly before the beat
  let offsetSec = (ph * period + 0.2) / fps;
  if (offsetSec < 0) offsetSec += period / fps;
  return { bpm, offsetSec, confidence: Math.min(1, fineScore * H / 6) };
}

// ---- key detection: chroma + Krumhansl-Schmuckler ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Camelot numbers indexed by pitch class
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

function detectKey(x, sr) {
  // decimate to ~11 kHz with a crude low-pass
  const dec = Math.max(1, Math.floor(sr / 11025));
  const fs = sr / dec;
  const m = Math.floor(x.length / dec);
  const y = new Float32Array(m);
  const lp1 = biquad('lp', fs * 0.42, sr), lp2 = biquad('lp', fs * 0.42, sr);
  for (let i = 0, j = 0; j < m; i++) {
    const v = lp2(lp1(x[i]));
    if (i % dec === 0) y[j++] = v;
  }
  const N = 8192;
  const re = new Float32Array(N), im = new Float32Array(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const chroma = new Float64Array(12);
  // map FFT bins (65 Hz .. 2 kHz) to pitch classes
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * fs / N;
    if (f < 65 || f > 2100) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const nearest = Math.round(midi);
    if (Math.abs(midi - nearest) > 0.35) continue;
    binPc[k] = ((nearest % 12) + 12) % 12;
  }
  const hop = N;
  for (let s = 0; s + N <= m; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = y[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const frame = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      frame[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    let fsum = 0;
    for (let c = 0; c < 12; c++) fsum += frame[c];
    if (fsum <= 1e-6) continue;
    for (let c = 0; c < 12; c++) chroma[c] += frame[c] / fsum;
  }
  const corr = (profile, root) => {
    let mx = 0, mp = 0;
    for (let i = 0; i < 12; i++) { mx += chroma[(i + root) % 12]; mp += profile[i]; }
    mx /= 12; mp /= 12;
    let num = 0, dx = 0, dp = 0;
    for (let i = 0; i < 12; i++) {
      const a = chroma[(i + root) % 12] - mx, b = profile[i] - mp;
      num += a * b; dx += a * a; dp += b * b;
    }
    return num / Math.sqrt(dx * dp + 1e-12);
  };
  let best = { score: -2, root: 0, minor: false };
  for (let r = 0; r < 12; r++) {
    const sM = corr(MAJOR, r), sm = corr(MINOR, r);
    if (sM > best.score) best = { score: sM, root: r, minor: false };
    if (sm > best.score) best = { score: sm, root: r, minor: true };
  }
  const num = best.minor ? CAMELOT_MINOR[best.root] : CAMELOT_MAJOR[best.root];
  return {
    name: NAMES[best.root] + (best.minor ? 'm' : ''),
    camelot: num + (best.minor ? 'A' : 'B'),
    confidence: best.score,
  };
}
