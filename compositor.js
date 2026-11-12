/* GPU compositor shared by the live preview and the exporter.
   A "layer" is: { id, src, cached, rot, alpha, key, place }
     src    : HTMLVideoElement | HTMLImageElement | VideoFrame | canvas
     cached : upload the texture only once (still images)
     rot    : 0/90/180/270 clockwise (raw decoded frames that carry a rotation flag)
     alpha  : 0..1 opacity
     key    : null or { rgb:[r,g,b] (0..1), sim, smooth }   -> chroma key (green screen)
     place  : null (fill the canvas) or { cx, cy, size, aspect }
              centre as 0..1 fractions, size = width as a fraction of canvas width, aspect = srcH/srcW */
(function () {
  'use strict';

  const VS = `
attribute vec2 p; uniform vec4 u_rect; uniform float u_rot; varying vec2 v;
void main(){
  gl_Position = vec4(u_rect.xy + p * u_rect.zw, 0.0, 1.0);
  vec2 s = p;
  if (u_rot > 45.0 && u_rot < 135.0) s = vec2(1.0 - p.y, p.x);
  else if (u_rot > 135.0 && u_rot < 225.0) s = vec2(1.0 - p.x, 1.0 - p.y);
  else if (u_rot > 225.0) s = vec2(p.y, 1.0 - p.x);
  v = s;
}`;

  const FS = `
precision mediump float;
varying vec2 v; uniform sampler2D t; uniform float u_a; uniform vec4 u_key; uniform vec2 u_kp;
vec2 uvOf(vec3 c){ return vec2(c.r*-0.169 + c.g*-0.331 + c.b*0.5, c.r*0.5 + c.g*-0.419 + c.b*-0.081); }
void main(){
  vec4 c = texture2D(t, v);
  float a = u_a * c.a;
  if (u_key.a > 0.5) {
    float d = distance(uvOf(c.rgb), uvOf(u_key.rgb));
    a *= smoothstep(u_kp.x, u_kp.x + u_kp.y + 0.001, d);
    // despill: cap the key colour's channel at the strongest of the other two
    vec3 w = step(max(max(u_key.r, u_key.g), u_key.b) - 0.001, u_key.rgb);
    float lim = max(max(c.r * (1.0 - w.r), c.g * (1.0 - w.g)), c.b * (1.0 - w.b));
    vec3 capped = min(c.rgb, vec3(lim) + (1.0 - w));
    c.rgb = capped;
  }
  gl_FragColor = vec4(c.rgb, a);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  class Comp {
    constructor(canvas, keep) {
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: !!keep });
      if (!gl) throw new Error('WebGL unavailable');
      this.gl = gl; this.canvas = canvas;
      const pr = gl.createProgram();
      gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      this.u = {};
      ['u_rect', 'u_rot', 'u_a', 'u_key', 'u_kp', 't'].forEach((n) => (this.u[n] = gl.getUniformLocation(pr, n)));
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(this.u.t, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.tex = new Map(); this.up = new Set();
    }
    size(w, h) { this.canvas.width = w; this.canvas.height = h; }
    drop(id) { const t = this.tex.get(id); if (t) this.gl.deleteTexture(t); this.tex.delete(id); this.up.delete(id); }
    texFor(id) {
      let t = this.tex.get(id);
      if (!t) {
        const gl = this.gl; t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.tex.set(id, t);
      }
      return t;
    }
    rect(L) {
      if (!L.place) return [-1, -1, 2, 2];
      const cw = this.canvas.width, ch = this.canvas.height, p = L.place;
      const wC = p.size * 2, hC = (2 * p.size * cw * p.aspect) / ch;
      return [p.cx * 2 - 1 - wC / 2, 1 - p.cy * 2 - hC / 2, wC, hC];
    }
    draw(layers, bg) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      bg = bg || [0, 0, 0]; gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      for (const L of layers) {
        if (!L || !L.src) continue;
        gl.bindTexture(gl.TEXTURE_2D, this.texFor(L.id));
        if (!L.cached || !this.up.has(L.id)) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.src);
          if (L.cached) this.up.add(L.id);
        }
        const r = this.rect(L);
        gl.uniform4f(this.u.u_rect, r[0], r[1], r[2], r[3]);
        gl.uniform1f(this.u.u_rot, L.rot || 0);
        gl.uniform1f(this.u.u_a, L.alpha == null ? 1 : L.alpha);
        if (L.key) {
          gl.uniform4f(this.u.u_key, L.key.rgb[0], L.key.rgb[1], L.key.rgb[2], 1);
          gl.uniform2f(this.u.u_kp, L.key.sim, L.key.smooth);
        } else gl.uniform4f(this.u.u_key, 0, 0, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    // read one pixel from the current drawing buffer (call right after draw)
    pixel(x, y) {
      const gl = this.gl, px = new Uint8Array(4);
      gl.readPixels(x, this.canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
  }

  const hexToRgb = (h) => {
    const n = parseInt(String(h).replace('#', ''), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');

  window.Comp = Comp;
  window.CompUtil = { hexToRgb, rgbToHex };
})();
