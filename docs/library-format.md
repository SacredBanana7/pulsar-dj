# Pulsar library format (`pulsar-library` v1)

Pulsar DJ can export its whole collection (track metadata, beat grids, keys,
cue points, playlists and the source/licence of downloaded open music) as one
plain JSON file. The format is open and documented here so that other tools can
read and write it. Pulsar DJ is GPL-3.0-or-later. This specification can be used
freely, with or without attribution.

Implementation: `app/js/libformat.js` (`exportLibrary`, `importLibrary`).

## File

* UTF-8 JSON, suggested extension `.pulsar.json`, MIME `application/json`.
* Top-level object:

| field        | type     | required | meaning |
|--------------|----------|----------|---------|
| `format`     | string   | yes      | always `"pulsar-library"` |
| `version`    | integer  | yes      | `1`. Readers should accept higher versions and ignore fields they do not know. |
| `generator`  | string   | no       | e.g. `"Pulsar DJ"` |
| `exportedAt` | string   | no       | ISO-8601 timestamp |
| `tracks`     | Track[]  | yes      | may be empty |
| `playlists`  | Playlist[] | yes    | may be empty |

## Track

All times are **seconds** (floating point) from the start of the decoded audio.

| field        | type            | meaning |
|--------------|-----------------|---------|
| `id`         | string          | Pulsar track id. Local files use `"{path}|{size}|{lastModified ms}"`. Open-music tracks use `"open:{source}:{sourceId}"`. Other tools may use any unique string. |
| `path`       | string          | path relative to the parent of the imported music folder, `/` separated, e.g. `"Music/House/Artist - Title.mp3"` |
| `name`       | string          | file name incl. extension |
| `size`       | integer         | file size in bytes (0 if unknown) |
| `title`, `artist`, `album`, `genre` | string | tags |
| `duration`   | number          | length in seconds (0 if unknown) |
| `bpm`        | number          | tempo of the beat grid (0 = none) |
| `beatOffset` | number \| null  | time of the first **downbeat** (beat 1 of a 4/4 bar) at or after 0. The grid is `beatOffset + n * 60 / bpm` for every integer n (also negative). |
| `key`        | object \| null  | `{ "name": "Am", "camelot": "8A" }`. `camelot` is `1A`–`12A` (minor) / `1B`–`12B` (major). `name` uses sharps: `C C# D D# E F F# G G# A A# B`, plus `m` for minor. |
| `tagKey`     | string          | key as written in the file tags (free text) |
| `rmsDb`      | number \| null  | loudness (RMS, dBFS) used for auto-gain |
| `plays`      | integer         | play count |
| `lastPlayed`, `addedAt` | integer \| null | Unix time in ms |
| `cues`       | object \| null  | `{ "hotcues": [8 × (number\|null)], "cuePoint": number\|null }`. Index 0–7 = hot cue A–H. `cuePoint` is the main (memory) cue. |
| `comment`    | string          | optional |
| `source`     | string          | optional. Where the audio came from: `"archive.org"`, `"openverse"`, `"ccmixter"`, `"jamendo"`. Missing means a local file. |
| `provider`   | string          | optional. Openverse's upstream provider (`jamendo`, `freesound`, `wikimedia_audio` …) |
| `sourceId`   | string          | optional. Id at the source |
| `pageUrl`    | string          | optional. Human-readable page of the work, used for attribution |
| `streamUrl`  | string          | optional. Direct audio URL, used to download the file again |
| `artistUrl`  | string          | optional |
| `attribution`| string          | optional. Ready-made attribution line |
| `license`    | object          | optional. `{ "code": "by-sa", "version": "3.0", "url": "...", "label": "CC BY-SA 3.0", "nc": false, "nd": false, "sa": true, "by": true, "publicDomain": false }`. `nc` = NonCommercial (not for paid gigs/streams), `nd` = NoDerivatives. |
| `waveform`   | object          | optional, only when exported with "include waveforms": `{ "rate": 150, "low": b64, "mid": b64, "high": b64, "peak": b64 }`. Each band is a base64 string of unsigned bytes (0–255), `rate` values per second. |

Unknown fields must be ignored by readers.

## Playlist

| field      | type     | meaning |
|------------|----------|---------|
| `id`       | string   | unique id |
| `name`     | string   | display name. Folder nesting from other software is flattened as `"Folder / Sub / Name"`. |
| `trackIds` | string[] | ordered track ids. These refer to `tracks[].id`. Duplicates are allowed. |

## Example

```json
{
 "format": "pulsar-library",
 "version": 1,
 "generator": "Pulsar DJ",
 "exportedAt": "2026-11-01T20:15:00.000Z",
 "tracks": [
  {
   "id": "Music/House/Artist A - Tune One.mp3|9142231|1700000000000",
   "path": "Music/House/Artist A - Tune One.mp3",
   "name": "Artist A - Tune One.mp3",
   "size": 9142231,
   "title": "Tune One",
   "artist": "Artist A",
   "album": "",
   "genre": "Deep House",
   "duration": 301.2,
   "bpm": 124,
   "beatOffset": 0.321,
   "key": { "name": "Am", "camelot": "8A" },
   "tagKey": "",
   "rmsDb": -11.5,
   "plays": 3,
   "lastPlayed": 1761990000000,
   "addedAt": 1700000500000,
   "cues": { "hotcues": [62.01, null, 93, null, null, null, null, null], "cuePoint": 0.321 }
  },
  {
   "id": "open:archive.org:WkBw0034/03-Monochromatic-LastNightFairytale-.mp3",
   "path": "Internet Archive/MonoChromatic/03-Monochromatic-LastNightFairytale-.mp3",
   "name": "03-Monochromatic-LastNightFairytale-.mp3",
   "size": 9110000,
   "title": "03 - Monochromatic - Last Night Fairytale-",
   "artist": "MonoChromatic",
   "album": "WkBw0034",
   "genre": "Trip Hop, Electronica, Ambient",
   "duration": 226,
   "bpm": 0, "beatOffset": null, "key": null, "tagKey": "", "rmsDb": null,
   "plays": 0, "lastPlayed": null, "addedAt": 1761990100000, "cues": null,
   "source": "archive.org",
   "sourceId": "WkBw0034/03-Monochromatic-LastNightFairytale-.mp3",
   "pageUrl": "https://archive.org/details/WkBw0034",
   "streamUrl": "https://archive.org/download/WkBw0034/03-Monochromatic-LastNightFairytale-.mp3",
   "license": { "code": "by-nc-sa", "version": "3.0", "url": "http://creativecommons.org/licenses/by-nc-sa/3.0/de/",
                "label": "CC BY-NC-SA 3.0 DE", "nc": true, "nd": false, "sa": true, "by": true, "publicDomain": false }
  }
 ],
 "playlists": [
  { "id": "pl-mh1abc-x7k2q", "name": "Warm-up", "trackIds": ["Music/House/Artist A - Tune One.mp3|9142231|1700000000000"] }
 ]
}
```

## Import rules (as implemented by Pulsar)

* A track matches an existing one by `id`. If that fails, it matches by
  file name plus `size`. If that also fails, it matches by file name only
  (preferring the longest matching path tail).
* Metadata (title, artist, album, genre, comment, source, licence) only fills
  **empty** fields. The user's own data is never overwritten. `plays` keeps the maximum.
* Beat grid (`bpm`, `beatOffset`) and `key` from the file are applied. When the
  track has no analysis yet, Pulsar keeps them and computes only the waveform and
  loudness the next time the track loads.
* Cues: every non-null hot cue slot and the `cuePoint` are applied. Other slots stay as they are.
* Unknown tracks are added as offline entries. They become playable once a
  folder with the same path, size and date is connected, or after the open-music
  track is downloaded again.
* Playlists merge by `id`, then by `name`. Missing tracks are appended. Nothing is ever deleted.

## Other formats supported by Pulsar

* **M3U / M3U8**: export per playlist (`#EXTM3U`, `#PLAYLIST:name`,
  `#EXTINF:<seconds>,Artist - Title`, then the library path). On import, entries
  match library tracks by file name (Windows, POSIX and `file://` paths are accepted).
* **Rekordbox XML** (`DJ_PLAYLISTS`), import and export:
  * `TRACK` provides `Name`, `Artist`, `Album`, `Genre`, `Comments`, `AverageBpm`,
    `Tonality` (`Am`, `F#m`, `Db`, or Camelot `8A`), `TotalTime`, `Size`, `PlayCount`, `Location`.
  * The first `TEMPO` (`Inizio`, `Bpm`, `Battito`) becomes the grid:
    `beatOffset = Inizio + ((5 − Battito) mod 4) · 60/Bpm`, reduced to the first
    downbeat ≥ 0. Variable-tempo grids use their first segment only.
    Export writes one `TEMPO` at the first beat ≥ 0 with the matching `Battito`.
  * `POSITION_MARK` `Num` 0–7 → hot cues A–H (loops use their start).
    `Num="-1"` (memory cue) → `cuePoint`. If there are several, the earliest one is used.
  * Playlists are `NODE Type="1"` with `KeyType="0"` (TrackID) or `KeyType="1"` (Location).
    Folders are flattened to `"Folder / Name"`.
  * Matching uses the file name from `Location` plus `Size`, with a fallback to the file name only.
  * Export `Location` is `file://localhost/` + `basePath` + library path, URL-encoded.
    Browsers do not reveal absolute paths, so the user enters `basePath` (the folder
    that contains the imported music folder). Without it, rekordbox shows the tracks
    as missing until they are relocated.
