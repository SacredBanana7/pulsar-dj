// Control bridge: maps Mixxx control objects (group, key) onto Pulsar state.
// Every control is described by a small definition object:
//   kind    'pot' (min..max, linear), 'logpot' (0..max, 1 = unity at param 0.5),
//           'push' (momentary, acts on every write), 'toggle' (latching on MIDI),
//           'pw' (power-window: latching, but momentary when held > 300 ms),
//           'raw' (plain number, MIDI value passed through)
//   get()   current value in Mixxx units
//   set(v)  write a value in Mixxx units
//   def     default value
// Unknown controls live in a generic value store so mapping scripts keep running.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { HOTCUE_COLORS } from '../deck.js';
import { FX_TYPES } from '../fx.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const b2n = (b) => (b ? 1 : 0);
const hexToRgb = (h) => parseInt(h.slice(1), 16);
const EPS = 1e-6;

// ---------- normalisation ----------
// Mixxx logpot: upper half is linear in dB up to `max`, lower half falls to -40 dB, 0 = silence
export function logpotFromParam(p, max) {
  if (p <= 0) return 0;
  const dbMax = 20 * Math.log10(max);
  const db = p >= 0.5 ? (p - 0.5) * 2 * dbMax : (p - 0.5) * 2 * 40;
  return Math.pow(10, db / 20);
}

export function logpotToParam(v, max) {
  if (v <= 0) return 0;
  const db = 20 * Math.log10(v);
  const dbMax = 20 * Math.log10(max);
  return clamp(db >= 0 ? 0.5 + db / dbMax / 2 : 0.5 + db / 40 / 2, 0, 1);
}

export function toParam(c, v) {
  if (c.kind === 'pot') return c.max === c.min ? 0 : (v - c.min) / (c.max - c.min);
  if (c.kind === 'logpot') return logpotToParam(v, c.max);
  return v;
}

export function fromParam(c, p) {
  if (c.kind === 'pot') return c.min + p * (c.max - c.min);
  if (c.kind === 'logpot') return logpotFromParam(p, c.max);
  return p;
}

// ControlPotmeterBehavior: 64 is exactly the centre, 127 reaches 1.0
export const midiToParam = (m) => (m <= 64 ? m / 128 : 0.5 + (m - 64) / 126);
export const paramToMidi = (p) => clamp(p <= 0.5 ? p * 128 : 64 + (p - 0.5) * 126, 0, 127);

const isPot = (c) => c.kind === 'pot' || c.kind === 'logpot';

// beat sizes Mixxx offers as beatloop_X / beatjump_X controls
const SIZE = '(\\d+(?:\\.\\d+)?|\\d+/\\d+)';
const parseSize = (s) => (s.includes('/') ? Number(s.split('/')[0]) / Number(s.split('/')[1]) : Number(s));

// defaults for controls Pulsar has no counterpart for, as Mixxx reports them
function genericDefault(group, key) {
  const eq = /^\[EqualizerRack1_/.test(group), quick = /^\[QuickEffectRack1_/.test(group);
  const fx = /^\[EffectRack1_EffectUnit\d+_Effect\d+\]$/.test(group);
  if (/_Effect\d+\]$/.test(group)) {
    if (key === 'num_parameters' || key === 'num_parameterslots') return 3;
    if (key === 'num_button_parameters' || key === 'num_button_parameterslots') return eq ? 3 : 0;
    if (key === 'enabled') return eq || quick ? 1 : 0;
    if (key === 'loaded') return 1;
    if (/^parameter\d+$/.test(key) || key === 'meta') return fx ? 0.5 : 1;
  }
  if (/^\[EffectRack1_EffectUnit\d+\]$/.test(group)) {
    if (key === 'num_effects' || key === 'num_effectslots') return 3;
    if (key === 'enabled' || key === 'mix') return 1;
    if (key === 'super1') return 0;
  }
  if (quick && key === 'enabled') return 1;
  if (/^\[EffectRack\d+\]$/.test(group) && key === 'num_effectunits') return 4;
  if (/^\[(Sampler|PreviewDeck)\d+\]$/.test(group)) {
    if (key === 'volume' || key === 'pregain' || key === 'rate_dir') return 1;
    if (key === 'orientation') return 1;
  }
  if (/^\[Channel\d+\]$/.test(group)) {
    if (key === 'volume' || key === 'pregain' || key === 'rate_dir') return 1;
    if (key === 'orientation') return 1;
  }
  return 0;
}

const bridges = new WeakMap();

// One bridge per app: Mixxx has a single control engine shared by all controllers.
export function getBridge(app) {
  let b = bridges.get(app);
  if (!b) { b = new ControlBridge(app); bridges.set(app, b); }
  return b;
}

export class ControlBridge {
  constructor(app) {
    this.app = app;
    this.cache = new Map();
    this.store = new Map();            // generic values for controls Pulsar doesn't have
    this.deckState = [0, 1, 2, 3].map(() => ({
      beatjumpSize: 4, held: {}, scratch2: 0, scratch2On: false, wheel: 0, reverseRollSlip: null, kills: {},
    }));
    this.levelCache = { t: -1, decks: [0, 0, 0, 0], master: [0, 0] };
    this.lastFrame = 0;
    this.errors = 0;
    this.listeners = new Set();        // called with (group, key) after every write
  }

  key(group, key) { return group + '\u0000' + key; }

  // ---------- public value API ----------
  resolve(group, key) {
    const k = this.key(group, key);
    let c = this.cache.get(k);
    if (!c) {
      c = this.build(String(group), String(key)) || this.generic(k);
      c.group = group;
      c.name = key;
      this.cache.set(k, c);
    }
    return c;
  }

  getValue(group, key) {
    const c = this.resolve(group, key);
    try {
      const v = Number(c.get());
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  setValue(group, key, v) {
    const c = this.resolve(group, key);
    v = Number(v);
    if (!Number.isFinite(v)) v = 0;
    if (c.ro) return;
    try { c.set(v); } catch (e) { this.report(e, group, key); }
    this.app.ui?.dirty?.();
    for (const l of this.listeners) l(group, key);
  }

  getParameter(group, key) { const c = this.resolve(group, key); return toParam(c, this.getValue(group, key)); }
  setParameter(group, key, p) { const c = this.resolve(group, key); this.setValue(group, key, fromParam(c, clamp(Number(p) || 0, 0, 1))); }
  getParameterForValue(group, key, v) { return toParam(this.resolve(group, key), Number(v) || 0); }
  getDefaultValue(group, key) { return this.resolve(group, key).def ?? 0; }
  getDefaultParameter(group, key) { const c = this.resolve(group, key); return toParam(c, c.def ?? 0); }
  reset(group, key) { this.setValue(group, key, this.getDefaultValue(group, key)); }
  isPot(group, key) { return isPot(this.resolve(group, key)); }

  // MIDI value -> control, using the control's MIDI behaviour (ControlBehavior::setValueFromMidi)
  setValueFromMidi(group, key, opcode, m) {
    const c = this.resolve(group, key);
    const pressed = opcode !== 0x80 && m > 0;
    switch (c.kind) {
      case 'pot': case 'logpot':
        return this.setValue(group, key, fromParam(c, midiToParam(m)));
      case 'push':
        return this.setValue(group, key, pressed ? 1 : 0);
      case 'toggle':
        if (!pressed) return;
        return this.setValue(group, key, c.states ? (this.getValue(group, key) + 1) % c.states : b2n(!this.getValue(group, key)));
      case 'pw': {
        if (pressed) {
          c.pressedAt = performance.now();
          return this.setValue(group, key, b2n(!this.getValue(group, key)));
        }
        if (c.pressedAt && performance.now() - c.pressedAt > 300) this.setValue(group, key, b2n(!this.getValue(group, key)));
        c.pressedAt = 0;
        return;
      }
      default:
        return this.setValue(group, key, m);
    }
  }

  // current value as MIDI parameter (ControlObject::getMidiParameter)
  getMidiParameter(group, key) {
    const c = this.resolve(group, key);
    return isPot(c) ? paramToMidi(toParam(c, this.getValue(group, key))) : this.getValue(group, key);
  }

  report(e, group, key) {
    if (this.errors++ < 20) console.warn(`[mixxx] ${group} ${key}:`, e);
  }

  // ---------- per-frame upkeep (fast search, scratch2 velocity, wheel) ----------
  frame() {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    if (dt < 0.005) return;
    this.lastFrame = now;
    this.app.decks.forEach((d, i) => {
      const s = this.deckState[i];
      if (!d.loaded) return;
      try {
        if (s.held.fwd) d.seek(d.position + dt * 4);
        if (s.held.back) d.seek(d.position - dt * 4);
        if (s.scratch2On && s.scratch2) d.send({ type: 'scratchMove', frames: s.scratch2 * dt * d.sr });
        if (s.wheel && !d.playing) d.seek(d.position + s.wheel * dt * 0.5);
      } catch (e) { /* audio not started yet */ }
    });
  }

  // ---------- levels (one analyser read per frame) ----------
  levels() {
    const now = performance.now();
    const lc = this.levelCache;
    if (now - lc.t < 15) return lc;
    lc.t = now;
    this.app.decks.forEach((d, i) => {
      try { lc.decks[i] = d.strip ? d.strip.level() : 0; } catch { lc.decks[i] = 0; }
    });
    try { lc.master = this.app.engine.ctx && this.app.engine.masterLevels ? this.app.engine.masterLevels() : [0, 0]; } catch { lc.master = [0, 0]; }
    return lc;
  }

  static vu(peak) {
    const db = 20 * Math.log10(peak + 1e-6);
    return clamp((db + 48) / 48, 0, 1);
  }

  // ---------- definition helpers ----------
  generic(k) {
    const store = this.store;
    const [group, key] = k.split('\u0000');
    const def = genericDefault(group, key);
    return { kind: 'raw', def, get: () => store.get(k) ?? def, set: (v) => store.set(k, v) };
  }

  stored(k, def = 0, kind = 'raw', onSet) {
    const store = this.store;
    if (!store.has(k)) store.set(k, def);
    return { kind, def, get: () => store.get(k), set: (v) => { store.set(k, v); onSet?.(v); } };
  }

  act(name, t, a, b) {
    try { this.app.act(name, t, a, b); } catch (e) { this.report(e, name, t); }
  }

  mix() {
    try { this.app.engine.applyMix(this.app.decks); } catch (e) { this.report(e, 'mix', ''); }
  }

  build(group, key) {
    if (group === '[Main]' || group === '[App]') group = group === '[Main]' ? '[Master]' : group;
    let m;
    if ((m = /^\[Channel(\d+)\]$/.exec(group))) {
      const i = Number(m[1]) - 1;
      return i < this.app.decks.length ? this.channel(i, key, group) : null;
    }
    if (group === '[Master]' || group === '[App]') return this.master(key, group);
    if (group === '[Library]' || group === '[Playlist]') return this.library(key);
    if ((m = /^\[EqualizerRack1_\[Channel(\d+)\]_Effect1\]$/.exec(group))) {
      const i = Number(m[1]) - 1;
      return i < this.app.decks.length ? this.eqRack(i, key, group) : null;
    }
    if ((m = /^\[QuickEffectRack1_\[Channel(\d+)\]\]$/.exec(group))) {
      const i = Number(m[1]) - 1;
      if (i < this.app.decks.length && key === 'super1') return this.mixPot(i, 'filter', 0.5);
      return null;
    }
    if ((m = /^\[EffectRack1_EffectUnit(\d+)\]$/.exec(group))) {
      const u = Number(m[1]) - 1;
      return u < this.app.engine.fxUnits.length ? this.fxUnit(u, key, group) : null;
    }
    if ((m = /^\[EffectRack1_EffectUnit(\d+)_Effect(\d+)\]$/.exec(group))) {
      const u = Number(m[1]) - 1, s = Number(m[2]) - 1;
      const unit = this.app.engine.fxUnits[u];
      return unit && s < unit.slots.length ? this.fxSlot(u, s, key, group) : null;
    }
    return null;
  }

  ro(get) { return { kind: 'raw', ro: true, def: 0, get, set() {} }; }

  mixPot(i, field, def) {
    const d = this.app.decks[i];
    return { kind: 'pot', min: 0, max: 1, def, get: () => d.mix[field], set: (v) => { d.mix[field] = clamp(v, 0, 1); this.mix(); } };
  }

  // logpot (0..max, 1 = unity) onto a Pulsar 0..1 knob with 0.5 = unity
  mixLogpot(i, field, max = 4) {
    const d = this.app.decks[i];
    return { kind: 'logpot', max, def: 1, get: () => logpotFromParam(d.mix[field], max), set: (v) => { d.mix[field] = logpotToParam(v, max); this.mix(); } };
  }

  // EQ kill button (Mixxx keeps the knob, Pulsar only has the knob: remember it)
  kill(i, field) {
    const d = this.app.decks[i], st = this.deckState[i].kills;
    return {
      kind: 'pw', def: 0,
      get: () => b2n(st[field] != null),
      set: (v) => {
        if (v && st[field] == null) { st[field] = d.mix[field]; d.mix[field] = 0; }
        else if (!v && st[field] != null) { d.mix[field] = st[field] || 0.5; delete st[field]; }
        this.mix();
      },
    };
  }

  // momentary/one-shot: `down` runs on every write > 0, `up` on writes of 0
  push(k, down, up, kind = 'push') {
    const store = this.store;
    return {
      kind, def: 0,
      get: () => store.get(k) ?? 0,
      set: (v) => { store.set(k, v); if (v > 0) down?.(v); else up?.(); },
    };
  }

  // ---------- [ChannelN] ----------
  channel(i, key, group) {
    const a = this.app, d = a.decks[i], st = this.deckState[i], k = this.key(group, key);
    const loaded = () => d.loaded;
    const sec2samples = (s) => Math.round(s * d.sr) * 2;
    const toggle = (get, set) => ({ kind: 'toggle', def: 0, get: () => b2n(get()), set: (v) => { if (!!v !== !!get()) set(!!v); } });
    const trig = (fn) => this.push(k, () => { if (loaded()) fn(); });
    let m;

    if ((m = /^hotcue_(\d+)_(.+)$/.exec(key))) {
      const n = Number(m[1]) - 1, what = m[2];
      if (n >= d.hotcues.length) return null;
      const has = () => d.hotcues[n] != null;
      switch (what) {
        case 'activate': case 'activatecue': return this.push(k, () => this.act('hotcueDown', i, n), () => this.act('hotcueUp', i, n));
        case 'clear': return trig(() => this.act('hotcueClear', i, n));
        case 'set': return trig(() => { d.hotcues[n] = null; d.hotcueDown(n); });
        case 'goto': return trig(() => { if (has()) d.seek(d.hotcues[n]); });
        case 'gotoandplay': return trig(() => { if (has()) { d.seek(d.hotcues[n]); if (!d.playing) this.act('play', i); } });
        case 'gotoandstop': return trig(() => { if (has()) { d.pause(); d.seek(d.hotcues[n]); } });
        case 'gotoandloop': return trig(() => { if (has()) { d.seek(d.hotcues[n]); d.beatLoop(d.loop.beats || 4); } });
        case 'enabled': case 'status': return this.ro(() => (has() ? (d.hotcuePreview === n ? 2 : 1) : 0));
        case 'position': return this.ro(() => (has() ? sec2samples(d.hotcues[n]) : -1));
        case 'color': return this.ro(() => hexToRgb(HOTCUE_COLORS[n % HOTCUE_COLORS.length]));
        case 'type': return this.ro(() => b2n(has()));
        default: return null;
      }
    }
    if ((m = new RegExp(`^beatloop_${SIZE}_(activate|toggle|enabled)$`).exec(key))) {
      const beats = parseSize(m[1]);
      if (m[2] === 'enabled') return this.ro(() => b2n(d.loop.on && !d.loop.roll && Math.abs(d.loop.beats - beats) < EPS));
      if (m[2] === 'toggle') return trig(() => this.act('beatLoop', i, beats));
      // activate: (re)sets the loop, never toggles it off
      return trig(() => {
        if (d.loop.on && !d.loop.roll && Math.abs(d.loop.beats - beats) < EPS) return;
        this.act('beatLoop', i, beats);
      });
    }
    if ((m = new RegExp(`^beatlooproll_${SIZE}_activate$`).exec(key))) {
      const beats = parseSize(m[1]);
      return this.push(k, () => this.act('rollDown', i, beats), () => this.act('rollUp', i));
    }
    if ((m = new RegExp(`^beatjump_${SIZE}_(forward|backward)$`).exec(key))) {
      const beats = parseSize(m[1]) * (m[2] === 'forward' ? 1 : -1);
      return trig(() => this.act('beatJump', i, beats));
    }
    if ((m = new RegExp(`^loop_move_${SIZE}_(forward|backward)$`).exec(key))) {
      const beats = parseSize(m[1]) * (m[2] === 'forward' ? 1 : -1);
      return trig(() => this.act('beatJump', i, beats));
    }

    const holdBend = (amount) => this.push(k, () => { try { d.setBend(amount); } catch {} }, () => { try { d.setBend(0); } catch {} });
    const nudge = (amount) => trig(() => d.nudgePitch(amount));
    const levelOf = () => this.levels().decks[i];

    switch (key) {
      // transport
      case 'play': return {
        kind: 'toggle', def: 0, get: () => b2n(d.playing && !d.cuePreview),
        set: (v) => { if ((v > 0) !== (d.playing && !d.cuePreview) || (v > 0 && d.cuePreview)) this.act('play', i); },
      };
      case 'play_indicator': case 'play_latched': return this.ro(() => b2n(d.playing));
      case 'play_stutter': return trig(() => this.act('stutter', i));
      case 'stop': return trig(() => d.pause());
      case 'cue_default': case 'cue_cdj': case 'cue_simple': case 'cue_preview':
        return this.push(k, () => this.act('cueDown', i), () => this.act('cueUp', i));
      case 'cue_indicator': return this.ro(() => {
        if (!d.loaded) return 0;
        const at = Math.abs(d.position - d.cuePoint) < 0.05;
        if (d.playing) return b2n(at && d.cuePreview);
        return at ? 1 : b2n(Math.floor(performance.now() / 250) % 2 === 0);
      });
      case 'cue_gotoandplay': case 'cue_play': return trig(() => { d.seek(d.cuePoint); if (!d.playing) this.act('play', i); });
      case 'cue_gotoandstop': return trig(() => { d.pause(); d.seek(d.cuePoint); });
      case 'cue_goto': return trig(() => d.seek(d.cuePoint));
      case 'cue_set': return trig(() => { d.cuePoint = d.position; d.persist?.(); });
      case 'cue_clear': return trig(() => { d.cuePoint = 0; d.persist?.(); });
      case 'cue_point': return this.ro(() => (d.loaded ? sec2samples(d.cuePoint) : -1));
      case 'start': return trig(() => d.seek(0));
      case 'start_play': return trig(() => { d.seek(0); if (!d.playing) this.act('play', i); });
      case 'start_stop': return trig(() => this.act('jumpStart', i));
      case 'end': return trig(() => d.seek(d.duration));
      case 'fwd': case 'back': return this.push(k, () => (st.held[key] = true), () => (st.held[key] = false));
      case 'eject': return this.push(k, () => {});
      case 'LoadSelectedTrack': return this.push(k, () => a.loadTrack(i, a.ui?.selected ?? a.selected));
      case 'LoadSelectedTrackAndPlay': return this.push(k, async () => {
        await a.loadTrack(i, a.ui?.selected ?? a.selected);
        if (d.loaded && !d.playing) this.act('play', i);
      });
      // sync & tempo
      case 'sync_enabled': return toggle(() => d.sync, () => this.act('sync', i));
      case 'beatsync': case 'beatsync_tempo': case 'beatsync_phase': return trig(() => {
        const mst = a.masterFor(d);
        if (!mst || !d.bpm) return;
        if (key !== 'beatsync_phase') d.followMaster(mst);
        if (key !== 'beatsync_tempo') d.syncPhase(true);
      });
      case 'sync_leader': case 'sync_master': return {
        kind: 'toggle', def: 0, get: () => b2n(a.masterIndex === i),
        set: (v) => { if (v) a.masterIndex = i; else if (a.masterIndex === i) a.masterIndex = null; },
      };
      case 'sync_mode': return this.ro(() => (a.masterIndex === i ? 2 : d.sync ? 1 : 0));
      case 'rate': return {
        kind: 'pot', min: -1, max: 1, def: 0,
        get: () => clamp(d.pitch / d.range, -1, 1) * (a.settings?.invertTempo ? -1 : 1),
        set: (v) => this.act('tempo', i, clamp(v, -1, 1) * (a.settings?.invertTempo ? -1 : 1)),
      };
      case 'rate_dir': return this.ro(() => 1);
      case 'rateRange': return { kind: 'raw', def: 0.08, get: () => d.range, set: (v) => { if (v > 0) d.setRange(v); } };
      case 'rate_temp_up': return holdBend(0.04);
      case 'rate_temp_down': return holdBend(-0.04);
      case 'rate_temp_up_small': return holdBend(0.01);
      case 'rate_temp_down_small': return holdBend(-0.01);
      case 'rate_perm_up': return nudge(0.005);
      case 'rate_perm_down': return nudge(-0.005);
      case 'rate_perm_up_small': return nudge(0.0005);
      case 'rate_perm_down_small': return nudge(-0.0005);
      case 'rate_set_default': case 'rate_set_zero': return trig(() => this.act('tempoReset', i));
      case 'bpm': return {
        kind: 'raw', def: 0, get: () => d.liveBpm,
        set: (v) => { if (d.bpm && v > 0) d.nudgePitch(v / d.bpm - 1 - d.pitch); },
      };
      case 'file_bpm': case 'local_bpm': return this.ro(() => d.bpm);
      case 'visual_bpm': return this.ro(() => d.liveBpm);
      case 'keylock': return toggle(() => d.keylock, () => this.act('keylock', i));
      case 'quantize': return toggle(() => d.quantize, () => this.act('quantize', i));
      case 'slip_enabled': return toggle(() => d.slip, () => this.act('slip', i));
      case 'reverse': return { kind: 'push', def: 0, get: () => b2n(d.reverse), set: (v) => this.act('reverse', i, v > 0) };
      case 'reverseroll': return {
        kind: 'push', def: 0, get: () => b2n(d.reverse && st.reverseRollSlip != null),
        set: (v) => {
          try {
            if (v > 0 && st.reverseRollSlip == null) { st.reverseRollSlip = d.slip; d.setSlip(true); d.setReverse(true); }
            else if (!v && st.reverseRollSlip != null) { d.setReverse(false); if (!st.reverseRollSlip) d.setSlip(false); st.reverseRollSlip = null; }
          } catch (e) { this.report(e, group, key); }
        },
      };
      // mixer
      case 'pfl': return toggle(() => d.mix.cue, () => this.act('headCue', i));
      case 'volume': return this.mixPot(i, 'volume', 1);
      case 'pregain': return this.mixLogpot(i, 'trim', 4);
      case 'filterLow': return this.mixLogpot(i, 'low', 4);
      case 'filterMid': return this.mixLogpot(i, 'mid', 4);
      case 'filterHigh': return this.mixLogpot(i, 'high', 4);
      case 'filterLowKill': return this.kill(i, 'low');
      case 'filterMidKill': return this.kill(i, 'mid');
      case 'filterHighKill': return this.kill(i, 'high');
      case 'orientation': return {
        kind: 'toggle', states: 3, def: 1,
        get: () => ({ A: 0, THRU: 1, B: 2 })[d.mix.xfAssign] ?? 1,
        set: (v) => this.act('xfAssign', i, ['A', 'THRU', 'B'][clamp(Math.round(v), 0, 2)]),
      };
      case 'orientation_left': return trig(() => this.act('xfAssign', i, 'A'));
      case 'orientation_center': return trig(() => this.act('xfAssign', i, 'THRU'));
      case 'orientation_right': return trig(() => this.act('xfAssign', i, 'B'));
      case 'VuMeter': case 'vu_meter': case 'VuMeterL': case 'VuMeterR': case 'vu_meter_left': case 'vu_meter_right':
        return this.ro(() => ControlBridge.vu(levelOf()));
      case 'PeakIndicator': case 'PeakIndicatorL': case 'PeakIndicatorR': case 'peak_indicator':
        return this.ro(() => b2n(levelOf() > 0.98));
      // track info
      case 'playposition': return {
        kind: 'pot', min: 0, max: 1, def: 0,
        get: () => (d.loaded && d.duration ? d.position / d.duration : 0),
        set: (v) => { if (d.loaded) d.seek(clamp(v, 0, 1) * d.duration); },
      };
      case 'duration': return this.ro(() => (d.loaded ? d.duration : 0));
      case 'track_loaded': return this.ro(() => b2n(d.loaded));
      case 'track_samples': return this.ro(() => (d.loaded ? sec2samples(d.duration) : 0));
      case 'track_samplerate': return this.ro(() => d.sr);
      case 'time_elapsed': return this.ro(() => d.position);
      case 'time_remaining': return this.ro(() => Math.max(0, d.duration - d.position));
      case 'beat_active': return this.ro(() => {
        if (!d.loaded || !d.bpm) return 0;
        const f = d.beatAt(d.position) % 1;
        return b2n(f < 0.15 || f > 0.97);
      });
      case 'end_of_track': return this.ro(() => b2n(d.loaded && d.playing && d.duration - d.position < 30));
      case 'track_color': return this.ro(() => -1);
      // loops
      case 'beatloop_size': return {
        kind: 'raw', def: 4, get: () => d.loop.beats || 4,
        set: (v) => {
          if (!(v > 0)) return;
          if (d.loop.on && !d.loop.roll && d.loop.beats) d.resizeLoop(v / d.loop.beats);
          else d.loop.beats = v;
        },
      };
      case 'beatloop_activate': return trig(() => {
        const b = d.loop.beats || 4;
        if (!(d.loop.on && !d.loop.roll && Math.abs(d.loop.beats - b) < EPS)) this.act('beatLoop', i, b);
      });
      case 'beatloop_toggle': return trig(() => this.act('autoLoop', i));
      case 'beatlooproll_activate': return this.push(k, () => this.act('rollDown', i, d.loop.beats || 4), () => this.act('rollUp', i));
      case 'loop_in': return trig(() => this.act('loopIn', i));
      case 'loop_out': return trig(() => this.act('loopOut', i));
      case 'loop_enabled': return {
        kind: 'raw', def: 0, get: () => b2n(d.loop.on),
        set: (v) => { if (v > 0 && !d.loop.on) this.act('reloop', i); else if (!v && d.loop.on) this.act('loopExit', i); },
      };
      case 'reloop_toggle': case 'reloop_exit': return trig(() => this.act('reloop', i));
      case 'reloop_andstop': return trig(() => { if (!d.loop.on) d.reloop(); d.seek(d.loop.start); d.pause(); });
      case 'loop_exit': return trig(() => { if (d.loop.on) this.act('loopExit', i); });
      case 'loop_halve': return trig(() => this.act('loopHalf', i));
      case 'loop_double': return trig(() => this.act('loopDouble', i));
      case 'loop_start_position': return this.ro(() => (d.loop.end > d.loop.start || d.loop.pendingIn ? sec2samples(d.loop.start) : -1));
      case 'loop_end_position': return this.ro(() => (d.loop.end > d.loop.start ? sec2samples(d.loop.end) : -1));
      case 'loop_move': case 'beatjump': return { kind: 'raw', def: 0, get: () => 0, set: (v) => { if (v && loaded()) this.act('beatJump', i, v); } };
      case 'beatjump_size': return { kind: 'raw', def: 4, get: () => st.beatjumpSize, set: (v) => { if (v > 0) st.beatjumpSize = v; } };
      case 'beatjump_forward': return trig(() => this.act('beatJump', i, st.beatjumpSize));
      case 'beatjump_backward': return trig(() => this.act('beatJump', i, -st.beatjumpSize));
      case 'beatjump_size_halve': return this.push(k, () => (st.beatjumpSize = Math.max(1 / 32, st.beatjumpSize / 2)));
      case 'beatjump_size_double': return this.push(k, () => (st.beatjumpSize = Math.min(512, st.beatjumpSize * 2)));
      // jog / scratch
      case 'jog': return {
        kind: 'raw', def: 0, get: () => 0,
        set: (v) => { if (v && loaded()) { try { d.jogBend(v * 2); } catch {} } },
      };
      case 'wheel': return {
        kind: 'raw', def: 0, get: () => st.wheel,
        set: (v) => { st.wheel = v; try { if (d.loaded && d.playing) d.setBend(clamp(v * 0.04, -0.5, 0.5)); else if (!v) d.setBend(0); } catch {} },
      };
      case 'scratch2': return { kind: 'raw', def: 0, get: () => st.scratch2, set: (v) => (st.scratch2 = v) };
      case 'scratch2_enable': return {
        kind: 'raw', def: 0, get: () => b2n(st.scratch2On),
        set: (v) => {
          const on = v > 0;
          if (on === st.scratch2On) return;
          st.scratch2On = on;
          try { if (d.loaded) d.send({ type: 'scratch', on }); } catch {}
        },
      };
      case 'vinylcontrol_enabled': return this.stored(k, 0, 'toggle');
      case 'mute': return this.stored(k, 0, 'toggle');
      case 'talkover': return this.stored(k, 0, 'toggle');
      case 'repeat': return this.stored(k, 0, 'toggle');
      default: return null;
    }
  }

  // ---------- [Master] / [App] ----------
  master(key, group) {
    const a = this.app, e = a.engine, k = this.key(group, key);
    const lv = () => this.levels().master;
    switch (key) {
      case 'crossfader': return { kind: 'pot', min: -1, max: 1, def: 0, get: () => e.xfader * 2 - 1, set: (v) => this.act('xfader', 0, clamp((v + 1) / 2, 0, 1)) };
      case 'crossfader_up': return this.push(k, () => this.act('xfader', 0, clamp(e.xfader + 0.05, 0, 1)));
      case 'crossfader_down': return this.push(k, () => this.act('xfader', 0, clamp(e.xfader - 0.05, 0, 1)));
      case 'crossfader_up_small': return this.push(k, () => this.act('xfader', 0, clamp(e.xfader + 0.01, 0, 1)));
      case 'crossfader_down_small': return this.push(k, () => this.act('xfader', 0, clamp(e.xfader - 0.01, 0, 1)));
      case 'volume': case 'gain': return { kind: 'logpot', max: 5, def: 1, get: () => logpotFromParam(e.masterVol, 5), set: (v) => this.act('masterVol', 0, logpotToParam(v, 5)) };
      case 'headMix': return { kind: 'pot', min: -1, max: 1, def: -1, get: () => e.headMix * 2 - 1, set: (v) => this.act('headMix', 0, clamp((v + 1) / 2, 0, 1)) };
      case 'headGain': case 'headVolume': return { kind: 'logpot', max: 5, def: 1, get: () => logpotFromParam(e.headVol, 5), set: (v) => this.act('headVol', 0, logpotToParam(v, 5)) };
      case 'VuMeterL': case 'vu_meter_left': return this.ro(() => ControlBridge.vu(lv()[0]));
      case 'VuMeterR': case 'vu_meter_right': return this.ro(() => ControlBridge.vu(lv()[1]));
      case 'VuMeter': case 'vu_meter': return this.ro(() => ControlBridge.vu(Math.max(...lv())));
      case 'PeakIndicatorL': return this.ro(() => b2n(lv()[0] > 0.98));
      case 'PeakIndicatorR': return this.ro(() => b2n(lv()[1] > 0.98));
      case 'PeakIndicator': return this.ro(() => b2n(Math.max(...lv()) > 0.98));
      case 'num_decks': return this.ro(() => a.decks.length);
      case 'num_samplers': return this.ro(() => 4);
      case 'num_preview_decks': return this.ro(() => 1);
      case 'num_microphones': case 'num_auxiliaries': return this.ro(() => 0);
      case 'samplerate': return this.ro(() => e.ctx?.sampleRate || 44100);
      case 'latency': return this.ro(() => (e.ctx?.baseLatency || 0.01) * 1000);
      default: return null;
    }
  }

  // ---------- [Library] / [Playlist] ----------
  library(key) {
    const a = this.app;
    const move = (n) => { if (n) a.ui?.moveSelection?.(Math.round(n)); };
    const firstStopped = () => {
      const n = a.settings?.fourDecks ? a.decks.length : 2;
      const i = a.decks.slice(0, n).findIndex((d) => !d.playing);
      if (i >= 0) a.loadTrack(i, a.ui?.selected ?? a.selected);
    };
    const btn = (fn) => ({ kind: 'push', def: 0, get: () => 0, set: (v) => { if (v > 0) fn(v); } });
    const rel = (fn) => ({ kind: 'raw', def: 0, get: () => 0, set: (v) => fn(v) });
    switch (key) {
      case 'MoveVertical': case 'SelectTrackKnob': case 'ScrollVertical': return rel(move);
      case 'MoveUp': case 'SelectPrevTrack': return btn(() => move(-1));
      case 'MoveDown': case 'SelectNextTrack': return btn(() => move(1));
      case 'ScrollUp': return btn(() => move(-10));
      case 'ScrollDown': return btn(() => move(10));
      case 'MoveFocusForward': case 'MoveFocusBackward': case 'MoveLeft': case 'MoveRight':
        return btn(() => a.ui?.toggleBrowseFocus?.());
      case 'MoveFocus': case 'MoveHorizontal': case 'SelectPlaylist': return rel((v) => { if (v) a.ui?.toggleBrowseFocus?.(); });
      case 'GoToItem': case 'LoadSelectedIntoFirstStopped': return btn(firstStopped);
      default: return null;
    }
  }

  // ---------- [EqualizerRack1_[ChannelN]_Effect1] ----------
  eqRack(i, key) {
    const bands = { parameter1: 'low', parameter2: 'mid', parameter3: 'high' };
    const kills = { button_parameter1: 'low', button_parameter2: 'mid', button_parameter3: 'high' };
    if (bands[key]) return this.mixLogpot(i, bands[key], 4);
    if (kills[key]) return this.kill(i, kills[key]);
    return null;
  }

  // ---------- effects ----------
  fxUnit(u, key) {
    const a = this.app, unit = a.engine.fxUnits[u];
    const m = /^group_\[Channel(\d+)\]_enable$/.exec(key);
    if (m) {
      const di = Number(m[1]) - 1;
      if (di >= a.decks.length) return null;
      return { kind: 'pw', def: 0, get: () => b2n(unit.assigned[di]), set: (v) => { if (!!v !== !!unit.assigned[di]) this.act('fxAssign', u, di); } };
    }
    return null;
  }

  fxSlot(u, s, key) {
    const a = this.app, slot = a.engine.fxUnits[u].slots[s];
    const types = Object.keys(FX_TYPES);
    const cycle = (dir) => {
      slot.type = types[(types.indexOf(slot.type) + dir + types.length) % types.length];
      try { a.engine.rewireFx(a.decks); } catch (e) { this.report(e, 'fx', key); }
    };
    switch (key) {
      case 'enabled': return { kind: 'pw', def: 0, get: () => b2n(slot.on), set: (v) => { if (!!v !== slot.on) this.act('fxSlot', u, s); } };
      case 'meta': return { kind: 'pot', min: 0, max: 1, def: 0.5, get: () => slot.level, set: (v) => this.act('fxLevel', u, s, clamp(v, 0, 1)) };
      case 'loaded': return this.ro(() => 1);
      case 'next_effect': return { kind: 'push', def: 0, get: () => 0, set: (v) => { if (v > 0) cycle(1); } };
      case 'prev_effect': return { kind: 'push', def: 0, get: () => 0, set: (v) => { if (v > 0) cycle(-1); } };
      case 'effect_selector': return { kind: 'raw', def: 0, get: () => 0, set: (v) => { if (v) cycle(Math.sign(v)); } };
      default: return null;
    }
  }
}
