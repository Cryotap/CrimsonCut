/* Media toolkit (no dependencies)
   - parseMp4(file)   : reads an MP4/MOV sample table so frames can be decoded with WebCodecs
   - DecSource        : sequential, hardware-decoded frame access   (fast path)
   - ElSource         : <video>-seek frame access                    (fallback for WebM etc.)
   - Mp4Mux / WebmMux : write MP4 (H.264+AAC) and WebM/MKV files from WebCodecs output */
(function () {
  'use strict';
  const u8 = Uint8Array;
  const te = new TextEncoder();
  const cat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new u8(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  const u32 = (v) => new u8([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const u16 = (v) => new u8([(v >> 8) & 255, v & 255]);
  const str = (s) => te.encode(s);
  const toU8 = (x) => (!x ? null : x instanceof u8 ? x : x instanceof ArrayBuffer ? new u8(x) : new u8(x.buffer, x.byteOffset, x.byteLength));
  const words = (arr) => { const o = new u8(arr.length * 4), dv = new DataView(o.buffer); for (let i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i] >>> 0); return o; };

  /* ───────────── MP4 demux ───────────── */
  function* boxes(b, s, e) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    while (s + 8 <= e) {
      let len = dv.getUint32(s), hl = 8;
      const t = String.fromCharCode(b[s + 4], b[s + 5], b[s + 6], b[s + 7]);
      if (len === 1) { len = Number(dv.getBigUint64(s + 8)); hl = 16; } else if (len === 0) len = e - s;
      if (len < hl || s + len > e) break;
      yield { t, s: s + hl, e: s + len };
      s += len;
    }
  }
  const find = (b, s, e, t) => { for (const x of boxes(b, s, e)) if (x.t === t) return x; return null; };
  const hex2 = (n) => n.toString(16).padStart(2, '0');

  function hevcString(c) {
    const ps = (c[1] >> 6) & 3, tier = (c[1] >> 5) & 1, idc = c[1] & 31;
    let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = [...c.subarray(6, 12)];
    while (cons.length > 1 && cons[cons.length - 1] === 0) cons.pop();
    return 'hvc1.' + ['', 'A', 'B', 'C'][ps] + idc + '.' + rev.toString(16) + '.' + (tier ? 'H' : 'L') + c[12] + cons.map((x) => '.' + x.toString(16)).join('');
  }

  async function parseMp4(file) {
    try {
      let pos = 0, moov = null;
      while (pos + 8 <= file.size) {
        const h = new u8(16); h.set(new u8(await file.slice(pos, pos + 16).arrayBuffer()));
        const dv = new DataView(h.buffer);
        let len = dv.getUint32(0), hl = 8;
        const t = String.fromCharCode(h[4], h[5], h[6], h[7]);
        if (len === 1) { len = Number(dv.getBigUint64(8)); hl = 16; } else if (len === 0) len = file.size - pos;
        if (t === 'moov') { moov = new u8(await file.slice(pos + hl, pos + len).arrayBuffer()); break; }
        if (len < 8) break; pos += len;
      }
      if (!moov) return null;
      const dv = new DataView(moov.buffer);
      let trak = null;
      for (const k of boxes(moov, 0, moov.length)) {
        if (k.t !== 'trak') continue;
        const mdia = find(moov, k.s, k.e, 'mdia'); if (!mdia) continue;
        const hd = find(moov, mdia.s, mdia.e, 'hdlr'); if (!hd) continue;
        if (String.fromCharCode(...moov.subarray(hd.s + 8, hd.s + 12)) === 'vide') { trak = k; break; }
      }
      if (!trak) return null;
      const tkhd = find(moov, trak.s, trak.e, 'tkhd');
      const mdia = find(moov, trak.s, trak.e, 'mdia');
      const mdhd = find(moov, mdia.s, mdia.e, 'mdhd');
      const minf = find(moov, mdia.s, mdia.e, 'minf');
      const stbl = find(moov, minf.s, minf.e, 'stbl');
      // rotation from the track matrix
      const mo = tkhd.s + (moov[tkhd.s] === 1 ? 48 : 40);
      const ma = dv.getInt32(mo) / 65536, mb = dv.getInt32(mo + 4) / 65536;
      let rot = Math.round((Math.atan2(mb, ma) * 180) / Math.PI); rot = ((rot % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(rot)) rot = 0;
      // timescale
      const v1 = moov[mdhd.s] === 1;
      const timescale = dv.getUint32(mdhd.s + (v1 ? 20 : 12));
      // sample description
      const stsd = find(moov, stbl.s, stbl.e, 'stsd');
      const entry = stsd.s + 8;
      const fmt = String.fromCharCode(...moov.subarray(entry + 4, entry + 8));
      const w = dv.getUint16(entry + 8 + 24), h = dv.getUint16(entry + 8 + 26);
      let codec = null, description = null;
      for (const c of boxes(moov, entry + 8 + 78, entry + dv.getUint32(entry))) {
        if (c.t === 'avcC' && (fmt === 'avc1' || fmt === 'avc3')) { description = moov.slice(c.s, c.e); codec = 'avc1.' + hex2(description[1]) + hex2(description[2]) + hex2(description[3]); }
        else if (c.t === 'hvcC' && (fmt === 'hvc1' || fmt === 'hev1')) { description = moov.slice(c.s, c.e); codec = hevcString(description); }
      }
      if (!codec) return null;
      // tables
      const rd = (box, fn) => { const b = find(moov, stbl.s, stbl.e, box); return b ? fn(b) : null; };
      const stszB = find(moov, stbl.s, stbl.e, 'stsz'); if (!stszB) return null;
      const uni = dv.getUint32(stszB.s + 4), n = dv.getUint32(stszB.s + 8);
      const sizes = new Array(n);
      for (let i = 0; i < n; i++) sizes[i] = uni || dv.getUint32(stszB.s + 12 + i * 4);
      const stco = find(moov, stbl.s, stbl.e, 'stco'), co64 = find(moov, stbl.s, stbl.e, 'co64');
      const cb = stco || co64; if (!cb) return null;
      const nch = dv.getUint32(cb.s + 4), chOff = new Array(nch);
      for (let i = 0; i < nch; i++) chOff[i] = stco ? dv.getUint32(cb.s + 8 + i * 4) : Number(dv.getBigUint64(cb.s + 8 + i * 8));
      const stscB = find(moov, stbl.s, stbl.e, 'stsc'), nS = dv.getUint32(stscB.s + 4);
      const stsc = []; for (let i = 0; i < nS; i++) stsc.push([dv.getUint32(stscB.s + 8 + i * 12), dv.getUint32(stscB.s + 12 + i * 12)]);
      const offs = new Array(n); let si = 0;
      for (let c = 0; c < nch && si < n; c++) {
        let spc = stsc[0][1];
        for (let k = 0; k < stsc.length; k++) if (stsc[k][0] <= c + 1) spc = stsc[k][1];
        let off = chOff[c];
        for (let j = 0; j < spc && si < n; j++) { offs[si] = off; off += sizes[si]; si++; }
      }
      const dts = new Array(n); { const b = find(moov, stbl.s, stbl.e, 'stts'), c = dv.getUint32(b.s + 4); let t = 0, i = 0; for (let k = 0; k < c; k++) { const cnt = dv.getUint32(b.s + 8 + k * 8), d = dv.getUint32(b.s + 12 + k * 8); for (let j = 0; j < cnt && i < n; j++) { dts[i++] = t; t += d; } } }
      const cts = new Array(n).fill(0); { const b = find(moov, stbl.s, stbl.e, 'ctts'); if (b) { const c = dv.getUint32(b.s + 4); let i = 0; for (let k = 0; k < c; k++) { const cnt = dv.getUint32(b.s + 8 + k * 8), o = dv.getInt32(b.s + 12 + k * 8); for (let j = 0; j < cnt && i < n; j++) cts[i++] = o; } } }
      const key = new Array(n).fill(true); { const b = find(moov, stbl.s, stbl.e, 'stss'); if (b) { key.fill(false); const c = dv.getUint32(b.s + 4); for (let k = 0; k < c; k++) key[dv.getUint32(b.s + 8 + k * 4) - 1] = true; } }
      // edit list start offset
      let edit = 0; { const edts = find(moov, trak.s, trak.e, 'edts'); const el = edts && find(moov, edts.s, edts.e, 'elst'); if (el) { const ev = moov[el.s], ec = dv.getUint32(el.s + 4); for (let k = 0; k < ec; k++) { const mt = ev === 1 ? Number(dv.getBigInt64(el.s + 8 + k * 20 + 8)) : dv.getInt32(el.s + 8 + k * 12 + 4); if (mt >= 0) { edit = mt; break; } } } }
      const samples = new Array(n);
      for (let i = 0; i < n; i++) samples[i] = { off: offs[i], size: sizes[i], ts: Math.max(0, Math.round(((dts[i] + cts[i] - edit) / timescale) * 1e6)), key: key[i] };
      let last = 0; for (const s of samples) if (s.ts > last) last = s.ts;
      const dur = last / 1e6 + (n > 1 ? (dts[n - 1] - dts[n - 2]) / timescale : 0);
      return { codec, description, w, h, rot, samples, duration: dur, fps: n > 1 ? n / Math.max(dur, 0.001) : 30 };
    } catch (e) { console.warn('parseMp4 failed', e); return null; }
  }

  /* ───────────── frame sources ───────────── */
  class DecSource {
    constructor(file, info) {
      this.f = file; this.i = info; this.S = info.samples; this.n = this.S.length; this.rot = info.rot;
      this.order = Array.from({ length: this.n }, (_, k) => k).sort((a, b) => this.S[a].ts - this.S[b].ts);
      this.pk = new Array(this.n); let k = 0;
      for (let i = 0; i < this.n; i++) { if (this.S[i].key) k = i; this.pk[i] = k; }
      this.dec = null; this.out = []; this.next = 0; this.curTs = -1; this.err = null; this.wait = null; this.blk = null; this.target = 0; this.flushed = false; this.flushDone = false;
    }
    static async supported(info) {
      if (typeof VideoDecoder === 'undefined') return false;
      try { const r = await VideoDecoder.isConfigSupported({ codec: info.codec, description: info.description }); return !!r.supported; } catch (e) { return false; }
    }
    _wake() { if (this.wait) { const r = this.wait; this.wait = null; r(); } }
    _tick() { return new Promise((r) => { this.wait = r; }); }
    _reset() {
      try { this.dec && this.dec.close(); } catch (e) {}
      this.out.forEach((f) => f.close()); this.out = [];
      this.err = null; this.flushed = false; this.flushDone = false;
      this.dec = new VideoDecoder({
        output: (f) => { if (f.timestamp < this.target) f.close(); else this.out.push(f); this._wake(); },
        error: (e) => { this.err = e; this._wake(); },
      });
      this.dec.configure({ codec: this.i.codec, description: this.i.description });
    }
    async _bytes(s) {
      let b = this.blk;
      if (!b || s.off < b.s || s.off + s.size > b.s + b.d.length) {
        const len = Math.max(4 << 20, s.size);
        b = this.blk = { s: s.off, d: new u8(await this.f.slice(s.off, s.off + len).arrayBuffer()) };
      }
      return b.d.subarray(s.off - b.s, s.off - b.s + s.size);
    }
    async frameAt(t) {
      const ts = Math.round(t * 1e6);
      let lo = 0, hi = this.n - 1, k = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (this.S[this.order[m]].ts <= ts) { k = m; lo = m + 1; } else hi = m - 1; }
      const di = this.order[k], tts = this.S[di].ts;
      this.target = tts;
      this.out = this.out.filter((f) => { if (f.timestamp < tts) { f.close(); return false; } return true; });
      let f = this.out.find((x) => x.timestamp === tts);
      if (!f) {
        if (!this.dec || tts < this.curTs || di - this.next > 90 || this.dec.state === 'closed') {
          this._reset(); this.next = this.pk[di];
        }
        while (!(f = this.out.find((x) => x.timestamp === tts))) {
          if (this.err) throw this.err;
          if (this.next < this.n && this.dec.decodeQueueSize < 12) {
            const s = this.S[this.next];
            this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, data: await this._bytes(s) }));
            this.next++; continue;
          }
          if (this.next >= this.n && !this.flushed) { this.flushed = true; this.dec.flush().then(() => { this.flushDone = true; this._wake(); }, () => { this.flushDone = true; this._wake(); }); }
          if (this.flushDone) { f = this.out[this.out.length - 1]; if (!f) throw new Error('decode produced no frame'); break; }
          await this._tick();
        }
      }
      this.curTs = f.timestamp;
      return { src: f, rot: this.rot };
    }
    dispose() { try { this.dec && this.dec.close(); } catch (e) {} this.out.forEach((f) => f.close()); this.out = []; }
  }

  class ElSource {
    constructor(url) {
      const v = (this.v = document.createElement('video'));
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      this.ready = new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video load failed')); });
    }
    async frameAt(t) {
      await this.ready; const v = this.v;
      t = Math.min(Math.max(t, 0), Math.max(0, (v.duration || 0) - 0.001));
      if (Math.abs(v.currentTime - t) > 0.0004) {
        await new Promise((res) => { const d = () => { clearTimeout(to); res(); }; const to = setTimeout(d, 2500); v.addEventListener('seeked', d, { once: true }); v.currentTime = t; });
      }
      return { src: v, rot: 0 };
    }
    dispose() { this.v.removeAttribute('src'); this.v.load(); }
  }

  /* ───────────── MP4 mux ───────────── */
  const box = (type, ...kids) => { const body = cat(kids); return cat([u32(body.length + 8), str(type), body]); };
  const fbox = (type, ver, flags, ...kids) => box(type, new u8([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...kids);
  const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const rle = (arr) => { const out = []; for (const v of arr) { if (out.length && out[out.length - 2 + 1] === v) out[out.length - 2]++; else out.push(1, v); } return out; };

  class Mp4Mux {
    constructor(o) { this.vt = o.video || null; this.at = o.audio || null; this.vs = []; this.as = []; this.audioOnly = !o.video; }
    addVideo(c) { const d = new u8(c.byteLength); c.copyTo(d); this.vs.push({ d, ts: c.timestamp, dur: c.duration || 0, key: c.type === 'key' }); }
    addAudio(c) { const d = new u8(c.byteLength); c.copyTo(d); this.as.push({ d, ts: c.timestamp, dur: c.duration || 0 }); }
    _prep(kind, list, scale) {
      const tick = (us) => Math.round((us * scale) / 1e6);
      const durs = list.map((s, i) => {
        if (kind === 'soun' && s.dur) return Math.max(1, Math.round((s.dur * scale) / 1e6));
        const nx = list[i + 1];
        return nx ? Math.max(1, tick(nx.ts) - tick(s.ts)) : Math.max(1, tick(s.ts + (s.dur || 33333)) - tick(s.ts));
      });
      return { kind, list, scale, durs, total: durs.reduce((a, b) => a + b, 0) };
    }
    finish() {
      const tracks = [];
      if (this.vt && this.vs.length) tracks.push(Object.assign(this._prep('vide', this.vs, 90000), { cfg: this.vt }));
      if (this.at && this.as.length) tracks.push(Object.assign(this._prep('soun', this.as, this.at.sr), { cfg: this.at }));
      tracks.forEach((t, i) => (t.id = i + 1));
      // interleave samples into chunks
      const order = [];
      tracks.forEach((t) => t.list.forEach((s, i) => order.push({ t, i, ts: s.ts })));
      order.sort((a, b) => a.ts - b.ts || (a.t.kind === 'vide' ? -1 : 1));
      let rel = 0; const parts = [];
      tracks.forEach((t) => { t.chunks = []; });
      let curT = null, curN = 0;
      for (const o of order) {
        const s = o.t.list[o.i];
        if (o.t !== curT || curN >= (o.t.kind === 'vide' ? 30 : 48)) { o.t.chunks.push({ off: rel, n: 0 }); curT = o.t; curN = 0; }
        o.t.chunks[o.t.chunks.length - 1].n++; curN++;
        parts.push(s.d); rel += s.d.length;
      }
      const movDur = Math.max(1, ...tracks.map((t) => Math.round((t.total / t.scale) * 1000)));
      const build = (base) => box('moov',
        fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movDur), u32(0x10000), u16(0x100), new u8(10), MATRIX, new u8(24), u32(tracks.length + 1)),
        ...tracks.map((t) => this._trak(t, base, movDur)));
      const isAudio = this.audioOnly;
      const ftyp = box('ftyp', str(isAudio ? 'M4A ' : 'isom'), u32(512), str(isAudio ? 'M4A ' : 'isom'), str('iso2'), str(isAudio ? 'mp42' : 'avc1'), str('mp41'));
      const m0 = build(0), base = ftyp.length + m0.length + 8, moov = build(base);
      const head = cat([u32(rel + 8), str('mdat')]);
      return new Blob([ftyp, moov, head, ...parts], { type: isAudio ? 'audio/mp4' : 'video/mp4' });
    }
    _trak(t, base, movDur) {
      const vid = t.kind === 'vide', c = t.cfg;
      const durMs = Math.round((t.total / t.scale) * 1000);
      const tkhd = fbox('tkhd', 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(durMs), new u8(8), u16(0), u16(0), u16(vid ? 0 : 0x100), u16(0), MATRIX, u32(vid ? (c.w * 65536) >>> 0 : 0), u32(vid ? (c.h * 65536) >>> 0 : 0));
      const mdhd = fbox('mdhd', 0, 0, u32(0), u32(0), u32(t.scale), u32(t.total), u16(0x55c4), u16(0));
      const hdlr = fbox('hdlr', 0, 0, u32(0), str(t.kind), new u8(12), str(vid ? 'VideoHandler\0' : 'SoundHandler\0'));
      let entry;
      if (vid) {
        entry = box('avc1', new u8(6), u16(1), new u8(16), u16(c.w), u16(c.h), u32(0x480000), u32(0x480000), u32(0), u16(1), new u8(32), u16(0x18), u16(0xffff), box('avcC', c.desc));
      } else {
        const asc = c.desc && c.desc.length ? c.desc : new u8([0x11, 0x90]);
        const dsi = cat([new u8([0x05, asc.length]), asc]);
        const dcd = cat([new u8([0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0]), u32(0), u32(0), dsi]);
        const es = cat([new u8([0x03, 3 + dcd.length + 3, 0, 0, 0]), dcd, new u8([0x06, 0x01, 0x02])]);
        entry = box('mp4a', new u8(6), u16(1), new u8(8), u16(c.ch), u16(16), u16(0), u16(0), u32((c.sr * 65536) >>> 0), fbox('esds', 0, 0, es));
      }
      const sttsRuns = rle(t.durs);
      const stsc = []; let prev = null;
      t.chunks.forEach((ch, i) => { if (!prev || prev !== ch.n) stsc.push(i + 1, ch.n, 1); prev = ch.n; });
      const sizes = t.list.map((s) => s.d.length);
      const keys = []; if (vid) t.list.forEach((s, i) => { if (s.key) keys.push(i + 1); });
      const stbl = box('stbl',
        fbox('stsd', 0, 0, u32(1), entry),
        fbox('stts', 0, 0, u32(sttsRuns.length / 2), words(sttsRuns)),
        ...(vid ? [fbox('stss', 0, 0, u32(keys.length), words(keys))] : []),
        fbox('stsc', 0, 0, u32(stsc.length / 3), words(stsc)),
        fbox('stsz', 0, 0, u32(0), u32(sizes.length), words(sizes)),
        fbox('stco', 0, 0, u32(t.chunks.length), words(t.chunks.map((ch) => base + ch.off))));
      const minf = box('minf', vid ? fbox('vmhd', 0, 1, u16(0), new u8(6)) : fbox('smhd', 0, 0, u16(0), u16(0)), box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))), stbl);
      return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    }
  }

  /* ───────────── WebM / Matroska mux ───────────── */
  const vsize = (n) => { let len = 1; while (n >= Math.pow(2, 7 * len) - 1) len++; const o = new u8(len); let v = n; for (let i = len - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } o[0] |= 1 << (8 - len); return o; };
  const el = (id, ...kids) => { const body = cat(kids); return cat([new u8(id), vsize(body.length), body]); };
  const uintB = (n) => { const b = []; do { b.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0); return new u8(b); };
  const eu = (id, n) => el(id, uintB(n));
  const ef = (id, x, big) => { const o = new u8(big ? 8 : 4); const dv = new DataView(o.buffer); big ? dv.setFloat64(0, x) : dv.setFloat32(0, x); return el(id, o); };
  const es = (id, s) => el(id, str(s));

  class WebmMux {
    constructor(o) { this.vt = o.video || null; this.at = o.audio || null; this.doc = o.doctype || 'webm'; this.vs = []; this.as = []; }
    addVideo(c) { const d = new u8(c.byteLength); c.copyTo(d); this.vs.push({ d, ts: c.timestamp, key: c.type === 'key', tr: 1 }); }
    addAudio(c) { const d = new u8(c.byteLength); c.copyTo(d); this.as.push({ d, ts: c.timestamp, key: true, tr: this.vt ? 2 : 1 }); }
    finish() {
      const ebml = el([0x1a, 0x45, 0xdf, 0xa3], eu([0x42, 0x86], 1), eu([0x42, 0xf7], 1), eu([0x42, 0xf2], 4), eu([0x42, 0xf3], 8), es([0x42, 0x82], this.doc), eu([0x42, 0x87], 4), eu([0x42, 0x85], 2));
      const all = this.vs.concat(this.as).sort((a, b) => a.ts - b.ts);
      const lastTs = all.length ? all[all.length - 1].ts : 0;
      const info = el([0x15, 0x49, 0xa9, 0x66], eu([0x2a, 0xd7, 0xb1], 1000000), es([0x4d, 0x80], 'CrimsonCut'), es([0x57, 0x41], 'CrimsonCut'), ef([0x44, 0x89], lastTs / 1000, true));
      const tr = [];
      if (this.vt) tr.push(el([0xae], eu([0xd7], 1), eu([0x73, 0xc5], 1), eu([0x83], 1), eu([0x9c], 0), es([0x86], this.vt.codec), ...(this.vt.priv ? [el([0x63, 0xa2], this.vt.priv)] : []), el([0xe0], eu([0xb0], this.vt.w), eu([0xba], this.vt.h))));
      if (this.at) {
        const n = this.vt ? 2 : 1;
        tr.push(el([0xae], eu([0xd7], n), eu([0x73, 0xc5], n), eu([0x83], 2), eu([0x9c], 0), es([0x86], this.at.codec),
          ...(this.at.codec === 'A_OPUS' ? [eu([0x56, 0xaa], 6500000), eu([0x56, 0xbb], 80000000)] : []),
          ...(this.at.priv ? [el([0x63, 0xa2], this.at.priv)] : []),
          el([0xe1], ef([0xb5], this.at.sr, true), eu([0x9f], this.at.ch))));
      }
      const tracks = el([0x16, 0x54, 0xae, 0x6b], ...tr);
      // clusters
      const clusters = [], cues = []; let pos = info.length + tracks.length;
      let cur = null, cStart = 0;
      const flush = () => { if (!cur) return; const c = el([0x1f, 0x43, 0xb6, 0x75], eu([0xe7], Math.round(cStart / 1000)), ...cur); clusters.push(c); pos += c.length; cur = null; };
      for (const s of all) {
        const ms = Math.round(s.ts / 1000);
        if (!cur || (s.tr === 1 && this.vt && s.key && ms - Math.round(cStart / 1000) >= 2000) || ms - Math.round(cStart / 1000) > 30000) {
          flush(); cur = []; cStart = s.ts;
          if (this.vt ? s.tr === 1 : true) cues.push(el([0xbb], eu([0xb3], ms), el([0xb7], eu([0xf7], s.tr), eu([0xf1], pos))));
        }
        const rel = ms - Math.round(cStart / 1000);
        const hd = new u8([0x80 | s.tr, (rel >> 8) & 255, rel & 255, s.key ? 0x80 : 0]);
        cur.push(el([0xa3], hd, s.d));
      }
      flush();
      const cuesEl = cues.length ? el([0x1c, 0x53, 0xbb, 0x6b], ...cues) : new u8(0);
      const seg = el([0x18, 0x53, 0x80, 0x67], info, tracks, ...clusters, cuesEl);
      return new Blob([ebml, seg], { type: this.vt ? (this.doc === 'webm' ? 'video/webm' : 'video/x-matroska') : (this.doc === 'webm' ? 'audio/webm' : 'audio/x-matroska') });
    }
  }

  window.MediaX = { parseMp4, DecSource, ElSource, Mp4Mux, WebmMux, toU8 };
})();
