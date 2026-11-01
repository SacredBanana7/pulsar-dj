// Generates short synthetic club loops (WAV) with known BPM and key, used to
// check Pulsar's beat and key detection. Output: ../test-tracks/
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../test-tracks/', import.meta.url));
mkdirSync(out, { recursive: true });
const SR = 44100;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function render({ bpm, seconds, chords, bass, offset = 0 }) {
  const n = Math.floor(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR - offset;
    if (t < 0) continue;
    const b = t / beat;
    const inBeat = (b % 1) * beat;
    const bar = Math.floor(b / 4);
    // kick on every beat
    const kEnv = Math.exp(-inBeat * 18);
    const kick = Math.sin(2 * Math.PI * (45 * inBeat + 90 * (1 - Math.exp(-inBeat * 30)) / 30)) * kEnv * 0.9;
    // offbeat hat
    const off = ((b + 0.5) % 1) * beat;
    const hat = rnd() * Math.exp(-off * 60) * 0.18;
    // clap on 2 and 4
    const cb = ((b % 2) - 1) * beat;
    const clap = cb >= 0 ? rnd() * Math.exp(-cb * 25) * 0.2 : 0;
    // chord pad (changes every bar)
    const chord = chords[bar % chords.length];
    let pad = 0;
    for (const m of chord) {
      const f = midiHz(m);
      pad += Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.12;
    }
    pad *= 0.07 * (0.6 + 0.4 * Math.sin(Math.PI * (b % 1)));
    // bass on offbeats
    const bm = bass[bar % bass.length];
    const bEnv = Math.exp(-off * 6);
    const bs = Math.sin(2 * Math.PI * midiHz(bm) * t) * bEnv * 0.25;
    const mono = kick + clap + bs;
    L[i] = Math.tanh(mono + hat * 0.8 + pad * 1.1);
    R[i] = Math.tanh(mono + hat * 1.2 + pad * 0.9);
  }
  return [L, R];
}

function wav(name, [L, R]) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32000), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32000), 46 + i * 4);
  }
  writeFileSync(out + name, buf);
  console.log('wrote', name);
}

// A minor (8A): Am - F - C - G
wav('Pulsar Test - Nachtfahrt (124 BPM, 8A).wav', render({
  bpm: 124, seconds: 75, offset: 0.12,
  chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
  bass: [33, 29, 36, 31],
}));
// C major (8B): C - G - Am - F
wav('Pulsar Test - Sonnendeck (128 BPM, 8B).wav', render({
  bpm: 128, seconds: 75, offset: 0.31,
  chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]],
  bass: [36, 31, 33, 29],
}));
// F# minor (11A)
wav('Pulsar Test - Tiefgarage (122 BPM, 11A).wav', render({
  bpm: 122, seconds: 60, offset: 0.05,
  chords: [[54, 57, 61], [50, 54, 57], [57, 61, 64], [52, 56, 59]],
  bass: [30, 26, 33, 28],
}));
