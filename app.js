(() => {
'use strict';

/* ───────────────────────── helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (cls, tag = 'div') => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const S = {
  loaded: false, name: 'video', duration: 0, vw: 0, vh: 0,
  segs: [],        // {id,start,end,vol}  (source-time ranges, played in order)
  sounds: [],      // {id,lib,name,time,vol}  (time = output timeline)
  autoMutes: [],   // {id,start,end}  (source time)
  playhead: 0,     // output timeline seconds
  pps: 50,         // pixels per second
  shield: { on: false, sens: 55, scanned: false },
  audioBuf: null, peaks: null,
};
const PK = 20;                  // waveform peaks per second
const lib = new Map();          // sound library id -> {name, buffer}

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
const snap = () => JSON.stringify({ segs: S.segs, sounds: S.sounds, autoMutes: S.autoMutes });
function push() { hist.u.push(snap()); if (hist.u.length > 100) hist.u.shift(); hist.r = []; updUndo(); }
function restore(str) { const o = JSON.parse(str); S.segs = o.segs; S.sounds = o.sounds; S.autoMutes = o.autoMutes; }
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

/* ───────────────────────── playback engine ───────────────────────── */
let playing = false, idx = 0, timer = null, active = [], onEnd = null, exporting = false;

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
}

function seekOut(t) {
  if (!S.segs.length) return;
  t = clamp(t, 0, total());
  const L = locate(t);
  idx = L.i; S.playhead = t;
  const target = S.segs[L.i].start + L.off;
  if (Math.abs(video.currentTime - target) > 0.001) video.currentTime = target;
  if (playing) scheduleSounds(t);
  updHead();
}

function play() {
  if (!S.loaded || playing) return;
  ensureAC(); ac.resume();
  if (S.playhead >= total() - 0.05) S.playhead = 0;
  const L = locate(S.playhead); idx = L.i;
  const target = S.segs[idx].start + L.off;
  if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
  video.play().catch(() => {});
  playing = true;
  scheduleSounds(S.playhead);
  timer = setInterval(tick, 20);
  updPlayBtn(); frameLoop();
}
function pause() {
  if (!playing) { stopSounds(); return; }
  playing = false; clearInterval(timer);
  video.pause(); stopSounds(); updPlayBtn();
}
function finish() {
  const wasPlaying = playing;
  playing = false; clearInterval(timer);
  video.pause(); stopSounds();
  S.playhead = total(); updHead(); updPlayBtn();
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
  updHead();
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
  S.url = url;
  S.loaded = true;
  S.name = file.name.replace(/\.[^.]+$/, '') || 'video';
  S.duration = video.duration; S.vw = video.videoWidth; S.vh = video.videoHeight;
  S.segs = [{ id: uid(), start: 0, end: S.duration, vol: 1 }];
  S.autoMutes = []; S.sounds = []; S.playhead = 0;
  S.shield.scanned = false; S.audioBuf = null; S.peaks = null;
  hist.u = []; hist.r = [];
  S.pps = clamp(Math.round(300 / Math.max(S.duration, 1)) * 10, 12, 120);
  $('#empty').classList.add('gone');
  $('#btnExport').disabled = false;
  $('#fname').value = S.name + '-edited';
  renderAll(); updUndo();
  decodeAudio(file);
}

async function decodeAudio(file) {
  try {
    if (file.size > 700 * 1024 * 1024) { toast('Large file: waveform and Shield are turned off to save memory.'); renderShield(); return; }
    ensureAC();
    const ab = await file.arrayBuffer();
    const buf = await ac.decodeAudioData(ab);
    if (file !== undefined && S.loaded) {
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
  S.sounds = []; S.autoMutes = []; S.shield.scanned = false; S.playhead = 0;
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
  track.style.width = Math.max(tot * S.pps, 1) + 'px';
  track.innerHTML = '';
  if (!S.loaded) return;

  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * S.pps >= 70) || 600;
  for (let t = 0; t <= tot + 1e-6; t += step) {
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

/* timeline interactions: tap to seek, drag knob to scrub, drag sound chips */
let tap = null;
track.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.sfx') || e.target.closest('.knob')) return;
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
const CAND = [
  { id: 'mp4', label: 'MP4 · H.264 + AAC', mime: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'], ext: 'mp4', kind: 'video' },
  { id: 'mkv', label: 'MKV · H.264', mime: ['video/x-matroska;codecs=avc1,opus', 'video/x-matroska'], ext: 'mkv', kind: 'video' },
  { id: 'webm9', label: 'WebM · VP9 + Opus', mime: ['video/webm;codecs=vp9,opus'], ext: 'webm', kind: 'video' },
  { id: 'webm8', label: 'WebM · VP8 + Opus', mime: ['video/webm;codecs=vp8,opus', 'video/webm'], ext: 'webm', kind: 'video' },
  { id: 'm4a', label: 'Audio only · M4A (AAC)', mime: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'], ext: 'm4a', kind: 'audio' },
  { id: 'opus', label: 'Audio only · WebM (Opus)', mime: ['audio/webm;codecs=opus'], ext: 'webm', kind: 'audio' },
  { id: 'wav', label: 'Audio only · WAV (lossless)', ext: 'wav', kind: 'wav' },
];
let FORMATS = [];
function detectFormats() {
  FORMATS = CAND.map((c) => {
    if (c.kind === 'wav') return { ...c, ok: !!S.audioBuf, mimeUse: 'audio/wav' };
    const m = typeof MediaRecorder !== 'undefined' ? c.mime.find((x) => MediaRecorder.isTypeSupported(x)) : null;
    return { ...c, ok: !!m, mimeUse: m };
  }).filter((f) => f.ok);
}

const modal = $('#exportModal');
let resultBlob = null, resultName = '', exportCancel = null, wakeLock = null;

function openExport() {
  if (!needClip()) return;
  pause(); detectFormats();
  const sel = $('#fmt'); sel.innerHTML = '';
  FORMATS.forEach((f, i) => { const o = document.createElement('option'); o.value = i; o.textContent = f.label; sel.appendChild(o); });
  if (!FORMATS.length) { toast("This browser can't record video. Try Chrome on Android."); return; }
  $('#expForm').hidden = false; $('#expProgress').hidden = true; $('#expDone').hidden = true;
  modal.hidden = false; updExpNote();
}
function updExpNote() {
  const f = FORMATS[+$('#fmt').value]; if (!f) return;
  $('#videoOpts').hidden = f.kind !== 'video';
  $('#expNote').textContent = f.kind === 'wav'
    ? `Renders quickly (about ${Math.max(1, Math.round(total() / 20))}s).`
    : `Renders in real time: about ${fmt(total(), 0)} for this edit. Keep the screen on and stay in the app.`;
}
$('#fmt').addEventListener('change', updExpNote);
$('#expX').addEventListener('click', () => { if (exporting) return; modal.hidden = true; });
$('#expAgain').addEventListener('click', () => { modal.hidden = true; });
$('#btnExport').addEventListener('click', openExport);

async function lockScreen() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
function unlockScreen() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

const seekWait = (t) => new Promise((res) => {
  const L = locate(t); idx = L.i; S.playhead = t;
  const tg = S.segs[L.i].start + L.off;
  if (Math.abs(video.currentTime - tg) < 0.01) return res();
  const done = () => { clearTimeout(to); res(); };
  const to = setTimeout(done, 1500);
  video.addEventListener('seeked', done, { once: true });
  video.currentTime = tg;
});

async function recordRealtime(f, opts, setProg) {
  ensureAC(); await ac.resume();
  const isVideo = f.kind === 'video';
  const tracks = [...dest.stream.getAudioTracks()];
  let cv, c2, w = 0, h = 0;
  if (isVideo) {
    const sc = opts.maxH && S.vh > opts.maxH ? opts.maxH / S.vh : 1;
    w = Math.max(2, Math.round((S.vw * sc) / 2) * 2); h = Math.max(2, Math.round((S.vh * sc) / 2) * 2);
    cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    c2 = cv.getContext('2d', { alpha: false });
    tracks.unshift(...cv.captureStream(opts.fps).getVideoTracks());
  }
  const rec = new MediaRecorder(new MediaStream(tracks), {
    mimeType: f.mimeUse,
    videoBitsPerSecond: isVideo ? Math.round(w * h * opts.fps * 0.09 * opts.q) : undefined,
    audioBitsPerSecond: 128000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => (rec.onstop = res));

  pause();
  gMon.gain.value = 0;                       // don't blast the speaker while rendering
  await seekWait(0);
  if (isVideo) c2.drawImage(video, 0, 0, w, h);
  rec.start(250);

  let cancelled = false;
  exportCancel = () => { cancelled = true; finish(); };
  exporting = true;
  const draw = () => {
    if (!exporting) return;
    if (isVideo) c2.drawImage(video, 0, 0, w, h);
    setProg(clamp(S.playhead / Math.max(total(), 0.01), 0, 1));
    requestAnimationFrame(draw);
  };
  draw();
  await new Promise((res) => { onEnd = res; play(); });
  const endT = performance.now();
  while (performance.now() - endT < 350) { if (isVideo) c2.drawImage(video, 0, 0, w, h); await sleep(30); }
  exporting = false;
  rec.stop(); await stopped;
  gMon.gain.value = 1; exportCancel = null;
  return cancelled ? null : new Blob(chunks, { type: f.mimeUse.split(';')[0] });
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

async function renderWav(setProg) {
  const sr = 48000, tot = total();
  const oc = new OfflineAudioContext(2, Math.ceil(tot * sr), sr);
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
  for (const s of S.sounds) {
    const it = lib.get(s.lib); if (!it) continue;
    const n = oc.createBufferSource(); n.buffer = it.buffer;
    const g = oc.createGain(); g.gain.value = s.vol; n.connect(g); g.connect(oc.destination);
    n.start(s.time);
  }
  setProg(0.3);
  const out = await oc.startRendering();
  setProg(0.9);
  return encodeWav(out);
}

$('#expStart').addEventListener('click', async () => {
  const f = FORMATS[+$('#fmt').value]; if (!f) return;
  const base = ($('#fname').value || 'crimsoncut-export').replace(/[\\/:*?"<>|]+/g, '_');
  $('#expForm').hidden = true; $('#expProgress').hidden = false; $('#expDone').hidden = true;
  const fill = $('#barFill'); fill.style.width = '0%';
  const setProg = (p) => { fill.style.width = Math.round(p * 100) + '%'; $('#expStatus').textContent = `Rendering… ${Math.round(p * 100)}% · keep this screen open`; };
  $('#expCancel').hidden = f.kind === 'wav';
  await lockScreen();
  let blob = null;
  try {
    if (f.kind === 'wav') blob = await renderWav(setProg);
    else blob = await recordRealtime(f, { maxH: +$('#res').value || 0, q: +$('#qual').value, fps: 30 }, setProg);
  } catch (err) {
    console.error(err);
    exporting = false; if (gMon) gMon.gain.value = 1;
    toast('Export failed on this device. Try another format.');
    unlockScreen(); $('#expForm').hidden = false; $('#expProgress').hidden = true; return;
  }
  unlockScreen();
  if (!blob) { toast('Export cancelled'); $('#expForm').hidden = false; $('#expProgress').hidden = true; seekOut(0); return; }
  resultBlob = blob; resultName = `${base}.${f.ext}`;
  $('#expProgress').hidden = true; $('#expDone').hidden = false;
  $('#doneInfo').textContent = `${resultName} · ${(blob.size / 1048576).toFixed(1)} MB`;
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
}));

document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click(); }
  else if (e.key === 's' || e.key === 'S') doSplit();
  else if (e.key === 'Delete' || e.key === 'Backspace') doDelete();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

video.addEventListener('seeked', () => { if (!playing && !exporting) updHead(); });

/* PWA install + service worker */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#btnInstall').hidden = true; });
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

function renderAll() { renderTimeline(); renderSounds(); renderShield(); updHead(); }
renderAll();

// test hook
window.__cc = { S, loadVideo, doSplit, doDelete, doCutBefore, doCutAfter, seekOut, total, play, pause };
})();
