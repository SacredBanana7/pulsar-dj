// Free, openly licensed music for Pulsar DJ. Only Creative Commons / public
// domain sources, no DRM, no streaming services:
//   openverse   api.openverse.org (aggregates Jamendo, Freesound, Wikimedia, ...)
//   archive.org Internet Archive "netlabels" collection
//   ccmixter    ccmixter.org (no CORS -> local /proxy)
//   jamendo     api.jamendo.com (only with a client_id)
// Every source is queried independently with a timeout; one failing source never
// breaks the others. Requests that fail with a network/CORS TypeError are retried
// through the local proxy (GET /proxy?url=..., served by server.mjs / the exe).
// SPDX-License-Identifier: GPL-3.0-or-later

const IA = 'https://archive.org';

export const config = {
  // '/proxy?url=' on the local server; null = no proxy (e.g. Node tests)
  proxyBase: typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? `${location.origin}/proxy?url=` : null,
  timeoutMs: 12000,
  timeouts: { openverse: 25000 }, // Openverse answers uncached searches slowly
  rows: 20,
};

export function proxied(url) {
  return config.proxyBase ? config.proxyBase + encodeURIComponent(url) : url;
}

export const SOURCES = {
  openverse: { label: 'Openverse', home: 'https://openverse.org' },
  'archive.org': { label: 'Internet Archive', home: 'https://archive.org/details/netlabels' },
  ccmixter: { label: 'ccMixter', home: 'https://ccmixter.org' },
  jamendo: { label: 'Jamendo', home: 'https://www.jamendo.com', needsKey: true },
};

// Genre presets with per-source vocabularies.
export const GENRES = {
  techno: { label: 'Techno', ia: 'subject:(techno OR "minimal techno" OR "dub techno")', words: 'techno', cc: 'techno', jam: 'techno' },
  house: { label: 'House', ia: 'subject:(house OR "deep house" OR "tech house")', words: 'house', cc: 'house', jam: 'house' },
  dnb: { label: 'Drum & Bass', ia: 'subject:("drum and bass" OR "drum n bass" OR dnb OR jungle)', words: 'drum and bass', cc: 'drum_and_bass', jam: 'drumnbass' },
  dubstep: { label: 'Dubstep', ia: 'subject:(dubstep OR "uk garage")', words: 'dubstep', cc: 'dubstep', jam: 'dubstep' },
  ambient: { label: 'Ambient', ia: 'subject:(ambient OR downtempo OR chillout)', words: 'ambient', cc: 'ambient', jam: 'ambient' },
  hiphop: { label: 'Hip Hop', ia: 'subject:("hip hop" OR hip-hop OR hiphop OR beats)', words: 'hip hop', cc: 'hip_hop', jam: 'hiphop' },
  disco: { label: 'Disco / Funk', ia: 'subject:(disco OR "nu disco" OR funk)', words: 'disco', cc: 'disco', jam: 'disco' },
  electro: { label: 'Electro', ia: 'subject:(electro OR electroclash)', words: 'electro', cc: 'electro', jam: 'electronic' },
  trance: { label: 'Trance', ia: 'subject:(trance OR psytrance OR "progressive trance")', words: 'trance', cc: 'trance', jam: 'trance' },
  breaks: { label: 'Breakbeat', ia: 'subject:(breakbeat OR breaks OR "big beat")', words: 'breakbeat', cc: 'breakbeat', jam: 'breakbeat' },
  electronica: { label: 'IDM / Electronica', ia: 'subject:(idm OR electronica)', words: 'electronica', cc: 'electronica', jam: 'electronica' },
  experimental: { label: 'Experimental', ia: 'subject:(experimental OR glitch)', words: 'experimental', cc: 'experimental', jam: 'experimental' },
};

// ---------- licenses ----------
// licenseInfo(url | code, version?) ->
// { code:'by-nc-sa', version:'3.0', url, label:'CC BY-NC-SA 3.0 DE', nc, nd, sa, by, publicDomain, open }
export function licenseInfo(urlOrCode, version = '') {
  const u = String(urlOrCode || '').trim();
  const base = { code: '', version: '', url: u, label: u ? 'Unbekannte Lizenz' : 'Keine Lizenz', nc: false, nd: false, sa: false, by: false, publicDomain: false, open: false };
  if (!u) return base;
  // bare code from an API (openverse: 'by-sa', 'cc0', 'pdm', 'sampling+')
  if (!/[/.]/.test(u)) {
    const c = u.toLowerCase();
    if (c === 'cc0') return licenseInfo(`https://creativecommons.org/publicdomain/zero/${version || '1.0'}/`);
    if (c === 'pdm') return licenseInfo(`https://creativecommons.org/publicdomain/mark/${version || '1.0'}/`);
    return licenseInfo(`https://creativecommons.org/licenses/${c}/${version || '4.0'}/`);
  }
  let m = /creativecommons\.org\/licenses\/([a-z+-]+)\/(\d+(?:\.\d+)?)(?:\/([a-z]{2,3})(?=\/|$))?/i.exec(u);
  if (m) {
    const code = m[1].toLowerCase(), parts = code.split('-');
    const sampling = code.startsWith('sampling') || code.startsWith('nc-sampling');
    const name = sampling ? code.replace('nc-', 'NC-').replace('sampling', 'Sampling') : code.toUpperCase();
    const nc = parts.includes('nc');
    const nd = parts.includes('nd') || sampling; // sampling licences forbid plain redistribution of the whole work
    return {
      ...base, code, version: m[2], open: true,
      label: `CC ${name} ${m[2]}${m[3] ? ' ' + m[3].toUpperCase() : ''}`,
      by: parts.includes('by') || sampling, nc, nd, sa: parts.includes('sa'),
    };
  }
  m = /creativecommons\.org\/publicdomain\/(zero|mark)\/(\d+(?:\.\d+)?)/i.exec(u);
  if (m) {
    const zero = m[1].toLowerCase() === 'zero';
    return { ...base, code: zero ? 'cc0' : 'pdm', version: m[2], label: zero ? `CC0 ${m[2]}` : `Public Domain Mark ${m[2]}`, publicDomain: true, open: true };
  }
  if (/publicdomain|public[\s_-]?domain/i.test(u)) return { ...base, code: 'pd', label: 'Public Domain', publicDomain: true, open: true };
  return base;
}

export const licenseLabel = (url) => licenseInfo(url).label;

// license filter: 'any' | 'commercial' (no NC, no ND) | 'cc0' (public domain only)
export function licenseAllowed(lic, mode = 'any') {
  if (!lic?.open) return false;
  if (mode === 'commercial') return !lic.nc && !lic.nd;
  if (mode === 'cc0') return lic.publicDomain;
  return true;
}

// ---------- fetching ----------
function withTimeout(signal, ms = config.timeoutMs) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// fetch; on a network/CORS TypeError retry once through the local proxy.
export async function openFetch(url, { signal, proxy = false, timeout } = {}) {
  const opts = { signal: timeout === 0 ? signal : withTimeout(signal, timeout) };
  if (proxy && config.proxyBase) return fetch(proxied(url), opts);
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e?.name === 'TypeError' && config.proxyBase && !opts.signal?.aborted) return fetch(proxied(url), opts);
    throw e;
  }
}

async function getJSON(url, o) {
  const res = await openFetch(url, o);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Fetch with progress -> Blob. onProgress(fraction 0..1, loadedBytes, totalBytes)
export async function fetchBlob(url, { onProgress, signal, expectedSize = 0, type = '', proxy = false } = {}) {
  const res = await openFetch(url, { signal, proxy, timeout: 0 });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  const ct = res.headers.get('content-type') || '';
  const mime = type || (/^audio\//.test(ct) ? ct.split(';')[0] : 'audio/mpeg');
  if (!res.body?.getReader) {
    const b = await res.blob();
    onProgress?.(1, b.size, b.size);
    return new Blob([b], { type: mime });
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(total ? Math.min(1, loaded / total) : 0, loaded, total);
  }
  onProgress?.(1, loaded, total || loaded);
  return new Blob(chunks, { type: mime });
}

// ---------- helpers ----------
const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
function luceneWords(s) {
  return String(s || '').replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
}
function parseLength(s) {
  if (s == null || s === '') return 0;
  const str = String(s);
  if (str.includes(':')) return str.split(':').reduce((a, x) => a * 60 + Number(x), 0) || 0;
  return Number(str) || 0;
}
function fileNameFrom(url, fallback = 'track.mp3') {
  try {
    const p = new URL(url).pathname.split('/').pop();
    return decodeURIComponent(p) && /\.[a-z0-9]{2,4}$/i.test(p) ? decodeURIComponent(p) : fallback;
  } catch { return fallback; }
}
const slug = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';

function result(r) {
  const lic = r.license;
  return {
    kind: 'track',
    album: '', artistUrl: '', genre: '', tags: [], bpm: 0, size: 0, durationSec: 0,
    ...r,
    sourceLabel: SOURCES[r.source]?.label || r.source,
    fileName: r.fileName || `${slug(r.artist ? `${r.artist} - ${r.title}` : r.title)}.mp3`,
    license: { code: lic.code, version: lic.version, url: lic.url, label: lic.label, nc: lic.nc, nd: lic.nd, sa: lic.sa, by: lic.by, publicDomain: lic.publicDomain, open: lic.open },
  };
}

// ---------- Openverse ----------
async function searchOpenverse({ query, genre, license, page, rows, signal, timeout, sounds }) {
  const p = new URLSearchParams();
  const q = [query, GENRES[genre]?.words || genre].filter(Boolean).join(' ').trim();
  p.set('q', q || 'electronic');
  p.set('page_size', String(Math.min(20, rows)));
  p.set('page', String(page));
  if (!sounds) p.set('category', 'music');
  if (license === 'commercial') p.set('license_type', 'commercial,modification');
  if (license === 'cc0') p.set('license', 'cc0,pdm');
  const json = await getJSON(`https://api.openverse.org/v1/audio/?${p}`, { signal, timeout });
  return {
    total: json.result_count || 0,
    results: (json.results || []).filter((d) => d.url).map((d) => result({
      id: d.id,
      source: 'openverse',
      provider: d.provider || d.source || '',
      title: d.title || 'Unbenannt',
      artist: d.creator || '',
      artistUrl: d.creator_url || '',
      album: d.audio_set?.title || '',
      durationSec: (d.duration || 0) / 1000,
      streamUrl: d.url,
      pageUrl: d.foreign_landing_url || '',
      license: licenseInfo(d.license_url || d.license, d.license_version),
      genre: list(d.genres).join(', '),
      tags: list(d.tags).map((t) => t.name).filter(Boolean),
      size: d.filesize || 0,
      fileName: /\.(mp3|ogg|flac|wav|m4a)$/i.test(fileNameFrom(d.url, '')) ? fileNameFrom(d.url) : undefined,
      attribution: d.attribution || '',
    })),
  };
}

// ---------- Internet Archive ----------
// Search returns albums (kind: 'album'); album.tracks() loads the individual
// tracks (kind: 'track', streamable/downloadable) with one metadata request.
async function searchArchive({ query, genre, license, page, rows, signal, timeout }) {
  const parts = ['mediatype:audio', 'collection:netlabels'];
  parts.push(license === 'cc0' ? 'licenseurl:*publicdomain*' : '(licenseurl:*creativecommons.org* OR licenseurl:*publicdomain*)');
  if (genre) parts.push(GENRES[genre]?.ia || `subject:(${luceneWords(genre) || '*'})`);
  const text = luceneWords(query);
  if (text) parts.push(`(${text})`);
  let q = parts.join(' AND ');
  if (license === 'commercial') q += ' NOT licenseurl:*-nc* NOT licenseurl:*-nd* NOT licenseurl:*sampling*';
  const p = new URLSearchParams();
  p.set('q', q);
  for (const f of ['identifier', 'title', 'creator', 'licenseurl', 'subject', 'date', 'downloads']) p.append('fl[]', f);
  if (!text) p.append('sort[]', 'downloads desc'); // free text: relevance order
  p.set('rows', String(rows));
  p.set('page', String(page));
  p.set('output', 'json');
  const json = await getJSON(`${IA}/advancedsearch.php?${p}`, { signal, timeout });
  const r = json.response || { numFound: 0, docs: [] };
  return { total: r.numFound, results: r.docs.map(archiveItem).filter((x) => x.license.code) };
}

function archiveItem(d) {
  const id = d.identifier;
  const lic = licenseInfo(first(d.licenseurl));
  const res = result({
    kind: 'album',
    id,
    source: 'archive.org',
    title: first(d.title) || id,
    artist: list(d.creator).join(', '),
    artistUrl: '',
    album: first(d.title) || id,
    streamUrl: null,
    pageUrl: `${IA}/details/${id}`,
    thumb: `${IA}/services/img/${id}`,
    license: lic,
    genre: list(d.subject).slice(0, 3).join(', '),
    tags: list(d.subject).flatMap((s) => String(s).split(/\s*;\s*/)).filter(Boolean),
    date: first(d.date),
    downloads: Number(d.downloads) || 0,
  });
  res.tracks = (o) => archiveTracks(id, o).then((x) => x.tracks);
  return res;
}

function mp3Rank(f) {
  const fmt = f.format || '';
  if (!/mp3/i.test(fmt)) return null;
  if (f.source === 'original') return 0;
  if (/^VBR MP3$/i.test(fmt)) return 1;
  const k = Number((/(\d+)\s*Kbps/i.exec(fmt) || [])[1]) || 0;
  return k >= 320 ? 2 : k >= 256 ? 3 : k >= 192 ? 4 : k >= 128 ? 5 : 9; // 64k previews last
}
const IA_AUDIO = /^(flac|24bit flac|wave|aiff|ogg vorbis)$/i;

// archiveTracks(identifier) -> { item, tracks[] } ; one track per original
// recording, best MP3 variant (original > VBR > 320 > 256 > 192 > 128 > 64 kbps),
// FLAC/OGG/WAV only when no MP3 exists.
export async function archiveTracks(identifier, { signal } = {}) {
  const json = await getJSON(`${IA}/metadata/${encodeURIComponent(identifier)}`, { signal });
  if (!json.metadata) throw new Error('Item nicht gefunden');
  const md = json.metadata;
  const item = archiveItem({ ...md, identifier: md.identifier || identifier });
  const files = json.files || [];
  const byName = new Map(files.map((f) => [f.name, f]));
  const groups = new Map();
  for (const f of files) {
    if (mp3Rank(f) == null && !(f.source === 'original' && IA_AUDIO.test(f.format || ''))) continue;
    const key = f.source === 'original' ? f.name : (f.original || f.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const tracks = [];
  for (const [key, cands] of groups) {
    const mp3 = cands.filter((f) => mp3Rank(f) != null).sort((a, b) => mp3Rank(a) - mp3Rank(b));
    const pick = mp3[0] || cands.find((f) => f.source === 'original') || cands[0];
    const orig = byName.get(key) || pick;
    const meta = (k) => first(pick[k]) || first(orig[k]) || '';
    tracks.push(result({
      id: `${item.id}/${pick.name}`,
      source: 'archive.org',
      title: meta('title') || pick.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
      artist: meta('artist') || meta('creator') || item.artist,
      album: meta('album') || item.title,
      trackNo: meta('track'),
      durationSec: parseLength(orig.length || pick.length),
      streamUrl: archiveDownloadUrl(item.id, pick.name),
      pageUrl: item.pageUrl,
      license: licenseInfo(item.license.url),
      genre: meta('genre') || item.genre,
      tags: item.tags,
      size: Number(pick.size) || 0,
      format: pick.format,
      mtime: Number(pick.mtime || orig.mtime) || 0,
      fileName: pick.name.split('/').pop(),
      itemId: item.id,
    }));
  }
  const tn = (t) => parseInt(String(t.trackNo || '').split('/')[0], 10) || 9999;
  tracks.sort((a, b) => tn(a) - tn(b) || a.fileName.localeCompare(b.fileName));
  return { item, tracks };
}

export function archiveDownloadUrl(identifier, name) {
  return `${IA}/download/${encodeURIComponent(identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------- ccMixter (always via proxy: no CORS) ----------
async function searchCcmixter({ query, genre, page, rows, signal, timeout }) {
  const p = new URLSearchParams({ f: 'json', limit: String(rows), offset: String((page - 1) * rows), sort: 'rank' });
  if (query) { p.set('search', query); p.set('search_type', 'all'); }
  const tag = GENRES[genre]?.cc || (genre ? String(genre).toLowerCase().replace(/\s+/g, '_') : '');
  if (tag) p.set('tags', tag);
  if (!query && !tag) p.set('tags', 'electronic');
  const json = await getJSON(`https://ccmixter.org/api/query?${p}`, { signal, timeout, proxy: true });
  const out = [];
  for (const d of list(json)) {
    const files = list(d.files);
    const f = files.find((x) => /mp3/i.test(x.file_format_info?.['default-ext'] || x.file_name)) || files.find((x) => x.file_format_info?.['media-type'] === 'audio');
    if (!f?.download_url) continue;
    const tags = String(d.upload_extra?.usertags || '').split(',').map((s) => s.trim()).filter(Boolean);
    out.push(result({
      id: String(d.upload_id),
      source: 'ccmixter',
      title: d.upload_name || 'Unbenannt',
      artist: d.user_real_name || d.user_name || '',
      artistUrl: d.artist_page_url || '',
      durationSec: parseLength(f.file_format_info?.ps),
      streamUrl: f.download_url,
      pageUrl: d.file_page_url || '',
      license: licenseInfo(d.license_url),
      genre: tags.slice(0, 3).join(', '),
      tags,
      bpm: Number(d.upload_extra?.bpm) || 0,
      size: Number(f.file_rawsize) || 0,
      fileName: f.file_name,
      proxy: true, // audio has no CORS headers either
    }));
  }
  return { total: null, results: out };
}

// ---------- Jamendo (needs a client_id) ----------
async function searchJamendo({ query, genre, license, page, rows, signal, timeout, jamendoClientId }) {
  const p = new URLSearchParams({
    client_id: jamendoClientId, format: 'json', limit: String(rows), offset: String((page - 1) * rows),
    include: 'licenses musicinfo', audioformat: 'mp32', order: query ? 'relevance' : 'popularity_month',
  });
  if (query) p.set('search', query);
  const tag = GENRES[genre]?.jam || genre;
  if (tag) p.set('tags', tag);
  if (license === 'commercial') { p.set('ccnc', 'false'); p.set('ccnd', 'false'); }
  const json = await getJSON(`https://api.jamendo.com/v3.0/tracks/?${p}`, { signal, timeout });
  if (json.headers?.status && json.headers.status !== 'success') throw new Error(json.headers.error_message || 'Jamendo-Fehler');
  return {
    total: json.headers?.results_fullcount ?? null,
    results: list(json.results).filter((d) => d.audio).map((d) => result({
      id: String(d.id),
      source: 'jamendo',
      title: d.name || 'Unbenannt',
      artist: d.artist_name || '',
      artistUrl: d.artist_id ? `https://www.jamendo.com/artist/${d.artist_id}` : '',
      album: d.album_name || '',
      durationSec: Number(d.duration) || 0,
      streamUrl: (d.audiodownload_allowed && d.audiodownload) || d.audio,
      pageUrl: d.shareurl || `https://www.jamendo.com/track/${d.id}`,
      license: licenseInfo(d.license_ccurl),
      genre: list(d.musicinfo?.tags?.genres).join(', '),
      tags: [...list(d.musicinfo?.tags?.genres), ...list(d.musicinfo?.tags?.vartags)],
      thumb: d.image || '',
    })),
  };
}

const SEARCHERS = { openverse: searchOpenverse, 'archive.org': searchArchive, ccmixter: searchCcmixter, jamendo: searchJamendo };

// searchAll({ query, genre, license, page, sources, jamendoClientId, signal, rows, sounds })
// -> Promise<[{ source, label, ok, error?, total, results[] }]> (one entry per source,
//    in SOURCES order; never rejects because of a single source)
export async function searchAll({ query = '', genre = '', license = 'any', page = 1, sources, jamendoClientId = '', signal, rows = config.rows, sounds = false } = {}) {
  const want = (sources && sources.length ? sources : Object.keys(SOURCES))
    .filter((s) => SEARCHERS[s] && (s !== 'jamendo' || jamendoClientId));
  const args = { query: String(query || '').trim(), genre, license, page: Math.max(1, page | 0), rows, signal, jamendoClientId, sounds };
  const seen = new Set();
  const settled = await Promise.all(want.map(async (source) => {
    try {
      const r = await SEARCHERS[source]({ ...args, timeout: config.timeouts[source] ?? config.timeoutMs });
      return { source, label: SOURCES[source].label, ok: true, total: r.total, results: r.results.filter((x) => licenseAllowed(x.license, license)) };
    } catch (e) {
      const error = e?.name === 'TimeoutError' ? 'Zeitüberschreitung' : String(e?.message || e);
      return { source, label: SOURCES[source].label, ok: false, error, total: 0, results: [] };
    }
  }));
  // drop Openverse duplicates of tracks that a dedicated source already returned
  for (const g of settled) if (g.source !== 'openverse') for (const r of g.results) if (r.pageUrl) seen.add(r.pageUrl);
  for (const g of settled) if (g.source === 'openverse') g.results = g.results.filter((r) => !seen.has(r.pageUrl));
  return settled;
}

// Single-source convenience (Internet Archive item search as briefed).
export async function search({ query, genre, page, license = 'any', source = 'archive.org', ...rest } = {}) {
  const [g] = await searchAll({ query, genre, page, license, sources: [source], ...rest });
  if (!g.ok) throw new Error(g.error);
  return g;
}

export const itemTracks = archiveTracks;

// Stable library id for an open-music result.
export const openTrackId = (r) => `open:${r.source}:${r.id}`;

export const OpenMusic = {
  config, SOURCES, GENRES, searchAll, search, itemTracks, archiveTracks, archiveDownloadUrl,
  licenseInfo, licenseLabel, licenseAllowed, fetchBlob, openFetch, proxied, openTrackId,
};
export default OpenMusic;
