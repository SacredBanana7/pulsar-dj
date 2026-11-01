// Small DOM helpers and the custom knob / fader widgets.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'learn') el.dataset.learn = JSON.stringify(v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Update text/class only when it changed (cheap per-frame rendering).
export function setText(el, s) {
  if (el._t !== s) { el._t = s; el.textContent = s; }
}
export function setClass(el, cls, on) {
  const k = '_c_' + cls;
  if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); }
}
export function setStyle(el, prop, v) {
  const k = '_s_' + prop;
  if (el[k] !== v) { el[k] = v; el.style.setProperty(prop, v); }
}

function dragValue(el, getValue, setValue, { sensitivity = 0.005, horizontal = false, def }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (document.body.classList.contains('learning')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    let last = horizontal ? e.clientX : e.clientY;
    const move = (ev) => {
      const p = horizontal ? ev.clientX : ev.clientY;
      const d = horizontal ? p - last : last - p;
      last = p;
      const fine = ev.shiftKey ? 0.2 : 1;
      setValue(Math.max(0, Math.min(1, getValue() + d * sensitivity * fine)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => def != null && setValue(def));
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    setValue(Math.max(0, Math.min(1, getValue() - Math.sign(e.deltaY) * 0.02)));
  }, { passive: false });
}

// Rotary knob, 0..1, drawn as an SVG arc.
export class Knob {
  constructor({ label = '', value = 0.5, def = 0.5, bipolar = true, color = 'var(--accent)', onInput, learn, size = 'm', kill = false }) {
    this.value = value;
    this.def = def;
    this.bipolar = bipolar;
    this.onInput = onInput;
    const R = 15, C = 2 * Math.PI * R, sweep = 0.75;
    this.C = C;
    this.sweep = sweep;
    this.arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const c of [track, this.arc]) {
      c.setAttribute('cx', 20); c.setAttribute('cy', 20); c.setAttribute('r', R);
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', 3.2);
      c.setAttribute('transform', 'rotate(135 20 20)');
      c.setAttribute('stroke-linecap', 'round');
    }
    track.setAttribute('stroke', 'var(--knob-track)');
    track.setAttribute('stroke-dasharray', `${C * sweep} ${C}`);
    this.arc.setAttribute('stroke', color);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.append(track, this.arc);
    this.cap = h('div', { class: 'knob-cap' }, h('div', { class: 'knob-tick' }));
    this.el = h('div', { class: `knob knob-${size}${kill ? ' knob-kill' : ''}`, learn, title: label },
      h('div', { class: 'knob-body' }, svg, this.cap),
      label ? h('div', { class: 'knob-label' }, label) : null);
    dragValue(this.el.firstChild, () => this.value, (v) => { this.set(v); this.onInput?.(v); }, { def });
    this.set(value);
  }

  set(v) {
    if (v === this._v) return;
    this._v = v;
    this.value = v;
    const { C, sweep } = this;
    if (this.bipolar) {
      const from = Math.min(v, 0.5), to = Math.max(v, 0.5);
      this.arc.setAttribute('stroke-dasharray', `0 ${C * sweep * from} ${C * sweep * (to - from) + 0.001} ${C}`);
    } else {
      this.arc.setAttribute('stroke-dasharray', `${C * sweep * v + 0.001} ${C}`);
    }
    this.cap.style.transform = `rotate(${-135 + v * 270}deg)`;
    this.el.classList.toggle('killed', v < 0.02);
  }
}

// Vertical (or horizontal) fader, 0..1.
export class Fader {
  constructor({ value = 0, def = null, onInput, horizontal = false, learn, cls = '' }) {
    this.value = value;
    this.horizontal = horizontal;
    this.onInput = onInput;
    this.thumb = h('div', { class: 'fader-thumb' });
    this.fill = h('div', { class: 'fader-fill' });
    this.el = h('div', { class: `fader ${horizontal ? 'fader-h' : 'fader-v'} ${cls}`, learn },
      h('div', { class: 'fader-slot' }, this.fill), this.thumb);
    const el = this.el;
    // absolute positioning: click jumps, drag follows
    const fromEvent = (e) => {
      const r = el.getBoundingClientRect();
      return horizontal
        ? Math.max(0, Math.min(1, (e.clientX - r.left - 10) / (r.width - 20)))
        : Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 10) / (r.height - 20)));
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || document.body.classList.contains('learning')) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const onThumb = e.target === this.thumb;
      const startV = this.value, startP = horizontal ? e.clientX : e.clientY;
      const r = el.getBoundingClientRect();
      const span = (horizontal ? r.width : r.height) - 20;
      const apply = (ev) => {
        let v;
        if (onThumb) {
          const p = horizontal ? ev.clientX : ev.clientY;
          v = startV + (horizontal ? p - startP : startP - p) / span * (ev.shiftKey ? 0.2 : 1);
        } else v = fromEvent(ev);
        v = Math.max(0, Math.min(1, v));
        this.set(v);
        this.onInput?.(v);
      };
      if (!onThumb) apply(e);
      const up = () => {
        el.removeEventListener('pointermove', apply);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', apply);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => {
      if (def == null) return;
      this.set(def);
      this.onInput?.(def);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = Math.max(0, Math.min(1, this.value - Math.sign(e.deltaY) * 0.02));
      this.set(v);
      this.onInput?.(v);
    }, { passive: false });
    this.set(value);
  }

  set(v) {
    if (v === this._v) return;
    this._v = v;
    this.value = v;
    const pct = `calc(${v} * (100% - 20px))`;
    if (this.horizontal) {
      this.thumb.style.left = pct;
    } else {
      this.thumb.style.bottom = pct;
      this.fill.style.height = `${v * 100}%`;
    }
  }
}
