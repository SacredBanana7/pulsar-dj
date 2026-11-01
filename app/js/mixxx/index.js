// Public entry point for running Mixxx controller mappings in Pulsar.
//   loadMappingIndex()              -> [{ file, name, author, controllerId, devices, scripts, ... }]
//   matchMapping(index, portName)   -> best entry for a Web MIDI port name, or null
//   new MixxxController(app, entry, midiOutput, { sysex })
//     .start() / .handleMidi(data) / .tick() / .stop()
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { MixxxController } from './runtime.js';

export { MixxxController };
export { getBridge } from './bridge.js';

export const MAPPING_BASE = new URL('../../controllers/mixxx/', import.meta.url).href;

let indexPromise = null;

export function loadMappingIndex() {
  if (!indexPromise) {
    indexPromise = fetch(new URL('index.json', MAPPING_BASE).href, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`index.json: ${r.status}`);
        return r.json();
      })
      .then((j) => (j.mappings || []).filter((m) => /\.midi\.xml$/i.test(m.file)))
      .catch((e) => {
        indexPromise = null;
        throw e;
      });
  }
  return indexPromise;
}

// tokens that say nothing about the device model
const NOISE = /^(midi|usb|in|out|input|output|port|audio|device|controller|driver|interface|ch|channel|\d)$|^midi(in|out)\d*$/;

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.midi\.xml$/, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE.test(t));
}

const compact = (s) => String(s || '').toLowerCase().replace(/\.midi\.xml$/, '').replace(/[^a-z0-9]/g, '');

function score(portTokens, portCompact, cand) {
  const ct = tokens(cand);
  if (!ct.length || !portTokens.length) return 0;
  const cset = new Set(ct);
  const common = portTokens.filter((t) => cset.has(t));
  // model numbers in the port name must appear in the candidate (DDJ-SB2 is not DDJ-SB3)
  if (portTokens.some((t) => /\d/.test(t) && !cset.has(t) && !compact(cand).includes(t))) return 0;
  let s = (common.length / portTokens.length) * 0.7 + (common.length / ct.length) * 0.3;
  const cc = compact(cand);
  if (cc.length >= 4 && (cc === portCompact)) s = Math.max(s, 1);
  else if (cc.length >= 4 && portCompact.length >= 4 && (portCompact.includes(cc) || cc.includes(portCompact))) s = Math.max(s, 0.8);
  return s;
}

// Fuzzy match a MIDI port name against mapping name, controller id, devices and file name.
export function matchMapping(index, portName) {
  if (!index || !portName) return null;
  // Windows: "MIDIIN2 (DDJ-SX)" / "2- Mixtrack Pro 3"; strip numbering prefixes
  const name = String(portName).replace(/^\d+\s*-\s*/, '');
  const pt = tokens(name);
  const pc = compact(name.replace(/^midi(in|out)\d*\s*/i, '').replace(/[()]/g, ''));
  if (!pt.length) return null;
  let best = null, bestScore = 0;
  for (const e of index) {
    const cands = [e.name, e.controllerId, e.file, ...(e.devices || []).map((d) => (typeof d === 'string' ? d : d?.name))];
    let s = 0;
    for (const c of cands) if (c) s = Math.max(s, score(pt, pc, c));
    if (s > bestScore + 1e-9) { bestScore = s; best = e; }
  }
  return bestScore >= 0.6 ? best : null;
}
