// Music library: folder import (File System Access API), drag & drop, tag
// reading, cached analysis, harmonic/tempo matching, playlists and offline
// open-music downloads (Internet Archive, see openmusic.js).
// SPDX-License-Identifier: GPL-3.0-or-later

import { db } from './db.js';
import { fetchBlob, openTrackId, SOURCES } from './openmusic.js';

export const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|webm|mp4)$/i;

// ---------- Camelot helpers ----------
export function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/.exec(c || '');
  return m ? { n: Number(m[1]), m: m[2] } : null;
}

// 0 = perfect, 1 = adjacent / relative, 2 = energy boost, 99 = clash
export function camelotDistance(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 50;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.m === y.m) return d === 0 ? 0 : d === 1 ? 1 : d === 2 ? 2.5 : 99;
  return d === 0 ? 1 : 99;
}

export function keyColor(c) {
  const k = parseCamelot(c);
  if (!k) return '#555b66';
  const hue = ((k.n - 1) * 30 + 150) % 360;
  return `hsl(${hue} ${k.m === 'A' ? 70 : 85}% ${k.m === 'A' ? 58 : 66}%)`;
}

export function bpmDistance(a, b) {
  if (!a || !b) return 1;
  const r = [b / a, (b * 2) / a, b / (a * 2)].map((x) => Math.abs(1 - x));
  return Math.min(...r);
}

// ---------- tag reading ----------
function decodeText(bytes, enc) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(bytes);
    if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function clean(s) { return (s || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim(); }

function readID3(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x49 || u[1] !== 0x44 || u[2] !== 0x33) return null;
  const ver = u[3];
  const size = (u[6] << 21) | (u[7] << 14) | (u[8] << 7) | u[9];
  const end = Math.min(u.length, 10 + size);
  let p = 10;
  if (u[5] & 0x40) { // extended header
    const ext = ver === 4 ? (u[10] << 21) | (u[11] << 14) | (u[12] << 7) | u[13] : ((u[10] << 24) | (u[11] << 16) | (u[12] << 8) | u[13]) + 4;
    p += ext;
  }
  const tags = {};
  const want = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TBPM: 'bpm', TKEY: 'key', TT2: 'title', TP1: 'artist', TAL: 'album', TBP: 'bpm' };
  while (p + 10 < end) {
    let id, fsize, hdr;
    if (ver === 2) {
      id = String.fromCharCode(u[p], u[p + 1], u[p + 2]);
      fsize = (u[p + 3] << 16) | (u[p + 4] << 8) | u[p + 5];
      hdr = 6;
    } else {
      id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
      fsize = ver === 4
        ? (u[p + 4] << 21) | (u[p + 5] << 14) | (u[p + 6] << 7) | u[p + 7]
        : (u[p + 4] << 24) | (u[p + 5] << 16) | (u[p + 6] << 8) | u[p + 7];
      hdr = 10;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || fsize <= 0) break;
    const body = u.subarray(p + hdr, Math.min(end, p + hdr + fsize));
    if (want[id] && body.length > 1) tags[want[id]] = clean(decodeText(body.subarray(1), body[0]));
    p += hdr + fsize;
  }
  return tags;
}

function readFlac(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x66 || u[1] !== 0x4c || u[2] !== 0x61 || u[3] !== 0x43) return null;
  let p = 4;
  const dv = new DataView(buf);
  while (p + 4 < u.length) {
    const last = u[p] & 0x80, type = u[p] & 0x7f;
    const len = (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3];
    if (type === 4) {
      let q = p + 4;
      const vlen = dv.getUint32(q, true); q += 4 + vlen;
      const count = dv.getUint32(q, true); q += 4;
      const tags = {};
      const td = new TextDecoder();
      for (let i = 0; i < count && q < u.length; i++) {
        const l = dv.getUint32(q, true); q += 4;
        const s = td.decode(u.subarray(q, q + l)); q += l;
        const eq = s.indexOf('=');
        const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1);
        if (k === 'TITLE') tags.title = v;
        else if (k === 'ARTIST') tags.artist = v;
        else if (k === 'ALBUM') tags.album = v;
        else if (k === 'GENRE') tags.genre = v;
        else if (k === 'BPM') tags.bpm = v;
        else if (k === 'INITIALKEY' || k === 'KEY') tags.key = v;
      }
      return tags;
    }
    if (last) break;
    p += 4 + len;
  }
  return null;
}

async function readTags(file) {
  try {
    const head = await file.slice(0, 512 * 1024).arrayBuffer();
    return readID3(head) || readFlac(head) || {};
  } catch { return {}; }
}

function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base.trim() };
}

// ---------- Library ----------
export class Library {
  constructor(app) {
    this.app = app;
    this.tracks = new Map();     // id -> track
    this.files = new Map();      // id -> File | FileSystemFileHandle (this session)
    this.roots = [];             // FileSystemDirectoryHandle[]
    this.needsPermission = false;
    this.history = [];
    this.analysisQueue = [];
    this.analyzing = null;
    this.playlists = [];         // [{ id, name, trackIds[], createdAt }]
    this.stored = new Set();     // ids with a downloaded Blob in IndexedDB ('blobs')
    this.worker = typeof Worker !== 'undefined' ? new Worker('js/analysis-worker.js') : { postMessage() {} };
    this.jobs = new Map();
    this.worker.onmessage = (e) => {
      const job = this.jobs.get(e.data.id);
      if (!job) return;
      if (e.data.progress != null) { job.onProgress?.(e.data.progress); return; }
      this.jobs.delete(e.data.id);
      e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data.result);
    };
    this.jobId = 0;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  async init() {
    for (const [id, t] of await db.all('tracks')) this.tracks.set(id, t);
    this.stored = new Set(await db.keys('blobs'));
    this.playlists = (await db.all('playlists')).map(([, p]) => p).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    this.roots = (await db.get('kv', 'roots')) || [];
    if (this.roots.length) {
      const handles = this.roots.filter((r) => !r.picked);
      const states = await Promise.all(handles.map((r) => r.queryPermission?.({ mode: 'read' }).catch(() => 'denied')));
      const granted = states.every((s) => s === 'granted');
      if (handles.length && granted) this.rescan();
      this.needsPermission = !granted || this.roots.some((r) => r.picked);
    }
    this.changed();
  }

  async addFolder() {
    if (!window.showDirectoryPicker) return this.pickFolder();
    const dir = await window.showDirectoryPicker({ id: 'pulsar-music', mode: 'read' });
    if (!this.roots.some((r) => r.name === dir.name)) this.roots.push(dir);
    await db.put('kv', 'roots', this.roots);
    await this.scanDir(dir, dir.name);
    this.changed();
  }

  // Fallback for browsers without the File System Access API (Brave, Firefox):
  // a classic folder upload dialog. Access is not remembered, so after a restart
  // the folder has to be picked again (analysis and cues stay cached).
  pickFolder() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.multiple = true;
      input.addEventListener('cancel', () => resolve(false));
      this.pickedThisSession = this.pickedThisSession || new Set();
      input.addEventListener('change', async () => {
        const files = [...input.files].filter((f) => AUDIO_EXT.test(f.name));
        const rootName = (input.files[0]?.webkitRelativePath || '').split('/')[0] || 'Musik';
        this.pickedThisSession.add(rootName);
        if (!this.roots.some((r) => r.name === rootName)) this.roots.push({ name: rootName, picked: true });
        await db.put('kv', 'roots', this.roots);
        this.scanning = true;
        this.changed();
        for (let i = 0; i < files.length; i++) {
          await this.register(files[i], files[i].webkitRelativePath);
          if (i % 50 === 0) this.changed();
        }
        this.scanning = false;
        this.needsPermission = this.roots.some((r) => r.picked && !this.pickedThisSession.has(r.name));
        this.changed();
        resolve(true);
      });
      input.click();
    });
  }

  async reconnect() {
    if (this.roots.some((r) => r.picked)) {
      // no stored permission possible: pick the folder again
      await this.pickFolder();
      return !this.needsPermission;
    }
    for (const r of this.roots) {
      const s = await r.requestPermission({ mode: 'read' });
      if (s !== 'granted') return false;
    }
    this.needsPermission = false;
    await this.rescan();
    return true;
  }

  async removeRoots() {
    this.roots = [];
    await db.put('kv', 'roots', []);
    this.changed();
  }

  async rescan() {
    this.scanning = true;
    this.changed();
    for (const r of this.roots) if (!r.picked) await this.scanDir(r, r.name);
    this.scanning = false;
    this.changed();
  }

  async scanDir(dir, path) {
    const batch = [];
    const walk = async (d, p) => {
      for await (const entry of d.values()) {
        if (entry.kind === 'directory') await walk(entry, `${p}/${entry.name}`);
        else if (AUDIO_EXT.test(entry.name)) {
          const file = await entry.getFile();
          const t = await this.register(file, `${p}/${entry.name}`, entry);
          if (t) batch.push(t);
          if (batch.length % 50 === 0) this.changed();
        }
      }
    };
    await walk(dir, path);
    return batch;
  }

  trackId(file, path) { return `${path}|${file.size}|${file.lastModified}`; }

  // opts.id overrides the path-based id (open-music tracks), opts.transient keeps
  // the track out of IndexedDB (online preview, not downloaded).
  async register(file, path, handle, opts = {}) {
    const id = opts.id || this.trackId(file, path);
    this.files.set(id, handle || file);
    let t = this.tracks.get(id);
    if (t) return t;
    const tags = await readTags(file);
    const fn = fromFilename(file.name);
    t = {
      id,
      path,
      name: file.name,
      size: file.size,
      title: tags.title || fn.title,
      artist: tags.artist || fn.artist,
      album: tags.album || '',
      genre: tags.genre || '',
      bpm: Number(tags.bpm) || 0,
      tagKey: tags.key || '',
      camelot: '',
      keyName: '',
      duration: 0,
      analyzed: false,
      plays: 0,
      addedAt: Date.now(),
    };
    if (opts.transient) t.transient = true;
    this.tracks.set(id, t);
    if (!t.transient) await db.put('tracks', id, t);
    return t;
  }

  async addFiles(fileList) {
    const out = [];
    for (const f of fileList) {
      if (!AUDIO_EXT.test(f.name)) continue;
      out.push(await this.register(f, `Import/${f.name}`));
    }
    this.changed();
    return out;
  }

  async getFile(t) {
    const h = this.files.get(t.id);
    if (h) return h instanceof File ? h : h.getFile();
    if (this.stored.has(t.id)) {
      const blob = await db.get('blobs', t.id);
      if (!blob) { this.stored.delete(t.id); return null; }
      const file = blob instanceof File ? blob : new File([blob], t.name, { type: blob.type || 'audio/mpeg', lastModified: t.lastModified || 0 });
      this.files.set(t.id, file);
      return file;
    }
    return null;
  }

  available(t) { return !!t && (this.files.has(t.id) || this.stored.has(t.id)); }

  isDownloaded(t) { return !!t && this.stored.has(t.id); }

  // ---------- open music (openmusic.js results) ----------
  // Both functions take a normalised OpenMusic result of kind 'track' (for an
  // Internet Archive album, call result.tracks() first). Track id: open:{source}:{id}.

  // Fetch into a File without saving it: the track is "transient" (in memory, not
  // in IndexedDB) and can be loaded onto a deck via the normal prepare() path.
  // Analysis/cues are stored under the stable id and carry over to a later download.
  async openTrackFile(r, onProgress, { signal } = {}) {
    const id = openTrackId(r);
    const have = this.tracks.get(id);
    if (have && this.available(have)) { onProgress?.(1, have.size, have.size); return have; }
    const f = await this.fetchOpenFile(r, onProgress, signal);
    const t = await this.register(f, this.openPath(r), null, { id, transient: !this.stored.has(id) });
    this.applyOpenMeta(t, r);
    if (!t.transient) await this.saveTrack(t);
    this.changed();
    return t;
  }

  // Download and keep offline (IndexedDB 'blobs'); available after every restart.
  // onProgress(fraction 0..1, loadedBytes, totalBytes). Resolves to the library track.
  async downloadOpenTrack(r, onProgress, { signal } = {}) {
    if (r?.kind === 'album') throw new Error('Album: erst result.tracks() laden und einen Titel wählen');
    const id = openTrackId(r);
    let t = this.tracks.get(id);
    if (t && this.stored.has(id)) { onProgress?.(1, t.size, t.size); return t; }
    globalThis.navigator?.storage?.persist?.().catch(() => {});
    const f = (t && this.files.get(id)) || await this.fetchOpenFile(r, onProgress, signal);
    if (t) onProgress?.(1, f.size, f.size);
    await db.put('blobs', id, new Blob([f], { type: f.type || 'audio/mpeg' }));
    this.stored.add(id);
    t = await this.register(f, this.openPath(r), null, { id });
    delete t.transient;
    this.applyOpenMeta(t, r);
    t.lastModified = f.lastModified;
    await this.saveTrack(t);
    this.changed();
    return t;
  }

  openPath(r) {
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Unbekannt';
    return `${SOURCES[r.source]?.label || r.source}/${safe(r.artist)}/${safe(r.fileName)}`;
  }

  async fetchOpenFile(r, onProgress, signal) {
    if (!r?.streamUrl) throw new Error('Kein Audio-Link für diesen Eintrag');
    const blob = await fetchBlob(r.streamUrl, { onProgress, signal, expectedSize: r.size, proxy: !!r.proxy });
    const lastModified = r.mtime ? r.mtime * 1000 : Date.now();
    return new File([blob], r.fileName || 'track.mp3', { type: blob.type || 'audio/mpeg', lastModified });
  }

  applyOpenMeta(t, r) {
    Object.assign(t, {
      source: r.source,
      provider: r.provider || '',
      sourceId: r.id,
      pageUrl: r.pageUrl || '',
      sourceUrl: r.pageUrl || '',
      streamUrl: r.streamUrl,
      artistUrl: r.artistUrl || '',
      license: { ...r.license },
      title: r.title || t.title,
      artist: r.artist || t.artist,
      album: r.album || t.album,
      genre: t.genre || r.genre || '',
      attribution: r.attribution || `"${r.title}" by ${r.artist || 'unknown'} (${r.license?.label || ''}) ${r.pageUrl || ''}`.trim(),
    });
    if (!t.duration && r.durationSec) t.duration = r.durationSec;
    if (!t.bpm && r.bpm) t.bpm = r.bpm;
  }

  findOpenTrack(r) { return this.tracks.get(openTrackId(r)) || null; }

  // Rebuild an OpenMusic result from a stored track (e.g. imported from a
  // pulsar-library file on another device) so it can be downloaded again.
  openResultOf(t) {
    if (!t?.source || !t.streamUrl) return null;
    return {
      kind: 'track', id: t.sourceId || t.id.replace(/^open:[^:]+:/, ''), source: t.source, provider: t.provider,
      title: t.title, artist: t.artist, artistUrl: t.artistUrl, album: t.album, genre: t.genre,
      durationSec: t.duration, streamUrl: t.streamUrl, pageUrl: t.pageUrl, license: t.license || {},
      fileName: t.name, size: t.size, proxy: t.source === 'ccmixter', attribution: t.attribution,
    };
  }

  redownload(t, onProgress, opts) {
    const r = this.openResultOf(t);
    if (!r) return Promise.reject(new Error('Keine Quelle zum erneuten Laden'));
    return this.downloadOpenTrack(r, onProgress, opts);
  }

  // Simple local search (title/artist/album/genre/key), for mixing with online results.
  searchLocal(query = '', { limit = 500 } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const t of this.tracks.values()) {
      if (t.transient) continue;
      const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.camelot} ${t.name}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  // Deletes the stored audio and the track (incl. analysis, cues, playlist entries).
  async removeDownloaded(t) {
    if (!t) return false;
    await db.del('blobs', t.id);
    this.stored.delete(t.id);
    this.files.delete(t.id);
    await this.forgetTrack(t);
    return true;
  }

  async forgetTrack(t) {
    this.tracks.delete(t.id);
    this.history = this.history.filter((x) => x.id !== t.id);
    await Promise.all([db.del('tracks', t.id), db.del('analysis', t.id), db.del('cues', t.id)]);
    for (const p of this.playlists) {
      if (p.trackIds.includes(t.id)) { p.trackIds = p.trackIds.filter((x) => x !== t.id); await this.savePlaylist(p); }
    }
    this.changed();
  }

  downloadedBytes() {
    let n = 0;
    for (const id of this.stored) n += this.tracks.get(id)?.size || 0;
    return n;
  }

  // ---------- playlists ----------
  getPlaylist(id) { return this.playlists.find((p) => p.id === id) || null; }

  playlistTracks(id) {
    const p = this.getPlaylist(id);
    return p ? p.trackIds.map((x) => this.tracks.get(x)).filter(Boolean) : [];
  }

  async savePlaylist(p) {
    p.updatedAt = Date.now();
    await db.put('playlists', p.id, { id: p.id, name: p.name, trackIds: p.trackIds.slice(), createdAt: p.createdAt, updatedAt: p.updatedAt });
  }

  async createPlaylist(name, tracks = []) {
    const id = 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const p = { id, name: String(name || '').trim() || 'Neue Playlist', trackIds: this.idsOf(tracks), createdAt: Date.now() };
    this.playlists.push(p);
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  idsOf(tracks) {
    return [].concat(tracks ?? []).map((x) => (typeof x === 'string' ? x : x?.id)).filter((x) => this.tracks.has(x));
  }

  async renamePlaylist(id, name) {
    const p = this.getPlaylist(id);
    if (!p || !String(name || '').trim()) return null;
    p.name = String(name).trim();
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  async deletePlaylist(id) {
    const i = this.playlists.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.playlists.splice(i, 1);
    await db.del('playlists', id);
    this.changed();
    return true;
  }

  // Insert tracks (ids or track objects) at index (default: end). Duplicates allowed.
  async addToPlaylist(id, tracks, index) {
    const p = this.getPlaylist(id);
    if (!p) return null;
    const ids = this.idsOf(tracks);
    const at = index == null ? p.trackIds.length : Math.max(0, Math.min(p.trackIds.length, index));
    p.trackIds.splice(at, 0, ...ids);
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  // Remove entries by position (number[]), or every occurrence of tracks (ids / objects).
  async removeFromPlaylist(id, which) {
    const p = this.getPlaylist(id);
    if (!p) return null;
    const list = [].concat(which);
    if (typeof list[0] === 'number') {
      const drop = new Set(list);
      p.trackIds = p.trackIds.filter((_, i) => !drop.has(i));
    } else {
      const drop = new Set(list.map((x) => (typeof x === 'string' ? x : x?.id)));
      p.trackIds = p.trackIds.filter((x) => !drop.has(x));
    }
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  async movePlaylistTrack(id, from, to) {
    const p = this.getPlaylist(id);
    if (!p || from < 0 || from >= p.trackIds.length) return null;
    const [x] = p.trackIds.splice(from, 1);
    p.trackIds.splice(Math.max(0, Math.min(p.trackIds.length, to)), 0, x);
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  // Replace the whole order (e.g. after drag & drop or sorting).
  async reorderPlaylist(id, tracks) {
    const p = this.getPlaylist(id);
    if (!p) return null;
    p.trackIds = this.idsOf(tracks);
    await this.savePlaylist(p);
    this.changed();
    return p;
  }

  // ---------- imported grids / keys (used by libformat.js) ----------
  // Merge {bpm, beatOffset, key:{name,camelot}, duration} into the stored analysis.
  // Without a waveform the entry stays "partial" and is completed (keeping these
  // values) the next time the track is loaded or analysed.
  async applyAnalysis(t, part) {
    const cur = await db.get('analysis', t.id);
    const next = { ...(cur || {}) };
    if (part.bpm > 0) next.bpm = part.bpm;
    if (Number.isFinite(part.beatOffset)) next.beatOffset = part.beatOffset;
    if (part.key?.camelot) next.key = { ...(cur?.key || {}), ...part.key };
    if (Number.isFinite(part.rmsDb) && !Number.isFinite(next.rmsDb)) next.rmsDb = part.rmsDb;
    if (!next.duration && part.duration) next.duration = part.duration;
    if (!next.wave) next.partial = true;
    await db.put('analysis', t.id, next);
    if (next.bpm) t.bpm = next.bpm;
    if (next.key?.camelot) { t.camelot = next.key.camelot; t.keyName = next.key.name || t.keyName; }
    if (!t.duration && next.duration) t.duration = next.duration;
    await this.saveTrack(t);
    return next;
  }

  getAnalysis(t) { return db.get('analysis', t.id); }

  // fresh analysis + previously imported grid/key (user-prepared values win)
  async mergeImported(t, fresh) {
    const cur = await db.get('analysis', t.id);
    if (!cur?.partial) return fresh;
    return {
      ...fresh,
      bpm: cur.bpm || fresh.bpm,
      beatOffset: Number.isFinite(cur.beatOffset) ? cur.beatOffset : fresh.beatOffset,
      key: cur.key?.camelot ? cur.key : fresh.key,
    };
  }

  async saveTrack(t) {
    this.tracks.set(t.id, t);
    if (!t.transient) await db.put('tracks', t.id, t);
  }

  saveCues(t, cues) { if (t) db.put('cues', t.id, cues); }
  loadCues(t) { return db.get('cues', t.id); }

  // Decode + (cached) analysis. Returns { buffer, info }.
  async prepare(t, ctx, onProgress) {
    const file = await this.getFile(t);
    if (!file) throw new Error('Datei nicht verfügbar. Ordner neu verbinden.');
    onProgress?.(0.05);
    const data = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    onProgress?.(0.3);
    let info = await db.get('analysis', t.id);
    if (!info || !info.wave) {
      info = await this.analyzeBuffer(buffer, (p) => onProgress?.(0.3 + p * 0.7));
      info = await this.mergeImported(t, info);
      await this.storeAnalysis(t, info);
    }
    return { buffer, info };
  }

  analyzeBuffer(buffer, onProgress) {
    const n = buffer.length, ch = buffer.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
    }
    const id = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, mono, sr: buffer.sampleRate }, [mono.buffer]);
    });
  }

  async storeAnalysis(t, info) {
    await db.put('analysis', t.id, info);
    t.bpm = info.bpm || t.bpm;
    t.camelot = info.key?.camelot || '';
    t.keyName = info.key?.name || '';
    t.duration = info.duration;
    t.analyzed = true;
    await this.saveTrack(t);
    this.changed();
  }

  async updateGrid(t, info) {
    await db.put('analysis', t.id, info);
    t.bpm = info.bpm;
    await this.saveTrack(t);
    this.changed();
  }

  // Background analysis of everything not analysed yet.
  async analyzeAll(ctx) {
    const todo = [...this.tracks.values()].filter((t) => !t.analyzed && this.available(t));
    this.analysisQueue = todo;
    this.analysisTotal = todo.length;
    while (this.analysisQueue.length) {
      const t = this.analysisQueue.shift();
      this.analyzing = t;
      this.changed();
      try {
        const file = await this.getFile(t);
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        const info = await this.mergeImported(t, await this.analyzeBuffer(buffer));
        await this.storeAnalysis(t, info);
      } catch (e) {
        console.warn('Analyse fehlgeschlagen', t.name, e);
        t.analyzed = true;
        t.error = String(e.message || e);
        await this.saveTrack(t);
      }
    }
    this.analyzing = null;
    this.changed();
  }

  markPlayed(t) {
    t.plays = (t.plays || 0) + 1;
    t.lastPlayed = Date.now();
    this.saveTrack(t);
    if (!this.history.includes(t)) this.history.unshift(t);
    this.changed();
  }

  // Rank tracks that mix well into `ref` (key + tempo + not yet played).
  suggestions(ref, limit = 200) {
    if (!ref) return [];
    const out = [];
    for (const t of this.tracks.values()) {
      if (t.id === ref.id) continue;
      const kd = camelotDistance(ref.camelot, t.camelot);
      const bd = bpmDistance(ref.bpm, t.bpm);
      if (kd >= 99 || bd > 0.08) continue;
      const played = this.history.includes(t) ? 3 : 0;
      out.push({ t, score: kd * 1.2 + bd * 60 + played });
    }
    out.sort((a, b) => a.score - b.score);
    return out.slice(0, limit).map((x) => x.t);
  }
}
