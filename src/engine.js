// WebGL2 film lab. expose: photo -> film exposure (table L1). Halation runs on linear exposure.
// develop: EV offset, film density (L2), grain, print exposure (L3 + filter tables), print and scan (L4).
// Slide stocks skip the print stage and use one scan table. Tables are exact float, trilinear by hand.
const VERT = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 outColor;
vec3 tri(sampler3D t, vec3 c, float last) {
  vec3 p = clamp(c, 0.0, 1.0) * last;
  ivec3 i = ivec3(min(floor(p), vec3(last - 1.0)));
  vec3 f = p - vec3(i);
  vec3 x00 = mix(texelFetch(t, i, 0).rgb, texelFetch(t, i + ivec3(1, 0, 0), 0).rgb, f.x);
  vec3 x10 = mix(texelFetch(t, i + ivec3(0, 1, 0), 0).rgb, texelFetch(t, i + ivec3(1, 1, 0), 0).rgb, f.x);
  vec3 x01 = mix(texelFetch(t, i + ivec3(0, 0, 1), 0).rgb, texelFetch(t, i + ivec3(1, 0, 1), 0).rgb, f.x);
  vec3 x11 = mix(texelFetch(t, i + ivec3(0, 1, 1), 0).rgb, texelFetch(t, i + ivec3(1, 1, 1), 0).rgb, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}`;

const EXPOSE = HEAD + `
uniform sampler2D uSrc; uniform sampler3D uL1; uniform float uLast;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 rgb = texelFetch(uSrc, ivec2(c.x, textureSize(uSrc, 0).y - 1 - c.y), 0).rgb; // bitmaps upload top row first
  outColor = vec4(pow(vec3(10.0), tri(uL1, rgb, uLast)), 1.0);
}`;

const BLUR = HEAD + `
uniform sampler2D uSrc; uniform vec3 uSigma; uniform ivec2 uAxis; uniform int uRadius;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), hi = textureSize(uSrc, 0) - 1;
  vec3 sum = vec3(0.0), norm = vec3(0.0), k = -0.5 / (uSigma * uSigma);
  for (int i = -uRadius; i <= uRadius; i++) {
    vec3 w = exp(k * float(i * i));
    sum += w * texelFetch(uSrc, clamp(c + uAxis * i, ivec2(0), hi), 0).rgb;
    norm += w;
  }
  outColor = vec4(sum / norm, 1.0);
}`;

const MIX = HEAD + `
uniform sampler2D uA; uniform sampler2D uB; uniform vec3 uKa; uniform vec3 uKb;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  outColor = vec4(uKa * texelFetch(uA, c, 0).rgb + uKb * texelFetch(uB, c, 0).rgb, 1.0);
}`;

const DEVELOP = HEAD + `
uniform sampler2D uExposed; uniform sampler2D uGrainLut;
uniform sampler3D uL2; uniform sampler3D uL3; uniform sampler3D uL4; uniform sampler3D uDy; uniform sampler3D uDm;
uniform float uLast, uEvLog, uPrintLog, uY, uM, uGrainScale; uniform bool uSlide; uniform uint uSeed;
uniform vec2 uFilmWire, uPrintWire; uniform vec3 uDensMin, uDensMax, uKernel;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 gauss(ivec2 c) {
  uvec3 a = pcg3d(uvec3(uvec2(c + 8), uSeed)), b = pcg3d(uvec3(uvec2(c + 8), uSeed + 1u));
  vec3 u1 = (vec3(a) + 1.0) / 4294967296.0, u2 = vec3(b) / 4294967296.0;
  return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
}
vec3 grainField(ivec2 c) {
  vec3 sum = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 ki = i == 0 ? vec3(1.0) : uKernel, kj = j == 0 ? vec3(1.0) : uKernel;
    sum += ki * kj * gauss(c + ivec2(i, j));
  }
  return sum / (1.0 + 2.0 * uKernel * uKernel);
}
vec3 grainSigma(vec3 code) {
  vec3 p = clamp(code, 0.0, 1.0) * 255.0, s;
  for (int k = 0; k < 3; k++) {
    int i = min(int(p[k]), 254);
    s[k] = mix(texelFetch(uGrainLut, ivec2(i, 0), 0)[k], texelFetch(uGrainLut, ivec2(i + 1, 0), 0)[k], p[k] - float(i));
  }
  return s;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 logE = log(max(texelFetch(uExposed, c, 0).rgb, 1e-6)) / log(10.0) + uEvLog;
  vec3 density = tri(uL2, (logE - uFilmWire.x) / (uFilmWire.y - uFilmWire.x), uLast);
  vec3 code = (density - uDensMin) / (uDensMax - uDensMin);
  if (uGrainScale > 0.0) {
    density += grainSigma(code) * uGrainScale * grainField(c);
    code = (density - uDensMin) / (uDensMax - uDensMin);
  }
  vec3 rgb;
  if (uSlide) {
    rgb = tri(uL3, code, uLast);
  } else {
    vec3 logPrint = tri(uL3, code, uLast) + uPrintLog + uY * tri(uDy, code, uLast) + uM * tri(uDm, code, uLast);
    rgb = tri(uL4, (logPrint - uPrintWire.x) / (uPrintWire.y - uPrintWire.x), uLast);
  }
  outColor = vec4(rgb, 1.0);
}`;

const SCATTER_TAIL_FIT = [[0.1633, 0.5360], [0.6496, 1.5236], [0.1870, 2.7684]]; // spektrafilm's three-Gaussian exponential surrogate
const FILM_WIDTH_UM = 35000;

export async function readStock(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const end = bytes.indexOf(10);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
  const n = head.size, count = n * n * n * 3, tables = {};
  if (bytes.length !== end + 1 + head.tables.length * count * 2) throw new Error(`${url} has the wrong length`);
  head.tables.forEach((name, t) => {
    const start = end + 1 + t * count * 2;
    const q = new Uint16Array(bytes.slice(start, start + count * 2).buffer);
    const { lo, hi } = head.ranges[name];
    const out = new Float32Array(n * n * n * 4);
    for (let row = 0; row < n * n; row++) {
      const acc = [0, 0, 0];
      for (let r = 0; r < n; r++) {
        const i = row * n + r;
        for (let k = 0; k < 3; k++) {
          acc[k] = (acc[k] + q[i * 3 + k]) & 65535;
          out[i * 4 + k] = lo[k] + (acc[k] / 65535) * (hi[k] - lo[k]);
        }
        out[i * 4 + 3] = 1;
      }
    }
    tables[name] = out;
  });
  return { head, tables };
}

function grainLut(head) {
  const { min, max } = head.wires.cmy_film, lut = new Float32Array(256 * 4);
  for (let k = 0; k < 3; k++) {
    const pts = head.grain.bands.map(b => [b.density[k], b.sigma[k]]).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < 256; i++) {
      const d = min[k] + (i / 255) * (max[k] - min[k]);
      let j = 0;
      while (j < pts.length - 2 && pts[j + 1][0] < d) j++;
      const [d0, s0] = pts[j], [d1, s1] = pts[j + 1];
      const f = Math.min(1, Math.max(0, (d - d0) / Math.max(d1 - d0, 1e-6)));
      lut[i * 4 + k] = s0 + f * (s1 - s0);
    }
  }
  return lut;
}

function grainKernel(head) {
  // [a, 1, a] taps whose neighbour correlation matches the measured grain, averaged over mid densities
  const mid = head.grain.bands.slice(4, 12);
  return [0, 1, 2].map(k => {
    const rho = Math.min(0.7, Math.max(0.001, mid.reduce((s, b) => s + b.rho[k], 0) / mid.length));
    return (1 - Math.sqrt(1 - 2 * rho * rho)) / (2 * rho);
  });
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('This browser has no WebGL2.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This GPU cannot render to float textures.');
    }
    this.gl = gl;
    this.maxEdge = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.programs = { expose: this.program(EXPOSE), blur: this.program(BLUR), mix: this.program(MIX), develop: this.program(DEVELOP) };
    this.vao = gl.createVertexArray();
    this.targets = [];
    this.stocks = new Map();
    gl.bindVertexArray(this.vao);
  }

  program(fragment) {
    const { gl } = this, p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fragment]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  table(data, n) {
    const { gl } = this, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, n, n, n, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  plain(internal, format, type, w, h, data) {
    const { gl } = this, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  addStock(id, { head, tables }) {
    const { gl } = this, gpu = {};
    for (const name of head.tables) gpu[name] = this.table(tables[name], head.size);
    const lut = this.plain(gl.RGBA32F, gl.RGBA, gl.FLOAT, 256, 1, grainLut(head));
    this.stocks.set(id, { head, gpu, lut, kernel: grainKernel(head) });
  }

  setSize(w, h) {
    const { gl } = this;
    for (const t of this.targets) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
    this.targets = [];
    for (let i = 0; i < 4; i++) {
      const tex = this.plain(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, w, h, null);
      const fbo = gl.createFramebuffer();
      this.targets.push({ tex, fbo }); // held before the check, so the next setSize frees a partial set
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() === gl.OUT_OF_MEMORY) {
        throw new RangeError(`The GPU cannot hold a ${w} × ${h} render.`);
      }
    }
    this.canvas.width = w; this.canvas.height = h;
    this.w = w; this.h = h;
  }

  setImage(bitmap) {
    const { gl } = this;
    if (this.src) gl.deleteTexture(this.src);
    this.src = null;
    this.setSize(bitmap.width, bitmap.height);
    this.src = this.plain(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap.width, bitmap.height, bitmap);
    this.exposedKey = null;
  }

  bind(program, textures, is3d = {}) {
    const { gl } = this;
    gl.useProgram(program);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(is3d[name] ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(program, name), unit++);
    }
  }

  draw(target) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  blur(src, sigma, tmp, dst) {
    const { gl } = this, p = this.programs.blur;
    const radius = Math.ceil(3 * Math.max(...sigma));
    const safe = sigma.map(s => Math.max(s, 1e-3));
    for (const [from, to, axis] of [[src, tmp, [1, 0]], [tmp, dst, [0, 1]]]) {
      this.bind(p, { uSrc: from.tex });
      gl.uniform3fv(gl.getUniformLocation(p, 'uSigma'), safe);
      gl.uniform2iv(gl.getUniformLocation(p, 'uAxis'), axis);
      gl.uniform1i(gl.getUniformLocation(p, 'uRadius'), radius);
      this.draw(to);
    }
  }

  mix(a, ka, b, kb, dst) {
    const { gl } = this, p = this.programs.mix;
    this.bind(p, { uA: a.tex, uB: b.tex });
    gl.uniform3fv(gl.getUniformLocation(p, 'uKa'), ka);
    gl.uniform3fv(gl.getUniformLocation(p, 'uKb'), kb);
    this.draw(dst);
  }

  // scatter then multi-bounce halation, following spektrafilm's apply_halation_um, on linear exposure
  halation(h) {
    const px = FILM_WIDTH_UM / Math.max(this.w, this.h), um = v => v.map(x => x / px);
    const [raw, t1, t2, t3] = this.targets, one = [1, 1, 1], zero = [0, 0, 0], w = h.scatter_tail_weight;
    this.blur(raw, um(h.scatter_core_um), t1, t2);
    this.mix(t2, w.map(x => 1 - x), t2, zero, t3);
    let scattered = t3, spare = t1;
    for (const [amplitude, ratio] of SCATTER_TAIL_FIT) {
      this.blur(raw, um(h.scatter_tail_um).map(x => x * ratio), spare, t2);
      this.mix(scattered, one, t2, w.map(x => x * amplitude), spare);
      [scattered, spare] = [spare, scattered];
    }
    const n = h.halation_n_bounces, decay = Array.from({ length: n }, (_, k) => h.halation_bounce_decay ** k);
    const total = decay.reduce((a, b) => a + b, 0);
    let sum = null, free = [raw, spare, t2];
    for (let k = 1; k <= n; k++) {
      const [scratch, dst, third] = free, wk = decay[k - 1] / total, wv = [wk, wk, wk];
      this.blur(scattered, um(h.halation_first_sigma_um).map(x => x * Math.sqrt(k)), scratch, dst);
      if (sum) { this.mix(sum, one, dst, wv, scratch); free = [sum, dst]; sum = scratch; }
      else { this.mix(dst, wv, dst, zero, third); free = [scratch, dst]; sum = third; }
    }
    const a = h.halation_strength, norm = h.halation_renormalize ? a.map(x => 1 / (1 + x)) : one;
    this.mix(scattered, norm, sum, a.map((x, i) => x * norm[i]), free[0]);
    return free[0];
  }

  expose(stock, halationOn) {
    const key = `${stock.head.id}:${halationOn}:${this.w}`;
    if (this.exposedKey === key) return;
    const { gl } = this, p = this.programs.expose;
    this.bind(p, { uSrc: this.src, uL1: stock.gpu.l1 }, { uL1: true });
    gl.uniform1f(gl.getUniformLocation(p, 'uLast'), stock.head.size - 1);
    this.draw(this.targets[0]);
    this.exposed = halationOn && stock.head.halation.active ? this.halation(stock.head.halation) : this.targets[0];
    this.exposedKey = key;
  }

  render(id, s) {
    const { gl } = this, stock = this.stocks.get(id), { head, gpu } = stock, p = this.programs.develop;
    this.expose(stock, s.halation);
    const slide = head.slide;
    const tex = { uExposed: this.exposed.tex, uGrainLut: stock.lut, uL2: gpu.l2, uL3: slide ? gpu.scan : gpu.l3,
                  uL4: slide ? gpu.scan : gpu.l4, uDy: slide ? gpu.scan : gpu.dy, uDm: slide ? gpu.scan : gpu.dm };
    this.bind(p, tex, { uL2: true, uL3: true, uL4: true, uDy: true, uDm: true });
    const u = n => gl.getUniformLocation(p, n), { min, max } = head.wires.cmy_film;
    gl.uniform1f(u('uLast'), head.size - 1);
    gl.uniform1f(u('uEvLog'), s.ev * Math.log10(2));
    gl.uniform1f(u('uPrintLog'), s.print * Math.log10(2) + compensation(head, s.ev));
    gl.uniform1f(u('uY'), s.y); gl.uniform1f(u('uM'), s.m);
    gl.uniform1f(u('uGrainScale'), s.grain ? Math.max(this.w, this.h) / head.grain.edge : 0);
    gl.uniform1i(u('uSlide'), slide ? 1 : 0);
    gl.uniform1ui(u('uSeed'), 1009);
    gl.uniform2fv(u('uFilmWire'), head.wires.log_e_film);
    gl.uniform2fv(u('uPrintWire'), head.wires.log_e_print || [0, 1]);
    gl.uniform3fv(u('uDensMin'), min); gl.uniform3fv(u('uDensMax'), max);
    gl.uniform3fv(u('uKernel'), stock.kernel);
    this.draw(null);
  }
}

// the printer corrects for camera exposure, as spektrafilm does by default, so EV moves the film and not the brightness
function compensation(head, ev) {
  const c = head.print_compensation;
  if (!c) return 0;
  const x = Math.min(c.ev.length - 1.001, Math.max(0, (ev - c.ev[0]) / (c.ev[1] - c.ev[0]))), i = Math.floor(x);
  return c.offset[i] + (x - i) * (c.offset[i + 1] - c.offset[i]);
}
