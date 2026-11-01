// Mixxx-compatible controller scripting runtime.
// Mapping scripts run in a hidden same-origin iframe, so their top-level
// var/function/class/const declarations share one global scope like in Mixxx's
// QJSEngine. The iframe gets `engine`, `midi`, `console`, `print` and
// `ColorMapper`; common-controller-scripts.js is always evaluated first.
// XML <controls> are dispatched to script functions or to the control bridge,
// XML <outputs> and engine connections are fed by diffing control values.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { parseMapping } from './xml.js';
import { getBridge, midiToParam } from './bridge.js';

const DEFAULT_BASE = new URL('../../controllers/mixxx/', import.meta.url).href;
const COMMON = 'common-controller-scripts.js';
const textCache = new Map();
const ST_THRESHOLD = 3 / 128;

export function fetchText(url) {
  let p = textCache.get(url);
  if (!p) {
    p = fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.text();
    });
    p.catch(() => textCache.delete(url));
    textCache.set(url, p);
  }
  return p;
}

// Mixxx ColorMapper: nearest colour by the "redmean" weighted distance
class ColorMapper {
  constructor(available) {
    this.colors = Object.entries(available || {}).map(([rgb, value]) => [Number(rgb), value]);
    this.cache = new Map();
  }
  nearest(rgb) {
    rgb = Number(rgb) >>> 0;
    if (this.cache.has(rgb)) return this.cache.get(rgb);
    const r1 = (rgb >> 16) & 0xff, g1 = (rgb >> 8) & 0xff, b1 = rgb & 0xff;
    let best = null, bestD = Infinity;
    for (const c of this.colors) {
      const r2 = (c[0] >> 16) & 0xff, g2 = (c[0] >> 8) & 0xff, b2 = c[0] & 0xff;
      const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bestD) { bestD = d; best = c; }
    }
    this.cache.set(rgb, best);
    return best;
  }
  getNearestColor(rgb) {
    const c = this.nearest(rgb);
    return c ? { red: (c[0] >> 16) & 0xff, green: (c[0] >> 8) & 0xff, blue: c[0] & 0xff } : undefined;
  }
  getValueForNearestColor(rgb) { const c = this.nearest(rgb); return c ? c[1] : undefined; }
}

const CHARSETS = ['ASCII', 'UTF_8', 'UTF_16LE', 'UTF_16BE', 'UTF_32LE', 'UTF_32BE', 'CentralEurope', 'Cyrillic',
  'WesternEurope', 'Greek', 'Turkish', 'Hebrew', 'Arabic', 'Baltic', 'Vietnamese', 'Latin9', 'Shift_JIS', 'EUC_JP',
  'EUC_KR', 'Big5_HKSCS', 'KOI8_U', 'UCS2', 'SCSU', 'BOCU_1', 'CESU_8', 'Latin1'];

export class MixxxController {
  constructor(app, entry, midiOutput, opts = {}) {
    this.app = app;
    this.entry = entry;
    this.out = midiOutput || null;
    this.sysex = !!opts.sysex;
    this.baseUrl = opts.baseUrl || DEFAULT_BASE;
    this.name = entry?.name || entry?.file || 'Mixxx';
    this.bridge = getBridge(app);
    this.state = 'idle';               // idle | loading | running | error | stopped
    this.errors = [];
    this.errorCount = 0;
    this.logLines = [];
    this.sent = 0;
    this.droppedSysex = 0;
    this.conns = new Map();            // ckey -> Set(connection)
    this.lastVal = new Map();          // ckey -> last value seen by connections/outputs
    this.outByKey = new Map();         // ckey -> [output]
    this.controls = new Map();         // status<<8|midino -> [control]
    this.inputHandlers = new Map();
    this.fourteen = new Map();
    this.timers = new Map();
    this.timerSeq = 0;
    this.st = new Map();               // soft takeover state
    this.scratch = [null, null, null, null];
    this.bindings = new Map();
    this.connSeq = 0;
    this.flushPending = false;
    this.flushDepth = 0;
    this.onBridgeWrite = () => this.scheduleFlush();
  }

  // ---------- lifecycle ----------
  async start() {
    if (this.state === 'running' || this.state === 'loading') return;
    this.state = 'loading';
    try {
      const xml = await fetchText(new URL(this.entry.file, this.baseUrl).href);
      this.mapping = parseMapping(xml);
      this.indexMapping();
      this.win = await this.createFrame();
      this.installGlobals();
      const files = [COMMON, ...this.mapping.scripts.map((s) => s.file).filter((f) => f !== COMMON)];
      const texts = await Promise.all(files.map((f) => fetchText(new URL(f, this.baseUrl).href).catch((e) => e)));
      files.forEach((f, i) => {
        if (texts[i] instanceof Error) this.error('load ' + f, texts[i]);
        else this.evaluate(texts[i], f);
      });
      this.bridge.listeners.add(this.onBridgeWrite);
      this.state = 'running';
      for (const s of this.mapping.scripts) {
        if (!s.prefix) continue;
        this.callPrefix(s.prefix, 'init', [this.mapping.id || this.name, false]);
      }
      this.updateOutputs(true);
    } catch (e) {
      this.state = 'error';
      this.error('start', e);
    }
    return this;
  }

  stop() {
    if (this.state === 'stopped') return;
    if (this.state === 'running' && this.mapping) {
      for (const s of this.mapping.scripts) {
        if (!s.prefix) continue;
        this.callPrefix(s.prefix, 'shutdown', []);
      }
    }
    for (const t of this.timers.values()) (t.oneShot ? clearTimeout : clearInterval)(t.h);
    this.timers.clear();
    for (const set of this.conns.values()) for (const c of set) c.connected = false;
    this.conns.clear();
    this.scratch.forEach((s, i) => { if (s) this.scratchOff(i); });
    this.bridge.listeners.delete(this.onBridgeWrite);
    this.frame?.remove();
    this.frame = null;
    this.win = null;
    this.state = 'stopped';
  }

  createFrame() {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.setAttribute('aria-hidden', 'true');
      f.title = 'Mixxx script runtime: ' + this.name;
      f.src = 'about:blank';
      this.frame = f;
      let done = false;
      const ready = () => { if (!done) { done = true; resolve(f.contentWindow); } };
      f.onload = ready;
      document.body.appendChild(f);
      // about:blank is usually ready synchronously
      if (f.contentDocument && f.contentDocument.readyState === 'complete') ready();
    });
  }

  evaluate(text, file) {
    const win = this.win, doc = win.document;
    const s = doc.createElement('script');
    s.text = text + '\n//# sourceURL=' + new URL(file, this.baseUrl).href;
    this.loadingFile = file;
    (doc.head || doc.documentElement).appendChild(s);
    this.loadingFile = null;
  }

  // ---------- globals visible to mapping scripts ----------
  installGlobals() {
    const win = this.win, self = this;
    win.onerror = (msg, src, line, col, err) => {
      self.error(self.loadingFile ? 'eval ' + self.loadingFile : 'script', err || new Error(`${msg} (${src}:${line})`));
      return true;
    };
    const log = (level) => (...args) => self.logLine(level, args);
    const counters = {}, timersByLabel = {};
    win.console = {
      log: log('log'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'),
      exception: log('error'), trace: log('debug'),
      assert: (c, ...a) => { if (!c) self.logLine('error', ['Assertion failed', ...a]); },
      time: (l = 'default') => { timersByLabel[l] = performance.now(); },
      timeEnd: (l = 'default') => self.logLine('log', [`${l}: ${(performance.now() - (timersByLabel[l] || 0)).toFixed(1)}ms`]),
      count: (l = 'default') => self.logLine('log', [`${l}: ${(counters[l] = (counters[l] || 0) + 1)}`]),
      profile() {}, profileEnd() {},
    };
    win.print = (m) => self.logLine('log', [m]);
    win.ColorMapper = ColorMapper;
    win.engine = this.makeEngine();
    win.midi = this.makeMidi();
  }

  makeEngine() {
    const self = this, b = this.bridge;
    const str = (x) => String(x);
    const Charset = {};
    CHARSETS.forEach((n, i) => (Charset[n] = i));
    return {
      getValue: (g, k) => b.getValue(str(g), str(k)),
      setValue: (g, k, v) => self.write(str(g), str(k), Number(v), false),
      getParameter: (g, k) => b.getParameter(str(g), str(k)),
      setParameter: (g, k, p) => self.write(str(g), str(k), Number(p), true),
      getParameterForValue: (g, k, v) => b.getParameterForValue(str(g), str(k), v),
      getDefaultValue: (g, k) => b.getDefaultValue(str(g), str(k)),
      getDefaultParameter: (g, k) => b.getDefaultParameter(str(g), str(k)),
      reset: (g, k) => { b.reset(str(g), str(k)); self.scheduleFlush(); },
      getSetting: (name) => self.mapping?.settings?.[name],
      getPlayer: (g) => self.player(str(g)),
      makeConnection: (g, k, cb) => self.connect(str(g), str(k), cb),
      makeUnbufferedConnection: (g, k, cb) => self.connect(str(g), str(k), cb),
      connectControl: (g, k, cb, disconnect) => self.connectLegacy(str(g), str(k), cb, disconnect),
      trigger: (g, k) => self.triggerKey(str(g), str(k)),
      log: (m) => self.logLine('log', [m]),
      beginTimer: (ms, fn, oneShot) => self.beginTimer(ms, fn, oneShot),
      stopTimer: (id) => self.stopTimer(id),
      scratchEnable: (deck, ipr, rpm, alpha, beta, ramp) => self.scratchEnable(deck, ipr, rpm),
      scratchTick: (deck, interval) => self.scratchTick(deck, interval),
      scratchDisable: (deck) => self.scratchDisable(deck),
      isScratching: (deck) => !!self.scratch[(deck | 0) - 1],
      softTakeover: (g, k, enable) => self.softTakeover(str(g), str(k), !!enable),
      softTakeoverIgnoreNextValue: (g, k) => self.stState(str(g), str(k)).ignoreNext = true,
      brake: (deck, on) => self.deckStop(deck, on),
      spinback: (deck, on) => self.deckStop(deck, on),
      softStart: (deck, on) => { if (on) self.deckStart(deck); },
      isBrakeActive: () => false,
      isSpinbackActive: () => false,
      isSoftStartActive: () => false,
      Charset,
      convertCharset: (cs, value) => {
        const s = String(value);
        if (cs === Charset.UTF_8) return new TextEncoder().encode(s).buffer;
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 256 ? c : 0x3f; }
        return out.buffer;
      },
    };
  }

  makeMidi() {
    const self = this;
    const shortMsg = (status, d1, d2) => self.sendShort(status, d1, d2);
    const sysex = (data, length) => self.sendSysex(data, length);
    return {
      sendShortMsg: shortMsg,
      sendShortMsgBuffered: shortMsg,
      sendSysexMsg: sysex,
      send: sysex,
      makeInputHandler: (status, midino, cb) => {
        const k = ((status & 0xff) << 8) | (midino & 0xff);
        const h = { cb, connected: true };
        if (!self.inputHandlers.has(k)) self.inputHandlers.set(k, []);
        self.inputHandlers.get(k).push(h);
        return {
          get isConnected() { return h.connected; },
          disconnect: () => {
            const list = self.inputHandlers.get(k) || [];
            const i = list.indexOf(h);
            if (i >= 0) list.splice(i, 1);
            h.connected = false;
            return i >= 0;
          },
        };
      },
    };
  }

  player(group) {
    const m = /^\[Channel(\d+)\]$/.exec(group);
    const d = m ? this.app.decks[Number(m[1]) - 1] : null;
    if (!d) return undefined;
    const slot = { connect() {} };
    const t = () => d.track || {};
    const p = {};
    for (const f of ['artist', 'title', 'album', 'albumArtist', 'genre', 'composer', 'grouping', 'year', 'trackNumber', 'trackTotal', 'key']) {
      Object.defineProperty(p, f, { get: () => String(t()[f] ?? ''), enumerable: true });
      p[f + 'Changed'] = slot;
    }
    p.trackUnloaded = slot;
    return p;
  }

  // ---------- script helpers ----------
  lookup(expr) {
    try { return this.win.eval(expr); } catch { return undefined; }
  }

  call(fn, args, where, self) {
    try { return fn.apply(self, args); } catch (e) { this.error(where, e); }
  }

  // prefix.init() / .shutdown() / .incomingData() are called as methods, like Mixxx does
  callPrefix(prefix, name, args) {
    const obj = this.lookup(prefix);
    const fn = obj?.[name];
    if (typeof fn === 'function') this.call(fn, args, prefix + '.' + name, obj);
  }

  error(where, e) {
    this.errorCount++;
    const message = e && e.message ? e.message : String(e);
    if (this.errors.length < 50) this.errors.push({ where, message, stack: e?.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '' });
    if (this.errorCount <= 5) console.warn(`[mixxx ${this.name}] ${where}: ${message}`);
  }

  // problems Mixxx only logs (missing callbacks etc.): counted, not treated as errors
  warn(where, message) {
    this.warnings = (this.warnings || 0) + 1;
    this.logLine('warn', [where + ': ' + message]);
  }

  logLine(level, args) {
    const line = args.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
    this.logLines.push(level === 'log' ? line : `[${level}] ${line}`);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
  }

  // engine.setValue / setParameter with soft takeover
  write(group, key, v, isParam) {
    if (!Number.isFinite(v)) v = 0;
    const b = this.bridge;
    const st = this.st.get(b.key(group, key));
    if (st?.enabled && b.isPot(group, key)) {
      const p = isParam ? v : b.getParameterForValue(group, key, v);
      if (this.stIgnore(st, group, key, p)) return;
    }
    if (isParam) b.setParameter(group, key, v);
    else b.setValue(group, key, v);
  }

  // ---------- soft takeover (Mixxx SoftTakeover::ignore) ----------
  stState(group, key) {
    const k = this.bridge.key(group, key);
    let s = this.st.get(k);
    if (!s) { s = { enabled: false, prev: null, ignoreNext: false }; this.st.set(k, s); }
    return s;
  }

  softTakeover(group, key, enable) {
    const s = this.stState(group, key);
    if (enable && !s.enabled) s.prev = null;
    s.enabled = enable;
  }

  stIgnore(s, group, key, p) {
    if (s.ignoreNext) { s.ignoreNext = false; s.prev = p; return true; }
    const cur = this.bridge.getParameter(group, key);
    let ignore = false;
    if (s.prev != null) {
      const diff = cur - p, prevDiff = cur - s.prev;
      const crossed = (diff <= 0 && prevDiff >= 0) || (diff >= 0 && prevDiff <= 0);
      if (!crossed && Math.abs(diff) > ST_THRESHOLD && Math.abs(prevDiff) > ST_THRESHOLD) ignore = true;
    }
    s.prev = p;
    return ignore;
  }

  // ---------- connections ----------
  connect(group, key, cb) {
    if (typeof cb !== 'function') { this.warn('makeConnection', `callback for ${group},${key} is not a function`); return undefined; }
    const b = this.bridge, ck = b.key(group, key), self = this;
    const conn = {
      id: 'conn' + ++this.connSeq, group, key, cb, connected: true,
      get isConnected() { return this.connected; },
      disconnect() {
        if (!this.connected) return false;
        this.connected = false;
        self.conns.get(ck)?.delete(this);
        return true;
      },
      trigger() { if (this.connected) self.call(cb, [b.getValue(group, key), group, key], `${group},${key}`); },
    };
    if (!this.conns.has(ck)) this.conns.set(ck, new Set());
    this.conns.get(ck).add(conn);
    if (!this.lastVal.has(ck)) this.lastVal.set(ck, b.getValue(group, key));
    return conn;
  }

  connectLegacy(group, key, cb, disconnect) {
    const ck = this.bridge.key(group, key);
    const set = this.conns.get(ck);
    const fn = typeof cb === 'string' ? this.lookup(cb) : cb;
    if (disconnect) {
      let any = false;
      if (set) for (const c of [...set]) if (c.cb === fn || (typeof cb === 'string' && c.legacy === cb)) { c.disconnect(); any = true; }
      return any;
    }
    if (typeof fn !== 'function') { this.warn('connectControl', `callback ${cb} for ${group},${key} is not a function`); return false; }
    if (typeof cb === 'string' && set) {
      for (const c of set) if (c.legacy === cb) return c;
    }
    const conn = this.connect(group, key, fn);
    if (conn && typeof cb === 'string') conn.legacy = cb;
    return conn;
  }

  // engine.trigger(): queued like Qt's queued connection, so callbacks run after the calling script returns
  triggerKey(group, key) {
    queueMicrotask(() => { if (this.state === 'running') this.fireKey(group, key); });
  }

  fireKey(group, key) {
    const b = this.bridge, ck = b.key(group, key), v = b.getValue(group, key);
    this.lastVal.set(ck, v);
    const set = this.conns.get(ck);
    if (set) for (const c of [...set]) if (c.connected) this.call(c.cb, [v, group, key], `${group},${key}`);
    const outs = this.outByKey.get(ck);
    if (outs) for (const o of outs) this.sendOutput(o, v);
  }

  scheduleFlush() {
    if (this.flushPending || this.state !== 'running') return;
    this.flushPending = true;
    if (this.flushDepth++ > 20) {
      setTimeout(() => { this.flushDepth = 0; this.flush(); }, 0);
    } else {
      queueMicrotask(() => this.flush());
      setTimeout(() => (this.flushDepth = 0), 0);
    }
  }

  // diff all watched controls and fire connections / outputs that changed
  flush() {
    this.flushPending = false;
    if (this.state !== 'running') return;
    const b = this.bridge;
    for (const [ck, set] of this.conns) {
      if (!set.size) continue;
      const c0 = set.values().next().value;
      const v = b.getValue(c0.group, c0.key);
      if (this.lastVal.get(ck) === v) continue;
      this.lastVal.set(ck, v);
      for (const c of [...set]) if (c.connected) this.call(c.cb, [v, c.group, c.key], `${c.group},${c.key}`);
    }
    this.updateOutputs(false);
  }

  // ---------- XML outputs ----------
  indexMapping() {
    const b = this.bridge;
    for (const c of this.mapping.controls) {
      const k = (c.status << 8) | c.midino;
      if (!this.controls.has(k)) this.controls.set(k, []);
      this.controls.get(k).push(c);
    }
    for (const o of this.mapping.outputs) {
      o.last = -1;
      const ck = b.key(o.group, o.key);
      if (!this.outByKey.has(ck)) this.outByKey.set(ck, []);
      this.outByKey.get(ck).push(o);
    }
  }

  updateOutputs(force) {
    const b = this.bridge;
    for (const outs of this.outByKey.values()) {
      const v = b.getValue(outs[0].group, outs[0].key);
      for (const o of outs) {
        if (force) o.last = -1;
        this.sendOutput(o, v);
      }
    }
  }

  sendOutput(o, v) {
    const byte = v >= o.min && v <= o.max ? o.on : o.off;
    if (byte === o.last || byte === 0xff) return;
    o.last = byte;
    this.sendShort(o.status, o.midino, byte);
  }

  sendShort(status, d1, d2) {
    if (!this.out) return;
    status = Number(status) & 0xff;
    if (status < 0x80) return;
    const msg = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0
      ? [status, Number(d1) & 0x7f]
      : [status, Number(d1) & 0x7f, Number(d2) & 0x7f];
    try { this.out.send(msg); this.sent++; } catch (e) { this.error('sendShortMsg', e); }
  }

  sendSysex(data, length) {
    if (!this.out) return;
    let arr = Array.from(data || [], (x) => Number(x) & 0xff);
    if (length != null && length >= 0 && length < arr.length) arr = arr.slice(0, length);
    if (!arr.length) return;
    if (arr[0] === 0xf0 && !this.sysex) { this.droppedSysex++; return; }
    try { this.out.send(arr); this.sent++; } catch (e) { this.error('sendSysexMsg', e); }
  }

  // ---------- timers ----------
  beginTimer(ms, fn, oneShot) {
    if (typeof fn === 'string') {
      const code = fn;
      fn = () => this.win?.eval(code);
    }
    if (typeof fn !== 'function') { this.warn('beginTimer', 'timer callback is not a function'); return 0; }
    const id = ++this.timerSeq;
    ms = Math.max(1, Number(ms) || 0);
    const run = () => {
      if (oneShot) this.timers.delete(id);
      if (this.state === 'running') this.call(fn, [], 'timer');
    };
    this.timers.set(id, { h: oneShot ? setTimeout(run, ms) : setInterval(run, ms), oneShot: !!oneShot });
    return id;
  }

  stopTimer(id) {
    const t = this.timers.get(id);
    if (!t) return;
    (t.oneShot ? clearTimeout : clearInterval)(t.h);
    this.timers.delete(id);
  }

  // ---------- scratching ----------
  deck(n) { return this.app.decks[(n | 0) - 1] || null; }

  scratchEnable(n, ipr, rpm) {
    const d = this.deck(n);
    if (!d) return;
    this.scratch[n - 1] = { ipr: Number(ipr) || 128, rpm: Number(rpm) || 33 + 1 / 3 };
    d.jogTouched = true;
    try { if (d.loaded) d.send({ type: 'scratch', on: true }); } catch {}
  }

  scratchTick(n, interval) {
    const d = this.deck(n), s = this.scratch[n - 1];
    if (!d || !s) return;
    const ticks = (Number(interval) || 0) / s.ipr * 2048 * ((33 + 1 / 3) / s.rpm);
    try { d.jogScratch(ticks); } catch {}
  }

  scratchDisable(n) { if (this.scratch[n - 1]) this.scratchOff(n - 1); }

  scratchOff(i) {
    const d = this.app.decks[i];
    this.scratch[i] = null;
    if (!d) return;
    d.jogTouched = false;
    try { if (d.loaded) d.send({ type: 'scratch', on: false }); d.setBend(0); } catch {}
  }

  deckStop(n, on) {
    const d = this.deck(n);
    if (!d) return;
    if (on) { try { d.pause(); } catch {} } else if (!d.playing) this.deckStart(n);
  }

  deckStart(n) {
    const d = this.deck(n);
    if (d && d.loaded && !d.playing) this.bridge.act('play', n - 1);
  }

  // ---------- MIDI input ----------
  handleMidi(data) {
    if (this.state !== 'running' || !data || !data.length) return;
    const status = data[0];
    if (status === 0xf0) {
      for (const s of this.mapping.scripts) {
        if (!s.prefix) continue;
        this.callPrefix(s.prefix, 'incomingData', [Array.from(data), data.length]);
      }
      return;
    }
    if (status === 0xf8 || status === 0xfe) return;
    const d1 = data.length > 1 ? data[1] : 0;
    const d2 = data.length > 2 ? data[2] : 0;
    const type = status & 0xf0;
    let list = this.controls.get((status << 8) | d1);
    if (!list && type === 0xe0) {
      // pitch bend mappings carry no midino
      for (const [k, v] of this.controls) if (k >> 8 === status) { list = v; break; }
    }
    const handlers = this.inputHandlers.get((status << 8) | d1);
    if (handlers) for (const h of [...handlers]) this.call(h.cb, [status & 0x0f, d1, d2, status], 'inputHandler');
    if (list) for (const c of list) this.process(c, status, d1, d2);
    this.scheduleFlush();
  }

  binding(key) {
    let fn = this.bindings.get(key);
    if (fn === undefined) {
      try {
        // like QJSEngine wrapFunctionCode(key, 5): keeps `this` for member functions
        fn = this.win.eval(`(function (a, b, c, d, e) { return (${key})(a, b, c, d, e); })`);
      } catch (e) {
        fn = null;
        this.error('binding ' + key, e);
      }
      this.bindings.set(key, fn);
    }
    return fn;
  }

  process(c, status, d1, d2) {
    const o = c.options, type = status & 0xf0;
    if (o.has('script')) {
      const fn = this.binding(c.key);
      if (fn) this.call(fn, [status & 0x0f, d1, d2, status, c.group], c.key);
      return;
    }
    if (!c.group || !c.key) return;
    const b = this.bridge;
    let opcode = type;
    let value;
    if (type === 0xe0) {
      value = Math.min(127, ((d2 << 7) | d1) / 128);
    } else if (o.has('msb') || o.has('lsb')) {
      const ck = b.key(c.group, c.key);
      const q = this.fourteen.get(ck);
      const isMsb = o.has('msb');
      if (q && q.msb !== isMsb) {
        this.fourteen.delete(ck);
        const v14 = isMsb ? (d2 << 7) | q.value : (q.value << 7) | d2;
        value = Math.min(127, v14 / 128);
      } else {
        this.fourteen.set(ck, { msb: isMsb, value: d2 });
        return;
      }
    } else {
      value = computeValue(o, b.getMidiParameter(c.group, c.key), d2);
    }
    if (o.has('button') || o.has('switch')) opcode = 0x90;
    if (o.has('softtakeover') && b.isPot(c.group, c.key)) {
      const s = this.stState(c.group, c.key);
      if (!s.enabled) this.softTakeover(c.group, c.key, true);
      if (this.stIgnore(s, c.group, c.key, midiToParam(value))) return;
    }
    b.setValueFromMidi(c.group, c.key, opcode, value);
  }

  tick() {
    if (this.state !== 'running') return;
    this.bridge.frame();
    this.flush();
  }

  status() {
    return { name: this.name, file: this.entry?.file, state: this.state, errors: this.errorCount, sent: this.sent };
  }
}

// MidiController::computeValue: XML <options> applied to a 7-bit value
export function computeValue(o, prev, v) {
  if (!o.size) return v;
  if (o.has('invert')) return 127 - v;
  if (o.has('rot64') || o.has('rot64inv')) {
    let diff = v - 64;
    if (diff === -1 || diff === 1) diff /= 16;
    else diff += diff > 0 ? -1 : 1;
    const t = o.has('rot64') ? prev + diff : prev - diff;
    return Math.max(0, Math.min(127, t));
  }
  if (o.has('rot64fast')) return Math.max(0, Math.min(127, prev + (v - 64) * 1.5));
  if (o.has('diff')) return prev + (v >= 64 ? v - 128 : v);
  if (o.has('selectknob')) return v >= 64 ? v - 128 : v;
  if (o.has('button')) return v !== 0 ? 1 : 0;
  if (o.has('switch')) return 1;
  if (o.has('spread64')) return v - 64;
  if (o.has('hercjog')) return prev + (v > 64 ? v - 128 : v);
  if (o.has('hercjogfast')) return prev + (v > 64 ? v - 128 : v) * 3;
  return v;
}
