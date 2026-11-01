// Open library formats for Pulsar DJ:
//   - "pulsar-library" v1 JSON (full backup / exchange, see docs/library-format.md)
//   - M3U / M3U8 playlists
//   - Rekordbox XML (DJ_PLAYLISTS) import + export
// Pure string in / string out; works in browsers and Node (own XML parser, no DOMParser).
// SPDX-License-Identifier: GPL-3.0-or-later

export const FORMAT = 'pulsar-library';
export const FORMAT_VERSION = 1;

// ---------- small helpers ----------
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const lower = (s) => String(s || '').toLowerCase();
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (v, k = 3) => Math.round(v * 10 ** k) / 10 ** k;

// Index of library tracks for matching foreign files.
function index(library) {
  const byName = new Map(), byNameSize = new Map();
  for (const t of library.tracks.values()) {
    if (t.transient) continue;
    const n = lower(t.name || baseName(t.path));
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(t);
    if (t.size) byNameSize.set(`${n}|${t.size}`, t);
  }
  return {
    // name+size exact; name only if unique or path tail matches best
    find(name, size, pathHint = '') {
      const n = lower(baseName(name));
      if (size && byNameSize.has(`${n}|${size}`)) return byNameSize.get(`${n}|${size}`);
      const c = byName.get(n);
      if (!c?.length) return null;
      if (c.length === 1) return c[0];
      const hint = lower(pathHint).replace(/\\/g, '/').split('/').reverse();
      let best = c[0], bestScore = -1;
      for (const t of c) {
        const segs = lower(t.path).split('/').reverse();
        let s = 0;
        while (s < segs.length && s < hint.length && segs[s] === hint[s]) s++;
        if (s > bestScore) { best = t; bestScore = s; }
      }
      return best;
    },
  };
}

// ---------- keys ----------
const PITCH = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4, 'E#': 5, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11, CB: 11, 'B#': 0 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']; // as analysis-worker.js
const RB_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];   // rekordbox spelling
const CAM_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAM_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

// 'Am', 'F#m', 'Bbm', 'Abmin', 'C major', '8A', '08B', 'A minor' -> { name, camelot } | null
export function parseKey(s) {
  const str = String(s || '').trim().replace('♯', '#').replace('♭', 'b');
  if (!str) return null;
  let m = /^0?(\d{1,2})\s*([AB])$/i.exec(str);
  if (m) {
    const n = Number(m[1]), minor = m[2].toUpperCase() === 'A';
    if (n < 1 || n > 12) return null;
    const pc = (minor ? CAM_MINOR : CAM_MAJOR).indexOf(n);
    return { name: NAMES[pc] + (minor ? 'm' : ''), camelot: `${n}${minor ? 'A' : 'B'}` };
  }
  m = /^([A-Ga-g])([#b]?)\s*(m|min|minor|moll|maj|major|dur)?$/i.exec(str);
  if (!m) return null;
  const pc = PITCH[(m[1].toUpperCase() + (m[2] === 'b' ? 'B' : m[2])).toUpperCase()];
  if (pc == null) return null;
  const minor = !!m[3] && /^m(in|inor|oll)?$/i.test(m[3]) && m[3] !== 'M';
  return { name: NAMES[pc] + (minor ? 'm' : ''), camelot: `${(minor ? CAM_MINOR : CAM_MAJOR)[pc]}${minor ? 'A' : 'B'}` };
}

function rekordboxKey(camelot) {
  const k = parseKey(camelot);
  if (!k) return '';
  const minor = k.camelot.endsWith('A');
  const pc = (minor ? CAM_MINOR : CAM_MAJOR).indexOf(Number(k.camelot.slice(0, -1)));
  return RB_NAMES[pc] + (minor ? 'm' : '');
}

// ---------- base64 (waveforms) ----------
function toB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// =====================================================================
// pulsar-library v1 JSON
// =====================================================================
const META = ['title', 'artist', 'album', 'genre', 'tagKey', 'comment'];
const SOURCE = ['source', 'provider', 'sourceId', 'pageUrl', 'streamUrl', 'artistUrl', 'attribution'];

// exportLibrary(library, { includeWaveforms=false, playlistIds?, trackIds? }) -> object (JSON.stringify it)
export async function exportLibrary(library, { includeWaveforms = false, trackIds = null, playlistIds = null } = {}) {
  const playlists = library.playlists.filter((p) => !playlistIds || playlistIds.includes(p.id));
  let ids = trackIds ? new Set(trackIds) : null;
  if (!ids && playlistIds) ids = new Set(playlists.flatMap((p) => p.trackIds));
  const tracks = [];
  for (const t of library.tracks.values()) {
    if (t.transient || (ids && !ids.has(t.id))) continue;
    const a = (await library.getAnalysis(t)) || null;
    const c = (await library.loadCues(t)) || null;
    const o = {
      id: t.id,
      path: t.path,
      name: t.name,
      size: t.size || 0,
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      genre: t.genre || '',
      duration: round(a?.duration || t.duration || 0),
      bpm: round(a?.bpm || t.bpm || 0, 4),
      beatOffset: a && Number.isFinite(a.beatOffset) ? round(a.beatOffset, 4) : null,
      key: a?.key?.camelot ? { name: a.key.name || '', camelot: a.key.camelot } : (t.camelot ? { name: t.keyName || '', camelot: t.camelot } : null),
      tagKey: t.tagKey || '',
      rmsDb: a && Number.isFinite(a.rmsDb) ? round(a.rmsDb, 2) : null,
      plays: t.plays || 0,
      lastPlayed: t.lastPlayed || null,
      addedAt: t.addedAt || null,
      cues: c ? { hotcues: (c.hotcues || []).slice(0, 8).map((x) => (x == null ? null : round(x, 4))), cuePoint: c.cuePoint == null ? null : round(c.cuePoint, 4) } : null,
    };
    for (const k of SOURCE) if (t[k]) o[k] = t[k];
    if (t.license) o.license = { ...t.license };
    if (t.comment) o.comment = t.comment;
    if (includeWaveforms && a?.wave?.low) {
      o.waveform = { rate: a.wave.rate, low: toB64(a.wave.low), mid: toB64(a.wave.mid), high: toB64(a.wave.high), peak: toB64(a.wave.peak) };
    }
    tracks.push(o);
  }
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    generator: 'Pulsar DJ',
    exportedAt: new Date().toISOString(),
    tracks,
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, trackIds: p.trackIds.filter((x) => !ids || ids.has(x)) })),
  };
}

export async function exportLibraryJSON(library, opts) {
  return JSON.stringify(await exportLibrary(library, opts), null, 1);
}

// Merge cues: imported slots win where set, existing values are kept otherwise.
async function mergeCues(library, t, inc) {
  if (!inc) return false;
  const cur = (await library.loadCues(t)) || { hotcues: new Array(8).fill(null), cuePoint: null };
  const hot = (cur.hotcues || []).slice(0, 8);
  while (hot.length < 8) hot.push(null);
  let changed = false;
  (inc.hotcues || []).slice(0, 8).forEach((x, i) => { if (x != null && Number.isFinite(Number(x)) && hot[i] !== Number(x)) { hot[i] = Number(x); changed = true; } });
  let cuePoint = cur.cuePoint ?? null;
  if (inc.cuePoint != null && Number.isFinite(Number(inc.cuePoint)) && cuePoint !== Number(inc.cuePoint)) { cuePoint = Number(inc.cuePoint); changed = true; }
  if (changed) {
    const out = { hotcues: hot };
    if (cuePoint != null) out.cuePoint = cuePoint;
    await library.saveCues(t, out);
  }
  return changed;
}

// Fill empty metadata fields only (never overwrites the user's own data).
function fillMeta(t, src, keys) {
  let n = 0;
  for (const k of keys) if (src[k] && !t[k]) { t[k] = src[k]; n++; }
  return n;
}

// importLibrary(library, jsonStringOrObject) -> counts
// Merges by track id, then filename+size. Unknown tracks are added as offline
// entries (they become playable once their folder is connected with the same
// path/size/date, or re-downloaded for open-music tracks). Never deletes.
export async function importLibrary(library, input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || data.format !== FORMAT) throw new Error('Keine pulsar-library-Datei');
  if (Number(data.version) > FORMAT_VERSION) console.warn(`pulsar-library v${data.version} ist neuer als v${FORMAT_VERSION}; unbekannte Felder werden ignoriert`);
  const idx = index(library);
  const res = { tracks: 0, matched: 0, added: 0, updated: 0, analysis: 0, cues: 0, waveforms: 0, playlistsCreated: 0, playlistsMerged: 0 };
  const idMap = new Map();
  for (const it of data.tracks || []) {
    if (!it || (!it.id && !it.name)) continue;
    res.tracks++;
    let t = (it.id && library.tracks.get(it.id)) || idx.find(it.name || baseName(it.path), it.size, it.path);
    if (t) res.matched++;
    else {
      t = {
        id: it.id || `${it.path || it.name}|${it.size || 0}|0`,
        path: it.path || it.name, name: it.name || baseName(it.path), size: num(it.size),
        title: it.title || '', artist: it.artist || '', album: it.album || '', genre: it.genre || '',
        bpm: num(it.bpm), tagKey: it.tagKey || '', camelot: '', keyName: '', duration: num(it.duration),
        analyzed: false, plays: num(it.plays), addedAt: it.addedAt || Date.now(), imported: true,
      };
      res.added++;
    }
    idMap.set(it.id, t.id);
    let ch = fillMeta(t, it, META) + fillMeta(t, it, SOURCE);
    if (it.license && !t.license) { t.license = { ...it.license }; ch++; }
    if (num(it.plays) > (t.plays || 0)) { t.plays = num(it.plays); ch++; }
    if (it.lastPlayed && !(t.lastPlayed >= it.lastPlayed)) { t.lastPlayed = it.lastPlayed; ch++; }
    await library.saveTrack(t);
    if (ch) res.updated++;
    const key = it.key?.camelot ? parseKey(it.key.camelot) : null;
    if (it.waveform?.low) {
      const cur = await library.getAnalysis(t);
      if (!cur?.wave) {
        const w = it.waveform;
        await library.storeAnalysis(t, {
          bpm: num(it.bpm), beatOffset: num(it.beatOffset), key: key || { name: '', camelot: '' }, rmsDb: num(it.rmsDb, -14), duration: num(it.duration),
          wave: { rate: num(w.rate, 150), low: fromB64(w.low), mid: fromB64(w.mid), high: fromB64(w.high), peak: fromB64(w.peak) },
        });
        res.waveforms++;
      }
    }
    if (num(it.bpm) > 0 || key || it.beatOffset != null) {
      await library.applyAnalysis(t, { bpm: num(it.bpm), beatOffset: it.beatOffset == null ? NaN : num(it.beatOffset), key, rmsDb: it.rmsDb == null ? NaN : num(it.rmsDb), duration: num(it.duration) });
      res.analysis++;
    }
    if (await mergeCues(library, t, it.cues)) res.cues++;
  }
  for (const p of data.playlists || []) {
    const ids = (p.trackIds || []).map((x) => idMap.get(x) || x).filter((x) => library.tracks.has(x));
    const existing = (p.id && library.getPlaylist(p.id)) || library.playlists.find((x) => x.name === p.name);
    if (existing) {
      const missing = ids.filter((x) => !existing.trackIds.includes(x));
      if (missing.length) await library.addToPlaylist(existing.id, missing);
      res.playlistsMerged++;
    } else {
      await library.createPlaylist(p.name, ids);
      res.playlistsCreated++;
    }
  }
  library.changed();
  return res;
}

// =====================================================================
// M3U / M3U8
// =====================================================================
// playlistToM3U8(library, playlistId, { prefix='' }) -> string
// Paths are the library paths ("<folder>/<sub>/<file>"), i.e. relative to the
// parent of the imported folder. prefix is prepended (e.g. '../' or 'C:/Music/').
export function playlistToM3U8(library, playlistId, { prefix = '' } = {}) {
  const p = library.getPlaylist(playlistId);
  if (!p) throw new Error('Playlist nicht gefunden');
  const lines = ['#EXTM3U', `#PLAYLIST:${p.name}`];
  for (const id of p.trackIds) {
    const t = library.tracks.get(id);
    if (!t) continue;
    const label = [t.artist, t.title].filter(Boolean).join(' - ') || t.name;
    lines.push(`#EXTINF:${Math.round(t.duration || -1)},${label.replace(/[\r\n]+/g, ' ')}`);
    lines.push(prefix + t.path);
  }
  return lines.join('\n') + '\n';
}

// parseM3U(text) -> { name, entries: [{ path, duration, label }] }
export function parseM3U(text) {
  const out = { name: '', entries: [] };
  let inf = null;
  for (let line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      let m = /^#EXTINF:\s*(-?[\d.]+)[^,]*,(.*)$/i.exec(line);
      if (m) { inf = { duration: num(m[1], -1), label: m[2].trim() }; continue; }
      m = /^#PLAYLIST:(.*)$/i.exec(line);
      if (m) out.name = m[1].trim();
      continue;
    }
    let path = line;
    if (/^file:/i.test(path)) {
      try { path = decodeURIComponent(path.replace(/^file:\/\/(localhost)?\/?/i, '')); } catch { /* keep raw */ }
    }
    out.entries.push({ path, duration: inf?.duration ?? -1, label: inf?.label || '' });
    inf = null;
  }
  return out;
}

// importM3U(library, text, { name }) -> { playlist, matched, missing: [paths] }
export async function importM3U(library, text, { name = '' } = {}) {
  const m = parseM3U(text);
  const idx = index(library);
  const ids = [], missing = [];
  for (const e of m.entries) {
    const t = idx.find(baseName(e.path), 0, e.path);
    if (t) ids.push(t.id); else missing.push(e.path);
  }
  const plName = String(name || m.name || 'Importierte Playlist').replace(/\.m3u8?$/i, '');
  const playlist = await library.createPlaylist(plName, ids);
  return { playlist, matched: ids.length, missing };
}

// =====================================================================
// XML (tiny, dependency-free; enough for rekordbox / Traktor-like files)
// =====================================================================
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlDecode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
    }
    return ENT[e.toLowerCase()] ?? all;
  });
}
export function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // control chars are not allowed in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// parseXML(text) -> root element { name, attrs, children: [element], text }
export function parseXML(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m, pos = 0;
  while (pos < src.length && (m = re.exec(src))) {
    pos = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) {
      // close: pop to the matching element (tolerates sloppy nesting)
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; }
    } else if (m[3]) {
      const el = { name: m[3], attrs: {}, children: [], text: '' };
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[4] || ''))) el.attrs[a[1]] = xmlDecode(a[2] ?? a[3] ?? '');
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] != null) {
      if (/\S/.test(m[6])) top.text += xmlDecode(m[6]);
    }
  }
  if (pos < src.length) throw new Error(`XML-Fehler bei Zeichen ${pos}`);
  return root;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);

// =====================================================================
// Rekordbox XML
// =====================================================================
// file://localhost/C:/Music/a%20b.mp3 -> 'C:/Music/a b.mp3'
export function locationToPath(loc) {
  let s = String(loc || '');
  s = s.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\/\/?/i, '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  // mac paths have no drive letter: keep the leading slash
  if (!/^[A-Za-z]:\//.test(s) && !s.startsWith('/')) s = '/' + s;
  return s;
}
export function pathToLocation(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const enc = s.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return 'file://localhost/' + enc.replace(/^\/+/, '');
}

// parseRekordboxXML(text) -> { product, tracks: [...], playlists: [{ name, path[], keyType, keys[] }] }
export function parseRekordboxXML(text) {
  const doc = parseXML(text);
  const root = kid(doc, 'DJ_PLAYLISTS');
  if (!root) throw new Error('Keine rekordbox-XML (DJ_PLAYLISTS fehlt)');
  const product = kid(root, 'PRODUCT')?.attrs || {};
  const coll = kid(root, 'COLLECTION');
  const tracks = (coll ? kids(coll, 'TRACK') : []).map((el) => {
    const a = el.attrs;
    const path = locationToPath(a.Location);
    return {
      trackId: a.TrackID,
      name: a.Name || '', artist: a.Artist || '', album: a.Album || '', genre: a.Genre || '', comment: a.Comments || '',
      bpm: num(a.AverageBpm), tonality: a.Tonality || '', totalTime: num(a.TotalTime), size: num(a.Size),
      location: a.Location || '', path, fileName: baseName(path),
      playCount: num(a.PlayCount), dateAdded: a.DateAdded || '',
      tempos: kids(el, 'TEMPO').map((t) => ({ inizio: num(t.attrs.Inizio), bpm: num(t.attrs.Bpm), metro: t.attrs.Metro || '4/4', battito: num(t.attrs.Battito, 1) })),
      marks: kids(el, 'POSITION_MARK').map((p) => ({ name: p.attrs.Name || '', type: num(p.attrs.Type), start: num(p.attrs.Start), end: p.attrs.End != null ? num(p.attrs.End) : null, num: num(p.attrs.Num, -1) })),
    };
  });
  const playlists = [];
  const walk = (node, path) => {
    for (const n of kids(node, 'NODE')) {
      const name = n.attrs.Name || '';
      if (n.attrs.Type === '1') {
        playlists.push({ name, path: [...path, name], keyType: num(n.attrs.KeyType), keys: kids(n, 'TRACK').map((t) => t.attrs.Key) });
      } else {
        walk(n, name === 'ROOT' && !path.length ? path : [...path, name]);
      }
    }
  };
  const pls = kid(root, 'PLAYLISTS');
  if (pls) walk(pls, []);
  return { product, tracks, playlists };
}

// first TEMPO -> Pulsar grid (bpm, first downbeat >= 0)
export function gridFromTempos(tempos, fallbackBpm = 0) {
  const t0 = tempos?.[0];
  if (!t0 || !(t0.bpm > 0)) return fallbackBpm > 0 ? { bpm: fallbackBpm, beatOffset: NaN } : null;
  const spb = 60 / t0.bpm, bar = 4 * spb;
  const b = Math.min(4, Math.max(1, Math.round(t0.battito || 1)));
  let d = t0.inizio + ((5 - b) % 4) * spb;
  while (d - bar >= 0) d -= bar;
  while (d < 0) d += bar;
  return { bpm: t0.bpm, beatOffset: round(d, 4), variable: tempos.length > 1 };
}

// Pulsar grid -> one rekordbox TEMPO (first beat >= 0 and its Battito)
export function temposFromGrid(bpm, beatOffset) {
  if (!(bpm > 0)) return [];
  const spb = 60 / bpm;
  let d = Number.isFinite(beatOffset) ? beatOffset : 0;
  let first = ((d % spb) + spb) % spb;
  if (first > spb - 1e-6) first = 0;
  const k = Math.round((d - first) / spb); // beats from first beat to downbeat
  const battito = ((((-k) % 4) + 4) % 4) + 1;
  return [{ inizio: round(first, 3), bpm: round(bpm, 2), metro: '4/4', battito }];
}

// importRekordboxXML(library, text) -> { tracks, matched, unmatched: [names], analysis, cues, playlists, variableGrids }
export async function importRekordboxXML(library, text) {
  const rb = parseRekordboxXML(text);
  const idx = index(library);
  const res = { tracks: rb.tracks.length, matched: 0, unmatched: [], analysis: 0, cues: 0, playlists: 0, variableGrids: 0 };
  const byRbId = new Map(), byLoc = new Map();
  for (const r of rb.tracks) {
    const t = idx.find(r.fileName, r.size, r.path);
    if (!t) { res.unmatched.push(r.fileName || r.name); continue; }
    res.matched++;
    byRbId.set(r.trackId, t.id);
    byLoc.set(r.location, t.id);
    fillMeta(t, { title: r.name, artist: r.artist, album: r.album, genre: r.genre, comment: r.comment }, ['title', 'artist', 'album', 'genre', 'comment']);
    if (r.playCount > (t.plays || 0)) t.plays = r.playCount;
    await library.saveTrack(t);
    const grid = gridFromTempos(r.tempos, r.bpm);
    const key = parseKey(r.tonality);
    if (grid || key) {
      if (grid?.variable) res.variableGrids++;
      await library.applyAnalysis(t, { bpm: grid?.bpm || 0, beatOffset: grid ? grid.beatOffset : NaN, key, duration: r.totalTime });
      res.analysis++;
    }
    const hot = new Array(8).fill(null);
    let cuePoint = null;
    for (const mk of r.marks) {
      if (mk.num >= 0 && mk.num < 8) hot[mk.num] = round(mk.start, 4);
      else if (mk.num === -1 && (cuePoint == null || mk.start < cuePoint)) cuePoint = round(mk.start, 4);
    }
    if (await mergeCues(library, t, { hotcues: hot, cuePoint })) res.cues++;
  }
  for (const p of rb.playlists) {
    const ids = p.keys.map((k) => (p.keyType === 1 ? byLoc.get(k) : byRbId.get(k))).filter(Boolean);
    const name = p.path.join(' / ');
    const existing = library.playlists.find((x) => x.name === name);
    if (existing) {
      const add = ids.filter((x) => !existing.trackIds.includes(x));
      if (add.length) await library.addToPlaylist(existing.id, add);
    } else await library.createPlaylist(name, ids);
    res.playlists++;
  }
  library.changed();
  return res;
}

const HOT_RGB = [[40, 226, 20], [48, 90, 255], [255, 18, 123], [255, 140, 0], [224, 255, 0], [16, 177, 118], [180, 50, 255], [255, 255, 255]];
const KIND = { mp3: 'MP3 File', wav: 'WAV File', flac: 'FLAC File', m4a: 'M4A File', aac: 'M4A File', aif: 'AIFF File', aiff: 'AIFF File', ogg: 'OGG File' };

// exportRekordboxXML(library, { basePath='', playlistIds? }) -> string
// basePath: absolute folder that contains the library roots, e.g. 'C:/Users/me/Music'
// or '/Users/me/Music' (browsers cannot know absolute paths). Without it the
// Location is the library path, which rekordbox will show as "missing" until relocated.
export async function exportRekordboxXML(library, { basePath = '', playlistIds = null } = {}) {
  const pls = library.playlists.filter((p) => !playlistIds || playlistIds.includes(p.id));
  const only = playlistIds ? new Set(pls.flatMap((p) => p.trackIds)) : null;
  const rbId = new Map();
  const out = [];
  const A = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join('');
  const rows = [];
  let n = 0;
  for (const t of library.tracks.values()) {
    if (t.transient || (only && !only.has(t.id))) continue;
    const id = String(++n);
    rbId.set(t.id, id);
    const a = (await library.getAnalysis(t)) || {};
    const c = (await library.loadCues(t)) || {};
    const bpm = a.bpm || t.bpm || 0;
    const ext = lower((t.name || '').split('.').pop());
    const base = basePath ? basePath.replace(/[\\/]+$/, '') + '/' : '';
    const comment = [t.comment, t.license?.label, t.pageUrl].filter(Boolean).join(' | ');
    let x = `    <TRACK${A({
      TrackID: id, Name: t.title || t.name, Artist: t.artist, Album: t.album, Genre: t.genre, Kind: KIND[ext] || 'MP3 File',
      Size: t.size || 0, TotalTime: Math.round(a.duration || t.duration || 0), AverageBpm: bpm ? bpm.toFixed(2) : '0.00',
      DateAdded: t.addedAt ? new Date(t.addedAt).toISOString().slice(0, 10) : undefined, PlayCount: t.plays || 0,
      Tonality: rekordboxKey(a.key?.camelot || t.camelot), Comments: comment || undefined,
      Location: pathToLocation(base + t.path),
    })}>`;
    for (const tp of temposFromGrid(bpm, a.beatOffset)) x += `\n      <TEMPO${A({ Inizio: tp.inizio.toFixed(3), Bpm: tp.bpm.toFixed(2), Metro: tp.metro, Battito: tp.battito })}/>`;
    if (c.cuePoint != null) x += `\n      <POSITION_MARK${A({ Name: '', Type: 0, Start: c.cuePoint.toFixed(3), Num: -1 })}/>`;
    (c.hotcues || []).forEach((h, i) => {
      if (h == null || i > 7) return;
      const [r, g, b] = HOT_RGB[i];
      x += `\n      <POSITION_MARK${A({ Name: '', Type: 0, Start: h.toFixed(3), Num: i, Red: r, Green: g, Blue: b })}/>`;
    });
    x += '\n    </TRACK>';
    rows.push(x);
  }
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<DJ_PLAYLISTS Version="1.0.0">');
  out.push('  <PRODUCT Name="Pulsar DJ" Version="1" Company="Pulsar DJ (GPL-3.0-or-later)"/>');
  out.push(`  <COLLECTION Entries="${rows.length}">`);
  out.push(...rows);
  out.push('  </COLLECTION>');
  out.push('  <PLAYLISTS>');
  out.push(`    <NODE Type="0" Name="ROOT" Count="${pls.length}">`);
  for (const p of pls) {
    const keys = p.trackIds.map((x) => rbId.get(x)).filter(Boolean);
    out.push(`      <NODE Name="${xmlEscape(p.name)}" Type="1" KeyType="0" Entries="${keys.length}">`);
    for (const k of keys) out.push(`        <TRACK Key="${k}"/>`);
    out.push('      </NODE>');
  }
  out.push('    </NODE>');
  out.push('  </PLAYLISTS>');
  out.push('</DJ_PLAYLISTS>');
  return out.join('\n') + '\n';
}

// Auto-detect by content: returns the import result plus { kind }.
export async function importAny(library, text, { name = '' } = {}) {
  const s = String(text).replace(/^\uFEFF/, '').trimStart();
  if (s.startsWith('{')) return { kind: 'pulsar-library', ...(await importLibrary(library, s)) };
  if (s.startsWith('<') && /<DJ_PLAYLISTS/i.test(s.slice(0, 2000))) return { kind: 'rekordbox', ...(await importRekordboxXML(library, s)) };
  return { kind: 'm3u', ...(await importM3U(library, s, { name })) };
}

export const LibFormat = {
  exportLibrary, exportLibraryJSON, importLibrary, playlistToM3U8, parseM3U, importM3U,
  parseRekordboxXML, importRekordboxXML, exportRekordboxXML, importAny, parseKey, parseXML,
  gridFromTempos, temposFromGrid, locationToPath, pathToLocation,
};
export default LibFormat;
