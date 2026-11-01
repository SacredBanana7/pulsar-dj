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
        // square LFO drives the gain of the wet copy; dry is muted while active
        n.vca = ctx.createGain();
        n.vca.gain.value = 0;
        n.lfo = ctx.createOscillator();
        n.lfo.type = 'square';
        n.lfoAmt = ctx.createGain();
        n.lfoAmt.gain.value = 0.5;
        n.offset = ctx.createConstantSource();
        n.offset.offset.value = 0.5;
        n.lfo.connect(n.lfoAmt).connect(n.vca.gain);
        n.offset.connect(n.vca.gain);
        n.lfo.start();
        n.offset.start();
        i.connect(n.vca).connect(w);
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
        n.lfo.frequency.setTargetAtTime(1 / Math.max(0.05, period / 4), t, 0.01);
        ramp(this.wet.gain, lvl > 0 ? 1 : 0);
        ramp(this.dry.gain, 1 - lvl);
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

  dispose() {
    const n = this.nodes;
    for (const k of ['lfo', 'noise', 'offset']) if (n[k]) try { n[k].stop(); } catch {}
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
      ch.effects.forEach((e, i) => {
        const s = this.slots[i];
        e.on = s.on && this.assigned[deck.index];
        e.level = s.level;
        e.beats = this.beats;
        e.apply(beatSec);
      });
    }
  }
}
