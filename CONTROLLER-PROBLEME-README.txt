PULSAR DJ - CONTROLLER MIT BEKANNTEN FEHLERMELDUNGEN
=====================================================

Stand: 01.11.2026

Getestet wurden alle 144 MIDI-Controller-Mappings, die Pulsar mitbringt (sie
stammen aus dem Open-Source-Projekt Mixxx). Der automatische Test laedt jedes
Mapping, startet es, schickt simulierte Tasten-, Regler- und Jogwheel-Signale
und beendet es wieder.

Ergebnis:   126 ohne Fehler  |  18 mit Fehlermeldungen  |  0 starten gar nicht

Alle 18 unten genannten Controller starten und funktionieren grundsaetzlich.
Die Fehler betreffen jeweils nur einzelne Tasten oder das Beenden.

WICHTIG: Getestet wurde mit simulierten Signalen, NICHT mit echter Hardware.
Ausnahme ist der Pioneer DDJ-SX: Er hat in Pulsar ein eigenes Mapping, das an
echter Hardware geprueft ist, und steht deshalb nicht in dieser Liste.

Die Fehler fallen in drei Arten:

  [A] Nur beim Beenden. Das Mapping wirft einen Fehler, wenn Pulsar
      geschlossen oder der Controller abgesteckt wird. Waehrend des Auflegens
      merkt man nichts davon. Hoechstens bleiben ein paar LEDs an.

  [B] Funktion fehlt im Mapping. Fuer eine bestimmte Taste ist eine Funktion
      eingetragen, die im Skript des Mappings gar nicht existiert. Diese eine
      Taste macht dann nichts, alles andere geht. Wahrscheinlich ist der Fehler
      in Mixxx genauso vorhanden. Melde ihn am besten dort, damit er fuer alle
      behoben wird: https://github.com/mixxxdj/mixxx/issues

  [C] Wahrscheinlich eine Luecke in Pulsar. Das Mapping nutzt Teile der
      Mixxx-Schnittstelle, die Pulsar noch nicht oder nicht ganz nachbildet.
      Die betroffenen Tasten koennen ausfallen oder sich anders verhalten.
      Melde das bitte bei Pulsar:
      https://github.com/SacredBanana7/pulsar-dj/issues


LISTE NACH HERSTELLER
---------------------

Allen & Heath Xone K1 / K2 / K3                                 [A]
  Fehler beim Beenden ("columns" nicht gefunden).
  Folge: eventuell bleiben LEDs nach dem Schliessen an.

Gemini CDMP-7000 L  und  Gemini CDMP-7000 R                     [B]
  Die Funktion "vinyl_mode" bzw. "vinyl_mode_d2" fehlt im Skript.
  Folge: Die VINYL-Taste reagiert nicht.

Hercules DJ Console 4-Mx                                        [B]
  Die Funktion "onSensitivityChange" fehlt im Skript.
  Folge: Der Regler fuer die Jog-Empfindlichkeit reagiert nicht.

Hercules DJ Control AIR                                         [A]
  Beim Beenden fehlt die Funktion "resetLEDs".
  Folge: LEDs bleiben nach dem Schliessen eventuell an.

Hercules DJControl Inpulse 200                                  [B]
  Die Funktion "scratchPad" fehlt im Skript.
  Folge: Der Scratch-Pad-Modus der Pads reagiert nicht.

Icon P1-Nano                                                    [B/C]
  Record-Taste und Tap-Tempo-Taste finden ihre Funktion nicht.
  Folge: Diese beiden Tasten reagieren nicht.

ION Discover DJ Pro                                             [C]
  Beim Beruehren der Jogwheels tritt ein Fehler auf.
  Folge: Scratchen/Jog-Touch kann ausfallen. Das ist bei diesem Geraet
  der wichtigste Fehler in der Liste.

Numark N4                                                       [B]
  Die Funktion "Mixer.pflVuMeter" fehlt im Skript.
  Folge: Die Pegelanzeige im Vorhoer-Modus funktioniert nicht.

Numark NS4FX                                                    [C]
  Viele Fehler bei den Effekt-Tasten und beim Pad-Modus "Pitch Play"
  (86 Meldungen im Test).
  Folge: Effekt-Tasten und Pitch-Play-Pads koennen ausfallen. Bei diesem
  Geraet sind die meisten Funktionen betroffen.

Numark NS6II                                                    [C]
  Fehler am Crossfader-Zuweisungsschalter ("unreachable").
  Folge: Die Zuweisung der Kanaele zur Crossfader-Seite (A/B/Thru) am
  Geraet wird nicht uebernommen. In Pulsar per Maus zuweisen.

Numark NS7                                                      [C]
  Die Scratch-Taste kann ihre LED nicht setzen.
  Folge: Die LED der Scratch-Taste leuchtet nicht.

Pioneer DDJ-SB                                                  [B]
  Die Funktion "rotarySelectorClick" fehlt im Skript.
  Folge: Das Druecken des Browse-Reglers reagiert nicht. Drehen und LOAD
  funktionieren.

Pioneer DDJ-SB3                                                 [C]
  SHIFT + KEY LOCK ruft "skipSoftTakeover" auf, das fehlt.
  Folge: SHIFT + KEY LOCK (Tempo-Bereich umschalten) reagiert nicht.

Reloop Beatpad                                                  [B + A]
  Die Funktion "InstantFXBtnk" fehlt im Skript (vermutlich Tippfehler),
  dazu ein Fehler beim Beenden.
  Folge: Die Instant-FX-Taste reagiert nicht.

Soundless joyMIDI                                               [B]
  Die Funktion "gsensor" fehlt im Skript.
  Folge: Der Bewegungssensor (Kippen) steuert nichts.

Vestax VCI-100 (Hile Mod)                                       [A]
  Fehler beim Beenden.
  Folge: LEDs bleiben nach dem Schliessen eventuell an.

Vestax VCI-400                                                  [B]
  Die Funktion "beatLoop" fehlt im Skript.
  Folge: Die Beatloop-Tasten reagieren nicht. Loops lassen sich in Pulsar
  per Maus oder ueber die Loop-Tasten setzen.


NICHT UNTERSTUETZT
------------------

HID-Controller, also Geraete, die kein MIDI sprechen, zum Beispiel Native
Instruments Traktor Kontrol S2 MK3 und S4 MK3: Pulsar unterstuetzt bisher nur
MIDI-Controller.


DEIN CONTROLLER MACHT PROBLEME?
-------------------------------

1. In Pulsar auf das Zahnrad (Einstellungen) klicken, dann zu "MIDI".
2. Dort zeigt der MIDI-Monitor, was dein Controller sendet.
3. Ein Issue mit Controller-Name, betroffener Taste und den Zeilen aus dem
   MIDI-Monitor anlegen:
   https://github.com/SacredBanana7/pulsar-dj/issues

Funktioniert eine Taste gar nicht, kannst du sie ueber "MIDI-Learn" (oben in
der Leiste) selbst neu zuweisen.
