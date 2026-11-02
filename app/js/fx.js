// Effects. Every deck gets its own instance of each FX unit (3 slots each), so a
// beat-synced effect always locks to the deck it is on. The unit's knob values
// are shared and pushed into all instances.

export const FX_TYPES = {
  echo: 'Echo',
  reverb: 'Reverb',
  flanger: 'Flanger',
  crush: 'Bitcrush',
  gate: 'Trans-Gate',
  riser: 'Riser',
  phaser: 'Phaser',
  pingpong: 'Ping-Pong',
  tape: 'Tape-Echo',
  echoout: 'Echo-Out',
  wash: 'Wash-Out',
  chorus: 'Chorus',
  autopan: 'Auto-Pan',
  ringmod: 'Ring-Mod',
  lpf: 'Tiefpass',
  hpf: 'Hochpass',
  filterlfo: 'Filter-LFO',
  pump: 'Pump',
  slicer: 'Slicer',
  stutter: 'Stutter',
  drive: 'Overdrive',
  lofi: 'Lo-Fi Vinyl',
};

// Order and sections of the effect menu.
export const FX_GROUPS = {
  Echo: ['echo', 'pingpong', 'tape', 'echoout'],
  Raum: ['reverb', 'wash'],
  Modulation: ['flanger', 'phaser', 'chorus', 'autopan', 'ringmod'],
  Filter: ['lpf', 'hpf', 'filterlfo'],
  Rhythmus: ['gate', 'pump', 'slicer', 'stutter'],
  Zerrung: ['crush', 'drive', 'lofi'],
  Aufbau: ['riser'],
};

let reverbIR = null;
function getReverbIR(ctx) {
  if (reverbIR && reverbIR.sampleRate === ctx.sampleRate) return reverbIR;
  const len = Math.floor(ctx.sampleRate * 2.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; // slightly darker tail
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 80 ? i / 80 : 1);
    }
  }
  reverbIR = ir;
  return ir;
}

let noiseBuf = null;
function getNoise(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function crushCurve(bits) {
  const n = 2048, curve = new Float32Array(n), steps = Math.pow(2, bits);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function driveCurve() {
  const n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * 3);
  return curve;
}

let crackleBuf = null;
function getCrackle(ctx) {
  if (crackleBuf && crackleBuf.sampleRate === ctx.sampleRate) return crackleBuf;
  crackleBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
  const d = crackleBuf.getChannelData(0);
  for (let k = 0; k < 70; k++) {
    const at = Math.floor(Math.random() * (d.length - 40));
    const amp = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.7);
    for (let i = 0; i < 30; i++) d[at + i] += amp * Math.pow(1 - i / 30, 3);
  }
  return crackleBuf;
}

const SLICER_PATTERN = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1];
const edge = (x, width) => Math.min(1, x / width, (1 - x) / width);

// Rhythm shapes over one LFO cycle, with short edges so they don't click.
const BEAT_SHAPES = {
  square: (x) => (x < 0.5 ? edge(x * 2, 0.04) : 0),
  duck: (x) => 1 - Math.pow(Math.min(1, x / 0.6), 1.5),
  fall: (x) => Math.pow(1 - x, 2),
  sine: (x) => Math.sin(x * 2 * Math.PI),
  slicer: (x) => {
    const step = x * SLICER_PATTERN.length, i = Math.floor(step);
    return SLICER_PATTERN[i] ? edge(step - i, 0.08) : 0;
  },
};

// An LFO that can be locked to the deck's beat grid, which an OscillatorNode
// can't: a looping one-cycle buffer that is restarted when it drifts off the grid.
class BeatLfo {
  constructor(ctx, shape) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.buffer = ctx.createBuffer(1, 4096, ctx.sampleRate);
    const d = this.buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = BEAT_SHAPES[shape](i / d.length);
    this.cycle = 0.5;
    this.phase = 0;
    this.time = ctx.currentTime;
    this.restarted = -1;
    this.restart(0);
  }

  restart(phase) {
    const start = this.ctx.currentTime + 0.005;
    if (this.src) this.src.stop(start);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = this.buffer.duration / this.cycle;
    src.connect(this.output);
    src.start(start, (((phase + 0.005 / this.cycle) % 1) + 1) % 1 * this.buffer.duration);
    this.src = src;
    this.phase = phase;
    this.restarted = this.ctx.currentTime;
  }

  // cycle in seconds; target is the wanted phase now (0..1), null = free-running
  sync(cycle, target) {
    const t = this.ctx.currentTime;
    this.phase = (this.phase + (t - this.time) / this.cycle) % 1;
    this.time = t;
    if (cycle !== this.cycle) {
      this.cycle = cycle;
      this.src.playbackRate.setValueAtTime(this.buffer.duration / cycle, t);
    }
    if (target == null) return;
    const off = ((target - this.phase + 1.5) % 1) - 0.5;
    if (Math.abs(off) * cycle > 0.012 && t - this.restarted > 0.1) this.restart(target);
  }

  stop() { this.src.stop(); }
}

// One effect in one slot of one deck. Exposes input/output plus set(level, beatSec).
class Effect {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.type = type;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.wet.gain.value = 0;
    this.on = false;
    this.level = 0.5;
    this.build(type);
    this.apply(1 / 2);
  }

  build(type) {
    const ctx = this.ctx, i = this.input, w = this.wet;
    this.nodes = {};
    const n = this.nodes;
    switch (type) {
      case 'echo': {
        n.delay = ctx.createDelay(4);
        n.fb = ctx.createGain();
        n.tone = ctx.createBiquadFilter();
        n.tone.type = 'bandpass';
        n.tone.frequency.value = 1800;
        n.tone.Q.value = 0.5;
        i.connect(n.delay);
        n.delay.connect(n.tone).connect(n.fb).connect(n.delay);
        n.delay.connect(w);
        break;
      }
      case 'reverb': {
        n.conv = ctx.createConvolver();
        n.conv.buffer = getReverbIR(ctx);
        n.pre = ctx.createBiquadFilter();
        n.pre.type = 'highpass';
        n.pre.frequency.value = 280;
        i.connect(n.pre).connect(n.conv).connect(w);
        break;
      }
      case 'flanger': {
        n.delay = ctx.createDelay(0.05);
        n.delay.delayTime.value = 0.004;
        n.lfo = ctx.createOscillator();
        n.depth = ctx.createGain();
        n.fb = ctx.createGain();
        n.fb.gain.value = 0.6;
        n.depth.gain.value = 0.0028;
        n.lfo.connect(n.depth).connect(n.delay.delayTime);
        n.lfo.start();
        i.connect(n.delay);
        n.delay.connect(n.fb).connect(n.delay);
        n.delay.connect(w);
        i.connect(w);
        break;
      }
      case 'phaser': {
        n.lfo = ctx.createOscillator();
        n.stages = [];
        let prev = i;
        for (let s = 0; s < 6; s++) {
          const ap = ctx.createBiquadFilter();
          ap.type = 'allpass';
          ap.frequency.value = 900;
          ap.Q.value = 0.7;
          const d = ctx.createGain();
          d.gain.value = 700 + s * 120;
          n.lfo.connect(d).connect(ap.frequency);
          prev.connect(ap);
          prev = ap;
          n.stages.push(ap);
        }
        n.lfo.start();
        prev.connect(w);
        i.connect(w);
        break;
      }
      case 'crush': {
        n.shaper = ctx.createWaveShaper();
        n.shaper.curve = crushCurve(5);
        n.lp = ctx.createBiquadFilter();
        n.lp.type = 'lowpass';
        n.lp.frequency.value = 9000;
        i.connect(n.shaper).connect(n.lp).connect(w);
        break;
      }
      case 'gate': {
        // grid-locked LFO drives the gain of the wet copy; dry is muted while active
        n.vca = ctx.createGain();
        n.vca.gain.value = 0;
        n.beat = new BeatLfo(ctx, 'square');
        n.beat.output.connect(n.vca.gain);
        i.connect(n.vca).connect(w);
        break;
      }
      case 'pingpong': {
        // the echo bounces: left delay feeds the right one, which feeds back to the left
        n.sum = ctx.createGain();
        n.sum.channelCount = 1;
        n.sum.channelCountMode = 'explicit';
        n.delayL = ctx.createDelay(4);
        n.delayR = ctx.createDelay(4);
        n.fb = ctx.createGain();
        n.merge = ctx.createChannelMerger(2);
        i.connect(n.sum).connect(n.delayL).connect(n.delayR).connect(n.fb).connect(n.delayL);
        n.delayL.connect(n.merge, 0, 0);
        n.delayR.connect(n.merge, 0, 1);
        n.merge.connect(w);
        break;
      }
      case 'tape': {
        // dark, saturated repeats with a slow pitch wobble
        n.delay = ctx.createDelay(4);
        n.fb = ctx.createGain();
        n.sat = ctx.createWaveShaper();
        n.sat.curve = driveCurve();
        n.satIn = ctx.createGain();
        n.satIn.gain.value = 1 / 3; // unity gain for small signals, so the loop stays below 1
        n.lp = ctx.createBiquadFilter();
        n.lp.type = 'lowpass';
        n.lp.frequency.value = 2600;
        n.lp.Q.value = 0;
        n.hp = ctx.createBiquadFilter();
        n.hp.type = 'highpass';
        n.hp.frequency.value = 180;
        n.hp.Q.value = 0;
        n.lfo = ctx.createOscillator();
        n.lfo.frequency.value = 0.7;
        n.depth = ctx.createGain();
        n.depth.gain.value = 0.0012;
        n.lfo.connect(n.depth).connect(n.delay.delayTime);
        n.lfo.start();
        i.connect(n.delay);
        n.delay.connect(n.satIn).connect(n.sat).connect(n.lp).connect(n.hp);
        n.hp.connect(n.fb).connect(n.delay);
        n.hp.connect(w);
        break;
      }
      case 'echoout': {
        // the delay always listens; switching on cuts the track and leaves the echoes
        n.send = ctx.createGain();
        n.delay = ctx.createDelay(4);
        n.fb = ctx.createGain();
        i.connect(n.send).connect(n.delay);
        n.delay.connect(n.fb).connect(n.delay);
        n.delay.connect(w);
        break;
      }
      case 'wash': {
        n.hp = ctx.createBiquadFilter();
        n.hp.type = 'highpass';
        n.delay = ctx.createDelay(4);
        n.fb = ctx.createGain();
        n.conv = ctx.createConvolver();
        n.conv.buffer = getReverbIR(ctx);
        i.connect(n.hp);
        n.hp.connect(n.conv);
        n.hp.connect(n.delay);
        n.delay.connect(n.fb).connect(n.delay);
        n.delay.connect(n.conv);
        n.conv.connect(w);
        break;
      }
      case 'chorus': {
        [[0.015, 0.6, -0.7], [0.021, 0.9, 0], [0.027, 1.3, 0.7]].forEach(([time, rate, pan], v) => {
          const delay = ctx.createDelay(0.05);
          delay.delayTime.value = time;
          const lfo = ctx.createOscillator();
          lfo.frequency.value = rate;
          const depth = ctx.createGain();
          depth.gain.value = 0.0025;
          const p = ctx.createStereoPanner();
          p.pan.value = pan;
          lfo.connect(depth).connect(delay.delayTime);
          lfo.start();
          i.connect(delay).connect(p).connect(w);
          n[`lfo${v}`] = lfo;
        });
        break;
      }
      case 'autopan': {
        n.pan = ctx.createStereoPanner();
        n.depth = ctx.createGain();
        n.beat = new BeatLfo(ctx, 'sine');
        n.beat.output.connect(n.depth).connect(n.pan.pan);
        i.connect(n.pan).connect(w);
        break;
      }
      case 'ringmod': {
        n.vca = ctx.createGain();
        n.vca.gain.value = 0;
        n.lfo = ctx.createOscillator();
        n.lfo.connect(n.vca.gain);
        n.lfo.start();
        i.connect(n.vca).connect(w);
        break;
      }
      case 'lpf':
      case 'hpf': {
        n.filter = ctx.createBiquadFilter();
        n.filter.type = type === 'lpf' ? 'lowpass' : 'highpass';
        i.connect(n.filter).connect(w);
        break;
      }
      case 'filterlfo': {
        // the filter opens on the grid and closes again; detune sweeps in octaves
        n.filter = ctx.createBiquadFilter();
        n.filter.type = 'lowpass';
        n.filter.frequency.value = 280;
        n.filter.Q.value = 7;
        n.depth = ctx.createGain();
        n.beat = new BeatLfo(ctx, 'fall');
        n.beat.output.connect(n.depth).connect(n.filter.detune);
        i.connect(n.filter).connect(w);
        break;
      }
      case 'pump': {
        // sidechain feel: the signal ducks on every beat and swells back up
        n.vca = ctx.createGain();
        n.vca.gain.value = 1;
        n.depth = ctx.createGain();
        n.beat = new BeatLfo(ctx, 'duck');
        n.beat.output.connect(n.depth).connect(n.vca.gain);
        i.connect(n.vca).connect(w);
        break;
      }
      case 'slicer': {
        n.vca = ctx.createGain();
        n.depth = ctx.createGain();
        n.beat = new BeatLfo(ctx, 'slicer');
        n.beat.output.connect(n.depth).connect(n.vca.gain);
        i.connect(n.vca).connect(w);
        break;
      }
      case 'stutter': {
        // the delay line holds the last beats; on hold its input closes and it loops them
        n.send = ctx.createGain();
        n.delay = ctx.createDelay(4);
        n.fb = ctx.createGain();
        n.fb.gain.value = 0;
        i.connect(n.send).connect(n.delay);
        n.delay.connect(n.fb).connect(n.delay);
        n.delay.connect(w);
        break;
      }
      case 'drive': {
        n.pre = ctx.createGain();
        n.shaper = ctx.createWaveShaper();
        n.shaper.curve = driveCurve();
        n.shaper.oversample = '4x';
        n.lp = ctx.createBiquadFilter();
        n.lp.type = 'lowpass';
        n.lp.frequency.value = 10000;
        n.post = ctx.createGain();
        i.connect(n.pre).connect(n.shaper).connect(n.lp).connect(n.post).connect(w);
        break;
      }
      case 'lofi': {
        n.hp = ctx.createBiquadFilter();
        n.hp.type = 'highpass';
        n.lp = ctx.createBiquadFilter();
        n.lp.type = 'lowpass';
        n.delay = ctx.createDelay(0.05);
        n.delay.delayTime.value = 0.006;
        n.lfo = ctx.createOscillator();
        n.lfo.frequency.value = 0.55;
        n.depth = ctx.createGain();
        n.lfo.connect(n.depth).connect(n.delay.delayTime);
        n.lfo.start();
        n.noise = ctx.createBufferSource();
        n.noise.buffer = getCrackle(ctx);
        n.noise.loop = true;
        n.noiseGain = ctx.createGain();
        n.noise.connect(n.noiseGain).connect(w);
        n.noise.start();
        i.connect(n.hp).connect(n.lp).connect(n.delay).connect(w);
        break;
      }
      case 'riser': {
        n.hp = ctx.createBiquadFilter();
        n.hp.type = 'highpass';
        n.hp.Q.value = 6;
        n.noise = ctx.createBufferSource();
        n.noise.buffer = getNoise(ctx);
        n.noise.loop = true;
        n.noiseGain = ctx.createGain();
        n.noiseGain.gain.value = 0;
        n.noiseHp = ctx.createBiquadFilter();
        n.noiseHp.type = 'bandpass';
        n.noiseHp.Q.value = 2;
        n.noise.connect(n.noiseHp).connect(n.noiseGain).connect(w);
        n.noise.start();
        i.connect(n.hp).connect(w);
        break;
      }
    }
  }

  // Wet/dry and parameters from level (0..1) and the beat length in seconds.
  apply(beatSec) {
    const t = this.ctx.currentTime, lvl = this.on ? this.level : 0, n = this.nodes;
    const ramp = (param, v) => param.setTargetAtTime(v, t, 0.02);
    const beats = this.beats || 1;
    const period = Math.max(0.02, beatSec * beats);
    switch (this.type) {
      case 'echo':
        ramp(this.wet.gain, lvl * 0.9);
        ramp(this.dry.gain, 1);
        n.delay.delayTime.setTargetAtTime(Math.min(3.9, period * 0.75), t, 0.05);
        ramp(n.fb.gain, 0.35 + lvl * 0.45);
        break;
      case 'reverb':
        ramp(this.wet.gain, lvl * 1.1);
        ramp(this.dry.gain, 1 - lvl * 0.25);
        break;
      case 'flanger':
      case 'phaser':
        n.lfo.frequency.setTargetAtTime(1 / Math.max(0.25, period * 4), t, 0.05);
        ramp(this.wet.gain, lvl * 0.8);
        ramp(this.dry.gain, 1 - lvl * 0.6);
        break;
      case 'crush':
        n.shaper.curve = crushCurve(Math.round(8 - lvl * 5));
        n.lp.frequency.setTargetAtTime(14000 - lvl * 9000, t, 0.05);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 1 - Math.min(1, lvl * 1.5) : 1);
        break;
      case 'gate':
        this.syncBeat(period / 4, beats / 4);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, 1 - lvl);
        break;
      case 'pingpong': {
        const side = Math.min(3.9, period / 2);
        n.delayL.delayTime.setTargetAtTime(side, t, 0.05);
        n.delayR.delayTime.setTargetAtTime(side, t, 0.05);
        ramp(n.fb.gain, 0.3 + lvl * 0.5);
        ramp(this.wet.gain, lvl);
        break;
      }
      case 'tape':
        n.delay.delayTime.setTargetAtTime(Math.min(3.9, period * 0.75), t, 0.08);
        ramp(n.fb.gain, 0.3 + lvl * 0.45);
        ramp(this.wet.gain, lvl * 0.8);
        break;
      case 'echoout':
        n.delay.delayTime.setTargetAtTime(Math.min(3.9, period / 2), t, 0.05);
        ramp(n.fb.gain, this.on ? 0.5 + lvl * 0.42 : 0);
        ramp(n.send.gain, 1 - lvl);
        ramp(this.dry.gain, 1 - lvl);
        // on release the remaining echoes fade instead of stopping dead
        this.wet.gain.setTargetAtTime(this.on ? 1 : 0, t, this.on ? 0.01 : 0.4);
        break;
      case 'wash':
        n.hp.frequency.setTargetAtTime(200 + lvl * 2300, t, 0.05);
        n.delay.delayTime.setTargetAtTime(Math.min(3.9, period * 0.75), t, 0.05);
        ramp(n.fb.gain, 0.3 + lvl * 0.45);
        ramp(this.wet.gain, lvl * 2);
        ramp(this.dry.gain, 1 - lvl);
        break;
      case 'chorus':
        ramp(this.wet.gain, lvl * 0.45);
        ramp(this.dry.gain, 1 - lvl * 0.3);
        break;
      case 'autopan':
        this.syncBeat(period * 2, beats * 2);
        ramp(n.depth.gain, lvl);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'ringmod':
        n.lfo.frequency.setTargetAtTime(40 * Math.pow(30, lvl), t, 0.03);
        ramp(this.wet.gain, lvl);
        ramp(this.dry.gain, 1 - lvl);
        break;
      case 'lpf':
        n.filter.frequency.setTargetAtTime(18000 * Math.pow(2, -lvl * 7), t, 0.03);
        n.filter.Q.setTargetAtTime(1 + lvl * 7, t, 0.03);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'hpf':
        n.filter.frequency.setTargetAtTime(20 * Math.pow(2, lvl * 9.5), t, 0.03);
        n.filter.Q.setTargetAtTime(1 + lvl * 7, t, 0.03);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'filterlfo':
        this.syncBeat(period, beats);
        ramp(n.depth.gain, 1800 + lvl * 4200);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'pump':
        this.syncBeat(period, beats);
        ramp(n.depth.gain, -lvl);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'slicer':
        this.syncBeat(period * 4, beats * 4);
        ramp(n.vca.gain, 1 - lvl);
        ramp(n.depth.gain, lvl);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'stutter': {
        const loop = Math.min(3.9, period);
        // a feedback cycle adds one render quantum, which would drift the loop off the grid;
        // whole frames only, because interpolating on every pass dulls the sound
        const sr = this.ctx.sampleRate;
        n.delay.delayTime.setTargetAtTime((Math.round(loop * sr) - 128) / sr, t, 0.02);
        // hold only once the delay line is filled with playing audio, else it loops silence
        if (!this.on) this.holding = false;
        else if (this.liveSince != null && t - this.liveSince >= loop) this.holding = true;
        ramp(n.send.gain, this.holding ? 0 : 1);
        ramp(n.fb.gain, this.holding ? 0.8 + this.level * 0.199 : 0);
        ramp(this.wet.gain, this.holding ? 1 : 0);
        ramp(this.dry.gain, this.holding ? 0 : 1);
        break;
      }
      case 'drive':
        ramp(n.pre.gain, 0.25 + lvl * 2);
        ramp(n.post.gain, 0.8 - lvl * 0.5);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'lofi':
        n.hp.frequency.setTargetAtTime(80 + lvl * 300, t, 0.05);
        n.lp.frequency.setTargetAtTime(9000 - lvl * 6200, t, 0.05);
        ramp(n.depth.gain, lvl * 0.003);
        ramp(n.noiseGain.gain, lvl * 0.2);
        ramp(this.wet.gain, lvl > 0 ? 1.3 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
      case 'riser':
        n.hp.frequency.setTargetAtTime(20 + Math.pow(lvl, 2) * 4000, t, 0.03);
        n.noiseHp.frequency.setTargetAtTime(400 + lvl * 7000, t, 0.03);
        ramp(n.noiseGain.gain, lvl * 0.12);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, lvl > 0 ? 0 : 1);
        break;
    }
  }

  // Lock a BeatLfo to the deck: its cycle lasts cycleBeats beats and starts on the grid.
  syncBeat(cycleSec, cycleBeats) {
    const pos = this.beatPos;
    const target = pos == null ? null : (((pos / cycleBeats) % 1) + 1) % 1;
    this.nodes.beat.sync(Math.max(0.03, cycleSec), target);
  }

  dispose() {
    for (const node of Object.values(this.nodes)) if (node?.stop) try { node.stop(); } catch {}
    this.input.disconnect();
    this.output.disconnect();
  }
}

// The user-facing FX unit: 3 slots, a beats setting and the decks it is assigned to.
export class FxUnit {
  constructor(index, types) {
    this.index = index;
    this.slots = types.map((type) => ({ type, on: false, level: 0.5 }));
    this.beats = 1;
    this.assigned = [false, false, false, false];
    this.chains = new Map(); // deck -> {input, output, effects[]}
  }

  static BEATS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8];

  stepBeats(dir) {
    const list = FxUnit.BEATS;
    let i = list.indexOf(this.beats);
    if (i < 0) i = 4;
    this.beats = list[Math.max(0, Math.min(list.length - 1, i + dir))];
  }

  // Build (or rebuild) the effect chain for one deck between input and output nodes.
  chainFor(ctx, deck) {
    let ch = this.chains.get(deck.index);
    if (ch && ch.types === this.slots.map((s) => s.type).join()) return ch;
    if (ch) ch.effects.forEach((e) => e.dispose());
    const input = ch ? ch.input : ctx.createGain();
    const output = ch ? ch.output : ctx.createGain();
    input.disconnect();
    const effects = this.slots.map((s) => new Effect(ctx, s.type));
    let prev = input;
    for (const e of effects) { prev.connect(e.input); prev = e.output; }
    prev.connect(output);
    ch = { input, output, effects, types: this.slots.map((s) => s.type).join() };
    this.chains.set(deck.index, ch);
    return ch;
  }

  update(ctx, decks) {
    for (const deck of decks) {
      const ch = this.chains.get(deck.index);
      if (!ch) continue;
      const beatSec = deck.beatSeconds();
      const live = this.assigned[deck.index] && deck.playing;
      const beatPos = live && deck.bpm ? deck.beatAt(deck.position) : null;
      ch.effects.forEach((e, i) => {
        const s = this.slots[i];
        e.on = s.on && this.assigned[deck.index];
        e.level = s.level;
        e.beats = this.beats;
        e.beatPos = beatPos;
        if (!live) e.liveSince = null;
        else if (e.liveSince == null) e.liveSince = ctx.currentTime;
        e.apply(beatSec);
      });
    }
  }
}
