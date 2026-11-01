// Web MIDI: native Pioneer DDJ-SX mapping with LED/VU/jog-ring feedback,
// Mixxx controller mappings (app/controllers/mixxx, run through js/mixxx)
// for ~140 other controllers, plus MIDI-learn for anything else.
// Each input gets a mapping choice: 'native' (DDJ-SX only), a Mixxx mapping
// file name, or 'none'. Choices are stored in localStorage.

import { ROLL_BEATS, LOOP_BEATS, JUMP_BEATS } from './deck.js';
import { loadMappingIndex, matchMapping, MixxxController } from './mixxx/index.js';

const DDJ_SX = /DDJ-?SX/i;
const CHOICE_KEY = 'pulsar.midiMapping';
// "MIDIIN2 (X)" / "X MIDI 1" / "X In" -> "x", to pair inputs with their output port
const portBase = (n) => String(n || '').toLowerCase()
  .replace(/^midi(in|out)\d*\s*\((.*)\)$/, '$2')
  .replace(/\b(midi|in|out|input|output|port)\b/g, '')
  .replace(/[^a-z0-9]/g, '');
const rel = (v) => (v > 0x40 ? v - 0x80 : v);          // rotary encoders: 1 = cw, 127 = ccw
const jogDelta = (v) => v - 0x40;                      // jog: centred on 0x40

export class Midi {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.inputs = [];
    this.out = null;
    this.ddj = false;
    this.msb = new Map();
    this.ledCache = new Map();
    this.learnTarget = null;
    this.learned = JSON.parse(localStorage.getItem('pulsar.midiLearn') || '{}');
    this.monitor = [];
    this.onUpdate = () => {};
    this.shift = [false, false, false, false];
    // Mixxx mappings
    this.mappingIndex = [];
    this.choices = JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}');
    this.controllers = new Map();      // input.id -> { input, file, ctl }
    this.sysex = false;
    this.lastFeedback = 0;
  }

  async init() {
    if (this.access || this.initializing) return;
    this.initializing = true;
    if (!navigator.requestMIDIAccess) {
      this.error = 'Web MIDI wird von diesem Browser nicht unterstützt (Chrome/Edge verwenden).';
      this.onUpdate();
      return;
    }
    const index = loadMappingIndex().catch((e) => {
      console.warn('Mixxx mapping index', e);
      return [];
    });
    try {
      // SysEx is needed by some Mixxx mappings (LED init, displays); fall back without it
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: true });
      } catch (e) {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      }
    } catch (e) {
      this.error = 'MIDI-Zugriff verweigert.';
      this.mappingIndex = await index;   // still listable in the UI
      this.onUpdate();
      return;
    }
    this.sysex = !!this.access.sysexEnabled;
    this.mappingIndex = await index;
    this.access.onstatechange = () => this.bind();
    this.bind();
    // Mixxx scripts need their tick before audio is started (feedback() runs only after app.start())
    this.tickTimer = setInterval(() => {
      if (performance.now() - this.lastFeedback > 100) this.tickControllers();
    }, 33);
  }

  bind() {
    for (const i of this.inputs) i.onmidimessage = null;
    this.inputs = [...this.access.inputs.values()];
    for (const i of this.inputs) i.onmidimessage = (e) => this.onMessage(e.data, i);
    const outs = [...this.access.outputs.values()];
    const was = this.ddj;
    this.out = outs.find((o) => DDJ_SX.test(o.name)) || null;
    this.ddj = this.inputs.some((i) => DDJ_SX.test(i.name) && this.mappingChoice(i.name) === 'native');
    if (this.ddj && !was) {
      this.ledCache.clear();
      // ask the controller to send all knob/fader positions
      setTimeout(() => this.send(0x9b, 0x08, 0x7f), 300);
    }
    this.bindControllers(outs);
    this.onUpdate();
  }

  deviceNames() { return this.inputs.map((i) => i.name); }

  // ---------- mapping choice per input ----------
  // 'native' | '<mapping file>' | 'none'; unknown devices are auto-matched by name
  mappingChoice(inputName) {
    const c = this.choices[inputName];
    if (c === 'native' && DDJ_SX.test(inputName)) return 'native';
    if (c === 'none') return 'none';
    if (c && this.mappingIndex.some((m) => m.file === c)) return c;
    if (DDJ_SX.test(inputName)) return 'native';
    return matchMapping(this.mappingIndex, inputName)?.file || 'none';
  }

  setMapping(inputName, choice) {
    this.choices[inputName] = choice;
    localStorage.setItem(CHOICE_KEY, JSON.stringify(this.choices));
    if (this.access) this.bind();
    else this.onUpdate();
  }

  // status for the UI, one row per MIDI input
  activeControllers() {
    return this.inputs.map((input) => {
      const choice = this.mappingChoice(input.name);
      const c = this.controllers.get(input.id);
      const entry = this.mappingIndex.find((m) => m.file === choice);
      return {
        input: input.name,
        choice,
        auto: !(input.name in this.choices),
        name: choice === 'native' ? 'Pioneer DDJ-SX (Pulsar)' : choice === 'none' ? '' : entry?.name || choice,
        state: choice === 'native' ? 'native' : choice === 'none' ? 'none' : c?.ctl.state || 'idle',
        errors: c?.ctl.errorCount || 0,
        lastError: c?.ctl.errors.at(-1)?.message || '',
        output: choice === 'native' ? this.out?.name || null : c?.ctl.out?.name || null,
      };
    });
  }

  findOutput(input, outs) {
    return outs.find((o) => o.name === input.name)
      || outs.find((o) => portBase(o.name) && portBase(o.name) === portBase(input.name))
      || null;
  }

  bindControllers(outs) {
    const live = new Set();
    for (const input of this.inputs) {
      const choice = this.mappingChoice(input.name);
      const entry = choice !== 'native' && choice !== 'none' ? this.mappingIndex.find((m) => m.file === choice) : null;
      let c = this.controllers.get(input.id);
      if (c && (!entry || c.file !== entry.file)) {
        c.ctl.stop();
        this.controllers.delete(input.id);
        c = null;
      }
      if (!entry) continue;
      live.add(input.id);
      const out = this.findOutput(input, outs);
      if (c) {
        if (c.ctl.out !== out) { c.ctl.out = out; if (out) c.ctl.updateOutputs(true); }
        continue;
      }
      const ctl = new MixxxController(this.app, entry, out, { sysex: this.sysex });
      this.controllers.set(input.id, { input, file: entry.file, ctl });
      ctl.start().then(() => this.onUpdate());
    }
    for (const [id, c] of this.controllers) {
      if (!live.has(id)) { c.ctl.stop(); this.controllers.delete(id); }
    }
  }

  tickControllers() {
    for (const c of this.controllers.values()) {
      try { c.ctl.tick(); } catch (e) { console.warn('[mixxx] tick', e); }
    }
  }

  send(status, d1, d2) {
    if (!this.out) return;
    const key = (status << 8) | d1;
    if (this.ledCache.get(key) === d2) return;
    this.ledCache.set(key, d2);
    try { this.out.send([status, d1, d2]); } catch {}
  }

  // 14-bit: MSB arrives first on cc, LSB on cc+0x20
  hi(status, cc, value, apply) {
    const k = (status << 8) | cc;
    if (cc < 0x20) {
      this.msb.set(k, value);
      apply(((value << 7) | 0) / 16383);
    } else {
      const m = this.msb.get((status << 8) | (cc - 0x20));
      if (m != null) apply(((m << 7) | value) / 16383);
    }
  }

  onMessage(data, input) {
    const [status, d1, d2 = 0] = data;
    const mixxx = this.controllers.get(input.id)?.ctl;
    if (status >= 0xf0) {
      if (status === 0xf0 && mixxx) mixxx.handleMidi(data);
      return;
    }
    this.monitor.unshift({ t: performance.now(), dev: input.name, bytes: [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ') });
    this.monitor.length = Math.min(this.monitor.length, 40);
    if (this.learnTarget) return this.learn(status, d1, d2);
    const lk = this.learned[`${status}:${d1}`];
    if (lk) return this.runLearned(lk, status, d2);
    if (DDJ_SX.test(input.name) && this.mappingChoice(input.name) === 'native') this.ddjIn(status, d1, d2);
    else if (mixxx) mixxx.handleMidi(data);
    this.onUpdate(true);
  }

  // ---------- DDJ-SX ----------
  ddjIn(status, d1, v) {
    const type = status & 0xf0, ch = status & 0x0f;
    const a = this.app;
    const on = type === 0x90 && v > 0;
    const isNote = type === 0x90 || type === 0x80;
    const isCC = type === 0xb0;

    // deck channels 0..3
    if (ch <= 3) {
      const d = a.decks[ch];
      if (isNote) {
        switch (d1) {
          case 0x0b: if (on) a.act('play', ch); return;
          case 0x47: if (on) a.act('stutter', ch); return;                 // shift+play
          case 0x0c: a.act(on ? 'cueDown' : 'cueUp', ch); return;
          case 0x48: if (on) a.act('jumpStart', ch); return;               // shift+cue
          case 0x58: if (on) a.act('sync', ch); return;
          case 0x5c: if (on) a.act('quantize', ch); return;                // shift+sync
          case 0x1a: if (on) a.act('keylock', ch); return;
          case 0x60: if (on) a.act('range', ch); return;                   // shift+keylock
          case 0x1c: if (on) a.act('tempoReset', ch); return;
          // the DDJ-SX keeps vinyl mode itself and reports the state on 0x3A
          case 0x17: return;
          case 0x3a: a.act('vinylState', ch, v > 0); return;
          // deck switch: 0x3C reports which deck each side is on
          case 0x3c: if (on) a.act('deckSelect', ch); return;
          case 0x72: return;
          case 0x40: if (on) a.act('slip', ch); return;
          case 0x38: a.act('reverse', ch, on); return;                     // shift+slip (censor)
          case 0x15: a.act('reverse', ch, on); return;
          case 0x54: if (on) a.act('headCue', ch); return;
          case 0x68: if (on) a.act('headCue', ch); return;
          case 0x3f: this.shift[ch] = on; return;
          case 0x36: case 0x35: case 0x67: a.act('jogTouch', ch, on); return;
          case 0x10: if (on) a.act('loopIn', ch); return;
          case 0x11: if (on) a.act('loopOut', ch); return;
          case 0x4c: if (on) a.act('loopExit', ch); return;               // shift+in
          case 0x4d: if (on) a.act('reloop', ch); return;
          case 0x50: if (on) a.act('reloop', ch); return;
          case 0x14: if (on) a.act('autoLoop', ch); return;
          case 0x12: if (on) a.act('loopHalf', ch); return;
          case 0x13: if (on) a.act('loopDouble', ch); return;
          case 0x61: if (on) a.act('beatJump', ch, -(d.loop.beats || 4)); return;
          case 0x62: if (on) a.act('beatJump', ch, d.loop.beats || 4); return;
          case 0x16: if (on) a.act('xfAssign', ch, 'A'); return;
          case 0x1d: if (on) a.act('xfAssign', ch, 'THRU'); return;
          case 0x18: if (on) a.act('xfAssign', ch, 'B'); return;
          case 0x43: case 0x44: this.needle = on; return;
          case 0x1b: if (on) a.act('padMode', ch, 'hotcue'); return;
          case 0x1e: if (on) a.act('padMode', ch, 'roll'); return;
          case 0x20: if (on) a.act('padMode', ch, 'slicer'); return;
          case 0x22: if (on) a.act('padMode', ch, 'sampler'); return;
          case 0x01: case 0x24: case 0x25: case 0x26: case 0x27: case 0x29:
            if (on) a.act('padPage', ch, -1); return;
          case 0x09: case 0x2c: case 0x2d: case 0x2e: case 0x2f: case 0x31:
            if (on) a.act('padPage', ch, 1); return;
        }
      }
      if (isCC) {
        const hi = (fn) => this.hi(status, d1, v, fn);
        switch (d1) {
          case 0x00: case 0x20: return hi((x) => a.act('tempo', ch, (x * 2 - 1) * (a.settings.invertTempo ? -1 : 1)));
          case 0x13: case 0x33: return hi((x) => a.act('volume', ch, x));
          case 0x04: case 0x24: return hi((x) => a.act('trim', ch, x));
          case 0x07: case 0x27: return hi((x) => a.act('eq', ch, 'high', x));
          case 0x0b: case 0x2b: return hi((x) => a.act('eq', ch, 'mid', x));
          case 0x0f: case 0x2f: return hi((x) => a.act('eq', ch, 'low', x));
          case 0x22: case 0x23: return a.act('jog', ch, jogDelta(v), false);
          case 0x21: return a.act('jog', ch, jogDelta(v), true);              // outer ring = bend
          case 0x1f: return a.act('jog', ch, jogDelta(v) * 4, false);         // shift + platter: fast
          case 0x26: return a.act('jog', ch, jogDelta(v) * 6, true);
          case 0x03: if (this.needle) a.act('needle', ch, v / 127); return;
        }
      }
    }

    // FX units: channel 4 / 5
    if (ch === 4 || ch === 5) {
      const u = ch - 4;
      if (isNote && on) {
        if (d1 >= 0x47 && d1 <= 0x49) return a.act('fxSlot', u, d1 - 0x47);
        if (d1 === 0x4a || d1 === 0x66) return a.act('fxCycle', u);
      }
      if (isCC) {
        if (d1 === 0x00 || d1 === 0x10) return a.act('fxBeats', u, Math.sign(rel(v)));
        const slot = { 0x02: 0, 0x04: 1, 0x06: 2, 0x22: 0, 0x24: 1, 0x26: 2, 0x12: 0, 0x14: 1, 0x16: 2, 0x32: 0, 0x34: 1, 0x36: 2 }[d1];
        if (slot != null) return this.hi(status, d1 & 0x2f, v, (x) => a.act('fxLevel', u, slot, x));
      }
    }

    // global: channel 6
    if (ch === 6) {
      if (isCC) {
        const hi = (fn) => this.hi(status, d1, v, fn);
        if (d1 >= 0x17 && d1 <= 0x1a) return hi((x) => a.act('filter', d1 - 0x17, x));
        if (d1 >= 0x37 && d1 <= 0x3a) return hi((x) => a.act('filter', d1 - 0x37, x));
        if (d1 === 0x1f || d1 === 0x3f) return hi((x) => a.act('xfader', 0, x));
        if (d1 === 0x01 || d1 === 0x21) return hi((x) => a.act('xfCurve', 0, x));
        if (d1 === 0x40) return a.act('browse', 0, rel(v));
        if (d1 === 0x64) return a.act('browse', 0, rel(v) * 10);
      }
      if (isNote && on) {
        if (d1 >= 0x46 && d1 <= 0x49) return a.act('load', d1 - 0x46);
        if (d1 >= 0x4c && d1 <= 0x4f) return a.act('fxAssign', 0, d1 - 0x4c);
        if (d1 >= 0x50 && d1 <= 0x53) return a.act('fxAssign', 1, d1 - 0x50);
        if (d1 === 0x41 || d1 === 0x42) return a.act('browseClick', 0);
        if (d1 === 0x65 || d1 === 0x66) return a.act('browseBack', 0);
        if (d1 === 0x62) return a.act('splitCue', 0);
        if (d1 === 0x78) return a.act('toggleView', 0);
        if (d1 === 0x67) return a.act('loadSuggested', 0);
      }
    }

    // pads: channels 7..10 = decks 1..4
    if (ch >= 7 && ch <= 10 && isNote) {
      const deck = ch - 7, grp = d1 & 0xf0, i = d1 & 0x07, shifted = (d1 & 0x08) !== 0;
      switch (grp) {
        case 0x00:
          // the DDJ-SX sends the same pad notes in every mode, so the mode lives in Pulsar
          if (shifted) {
            if (on && a.padMode[deck] === 'hotcue') a.act('hotcueClear', deck, i);
          } else {
            a.uiShift = false;
            a.act('pad', deck, i, on);
          }
          return;
        case 0x10: return a.act(on ? 'rollDown' : 'rollUp', deck, ROLL_BEATS[i]);
        case 0x20: if (on) a.act('slice', deck, i); return;
        case 0x30: if (on) a.act('beatJump', deck, JUMP_BEATS[i]); return;
        case 0x50: if (on) a.act('beatLoop', deck, LOOP_BEATS[i]); return;
      }
    }
  }

  // LEDs, VU meters and jog ring, called ~30x per second
  feedback() {
    this.lastFeedback = performance.now();
    this.tickControllers();
    if (!this.out || !this.ddj) return;
    const a = this.app;
    const led = (ch, note, v) => this.send(0x90 + ch, note, v ? 0x7f : 0);
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    a.decks.forEach((d, ch) => {
      led(ch, 0x0b, d.playing);
      led(ch, 0x0c, d.loaded && (!d.playing ? blink : Math.abs(d.position - d.cuePoint) < 0.05));
      led(ch, 0x58, d.sync);
      led(ch, 0x1a, d.keylock);
      led(ch, 0x0d, d.vinyl);
      led(ch, 0x40, d.slip);
      led(ch, 0x54, d.mix.cue);
      led(ch, 0x14, d.loop.on);
      led(ch, 0x50, d.loop.on);
      // pad mode buttons: HOT CUE / ROLL / SLICER (= Loop) / SAMPLER (= Jump)
      const mode = a.padMode[ch];
      led(ch, 0x1b, mode === 'hotcue');
      led(ch, 0x1e, mode === 'roll');
      led(ch, 0x20, mode === 'loop');
      led(ch, 0x22, mode === 'jump');
      // pads show the state of the current mode
      for (let i = 0; i < 8; i++) {
        let lit;
        if (mode === 'hotcue') lit = d.hotcues[i] != null;
        else if (mode === 'roll') lit = d.loop.on && d.loop.roll && Math.abs(d.loop.beats - ROLL_BEATS[i]) < 1e-6;
        else if (mode === 'loop') lit = d.loop.on && !d.loop.roll && Math.abs(d.loop.beats - LOOP_BEATS[i]) < 1e-6;
        else lit = d.loaded; // jump pads are always available
        this.send(0x97 + ch, 0x00 + i, lit ? 0x7f : 0);
        this.send(0x97 + ch, 0x08 + i, mode === 'hotcue' && d.hotcues[i] != null ? 0x7f : 0);
      }
      // channel VU (0..0x76, +9 = peak)
      const lvl = d.strip ? d.strip.level() : 0;
      const db = 20 * Math.log10(lvl + 1e-6);
      let vu = Math.max(0, Math.min(1, (db + 36) / 36));
      let val = Math.round(vu * 0x76);
      if (lvl > 0.98) val = Math.min(0x7f, val + 9);
      this.send(0xb0 + ch, 0x02, val);
      // jog ring: one revolution = 1.8 s (33 1/3 rpm)
      if (d.loaded) {
        const rev = d.position / 1.8;
        let pos = 1 + Math.floor((rev - Math.floor(rev)) * 0x48);
        const left = d.duration - d.position;
        if (left < 30 && !blink) pos = 0;
        this.send(0xbb, ch, pos);
      }
    });
    // FX unit LEDs
    a.engine.fxUnits.forEach((u, i) => {
      u.slots.forEach((s, k) => this.send(0x94 + i, 0x47 + k, s.on ? 0x7f : 0));
      a.decks.forEach((_, d) => this.send(0x96, (i === 0 ? 0x4c : 0x50) + d, u.assigned[d] ? 0x7f : 0));
    });
  }

  // ---------- MIDI learn ----------
  startLearn(target) { this.learnTarget = target; this.onUpdate(); }
  cancelLearn() { this.learnTarget = null; this.onUpdate(); }

  learn(status, d1, d2) {
    const type = status & 0xf0;
    if (type === 0x80 || (type === 0x90 && d2 === 0)) return;
    const t = this.learnTarget;
    const key = `${status}:${d1}`;
    this.learned[key] = { ...t, kind: type === 0xb0 ? (t.kind || 'abs') : 'button' };
    localStorage.setItem('pulsar.midiLearn', JSON.stringify(this.learned));
    this.learnTarget = null;
    this.onUpdate();
  }

  clearLearned() {
    this.learned = {};
    localStorage.removeItem('pulsar.midiLearn');
    this.onUpdate();
  }

  runLearned(m, status, v) {
    const a = this.app, type = status & 0xf0;
    const down = type === 0x90 && v > 0;
    if (m.kind === 'button') {
      if (m.hold) a.act(down ? m.action + 'Down' : m.action + 'Up', m.target, m.arg);
      else if (down || type === 0xb0 && v > 63) a.act(m.action, m.target, m.arg);
    } else if (m.kind === 'rel') {
      a.act(m.action, m.target, rel(v));
    } else if (m.arg != null) {
      a.act(m.action, m.target, m.arg, v / 127);
    } else {
      a.act(m.action, m.target, v / 127);
    }
    this.onUpdate(true);
  }
}
