# Pulsar DJ

**Freie 4-Deck-DJ-Software für den Browser, mit Unterstützung für über 140 DJ-Controller und eingebauter Suche nach legal freier Musik.**
*Free and open-source 4-deck DJ software that runs in the browser, supports 140+ MIDI DJ controllers and searches freely licensed music alongside your own collection.*

Pulsar läuft komplett lokal: Web Audio (AudioWorklet) für den Sound, Web MIDI für Controller und IndexedDB für die Bibliothek. Es gibt keinen Build-Schritt und kein Konto, Pulsar telefoniert nicht nach Hause. Deine Musik verlässt nie deinen Rechner.

## Funktionen

- **4 Decks** mit Key Lock (Time-Stretching ohne Tonhöhenänderung), Slip-Modus, Quantize, Vinyl-Modus und Scratchen, Reverse, CDJ-Cue, 8 Hot Cues, Loops, Loop Rolls und Beatjump
- **Analyse** von BPM, Beatgrid mit Takt-Eins und Tonart (Camelot), farbige 3-Band-Waveform und Auto-Gain. Das Beatgrid lässt sich korrigieren (÷2, ×2, verschieben, Tap)
- **Sync** mit Phasenabgleich, Half-/Double-Time und Soft-Takeover am Tempo-Fader
- **Mixer:** 3-Band-Isolator-EQ mit Kill, Ein-Knopf-Filter, Gain, Crossfader mit einstellbarer Kurve, Limiter, Vorhören auf Kanal 3/4 (z. B. Controller-Soundkarten) oder Split-Cue
- **Effekte:** 2 FX-Units mit je 3 Plätzen (Echo, Reverb, Flanger, Phaser, Bitcrush, Trans-Gate, Riser), beat-synchron
- **Harmonic Mixing:** „Passt zu Deck X“ schlägt Tracks nach Tonart und Tempo vor
- **Mix-Aufnahme** als Datei
- **Controller:**
  - Pioneer DDJ-SX nativ, an echter Hardware getestet, mit LEDs, VU und Jog-Ring
  - 144 weitere MIDI-Controller über die offenen [Mixxx](https://mixxx.org)-Mappings
  - MIDI-Learn für alles andere
- **Offene Musik-Bibliothek:**
  - Lokale Ordner und legal freie Online-Musik in einer gemeinsamen Suche (Openverse/Jamendo, Internet Archive, ccMixter)
  - Lizenz und Urheber werden bei jedem Track angezeigt
  - Freie Tracks lassen sich offline speichern
- **Offenes Library-Format:**
  - Die komplette Sammlung lässt sich als dokumentiertes JSON exportieren und importieren ([docs/library-format.md](docs/library-format.md))
  - Playlists als M3U8
  - Rekordbox-XML in beide Richtungen

## Starten

**Windows:** Repo herunterladen und `launcher\build.cmd` ausführen. Der benötigte C#-Compiler gehört zu Windows, es muss nichts installiert werden. Danach `Pulsar DJ.exe` im Hauptordner doppelklicken. Pulsar öffnet sich als eigenes Fenster (Chrome oder Edge muss installiert sein), Node.js wird nicht gebraucht.

**Überall (Node.js ≥ 18):**

```bash
npm start
```

Dann im Browser `http://localhost:5180` öffnen. Für MIDI und dauerhaften Ordnerzugriff empfiehlt sich Chrome oder Edge. Brave und Firefox funktionieren auch, dort muss der Musikordner aber nach jedem Neustart neu gewählt werden.

## Musik aus dem Netz – nur legal frei

Pulsar sucht ausschließlich in Quellen mit freien Lizenzen (Creative Commons, CC0, Public Domain). Bei jedem Track stehen die Lizenz und ein Link zum Urheber. Tracks mit **NC** (nicht kommerziell) oder **ND** (keine Bearbeitung) sind markiert. Für bezahlte Auftritte kommen sie nicht in Frage, und bei CC BY musst du den Urheber nennen. Inhalte von Streaming-Diensten wie Spotify, YouTube, Apple Music oder SoundCloud kann und wird Pulsar nicht laden.

## Entwicklung

```
app/                 Die komplette Anwendung (statisch, ES-Module)
  js/deck-processor.js   AudioWorklet: Wiedergabe, Scratch, Loops, Slip, WSOLA-Key-Lock
  js/analysis-worker.js  BPM, Beatgrid, Tonart, Waveform
  js/engine.js           Mixer, Routing, FX, Aufnahme
  js/midi.js             Web MIDI, natives DDJ-SX-Mapping, MIDI-Learn
  js/mixxx/              Mixxx-kompatible Skript-Laufzeit für Controller-Mappings
  js/library.js, openmusic.js, libformat.js   Bibliothek, freie Musik, Import/Export
  controllers/mixxx/     Unveränderte Mixxx-Mappings (GPL-2.0-or-later)
launcher/            Windows-Starter (C#, .NET Framework, ohne Abhängigkeiten)
server.mjs           Lokaler Server inkl. Proxy für freie Musikquellen ohne CORS
tools/               Mapping-Sync, Testtracks, MIDI-Recorder, Icon
docs/                Dateiformate
```

- Mixxx-Mappings aktualisieren: `node tools/sync-mixxx-mappings.mjs <mixxx-checkout>`
- Synthetische Testtracks mit bekanntem BPM/Key: `npm run testtracks`
- Rohe MIDI-Daten eines Controllers aufnehmen (Windows): `tools/midi-capture.ps1`

Beiträge sind willkommen, besonders Controller-Tests. Funktioniert dein Controller nicht? Dann öffne ein Issue mit der Ausgabe des MIDI-Monitors (⚙ → MIDI).

## Lizenz

Pulsar DJ steht unter der [GNU General Public License v3.0 oder neuer](LICENSE).
Die Controller-Mappings in `app/controllers/mixxx/` stammen vom Mixxx-Projekt (GPL-2.0-or-later), siehe [NOTICE](app/controllers/mixxx/NOTICE.md).
Online gefundene Musik unterliegt der jeweils angezeigten Lizenz ihrer Urheber.
