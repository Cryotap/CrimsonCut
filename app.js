(() => {
'use strict';

/* ───────────────────────── helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (cls, tag = 'div') => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
let uidN = 1;
const uid = () => 'i' + uidN++;

const fmt = (t, dec = 1) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  let s = t - m * 60;
  let str = s.toFixed(dec);
  if (parseFloat(str) >= 60) { return (m + 1) + ':' + (dec ? '00.' + '0'.repeat(dec) : '00'); }
  if (s < 10) str = '0' + str;
  return m + ':' + str;
};

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ───────────────────────── state ───────────────────────── */
const video = $('#video');
const view = $('#view');
const stage = $('#stage');
const defKey = () => ({ on: false, color: '#00ff00', sim: 0.5, smooth: 0.33 });
const S = {
  loaded: false, name: 'video', duration: 0, vw: 0, vh: 0, file: null, url: null,
  segs: [],        // {id,start,end,vol}  (source-time ranges, played in order)
  sounds: [],      // {id,lib,name,time,vol}  (time = output timeline)
  autoMutes: [],   // {id,start,end}  (source time)
  layers: [],      // {id,kind,name,start,dur,srcDur,aspect,cx,cy,size,alpha,vol,behind,key}
  mainKey: Object.assign(defKey(), { bg: '#000000' }),
  playhead: 0, pps: 50,
  shield: { on: false, sens: 55, scanned: false },
  audioBuf: null, peaks: null,
};
const PK = 20;                  // waveform peaks per second
const lib = new Map();          // sound library id -> {name, buffer}
const media = new Map();        // layer id -> {kind, canvas|el, file, url, buf}

const total = () => S.segs.reduce((a, s) => a + (s.end - s.start), 0);
const accOf = (i) => { let a = 0; for (let k = 0; k < i; k++) a += S.segs[k].end - S.segs[k].start; return a; };
function locate(t) {
  let acc = 0;
  for (let i = 0; i < S.segs.length; i++) {
    const d = S.segs[i].end - S.segs[i].start;
    if (t < acc + d || i === S.segs.length - 1) return { i, off: clamp(t - acc, 0, d), acc };
    acc += d;
  }
  return { i: 0, off: 0, acc: 0 };
}
const curSeg = () => S.segs.length ? S.segs[locate(S.playhead).i] : null;

/* ───────────────────────── undo / redo ───────────────────────── */
const hist = { u: [], r: [] };
const snap = () => JSON.stringify({ segs: S.segs, sounds: S.sounds, autoMutes: S.autoMutes, layers: S.layers, mainKey: S.mainKey });
function push() { hist.u.push(snap()); if (hist.u.length > 100) hist.u.shift(); hist.r = []; updUndo(); }
function restore(str) { const o = JSON.parse(str); S.segs = o.segs; S.sounds = o.sounds; S.autoMutes = o.autoMutes; S.layers = o.layers; S.mainKey = o.mainKey; if (selLayerId && !S.layers.find((l) => l.id === selLayerId)) selLayerId = null; }
function undo() { if (!hist.u.length) return; hist.r.push(snap()); restore(hist.u.pop()); afterEdit(); }
function redo() { if (!hist.r.length) return; hist.u.push(snap()); restore(hist.r.pop()); afterEdit(); }
function updUndo() { $('#btnUndo').disabled = !hist.u.length; $('#btnRedo').disabled = !hist.r.length; }
function afterEdit() {
  pause();
  S.playhead = Math.min(S.playhead, total());
  renderAll();
  seekOut(S.playhead);
  updUndo();
}
// one undo step per slider drag / typing session
let editOpen = false;
const beginEdit = () => { if (!editOpen) { push(); editOpen = true; } };
const endEdit = () => { editOpen = false; };

/* ───────────────────────── audio graph ───────────────────────── */
let ac = null, gSeg, gBus, gMaster, gMon, dest;
function ensureAC() {
  if (ac) return ac;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  const src = ac.createMediaElementSource(video);
  gSeg = ac.createGain(); gBus = ac.createGain(); gMaster = ac.createGain(); gMon = ac.createGain();
  dest = ac.createMediaStreamDestination();
  src.connect(gSeg); gSeg.connect(gMaster); gBus.connect(gMaster);
  gMaster.connect(gMon); gMon.connect(ac.destination); gMaster.connect(dest);
  return ac;
}

/* ───────────────────────── compositor / preview ───────────────────────── */
let pv = null;
const hexRgb = (h) => CompUtil.hexToRgb(h);
const keyObj = (k) => ({ rgb: hexRgb(k.color), sim: k.sim * 0.6, smooth: k.smooth * 0.3 });
const bgRGB = () => hexRgb(S.mainKey.bg || '#000000');

function initPreview() {
  if (pv) return;
  try { pv = new Comp(view, true); } catch (e) { toast('This browser has no WebGL, so the preview is limited.'); }
}

// Build the draw list for output-time t. `main` = {src,rot}; getL(layer) -> {src,cached,rot} | null
function layersAt(t, main, getL) {
  const act = S.layers.filter((L) => t >= L.start - 1e-6 && t < L.start + L.dur);
  const mk = (L) => {
    const g = getL(L); if (!g || !g.src) return null;
    return { id: L.id, src: g.src, cached: !!g.cached, rot: g.rot || 0, alpha: L.alpha, key: L.key.on ? keyObj(L.key) : null, place: { cx: L.cx, cy: L.cy, size: L.size, aspect: L.aspect } };
  };
  const out = [];
  act.filter((L) => L.behind).forEach((L) => { const o = mk(L); if (o) out.push(o); });
  if (main && main.src) out.push({ id: 'main', src: main.src, rot: main.rot || 0, alpha: 1, key: S.mainKey.on ? keyObj(S.mainKey) : null, place: null });
  act.filter((L) => !L.behind).forEach((L) => { const o = mk(L); if (o) out.push(o); });
  return out;
}
function previewGet(L) {
  const m = media.get(L.id); if (!m) return null;
  if (m.kind === 'image') return { src: m.canvas, cached: true };
  return m.el.readyState >= 2 ? { src: m.el } : null;
}

let dq = false;
function requestDraw() { if (dq) return; dq = true; requestAnimationFrame(() => { dq = false; drawPreview(); }); }
function drawPreview() {
  if (!pv || !S.loaded) return;
  const main = video.readyState >= 2 ? { src: video } : null;
  pv.draw(layersAt(S.playhead, main, previewGet), bgRGB());
  updSelBox();
}

function sizeView() {
  if (!S.loaded) return;
  const sc = Math.min(1, 1280 / Math.max(S.vw, S.vh));
  view.width = Math.max(2, Math.round(S.vw * sc)); view.height = Math.max(2, Math.round(S.vh * sc));
  fitView();
}
function fitView() {
  if (!S.loaded) return;
  const W = stage.clientWidth, H = stage.clientHeight, ar = S.vw / S.vh;
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  view.style.width = Math.floor(w) + 'px'; view.style.height = Math.floor(h) + 'px';
  updSelBox(); requestDraw();
}
new ResizeObserver(fitView).observe(stage);

/* ───────────────────────── playback engine ───────────────────────── */
let playing = false, idx = 0, timer = null, active = [], onEnd = null, exporting = false, busy = false;

function inAutoMute(t) {
  if (!S.shield.on) return false;
  for (const m of S.autoMutes) if (t >= m.start && t < m.end) return true;
  return false;
}

function stopSounds() { active.forEach((n) => { try { n.stop(); } catch (e) {} }); active = []; }
function scheduleSounds(fromT) {
  stopSounds();
  if (!ac) return;
  for (const s of S.sounds) {
    const item = lib.get(s.lib); if (!item) continue;
    const dur = item.buffer.duration;
    if (s.time + dur <= fromT) continue;
    const n = ac.createBufferSource(); n.buffer = item.buffer;
    const g = ac.createGain(); g.gain.value = s.vol;
    n.connect(g); g.connect(gBus);
    const delay = s.time - fromT;
    if (delay >= 0) n.start(ac.currentTime + delay); else n.start(ac.currentTime, -delay);
    active.push(n);
  }
  for (const L of S.layers) {
    if (L.kind !== 'video' || !(L.vol > 0)) continue;
    const m = media.get(L.id); if (!m || !m.buf) continue;
    const end = L.start + Math.min(L.dur, m.buf.duration);
    if (end <= fromT) continue;
    const n = ac.createBufferSource(); n.buffer = m.buf;
    const g = ac.createGain(); g.gain.value = L.vol;
    n.connect(g); g.connect(gBus);
    const delay = L.start - fromT;
    if (delay >= 0) n.start(ac.currentTime + delay, 0, end - L.start); else n.start(ac.currentTime, -delay, end - fromT);
    active.push(n);
  }
}

// keep overlay <video> elements in step with the timeline
function syncOverlays() {
  const t = S.playhead;
  for (const L of S.layers) {
    if (L.kind !== 'video') continue;
    const m = media.get(L.id); if (!m) continue;
    const v = m.el, local = t - L.start;
    const act = local >= 0 && local < L.dur && local < L.srcDur;
    if (!act) { if (!v.paused) v.pause(); continue; }
    if (playing) {
      if (v.paused) { v.currentTime = local; v.play().catch(() => {}); }
      else if (Math.abs(v.currentTime - local) > 0.3) v.currentTime = local;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - local) > 0.03) v.currentTime = local;
    }
  }
}

function seekOut(t) {
  if (!S.segs.length) return;
  t = clamp(t, 0, total());
  const L = locate(t);
  idx = L.i; S.playhead = t;
  const target = S.segs[L.i].start + L.off;
  if (Math.abs(video.currentTime - target) > 0.001) video.currentTime = target;
  if (playing) scheduleSounds(t);
  syncOverlays(); updHead(); requestDraw();
}

function play() {
  if (!S.loaded || playing || busy) return;
  ensureAC(); ac.resume();
  if (S.playhead >= total() - 0.05) S.playhead = 0;
  const L = locate(S.playhead); idx = L.i;
  const target = S.segs[idx].start + L.off;
  if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
  video.play().catch(() => {});
  playing = true;
  scheduleSounds(S.playhead);
  timer = setInterval(tick, 20);
  syncOverlays();
  updPlayBtn(); frameLoop();
}
function pause() {
  if (!playing) { stopSounds(); return; }
  playing = false; clearInterval(timer);
  video.pause(); stopSounds(); updPlayBtn(); syncOverlays(); requestDraw();
}
function finish() {
  const wasPlaying = playing;
  playing = false; clearInterval(timer);
  video.pause(); stopSounds();
  S.playhead = total(); syncOverlays(); updHead(); updPlayBtn(); requestDraw();
  if (onEnd) { const f = onEnd; onEnd = null; f(); }
  return wasPlaying;
}

function tick() {
  if (!playing) return;
  const seg = S.segs[idx];
  const ct = video.currentTime;
  if (ct >= seg.end - 0.02 || video.ended) {
    if (idx >= S.segs.length - 1) { finish(); return; }
    idx++;
    const nx = S.segs[idx];
    if (Math.abs(ct - nx.start) > 0.08) video.currentTime = nx.start;
    if (video.paused) video.play().catch(() => {});
    scheduleSounds(accOf(idx));
    return;
  }
  S.playhead = accOf(idx) + (ct - seg.start);
  const g = seg.vol * (inAutoMute(ct) ? 0 : 1);
  if (ac) gSeg.gain.setTargetAtTime(g, ac.currentTime, 0.015);
}

function frameLoop() {
  if (!playing) return;
  updHead(); syncOverlays(); drawPreview();
  requestAnimationFrame(frameLoop);
}

function updPlayBtn() {
  $('#playIco').innerHTML = `<use href="#i-${playing ? 'pause' : 'play'}"/>`;
}

/* ───────────────────────── loading a video ───────────────────────── */
async function loadVideo(file) {
  if (!file) return;
  pause();
  const url = URL.createObjectURL(file);
  video.src = url;
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('unsupported'));
    });
    if (!isFinite(video.duration)) {   // some recorded WebM files report Infinity
      video.currentTime = 1e101;
      await new Promise((r) => video.addEventListener('timeupdate', r, { once: true }));
      video.currentTime = 0;
    }
  } catch (e) {
    toast("This video format can't be opened here. Try an MP4 or WebM.");
    return;
  }
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = url; S.file = file;
  S.loaded = true;
  S.name = file.name.replace(/\.[^.]+$/, '') || 'video';
  S.duration = video.duration; S.vw = video.videoWidth; S.vh = video.videoHeight;
  S.segs = [{ id: uid(), start: 0, end: S.duration, vol: 1 }];
  S.autoMutes = []; S.sounds = []; S.layers = []; S.mainKey = Object.assign(defKey(), { bg: '#000000' });
  selLayerId = null; keyTarget = 'main'; S.playhead = 0;
  S.shield.scanned = false; S.audioBuf = null; S.peaks = null;
  hist.u = []; hist.r = [];
  S.pps = clamp(Math.round(300 / Math.max(S.duration, 1)) * 10, 12, 120);
  $('#empty').classList.add('gone');
  $('#btnExport').disabled = false;
  $('#fname').value = S.name + '-edited';
  initPreview(); sizeView();
  renderAll(); updUndo();
  decodeAudio(file);
}

async function decodeAudio(file) {
  try {
    if (file.size > 700 * 1024 * 1024) { toast('Large file: waveform and Shield are turned off to save memory.'); renderShield(); return; }
    ensureAC();
    const ab = await file.arrayBuffer();
    const buf = await ac.decodeAudioData(ab);
    if (S.loaded && S.file === file) {
      S.audioBuf = buf;
      const ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      const per = Math.floor(buf.sampleRate / PK);
      const n = Math.ceil(buf.length / per);
      const pk = new Float32Array(n);
      let mx = 0;
      for (let i = 0; i < n; i++) {
        let m = 0; const b = i * per, e = Math.min(b + per, buf.length);
        for (let k = b; k < e; k += 4) { const v = Math.abs(ch1 ? (ch0[k] + ch1[k]) * 0.5 : ch0[k]); if (v > m) m = v; }
        pk[i] = m; if (m > mx) mx = m;
      }
      if (mx > 0) for (let i = 0; i < n; i++) pk[i] = Math.sqrt(pk[i] / mx);
      S.peaks = pk;
      renderTimeline(); renderShield();
    }
  } catch (e) {
    S.audioBuf = null; S.peaks = null;
    renderShield();
  }
}

/* ───────────────────────── edit operations ───────────────────────── */
function needClip() { if (!S.loaded) { toast('Open a video first'); return false; } return true; }

function doSplit() {
  if (!needClip()) return;
  const L = locate(S.playhead), sg = S.segs[L.i], d = sg.end - sg.start;
  if (L.off < 0.1 || d - L.off < 0.1) { toast('Move the playhead inside a clip to split it'); return; }
  push();
  const cut = sg.start + L.off;
  S.segs.splice(L.i, 1, { id: uid(), start: sg.start, end: cut, vol: sg.vol }, { id: uid(), start: cut, end: sg.end, vol: sg.vol });
  renderAll(); toast('Split');
}
function doCutBefore() {
  if (!needClip()) return;
  const L = locate(S.playhead), sg = S.segs[L.i];
  if (L.off < 0.05) { toast('Move the playhead later in the clip'); return; }
  push();
  sg.start += L.off;
  S.playhead = L.acc;
  renderAll(); seekOut(S.playhead);
}
function doCutAfter() {
  if (!needClip()) return;
  const L = locate(S.playhead), sg = S.segs[L.i], d = sg.end - sg.start;
  if (d - L.off < 0.05) { toast('Move the playhead earlier in the clip'); return; }
  push();
  sg.end = sg.start + L.off;
  renderAll(); seekOut(Math.min(S.playhead, total()));
}
function doDelete() {
  if (!needClip()) return;
  if (S.segs.length < 2) { toast("You can't delete the only clip. Use Reset or open another video."); return; }
  pause();
  const L = locate(S.playhead);
  push();
  S.segs.splice(L.i, 1);
  S.playhead = clamp(accOf(Math.min(L.i, S.segs.length - 1)), 0, total());
  renderAll(); seekOut(S.playhead); toast('Clip deleted');
}
function doReset() {
  if (!needClip()) return;
  push();
  pause();
  S.segs = [{ id: uid(), start: 0, end: S.duration, vol: 1 }];
  S.sounds = []; S.autoMutes = []; S.layers = []; S.mainKey = Object.assign(defKey(), { bg: '#000000' });
  selLayerId = null; S.shield.scanned = false; S.playhead = 0;
  renderAll(); seekOut(0); toast('Edits reset (undo available)');
}

/* ───────────────────────── timeline rendering ───────────────────────── */
const track = $('#track'), tlScroll = $('#tlScroll');
let headEl = null, knobEl = null;

function drawWave(cv, sg) {
  const d = sg.end - sg.start;
  const W = Math.min(Math.max(Math.round(d * S.pps), 1), 4096);
  cv.width = W; cv.height = 44;
  if (!S.peaks) return;
  const g = cv.getContext('2d'); g.fillStyle = '#fff';
  for (let x = 0; x < W; x++) {
    const t = sg.start + (x / W) * d;
    const i0 = Math.floor(t * PK), i1 = Math.max(i0 + 1, Math.floor((t + d / W) * PK));
    let m = 0;
    for (let k = i0; k < i1 && k < S.peaks.length; k++) if (S.peaks[k] > m) m = S.peaks[k];
    const h = Math.max(1.5, m * 40);
    g.fillRect(x, 22 - h / 2, 1, h);
  }
}

function renderTimeline() {
  const tot = total();
  const extent = Math.max(tot, ...S.layers.map((L) => L.start + L.dur), ...S.sounds.map((s) => s.time + 0.5));
  track.style.width = Math.max(extent * S.pps, 1) + 'px';
  track.innerHTML = '';
  if (!S.loaded) return;

  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * S.pps >= 70) || 600;
  for (let t = 0; t <= extent + 1e-6; t += step) {
    const m = el('tick'); m.style.left = t * S.pps + 'px';
    m.textContent = step < 1 ? fmt(t, 1) : fmt(t, 0);
    track.appendChild(m);
  }

  let acc = 0;
  S.segs.forEach((sg) => {
    const d = sg.end - sg.start;
    const e = el('seg'); e.dataset.id = sg.id;
    e.style.left = acc * S.pps + 'px';
    e.style.width = Math.max(d * S.pps - 2, 3) + 'px';
    const cv = document.createElement('canvas'); drawWave(cv, sg); e.appendChild(cv);
    if (S.shield.on) {
      for (const m of S.autoMutes) {
        const a = Math.max(m.start, sg.start), b = Math.min(m.end, sg.end);
        if (b > a) { const o = el('mute'); o.style.left = (a - sg.start) * S.pps + 'px'; o.style.width = (b - a) * S.pps + 'px'; e.appendChild(o); }
      }
    }
    const lab = el('lab'); lab.textContent = Math.round(sg.vol * 100) + '%'; e.appendChild(lab);
    track.appendChild(e);
    acc += d;
  });

  const ll = el('lay-lane');
  S.layers.forEach((L) => {
    const c = el('lay' + (L.id === selLayerId ? ' sel' : '') + (L.behind ? ' behind' : '')); c.dataset.id = L.id;
    c.dataset.ico = L.kind === 'image' ? '▣' : '▶';
    c.style.left = L.start * S.pps + 'px';
    c.style.width = Math.max(L.dur * S.pps, 34) + 'px';
    c.textContent = L.name; ll.appendChild(c);
  });
  track.appendChild(ll);

  const lane = el('sfx-lane');
  S.sounds.forEach((s) => {
    const item = lib.get(s.lib); if (!item) return;
    const c = el('sfx' + (s.id === selSound ? ' sel' : '')); c.dataset.id = s.id;
    c.style.left = s.time * S.pps + 'px';
    c.style.width = Math.max(item.buffer.duration * S.pps, 28) + 'px';
    c.textContent = item.name;
    lane.appendChild(c);
  });
  track.appendChild(lane);

  headEl = el('head'); knobEl = el('knob'); headEl.appendChild(knobEl);
  track.appendChild(headEl);
  updHead(); updSel();
}

let lastSelId = null;
function updSel() {
  const c = curSeg(); const id = c ? c.id : null;
  lastSelId = id;
  $$('.seg', track).forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
  renderVolume();
}

function updHead() {
  $('#tCur').textContent = fmt(S.playhead);
  $('#tTot').textContent = fmt(total());
  if (!headEl) return;
  const x = S.playhead * S.pps;
  headEl.style.left = x + 'px';
  if (playing || exporting) {
    const vw = tlScroll.clientWidth;
    if (x > tlScroll.scrollLeft + vw - 60 || x < tlScroll.scrollLeft) tlScroll.scrollLeft = Math.max(0, x - 60);
  }
  const c = curSeg();
  if (c && c.id !== lastSelId) updSel();
}

/* timeline interactions: tap to seek, drag knob to scrub, drag sound & layer chips */
let tap = null;
track.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.sfx') || e.target.closest('.knob') || e.target.closest('.lay')) return;
  tap = { x: e.clientX, t: Date.now(), sx: tlScroll.scrollLeft };
});
track.addEventListener('pointerup', (e) => {
  if (!tap) return;
  const moved = Math.abs(e.clientX - tap.x) + Math.abs(tlScroll.scrollLeft - tap.sx);
  if (moved < 8 && Date.now() - tap.t < 600) {
    const r = track.getBoundingClientRect();
    pause(); seekOut((e.clientX - r.left) / S.pps);
  }
  tap = null;
});
track.addEventListener('pointercancel', () => { tap = null; });

track.addEventListener('pointerdown', (e) => {
  const knob = e.target.closest('.knob');
  if (knob) {
    e.preventDefault(); knob.setPointerCapture(e.pointerId);
    pause();
    const mv = (ev) => { const r = track.getBoundingClientRect(); seekOut((ev.clientX - r.left) / S.pps); };
    const up = () => { knob.removeEventListener('pointermove', mv); knob.removeEventListener('pointerup', up); knob.removeEventListener('pointercancel', up); };
    knob.addEventListener('pointermove', mv); knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
    return;
  }
  const lay = e.target.closest('.lay');
  if (lay) {
    e.preventDefault(); lay.setPointerCapture(e.pointerId);
    const L = S.layers.find((x) => x.id === lay.dataset.id); if (!L) return;
    selectLayer(L.id);
    const r = lay.getBoundingClientRect();
    const resize = e.clientX > r.right - 16;
    const sx = e.clientX, s0 = L.start, d0 = L.dur; let pushed = false;
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / S.pps;
      if (!pushed && Math.abs(ev.clientX - sx) > 3) { push(); pushed = true; }
      if (resize) { let nd = Math.max(0.2, d0 + dx); if (L.kind === 'video') nd = Math.min(nd, L.srcDur); L.dur = nd; lay.style.width = Math.max(nd * S.pps, 34) + 'px'; }
      else { L.start = clamp(s0 + dx, 0, Math.max(0, total() - 0.2)); lay.style.left = L.start * S.pps + 'px'; }
    };
    const up = () => {
      lay.removeEventListener('pointermove', mv); lay.removeEventListener('pointerup', up); lay.removeEventListener('pointercancel', up);
      renderLayers(); renderTimeline(); syncOverlays(); requestDraw();
    };
    lay.addEventListener('pointermove', mv); lay.addEventListener('pointerup', up); lay.addEventListener('pointercancel', up);
    return;
  }
  const chip = e.target.closest('.sfx');
  if (chip) {
    e.preventDefault(); chip.setPointerCapture(e.pointerId);
    const s = S.sounds.find((x) => x.id === chip.dataset.id); if (!s) return;
    selectSound(s.id);
    const startX = e.clientX, startT = s.time; let pushed = false;
    const mv = (ev) => {
      if (!pushed && Math.abs(ev.clientX - startX) > 3) { push(); pushed = true; }
      s.time = Math.max(0, startT + (ev.clientX - startX) / S.pps);
      chip.style.left = s.time * S.pps + 'px';
    };
    const up = () => { chip.removeEventListener('pointermove', mv); chip.removeEventListener('pointerup', up); chip.removeEventListener('pointercancel', up); renderSounds(); };
    chip.addEventListener('pointermove', mv); chip.addEventListener('pointerup', up); chip.addEventListener('pointercancel', up);
  }
});

function zoom(f) {
  const center = (tlScroll.scrollLeft + tlScroll.clientWidth / 2) / S.pps;
  S.pps = clamp(S.pps * f, 6, 400);
  renderTimeline();
  tlScroll.scrollLeft = center * S.pps - tlScroll.clientWidth / 2;
}

/* ───────────────────────── volume pane ───────────────────────── */
let volDirty = false;
function renderVolume() {
  const sg = curSeg(); if (!sg) return;
  const i = S.segs.indexOf(sg);
  $('#volLabel').textContent = `Clip ${i + 1} of ${S.segs.length} · ${fmt(sg.start)} – ${fmt(sg.end)}`;
  $('#volRange').value = Math.round(sg.vol * 100);
  $('#volPct').textContent = Math.round(sg.vol * 100) + '%';
  $('#volMute').textContent = sg.vol === 0 ? 'Unmute clip' : 'Mute clip';
}
function setVol(v, record = true) {
  const sg = curSeg(); if (!sg) return;
  if (record && !volDirty) { push(); volDirty = true; }
  sg.vol = clamp(v, 0, 2);
  $('#volPct').textContent = Math.round(sg.vol * 100) + '%';
  const e = $(`.seg[data-id="${sg.id}"] .lab`, track); if (e) e.textContent = Math.round(sg.vol * 100) + '%';
  if (ac && !playing) gSeg.gain.value = sg.vol;
}
$('#volRange').addEventListener('input', (e) => setVol(e.target.value / 100));
$('#volRange').addEventListener('change', () => { volDirty = false; renderVolume(); });
$('#volMute').addEventListener('click', () => { if (!needClip()) return; volDirty = false; const sg = curSeg(); push(); sg.vol = sg.vol === 0 ? 1 : 0; renderTimeline(); });
$('#volReset').addEventListener('click', () => { if (!needClip()) return; volDirty = false; push(); curSeg().vol = 1; renderTimeline(); });
$('#volAll').addEventListener('click', () => { if (!needClip()) return; const v = curSeg().vol; push(); S.segs.forEach((s) => (s.vol = v)); renderTimeline(); toast('Volume applied to all clips'); });

/* ───────────────────────── sounds pane ───────────────────────── */
let selSound = null;
function selectSound(id) { selSound = id; $$('.sfx', track).forEach((c) => c.classList.toggle('sel', c.dataset.id === id)); $$('.srow').forEach((r) => r.classList.toggle('sel', r.dataset.id === id)); }

function addSound(name, buffer) {
  if (!needClip()) return;
  const id = uid(); lib.set(id, { name, buffer });
  push();
  const s = { id, lib: id, name, time: clamp(S.playhead, 0, Math.max(total() - 0.1, 0)), vol: 1 };
  S.sounds.push(s); selSound = id;
  renderTimeline(); renderSounds();
  toast(`Added "${name}" at ${fmt(s.time)}`);
}

function synth(kind) {
  const A = ensureAC(), sr = A.sampleRate;
  const make = (dur, fn) => { const b = A.createBuffer(1, Math.floor(sr * dur), sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, i, sr); return b; };
  switch (kind) {
    case 'ding': return make(1.4, (t) => (Math.sin(2 * Math.PI * 880 * t) * 0.6 + Math.sin(2 * Math.PI * 1320 * t) * 0.3) * Math.exp(-t * 3.2));
    case 'pop': { let ph = 0; return make(0.18, (t, i, r) => { const f = 700 * Math.exp(-t * 22) + 120; ph += 2 * Math.PI * f / r; return Math.sin(ph) * Math.exp(-t * 20) * 0.9; }); }
    case 'whoosh': { let lp = 0; return make(1.0, (t) => { const env = Math.sin(Math.PI * Math.min(t / 1.0, 1)) ** 1.5; const k = 0.04 + 0.5 * Math.sin(Math.PI * t); lp += k * ((Math.random() * 2 - 1) - lp); return lp * env * 1.6; }); }
    case 'boom': { let ph = 0; return make(1.4, (t, i, r) => { const f = 90 * Math.exp(-t * 2.2) + 28; ph += 2 * Math.PI * f / r; return (Math.sin(ph) * 0.95 + (Math.random() * 2 - 1) * Math.exp(-t * 18) * 0.4) * Math.exp(-t * 2.4); }); }
    case 'bleep': return make(0.7, (t) => Math.sin(2 * Math.PI * 1000 * t) * 0.5 * (t < 0.02 ? t / 0.02 : t > 0.68 ? (0.7 - t) / 0.02 : 1));
  }
}
$$('[data-synth]').forEach((b) => b.addEventListener('click', () => {
  if (!needClip()) return;
  const kind = b.dataset.synth; addSound(b.textContent, synth(kind));
}));
$('#sfxAdd').addEventListener('click', () => { if (needClip()) $('#fileSound').click(); });
$('#fileSound').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  ensureAC();
  for (const f of files) {
    try { const buf = await ac.decodeAudioData(await f.arrayBuffer()); addSound(f.name.replace(/\.[^.]+$/, ''), buf); }
    catch (err) { toast(`Couldn't read "${f.name}" as audio`); }
  }
});

let previewNode = null;
function previewSound(s) {
  const item = lib.get(s.lib); if (!item) return;
  ensureAC(); ac.resume();
  try { previewNode && previewNode.stop(); } catch (e) {}
  const n = ac.createBufferSource(); n.buffer = item.buffer;
  const g = ac.createGain(); g.gain.value = s.vol; n.connect(g); g.connect(ac.destination);
  n.start(); previewNode = n;
}

function renderSounds() {
  const box = $('#sfxList'); box.innerHTML = '';
  S.sounds.forEach((s) => {
    const r = el('srow' + (s.id === selSound ? ' sel' : '')); r.dataset.id = s.id;
    r.innerHTML = `
      <div class="sname"></div>
      <div class="tm">at <input type="number" min="0" step="0.1" inputmode="decimal"> s</div>
      <div style="display:flex;gap:6px"><button class="mini" data-a="play" title="Preview"><svg><use href="#i-play"/></svg></button><button class="mini" data-a="del" title="Remove"><svg><use href="#i-trash"/></svg></button></div>
      <input type="range" min="0" max="200">`;
    $('.sname', r).textContent = `${s.name} · ${lib.get(s.lib) ? lib.get(s.lib).buffer.duration.toFixed(1) : '?'}s`;
    const num = $('input[type=number]', r); num.value = s.time.toFixed(1);
    num.addEventListener('change', () => { push(); s.time = Math.max(0, parseFloat(num.value) || 0); renderTimeline(); selectSound(s.id); });
    const rg = $('input[type=range]', r); rg.value = Math.round(s.vol * 100);
    let d = false;
    rg.addEventListener('input', () => { if (!d) { push(); d = true; } s.vol = rg.value / 100; });
    rg.addEventListener('change', () => { d = false; });
    $('[data-a=play]', r).addEventListener('click', () => previewSound(s));
    $('[data-a=del]', r).addEventListener('click', () => { push(); S.sounds = S.sounds.filter((x) => x.id !== s.id); renderTimeline(); renderSounds(); });
    r.addEventListener('pointerdown', () => selectSound(s.id));
    box.appendChild(r);
  });
}

/* ───────────────────────── layers: images & videos on top ───────────────────────── */
let selLayerId = null;
const selLayer = () => S.layers.find((l) => l.id === selLayerId) || null;

function newLayer(kind, name, srcDur, aspect) {
  const start = clamp(S.playhead, 0, Math.max(total() - 0.2, 0));
  const room = Math.max(total() - start, 0.5);
  const dur = kind === 'image' ? Math.min(5, room) : Math.min(srcDur, room);
  return { id: uid(), kind, name, start, dur, srcDur: kind === 'video' ? srcDur : 0, aspect, cx: 0.5, cy: 0.5, size: aspect > 1.2 ? 0.28 : 0.4, alpha: 1, vol: 0, behind: false, key: defKey() };
}
function fillSize(L) { return Math.max(1, (S.vh / S.vw) / L.aspect); }

async function addImageFile(file) {
  if (!needClip()) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    if (!img.naturalWidth) throw new Error('empty');
    const sc = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * sc)); cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const L = newLayer('image', file.name.replace(/\.[^.]+$/, '') || 'Image', 0, cv.height / cv.width);
    push(); media.set(L.id, { kind: 'image', canvas: cv });
    S.layers.push(L); selLayerId = L.id; keyTarget = L.id;
    renderAll(); toast(`Added "${L.name}"`);
  } catch (e) { toast(`Couldn't open "${file.name}" as an image`); }
  URL.revokeObjectURL(url);
}

async function addVideoOverlay(file) {
  if (!needClip()) return;
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('bad')); });
    if (!isFinite(v.duration) || !v.videoWidth) throw new Error('bad');
  } catch (e) { toast(`Couldn't open "${file.name}" as a video`); URL.revokeObjectURL(url); return; }
  const L = newLayer('video', file.name.replace(/\.[^.]+$/, '') || 'Video', v.duration, v.videoHeight / v.videoWidth);
  push();
  const m = { kind: 'video', el: v, file, url, buf: null };
  media.set(L.id, m);
  ['seeked', 'loadeddata'].forEach((ev) => v.addEventListener(ev, requestDraw));
  S.layers.push(L); selLayerId = L.id; keyTarget = L.id;
  renderAll(); toast(`Added "${L.name}"`);
  try { ensureAC(); m.buf = await ac.decodeAudioData(await file.arrayBuffer()); renderLayers(); } catch (e) { m.buf = null; }
}

function selectLayer(id) {
  selLayerId = id;
  if (id) keyTarget = id;
  $$('.lay', track).forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  renderLayers(); renderGreen(); updSelBox(); requestDraw();
}

function renderLayers() {
  const box = $('#layList'); if (!box) return;
  box.innerHTML = '';
  $('#layHint').hidden = S.layers.length > 0 && false;
  S.layers.forEach((L) => {
    const m = media.get(L.id);
    const r = el('lrow' + (L.id === selLayerId ? ' sel' : '')); r.dataset.id = L.id;
    r.innerHTML = `
      <div class="lh"><b class="lname"></b><button class="chip-btn" data-a="fill" style="height:30px">Fill</button><button class="mini" data-a="del" title="Remove"><svg><use href="#i-trash"/></svg></button></div>
      <div class="lt">Start <input type="number" data-f="start" min="0" step="0.1" inputmode="decimal"> s Length <input type="number" data-f="dur" min="0.2" step="0.1" inputmode="decimal"> s <button class="chip-btn" data-a="end" style="height:30px">To end</button></div>
      <div class="ls"><span>Size</span><input type="range" data-f="size" min="5" max="300"></div>
      <div class="ls"><span>Opacity</span><input type="range" data-f="alpha" min="0" max="100"></div>
      ${L.kind === 'video' ? `<div class="ls"><span>${m && m.buf === null ? 'No audio' : 'Volume'}</span><input type="range" data-f="vol" min="0" max="200" ${m && m.buf === null ? 'disabled' : ''}></div>` : ''}
      <label class="lc"><input type="checkbox" data-f="behind"> Behind main video</label>`;
    $('.lname', r).textContent = (L.kind === 'image' ? '▣ ' : '▶ ') + L.name;
    const set = (f, v) => { const i = $(`[data-f=${f}]`, r); if (i) i.type === 'checkbox' ? (i.checked = !!v) : (i.value = v); };
    set('start', L.start.toFixed(1)); set('dur', L.dur.toFixed(1)); set('size', Math.round(L.size * 100)); set('alpha', Math.round(L.alpha * 100)); set('vol', Math.round(L.vol * 100)); set('behind', L.behind);
    r.addEventListener('pointerdown', () => { if (selLayerId !== L.id) { selLayerId = L.id; keyTarget = L.id; $$('.lrow').forEach((x) => x.classList.toggle('sel', x === r)); $$('.lay', track).forEach((c) => c.classList.toggle('sel', c.dataset.id === L.id)); renderGreen(); updSelBox(); } });
    const refresh = () => { renderTimeline(); syncOverlays(); requestDraw(); };
    $$('input[type=number]', r).forEach((i) => {
      i.addEventListener('change', () => {
        push();
        let v = parseFloat(i.value) || 0;
        if (i.dataset.f === 'start') L.start = clamp(v, 0, Math.max(total() - 0.2, 0));
        else { v = Math.max(0.2, v); if (L.kind === 'video') v = Math.min(v, L.srcDur); L.dur = v; }
        renderLayers(); refresh();
      });
    });
    $$('input[type=range]', r).forEach((i) => {
      i.addEventListener('input', () => {
        beginEdit(); const v = +i.value;
        if (i.dataset.f === 'size') L.size = v / 100; else if (i.dataset.f === 'alpha') L.alpha = v / 100; else if (i.dataset.f === 'vol') L.vol = v / 100;
        requestDraw(); updSelBox();
      });
      i.addEventListener('change', endEdit);
    });
    $('[data-f=behind]', r).addEventListener('change', (e) => { push(); L.behind = e.target.checked; refresh(); });
    $('[data-a=fill]', r).addEventListener('click', () => { push(); L.cx = 0.5; L.cy = 0.5; L.size = fillSize(L); renderLayers(); requestDraw(); updSelBox(); });
    $('[data-a=end]', r).addEventListener('click', () => { push(); let d = Math.max(0.2, total() - L.start); if (L.kind === 'video') d = Math.min(d, L.srcDur); L.dur = d; renderLayers(); refresh(); });
    $('[data-a=del]', r).addEventListener('click', () => { push(); S.layers = S.layers.filter((x) => x.id !== L.id); if (selLayerId === L.id) selLayerId = null; if (keyTarget === L.id) keyTarget = 'main'; const mm = media.get(L.id); if (mm && mm.el) mm.el.pause(); renderAll(); });
    box.appendChild(r);
  });
}

// on-canvas select / drag / pinch
const rectOf = (L) => { const hw = L.size / 2, hh = (L.size * L.aspect * (S.vw / S.vh)) / 2; return { x0: L.cx - hw, x1: L.cx + hw, y0: L.cy - hh, y1: L.cy + hh }; };
const activeLayers = () => S.layers.filter((L) => S.playhead >= L.start - 1e-6 && S.playhead < L.start + L.dur);
function hitLayer(pt) {
  const list = activeLayers().slice().reverse().sort((a, b) => (a.behind ? 1 : 0) - (b.behind ? 1 : 0));
  const s = selLayer();
  const inside = (L) => { const r = rectOf(L); return pt.x >= r.x0 && pt.x <= r.x1 && pt.y >= r.y0 && pt.y <= r.y1; };
  if (s && list.includes(s) && inside(s)) return s;
  return list.find(inside) || null;
}
function updSelBox() {
  const box = $('#selBox'); const L = selLayer();
  if (!L || !S.loaded || !activeLayers().includes(L)) { box.hidden = true; return; }
  const vr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const w = L.size * vr.width, h = L.size * vr.width * L.aspect;
  box.style.left = vr.left - sr.left + L.cx * vr.width - w / 2 + 'px';
  box.style.top = vr.top - sr.top + L.cy * vr.height - h / 2 + 'px';
  box.style.width = w + 'px'; box.style.height = h + 'px';
  box.hidden = false;
}
const ptrs = new Map(); let drag = null, pinch = null, picking = false;
const viewPt = (e) => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
view.addEventListener('pointerdown', (e) => {
  if (!S.loaded) return;
  if (picking) { pickColor(e); return; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  view.setPointerCapture(e.pointerId);
  if (ptrs.size === 1) {
    const hit = hitLayer(viewPt(e));
    if (hit) { if (hit.id !== selLayerId) selectLayer(hit.id); drag = { L: hit, sx: e.clientX, sy: e.clientY, cx: hit.cx, cy: hit.cy, pushed: false }; }
    else { drag = null; if (selLayerId) selectLayer(null); }
  } else if (ptrs.size === 2 && selLayer()) {
    const [a, b] = [...ptrs.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, size0: selLayer().size, pushed: false }; drag = null;
  }
});
view.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()]; const L = selLayer(); if (!L) return;
    if (!pinch.pushed) { push(); pinch.pushed = true; }
    L.size = clamp(pinch.size0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0), 0.03, 4);
    requestDraw(); updSelBox();
  } else if (drag && ptrs.size === 1) {
    const r = view.getBoundingClientRect(), L = drag.L;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.pushed && Math.abs(dx) + Math.abs(dy) > 4) { push(); drag.pushed = true; }
    if (drag.pushed) { L.cx = drag.cx + dx / r.width; L.cy = drag.cy + dy / r.height; requestDraw(); updSelBox(); }
  }
});
const endPtr = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) { if (pinch && pinch.pushed) renderLayers(); pinch = null; } if (ptrs.size === 0) { if (drag && drag.pushed) renderLayers(); drag = null; } };
view.addEventListener('pointerup', endPtr); view.addEventListener('pointercancel', endPtr);

$('#layAddImg').addEventListener('click', () => { if (needClip()) $('#fileImg').click(); });
$('#layAddVid').addEventListener('click', () => { if (needClip()) $('#fileOvl').click(); });
$('#fileImg').addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; for (const x of f) await addImageFile(x); });
$('#fileOvl').addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; for (const x of f) await addVideoOverlay(x); });

/* ───────────────────────── green screen ───────────────────────── */
let keyTarget = 'main';
const keyOf = () => (keyTarget === 'main' ? S.mainKey : (S.layers.find((l) => l.id === keyTarget) || {}).key) || null;
function renderGreen() {
  if (keyTarget !== 'main' && !S.layers.find((l) => l.id === keyTarget)) keyTarget = 'main';
  const box = $('#keyTargets'); box.innerHTML = '';
  const chip = (id, label) => { const b = el('chip-btn' + (id === keyTarget ? ' on' : ''), 'button'); b.textContent = label; b.addEventListener('click', () => { keyTarget = id; if (id !== 'main') { selLayerId = id; $$('.lay', track).forEach((c) => c.classList.toggle('sel', c.dataset.id === id)); renderLayers(); updSelBox(); } renderGreen(); }); box.appendChild(b); };
  chip('main', 'Main video'); S.layers.forEach((L) => chip(L.id, L.name));
  const k = keyOf(); if (!k) return;
  $('#keyOn').checked = k.on;
  $('#keyColor').value = k.color;
  $('#keySim').value = Math.round(k.sim * 100); $('#keySimPct').textContent = Math.round(k.sim * 100);
  $('#keySm').value = Math.round(k.smooth * 100); $('#keySmPct').textContent = Math.round(k.smooth * 100);
  $('#keyBgRow').hidden = keyTarget !== 'main';
  if (keyTarget === 'main') $('#keyBg').value = S.mainKey.bg;
  $('#keySub').textContent = keyTarget === 'main' ? 'Replaces the colour with the background below.' : 'Put this clip over the main video with the colour removed.';
}
function keyEdit(fn) { if (!S.loaded) { toast('Open a video first'); return; } const k = keyOf(); if (!k) return; beginEdit(); fn(k); requestDraw(); }
$('#keyOn').addEventListener('change', (e) => { if (!S.loaded) { e.target.checked = false; toast('Open a video first'); return; } const k = keyOf(); push(); k.on = e.target.checked; renderTimeline(); requestDraw(); });
$('#keyColor').addEventListener('input', (e) => keyEdit((k) => { k.color = e.target.value; k.on = true; $('#keyOn').checked = true; }));
$('#keyColor').addEventListener('change', endEdit);
$('#keyBg').addEventListener('input', (e) => keyEdit(() => { S.mainKey.bg = e.target.value; }));
$('#keyBg').addEventListener('change', endEdit);
$('#keySim').addEventListener('input', (e) => keyEdit((k) => { k.sim = e.target.value / 100; $('#keySimPct').textContent = e.target.value; }));
$('#keySm').addEventListener('input', (e) => keyEdit((k) => { k.smooth = e.target.value / 100; $('#keySmPct').textContent = e.target.value; }));
$('#keySim').addEventListener('change', endEdit); $('#keySm').addEventListener('change', endEdit);

function setPicking(on) { picking = on; stage.classList.toggle('picking', on); $('#pickHint').hidden = !on; }
$('#keyPick').addEventListener('click', () => { if (!needClip()) return; pause(); setPicking(!picking); });
function pickColor(e) {
  if (!pv) { setPicking(false); return; }
  const r = view.getBoundingClientRect();
  const x = clamp(Math.floor(((e.clientX - r.left) / r.width) * view.width), 0, view.width - 1);
  const y = clamp(Math.floor(((e.clientY - r.top) / r.height) * view.height), 0, view.height - 1);
  const main = video.readyState >= 2 ? { src: video } : null;
  pv.draw(layersAt(S.playhead, main, previewGet).map((l) => Object.assign({}, l, { key: null })), bgRGB());
  const px = pv.pixel(x, y);
  const k = keyOf(); setPicking(false);
  if (!k) return;
  push(); k.color = CompUtil.rgbToHex(px[0], px[1], px[2]); k.on = true;
  renderGreen(); renderTimeline(); requestDraw();
  toast('Colour picked. Adjust Strength if edges look rough.');
}

/* ───────────────────────── copyright shield ───────────────────────── */
function renderShield() {
  $('#shieldOn').checked = S.shield.on;
  $('#sensRange').value = S.shield.sens; $('#sensPct').textContent = S.shield.sens;
  const st = $('#scanStatus');
  if (!S.loaded) st.textContent = 'Open a video first';
  else if (!S.audioBuf) st.textContent = 'Audio not available for this file';
  else if (!S.shield.scanned) st.textContent = 'Not scanned yet';
  else st.textContent = S.autoMutes.length ? `${S.autoMutes.length} section${S.autoMutes.length > 1 ? 's' : ''} flagged` : 'Nothing flagged';
  const fl = $('#flagList'); fl.innerHTML = '';
  S.autoMutes.forEach((m) => {
    const f = el('flag'); f.innerHTML = `<span>${fmt(m.start)} – ${fmt(m.end)}</span><button title="Keep this section's audio">✕</button>`;
    $('button', f).addEventListener('click', () => { push(); S.autoMutes = S.autoMutes.filter((x) => x.id !== m.id); renderTimeline(); renderShield(); });
    fl.appendChild(f);
  });
}

async function scanAudio() {
  if (!needClip()) return;
  if (!S.audioBuf) { toast('No decodable audio in this file'); return; }
  const st = $('#scanStatus'), btn = $('#btnScan'); btn.disabled = true;
  const buf = S.audioBuf, sr = buf.sampleRate;
  const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const hop = Math.floor(sr * 0.02), nF = Math.floor(buf.length / hop);
  const env = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let s = 0; const b = f * hop;
    for (let i = 0; i < hop; i += 2) { const v = c1 ? (c0[b + i] + c1[b + i]) * 0.5 : c0[b + i]; s += v * v; }
    env[f] = 10 * Math.log10(s / (hop / 2) + 1e-12);
    if (f % 3000 === 0) { st.textContent = `Scanning… ${Math.round(f / nF * 100)}%`; await sleep(0); }
  }
  // Speech has pauses and a wide loudness range; dense music stays steadier and loud.
  const W = 150, nSec = Math.max(1, Math.floor(nF / 50));
  const thr = 0.85 - 0.5 * (S.shield.sens / 100);
  const wflag = new Array(nSec).fill(false);
  for (let s = 0; s < nSec; s++) {
    const a = Math.max(0, Math.min(s * 50 - 50, nF - W)), b = Math.min(nF, a + W);
    if (b - a < 40) continue;
    const arr = Array.from(env.subarray(a, b)).sort((x, y) => x - y);
    const p10 = arr[Math.floor(arr.length * 0.1)], p90 = arr[Math.floor(arr.length * 0.9)];
    const loud = p90 > -38;
    const score = loud ? clamp((26 - (p90 - p10)) / 16, 0, 1) : 0;
    wflag[s] = score >= thr;
  }
  // close 1-second gaps, then keep runs of 3+ seconds
  for (let s = 1; s < nSec - 1; s++) if (!wflag[s] && wflag[s - 1] && wflag[s + 1]) wflag[s] = true;
  const ranges = []; let start = -1;
  for (let s = 0; s <= nSec; s++) {
    if (s < nSec && wflag[s]) { if (start < 0) start = s; }
    else if (start >= 0) { if (s - start >= 3) ranges.push({ id: uid(), start: Math.max(0, start - 0.1), end: Math.min(S.duration, s + 0.1) }); start = -1; }
  }
  push();
  S.autoMutes = ranges; S.shield.scanned = true;
  btn.disabled = false;
  renderTimeline(); renderShield();
  toast(ranges.length ? `Flagged ${ranges.length} music-like section${ranges.length > 1 ? 's' : ''}` : 'No music-like sections found');
}

$('#shieldOn').addEventListener('change', async (e) => {
  if (!S.loaded) { e.target.checked = false; toast('Open a video first'); return; }
  S.shield.on = e.target.checked;
  if (S.shield.on && !S.shield.scanned && S.audioBuf) await scanAudio();
  else if (S.shield.on && !S.audioBuf) toast('Audio can’t be analysed for this file');
  renderTimeline(); renderShield();
});
$('#sensRange').addEventListener('input', (e) => { S.shield.sens = +e.target.value; $('#sensPct').textContent = e.target.value; });
$('#sensRange').addEventListener('change', () => { if (S.shield.on || S.shield.scanned) scanAudio(); });
$('#btnScan').addEventListener('click', scanAudio);

/* ───────────────────────── export ───────────────────────── */
const hasAudioOut = () => !!S.audioBuf || S.sounds.length > 0 || S.layers.some((L) => L.kind === 'video' && L.vol > 0 && media.get(L.id) && media.get(L.id).buf);

// slower "record while playing" formats, used only when the phone lacks WebCodecs
const RT = [
  { id: 'rt-mp4', label: 'MP4 · compatibility mode', mime: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'], ext: 'mp4' },
  { id: 'rt-webm', label: 'WebM · compatibility mode', mime: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'], ext: 'webm' },
];
let FORMATS = [];

async function pickAvc(w, h, fps) {
  const c = []; const px = w * h;
  if (px > 2.2e6) c.push('avc1.640033', 'avc1.64002A'); else if (fps > 30) c.push('avc1.64002A', 'avc1.640028'); else c.push('avc1.640028', 'avc1.64002A');
  c.push('avc1.4D0028', 'avc1.42E028');
  for (const codec of c) {
    try { const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 5e6, framerate: fps, avc: { format: 'avc' } }); if (r.supported) return codec; } catch (e) {}
  }
  return null;
}
async function vOK(codec, w, h) { try { return !!(await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 4e6, framerate: 30 })).supported; } catch (e) { return false; } }
async function aOK(codec) { try { return !!(await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported; } catch (e) { return false; } }

async function detectFormats() {
  const out = []; const hasA = hasAudioOut();
  const W = even(S.vw), H = even(S.vh);
  const wc = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  const ae = typeof AudioEncoder !== 'undefined';
  if (wc) {
    const aac = ae && (await aOK('mp4a.40.2')), opus = ae && (await aOK('opus'));
    const avc = await pickAvc(W, H, 30);
    const vp9 = await vOK('vp09.00.40.08', W, H), vp8 = await vOK('vp8', W, H);
    if (avc && (aac || !hasA)) out.push({ id: 'mp4', mode: 'fast', label: 'MP4 · H.264' + (hasA ? ' + AAC' : '') + ' (fastest)', container: 'mp4', vcodec: 'avc', acodec: hasA ? 'aac' : null, ext: 'mp4' });
    if (avc && (aac || opus || !hasA)) out.push({ id: 'mkv', mode: 'fast', label: 'MKV · H.264' + (hasA ? (aac ? ' + AAC' : ' + Opus') : ''), container: 'mkv', vcodec: 'avc', acodec: hasA ? (aac ? 'aac' : 'opus') : null, ext: 'mkv' });
    if (vp9 && (opus || !hasA)) out.push({ id: 'webm9', mode: 'fast', label: 'WebM · VP9' + (hasA ? ' + Opus' : ''), container: 'webm', vcodec: 'vp9', vstr: 'vp09.00.40.08', acodec: hasA ? 'opus' : null, ext: 'webm' });
    if (vp8 && (opus || !hasA)) out.push({ id: 'webm8', mode: 'fast', label: 'WebM · VP8' + (hasA ? ' + Opus' : ''), container: 'webm', vcodec: 'vp8', vstr: 'vp8', acodec: hasA ? 'opus' : null, ext: 'webm' });
    if (hasA && aac) out.push({ id: 'm4a', mode: 'fast', label: 'Audio only · M4A (AAC)', container: 'm4a', acodec: 'aac', ext: 'm4a' });
    if (hasA && opus) out.push({ id: 'weba', mode: 'fast', label: 'Audio only · WebM (Opus)', container: 'weba', acodec: 'opus', ext: 'webm' });
  }
  if (!out.some((f) => f.vcodec) && typeof MediaRecorder !== 'undefined') {
    RT.forEach((c) => { const m = c.mime.find((x) => MediaRecorder.isTypeSupported(x)); if (m) out.push({ id: c.id, mode: 'rt', label: c.label, mimeUse: m, ext: c.ext, container: c.ext, vcodec: 'rt' }); });
  }
  if (hasA) out.push({ id: 'wav', mode: 'wav', label: 'Audio only · WAV (lossless)', container: 'wav', ext: 'wav' });
  return out;
}

const modal = $('#exportModal');
let resultBlob = null, resultName = '', exportCancel = null, wakeLock = null;

async function openExport() {
  if (!needClip()) return;
  pause();
  FORMATS = await detectFormats();
  const sel = $('#fmt'); sel.innerHTML = '';
  FORMATS.forEach((f, i) => { const o = document.createElement('option'); o.value = i; o.textContent = f.label; sel.appendChild(o); });
  if (!FORMATS.length) { toast("This browser can't export video. Try Chrome on Android."); return; }
  $('#expForm').hidden = false; $('#expProgress').hidden = true; $('#expDone').hidden = true;
  modal.hidden = false; updExpNote();
}
function updExpNote() {
  const f = FORMATS[+$('#fmt').value]; if (!f) return;
  $('#videoOpts').hidden = !f.vcodec;
  $('#expNote').textContent = f.mode === 'wav' ? 'Renders in a few seconds.'
    : f.mode === 'fast' ? 'Renders faster than real time using your phone’s video hardware.'
    : `Compatibility mode renders in real time, about ${fmt(total(), 0)} for this edit. Keep the screen on.`;
}
$('#fmt').addEventListener('change', updExpNote);
$('#expX').addEventListener('click', () => { if (busy) return; modal.hidden = true; });
$('#expAgain').addEventListener('click', () => { modal.hidden = true; });
$('#btnExport').addEventListener('click', openExport);

async function lockScreen() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
function unlockScreen() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

/* offline audio mix: main clips (volume + auto-silence), sounds, overlay-video audio */
async function renderMix() {
  const sr = 48000, tot = total();
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(tot * sr)), sr);
  if (S.audioBuf) {
    let acc = 0;
    for (const sg of S.segs) {
      const d = sg.end - sg.start;
      const n = oc.createBufferSource(); n.buffer = S.audioBuf;
      const g = oc.createGain(); g.gain.setValueAtTime(sg.vol, 0);
      if (S.shield.on) for (const m of S.autoMutes) {
        const a = Math.max(m.start, sg.start), b = Math.min(m.end, sg.end);
        if (b > a) { g.gain.setValueAtTime(0, acc + (a - sg.start)); g.gain.setValueAtTime(sg.vol, acc + (b - sg.start)); }
      }
      n.connect(g); g.connect(oc.destination); n.start(acc, sg.start, d);
      acc += d;
    }
  }
  for (const s of S.sounds) {
    const it = lib.get(s.lib); if (!it) continue;
    const n = oc.createBufferSource(); n.buffer = it.buffer;
    const g = oc.createGain(); g.gain.value = s.vol; n.connect(g); g.connect(oc.destination);
    n.start(s.time);
  }
  for (const L of S.layers) {
    const m = media.get(L.id); if (L.kind !== 'video' || !(L.vol > 0) || !m || !m.buf) continue;
    const n = oc.createBufferSource(); n.buffer = m.buf;
    const g = oc.createGain(); g.gain.value = L.vol; n.connect(g); g.connect(oc.destination);
    n.start(L.start, 0, Math.min(L.dur, m.buf.duration));
  }
  return oc.startRendering();
}

function encodeWav(ab) {
  const nCh = ab.numberOfChannels, len = ab.length, sr = ab.sampleRate;
  const out = new ArrayBuffer(44 + len * nCh * 2), dv = new DataView(out);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + len * nCh * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true); dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
  const chs = []; for (let c = 0; c < nCh; c++) chs.push(ab.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) { const v = clamp(chs[c][i], -1, 1); dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}

async function openSource(file, url) {
  const isMp4 = /mp4|quicktime|m4v|3gpp/i.test(file.type) || /\.(mp4|m4v|mov|3gp)$/i.test(file.name || '');
  if (isMp4) {
    const info = await MediaX.parseMp4(file);
    if (info && (await MediaX.DecSource.supported(info))) return { src: new MediaX.DecSource(file, info), info };
  }
  return { src: new MediaX.ElSource(url), info: null };
}

async function encodeAudioTrack(buf, codec, mux, cfg, ctl, setProg) {
  let err = null;
  const ae = new AudioEncoder({
    output: (c, m) => {
      mux.addAudio(c);
      if (m && m.decoderConfig && m.decoderConfig.description) { cfg.desc = MediaX.toU8(m.decoderConfig.description); cfg.priv = cfg.desc; }
    },
    error: (e) => { err = e; },
  });
  ae.configure({ codec: codec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
  const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  const chunk = 4800;
  for (let p = 0; p < buf.length; p += chunk) {
    if (ctl.cancel) { ae.close(); throw new Error('cancel'); }
    if (err) throw err;
    const n = Math.min(chunk, buf.length - p);
    const data = new Float32Array(n * 2); data.set(l.subarray(p, p + n), 0); data.set(r.subarray(p, p + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((p / 48000) * 1e6), data });
    ae.encode(ad); ad.close();
    while (ae.encodeQueueSize > 20) await sleep(2);
  }
  await ae.flush(); ae.close();
  if (err) throw err;
  if (!cfg.desc) {
    if (codec === 'aac') cfg.desc = new Uint8Array([0x11, 0x90]);
    else { const h = new Uint8Array(19); h.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 128, 187, 0, 0, 0, 0, 0]); cfg.desc = h; }
    cfg.priv = cfg.desc;
  }
}

const setStatus = (t) => { $('#expStatus').textContent = t; };

async function exportFast(f, o, setProg, ctl) {
  const T = total();
  const isVideo = !!f.vcodec;
  let mix = null;
  const acfg = { sr: 48000, ch: 2, desc: null, priv: null, codec: f.acodec === 'aac' ? 'A_AAC' : 'A_OPUS' };
  const vcfg = { w: 0, h: 0, desc: null, priv: null, codec: f.vcodec === 'avc' ? 'V_MPEG4/ISO/AVC' : f.vcodec === 'vp9' ? 'V_VP9' : 'V_VP8' };
  if (f.acodec) { setStatus('Mixing audio…'); mix = await renderMix(); setProg(0.04); }
  const mk = (v) => f.container === 'mp4' || f.container === 'm4a'
    ? new MediaX.Mp4Mux({ video: v, audio: mix ? acfg : null })
    : new MediaX.WebmMux({ video: v, audio: mix ? acfg : null, doctype: f.container === 'webm' || f.container === 'weba' ? 'webm' : 'matroska' });

  if (!isVideo) {
    const mux = mk(null);
    setStatus('Encoding audio…');
    await encodeAudioTrack(mix, f.acodec, mux, acfg, ctl, setProg);
    return mux.finish();
  }

  const main = await openSource(S.file, S.url);
  const ovSrc = new Map();
  try {
    let W = S.vw, H = S.vh; const short = Math.min(W, H);
    if (o.maxS && short > o.maxS) { const sc = o.maxS / short; W *= sc; H *= sc; }
    W = even(W); H = even(H);
    const fps = main.info ? clamp(Math.round(main.info.fps), 24, 60) : 30;
    const vstr = f.vcodec === 'avc' ? await pickAvc(W, H, fps) : f.vstr;
    if (!vstr) throw new Error('codec');
    vcfg.w = W; vcfg.h = H;
    const mux = mk(vcfg);
    let venc = null;
    const ve = new VideoEncoder({
      output: (c, m) => { mux.addVideo(c); if (m && m.decoderConfig && m.decoderConfig.description && !vcfg.desc) { vcfg.desc = MediaX.toU8(m.decoderConfig.description); vcfg.priv = vcfg.desc; } },
      error: (e) => { venc = e; },
    });
    const bitrate = Math.round(W * H * fps * 0.14 * o.q);
    ve.configure(Object.assign({ codec: vstr, width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' }, f.vcodec === 'avc' ? { avc: { format: 'avc' } } : {}));

    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas');
    const ex = new Comp(canvas, false); ex.size(W, H);
    const bg = bgRGB();
    const nF = Math.max(1, Math.round(T * fps)), dtUs = 1e6 / fps;
    setStatus('Rendering video…');
    for (let k = 0; k < nF; k++) {
      if (ctl.cancel) { try { ve.close(); } catch (e) {} throw new Error('cancel'); }
      if (venc) throw venc;
      const t = Math.min(k / fps, T - 1e-4);
      const L = locate(t), srcT = S.segs[L.i].start + L.off;
      const mf = await main.src.frameAt(srcT);
      const got = new Map();
      for (const ly of S.layers) {
        if (ly.kind !== 'video' || t < ly.start - 1e-6 || t >= ly.start + ly.dur) continue;
        let s = ovSrc.get(ly.id);
        if (!s) { const mm = media.get(ly.id); s = await openSource(mm.file, mm.url); ovSrc.set(ly.id, s); }
        got.set(ly.id, await s.src.frameAt(clamp(t - ly.start, 0, Math.max(0, ly.srcDur - 0.001))));
      }
      ex.draw(layersAt(t, mf, (ly) => { const m = media.get(ly.id); if (!m) return null; return m.kind === 'image' ? { src: m.canvas, cached: true } : got.get(ly.id) || null; }), bg);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(k * dtUs), duration: Math.round(dtUs) });
      ve.encode(vf, { keyFrame: k % (fps * 2) === 0 }); vf.close();
      if (ve.encodeQueueSize > 6) await new Promise((res) => { ve.ondequeue = () => { if (ve.encodeQueueSize <= 3) { ve.ondequeue = null; res(); } }; });
      if (k % 4 === 0) setProg(0.05 + 0.9 * (k / nF));
    }
    await ve.flush(); ve.close();
    if (venc) throw venc;
    if (mix) { setStatus('Encoding audio…'); await encodeAudioTrack(mix, f.acodec, mux, acfg, ctl, setProg); }
    setProg(1);
    return mux.finish();
  } finally {
    main.src.dispose(); ovSrc.forEach((s) => s.src.dispose());
  }
}

// compatibility fallback: record the live compositor while the clip plays
async function recordRealtime(f, o, setProg, ctl) {
  ensureAC(); await ac.resume();
  const tracks = [...dest.stream.getAudioTracks()];
  let W = S.vw, H = S.vh; const short = Math.min(W, H);
  if (o.maxS && short > o.maxS) { const sc = o.maxS / short; W *= sc; H *= sc; }
  W = even(W); H = even(H);
  const cv = document.createElement('canvas'); const rc = new Comp(cv, false); rc.size(W, H);
  tracks.unshift(...cv.captureStream(30).getVideoTracks());
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: f.mimeUse, videoBitsPerSecond: Math.round(W * H * 30 * 0.1 * o.q), audioBitsPerSecond: 128000 });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => (rec.onstop = res));
  pause(); gMon.gain.value = 0;
  seekOut(0); await sleep(250);
  rc.draw(layersAt(0, { src: video }, previewGet), bgRGB());
  rec.start(250);
  exporting = true;
  const draw = () => {
    if (!exporting) return;
    rc.draw(layersAt(S.playhead, video.readyState >= 2 ? { src: video } : null, previewGet), bgRGB());
    setProg(clamp(S.playhead / Math.max(total(), 0.01), 0, 1));
    requestAnimationFrame(draw);
  };
  draw();
  exportCancel = () => { ctl.cancel = true; finish(); };
  busy = false;   // play() is blocked while busy; the recorder needs real playback
  await new Promise((res) => { onEnd = res; play(); });
  busy = true;
  await sleep(350);
  exporting = false;
  rec.stop(); await stopped;
  gMon.gain.value = 1; exportCancel = null;
  return ctl.cancel ? null : new Blob(chunks, { type: f.mimeUse.split(';')[0] });
}

$('#expStart').addEventListener('click', async () => {
  const f = FORMATS[+$('#fmt').value]; if (!f) return;
  const base = ($('#fname').value || 'crimsoncut-export').replace(/[\\/:*?"<>|]+/g, '_');
  $('#expForm').hidden = true; $('#expProgress').hidden = false; $('#expDone').hidden = true;
  const fill = $('#barFill'); fill.style.width = '0%';
  const setProg = (p) => { const n = Math.round(clamp(p, 0, 1) * 100); fill.style.width = n + '%'; if (f.mode === 'rt') setStatus(`Rendering… ${n}% · keep this screen open`); else $('#expPct').textContent = n + '%'; };
  $('#expPct').textContent = '0%';
  $('#expCancel').hidden = f.mode === 'wav';
  const ctl = { cancel: false };
  exportCancel = () => { ctl.cancel = true; };
  busy = true; pause();
  await lockScreen();
  const t0 = performance.now();
  let blob = null;
  try {
    const o = { maxS: +$('#res').value || 0, q: +$('#qual').value };
    if (f.mode === 'wav') { setStatus('Rendering audio…'); setProg(0.3); blob = encodeWav(await renderMix()); }
    else if (f.mode === 'fast') blob = await exportFast(f, o, setProg, ctl);
    else blob = await recordRealtime(f, o, setProg, ctl);
  } catch (err) {
    busy = false; exporting = false; if (gMon) gMon.gain.value = 1; unlockScreen();
    $('#expForm').hidden = false; $('#expProgress').hidden = true;
    if (!(err && err.message === 'cancel')) { console.error(err); toast('Export failed on this device. Try another format.'); }
    else toast('Export cancelled');
    seekOut(0); return;
  }
  busy = false; unlockScreen();
  if (!blob) { toast('Export cancelled'); $('#expForm').hidden = false; $('#expProgress').hidden = true; seekOut(0); return; }
  resultBlob = blob; resultName = `${base}.${f.ext}`;
  $('#expProgress').hidden = true; $('#expDone').hidden = false;
  $('#doneInfo').textContent = `${resultName} · ${(blob.size / 1048576).toFixed(1)} MB · took ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  seekOut(0);
});
$('#expCancel').addEventListener('click', () => { if (exportCancel) exportCancel(); });
$('#expSave').addEventListener('click', () => {
  if (!resultBlob) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(resultBlob); a.download = resultName;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
});
$('#expShare').addEventListener('click', async () => {
  if (!resultBlob) return;
  const file = new File([resultBlob], resultName, { type: resultBlob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: resultName });
    else toast('Sharing isn’t supported here. Use Save instead.');
  } catch (e) { /* user cancelled */ }
});

/* ───────────────────────── wiring ───────────────────────── */
$('#btnOpen').addEventListener('click', () => $('#fileVideo').click());
$('#empty').addEventListener('click', () => $('#fileVideo').click());
$('#fileVideo').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; loadVideo(f); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('video/')) loadVideo(f); });

$('#btnPlay').addEventListener('click', () => { if (!S.loaded) { $('#fileVideo').click(); return; } playing ? pause() : play(); });
$('#btnPrev').addEventListener('click', () => { pause(); seekOut(S.playhead - 1 / 30); });
$('#btnNext').addEventListener('click', () => { pause(); seekOut(S.playhead + 1 / 30); });
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#zoomIn').addEventListener('click', () => zoom(1.5));
$('#zoomOut').addEventListener('click', () => zoom(1 / 1.5));

$('#toolSplit').addEventListener('click', doSplit);
$('#toolCutL').addEventListener('click', doCutBefore);
$('#toolCutR').addEventListener('click', doCutAfter);
$('#toolDel').addEventListener('click', doDelete);
$('#btnReset').addEventListener('click', doReset);

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + t.dataset.tab));
  if (t.dataset.tab === 'green') renderGreen();
  if (picking && t.dataset.tab !== 'green') setPicking(false);
}));

document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click(); }
  else if (e.key === 's' || e.key === 'S') doSplit();
  else if (e.key === 'Delete' || e.key === 'Backspace') doDelete();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

video.addEventListener('seeked', () => { if (!playing && !exporting) updHead(); requestDraw(); });
video.addEventListener('loadeddata', requestDraw);

/* PWA install + service worker */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#btnInstall').hidden = true; });
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

function renderAll() { renderTimeline(); renderSounds(); renderShield(); renderLayers(); renderGreen(); updHead(); requestDraw(); }
renderAll();

// test hook
window.__cc = { S, media, loadVideo, addImageFile, addVideoOverlay, doSplit, doDelete, doCutBefore, doCutAfter, seekOut, total, play, pause, selectLayer, getResult: () => resultBlob, drawPreview, get pv() { return pv; } };
})();
