import { App } from './app.js';
import { UI } from './ui.js';

const app = new App();
const ui = new UI(app, document.getElementById('app'));
window.pulsar = app; // handy for debugging in the console
window.addEventListener('pulsar-db-blocked', () => {
  ui.toast('Pulsar ist noch in einem anderen Fenster oder Tab offen (ältere Version). Bitte dort schließen, dann lädt die Bibliothek.', 'warn');
});

app.library.init().catch((e) => {
  console.error(e);
  ui.toast('Bibliothek konnte nicht geladen werden: ' + e.message, 'error');
});

// MIDI can be enabled before audio starts so the controller status shows right away
app.midi.init();

// Started from Pulsar DJ.exe: tell the launcher the window is still open
if (new URLSearchParams(location.search).has('app')) {
  const ping = () => fetch('/__alive', { cache: 'no-store' }).catch(() => {});
  ping();
  setInterval(ping, 2000);
}
