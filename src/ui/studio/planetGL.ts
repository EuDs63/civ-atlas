/**
 * 新建世界里那颗星球的 WebGL 部分(WebGL 1,手机上也有):网格、两组投影位置、样式贴图、板块漂移的帧缓冲。
 * 算法和着色器在 render/planet.ts;这里只管显卡上的东西,画哪一帧由调用的人给(PlanetFrame)。
 *
 *   样式贴图   按键存(世界编号 + 画风键);同一时间最多留几张,旧世界的随时扔掉
 *   板块漂移   每帧先把"t 时刻的实景"画进一张 1024×512 的等距圆柱贴图,再当成样式贴图铺到网格上
 *   标记层     助手要改的地方(白圈 + 编号),一张透明贴图盖在最上面
 *
 * 显卡不支持、着色器编不过 → create 返回 null(新建界面退回平面地图);画的过程中显卡丢了(context lost)→ onLost。
 */
import {
  DRIFT_VS,
  PLANET_FS,
  PLANET_NX,
  PLANET_NY,
  PLANET_VS,
  PLATE_MAX,
  driftLoop,
  driftShader,
  planetLayout,
  planetMesh,
  type PlanetLayout,
  type PlanetMesh,
  type PlanetProjection,
} from '../../render/planet';

/** 一帧画什么:两种投影之间变形到哪、卷了多少、在屏幕上多大、转到哪、用哪两张样式贴图 */
export interface PlanetFrame {
  projA: PlanetProjection;
  projB: PlanetProjection;
  /** 0 = 全是 A 的位置,1 = 全是 B */
  s: number;
  /** 0 = 平面,1 = 卷成球 */
  m: number;
  /** 每个单位多少 CSS 像素(地球仪 = 半径) */
  k: number;
  /** 图的中心(CSS 像素,画布左上为原点) */
  cx: number;
  cy: number;
  /** 绕球心往前俯仰(弧度,只在卷起来时起作用) */
  tilt: number;
  /** 正中那条经线(弧度) */
  lon: number;
  /** 两张样式贴图的键;mix = 1 全是 a */
  a: string;
  b: string;
  mix: number;
  /** 板块漂移到哪(0 最早,1 今天);null = 不放漂移 */
  drift: number | null;
  /** 漂移用哪张实景贴图(键) */
  real: string;
  markA: number;
}

/** 漂移那张贴图的大小(等距圆柱) */
const DRIFT_W = 1024;
const DRIFT_H = 512;

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, vs);
  const f = mk(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;
function uniforms(gl: WebGLRenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}

export class PlanetGL {
  readonly gl: WebGLRenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** 样式贴图的边长上限(手机上 1024 × 512,省显存) */
  readonly texW: number;
  private prog: WebGLProgram;
  private u: Uniforms;
  private mesh: PlanetMesh;
  private layouts = new Map<PlanetProjection, PlanetLayout>();
  private llBuffer: WebGLBuffer;
  private bufA: WebGLBuffer;
  private bufB: WebGLBuffer;
  private pair = '';
  private nIndex: number;
  private tex = new Map<string, WebGLTexture>();
  private blank: WebGLTexture;
  private mark: WebGLTexture | null = null;
  private plates: WebGLTexture | null = null;
  private rot = new Float32Array(PLATE_MAX * 4);
  private plateCount = 0;
  private drift: { prog: WebGLProgram; u: Uniforms; n: number; fbo: WebGLFramebuffer; tex: WebGLTexture; buf: WebGLBuffer } | null = null;
  private driftFailed = false;
  private maxFrag: number;
  private lost = false;
  onLost: (() => void) | null = null;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;

  static create(canvas: HTMLCanvasElement, opts: { small?: boolean } = {}): PlanetGL | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false, depth: true, powerPreference: 'high-performance' });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const prog = compile(gl, PLANET_VS, PLANET_FS);
    if (!prog) return null;
    try {
      return new PlanetGL(gl, canvas, prog, !!opts.small);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGLRenderingContext, canvas: HTMLCanvasElement, prog: WebGLProgram, small: boolean) {
    this.gl = gl;
    this.canvas = canvas;
    this.prog = prog;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.texW = small || maxTex < 4096 ? 1024 : 2048;
    this.maxFrag = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number;
    this.u = uniforms(gl, prog, ['u_s', 'u_m', 'u_k', 'u_tilt', 'u_c', 'u_view', 'u_a', 'u_b', 'u_mark', 'u_mix', 'u_lon', 'u_markA']);
    this.mesh = planetMesh(PLANET_NX, PLANET_NY);
    gl.useProgram(prog);
    const buf = (data: Float32Array, name: string, usage: number) => {
      const b = gl.createBuffer();
      if (!b) throw new Error('buffer');
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      return b;
    };
    this.llBuffer = buf(this.mesh.ll, 'a_ll', gl.STATIC_DRAW);
    const eq = this.layout('equirect').pos;
    this.bufA = buf(eq, 'a_pa', gl.DYNAMIC_DRAW);
    this.bufB = buf(eq, 'a_pb', gl.DYNAMIC_DRAW);
    this.pair = 'equirect|equirect';
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.index, gl.STATIC_DRAW);
    this.nIndex = this.mesh.index.length;
    this.blank = this.makeTexture(null, { w: 1, h: 1, px: new Uint8Array([16, 40, 72, 255]), nearest: true });
    canvas.addEventListener('webglcontextlost', this.lostHandler, false);
  }

  private lostHandler = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.onLost?.();
  };

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /** 某种投影下网格的位置(算一次存着) */
  layout(id: PlanetProjection): PlanetLayout {
    let l = this.layouts.get(id);
    if (!l) {
      l = planetLayout(this.mesh, id);
      this.layouts.set(id, l);
    }
    return l;
  }

  private makeTexture(
    src: TexImageSource | null,
    o: { w?: number; h?: number; px?: Uint8Array; nearest?: boolean; mip?: boolean } = {},
  ): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error('texture');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, o.nearest ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
    if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, o.w ?? 1, o.h ?? 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, o.px ?? null);
    const mip = !o.nearest && o.mip !== false;
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.nearest ? gl.NEAREST : mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.nearest ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** 把画布缩成贴图的大小(2 的幂;原图已经是这么大就直接用) */
  private fit(src: HTMLCanvasElement | HTMLImageElement | ImageBitmap): TexImageSource {
    const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
    const tw = Math.min(this.texW, w >= 2048 ? 2048 : 1024);
    const th = tw / 2;
    if (w === tw && h === th) return src;
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const ctx = c.getContext('2d');
    if (!ctx) return src;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    return c;
  }

  hasStyle(key: string): boolean {
    return this.tex.has(key);
  }

  /** 放进(或换掉)一张样式贴图;src 是等距圆柱整张图 */
  setStyle(key: string, src: HTMLCanvasElement | HTMLImageElement | ImageBitmap): void {
    if (this.isLost) return;
    const old = this.tex.get(key);
    if (old) this.gl.deleteTexture(old);
    this.tex.set(key, this.makeTexture(this.fit(src)));
  }

  /** 只留下这几张样式贴图(换了世界:旧世界的扔掉) */
  keepStyles(keep: (key: string) => boolean): void {
    for (const [k, t] of this.tex) {
      if (keep(k)) continue;
      this.gl.deleteTexture(t);
      this.tex.delete(k);
    }
  }

  /** 板块:每个像素的板块编号、陆地、大陆板块(plateTexels 的结果)+ 每块的转轴 */
  setPlates(px: Uint8Array, w: number, h: number, rot: Float32Array, count: number): void {
    if (this.isLost) return;
    if (this.plates) this.gl.deleteTexture(this.plates);
    this.plates = this.makeTexture(null, { w, h, px, nearest: true });
    this.rot = rot;
    this.plateCount = Math.min(count, PLATE_MAX);
  }

  /** 能不能放板块漂移(有板块数据、这台设备的着色器编得过) */
  canDrift(): boolean {
    return !!this.plates && this.plateCount > 0 && !!this.ensureDrift();
  }

  private ensureDrift() {
    if (this.driftFailed) return null;
    const n = driftLoop(this.plateCount, this.maxFrag);
    if (!n) return null;
    if (this.drift && this.drift.n >= n) return this.drift;
    const gl = this.gl;
    if (this.drift) {
      gl.deleteProgram(this.drift.prog);
      gl.deleteFramebuffer(this.drift.fbo);
      gl.deleteTexture(this.drift.tex);
      gl.deleteBuffer(this.drift.buf);
      this.drift = null;
    }
    const prog = compile(gl, DRIFT_VS, driftShader(n));
    if (!prog) {
      this.driftFailed = true;
      return null;
    }
    const tex = this.makeTexture(null, { w: DRIFT_W, h: DRIFT_H, mip: false });
    const fbo = gl.createFramebuffer();
    const buf = gl.createBuffer();
    if (!fbo || !buf) {
      this.driftFailed = true;
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      this.driftFailed = true;
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.drift = { prog, u: uniforms(gl, prog, ['u_real', 'u_plates', 'u_rot', 'u_t', 'u_count']), n, fbo, tex, buf };
    return this.drift;
  }

  /** 标记层(等距圆柱、和世界一样比例的透明画布);null = 去掉 */
  setMark(src: HTMLCanvasElement | null): void {
    if (this.isLost) return;
    if (this.mark) this.gl.deleteTexture(this.mark);
    this.mark = src ? this.makeTexture(this.fit(src)) : null;
  }

  /** 画布的 CSS 大小变了(像素按 devicePixelRatio,最多 2 倍) */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(2, Math.max(1, dpr));
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private setPair(a: PlanetProjection, b: PlanetProjection) {
    const key = `${a}|${b}`;
    if (key === this.pair) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufA);
    gl.bufferData(gl.ARRAY_BUFFER, this.layout(a).pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufB);
    gl.bufferData(gl.ARRAY_BUFFER, this.layout(b).pos, gl.DYNAMIC_DRAW);
    this.pair = key;
  }

  /** 漂移那一遍:t 时刻的实景画进帧缓冲,返回那张贴图;放不了 = null */
  private renderDrift(t: number, realKey: string): WebGLTexture | null {
    const real = this.tex.get(realKey);
    const d = real && this.plates ? this.ensureDrift() : null;
    if (!d || !real || !this.plates) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, d.fbo);
    gl.viewport(0, 0, DRIFT_W, DRIFT_H);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(d.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, d.buf);
    const loc = gl.getAttribLocation(d.prog, 'a_xy');
    // 网格那套程序也用了 0~2 号属性:这里只开 a_xy 那一个
    for (let i = 0; i < 3; i++) if (i !== loc) gl.disableVertexAttribArray(i);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, real);
    // 漂移里每块板块的取样位置在板块边上是断开的,mipmap 会按断开处选到最糊的一层:这一遍不用 mipmap
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.uniform1i(d.u.u_real, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.plates);
    gl.uniform1i(d.u.u_plates, 1);
    gl.uniform4fv(d.u.u_rot, this.rot.subarray(0, d.n * 4));
    gl.uniform1f(d.u.u_t, t);
    gl.uniform1i(d.u.u_count, this.plateCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, real);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 回到网格那套程序的属性
    gl.useProgram(this.prog);
    this.rebind();
    return d.tex;
  }

  private rebind() {
    const gl = this.gl;
    const bind = (b: WebGLBuffer | null, name: string) => {
      const loc = gl.getAttribLocation(this.prog, name);
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };
    bind(this.llBuffer, 'a_ll');
    bind(this.bufA, 'a_pa');
    bind(this.bufB, 'a_pb');
  }

  /** 画一帧;贴图还没准备好就只清空 */
  draw(f: PlanetFrame): void {
    if (this.isLost) return;
    const gl = this.gl;
    let ta = this.tex.get(f.a) ?? null;
    const tb = this.tex.get(f.b) ?? ta;
    let mix = f.mix;
    if (f.drift !== null && f.drift < 1) {
      const d = this.renderDrift(f.drift, f.real);
      if (d) {
        ta = d;
        mix = 1;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!ta) return;
    gl.useProgram(this.prog);
    this.setPair(f.projA, f.projB);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const u = this.u;
    const dpr = this.dpr;
    gl.uniform1f(u.u_s, f.s);
    gl.uniform1f(u.u_m, f.m);
    gl.uniform1f(u.u_k, f.k * dpr);
    gl.uniform1f(u.u_tilt, f.tilt);
    gl.uniform2f(u.u_c, f.cx * dpr, f.cy * dpr);
    gl.uniform2f(u.u_view, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_mix, mix);
    gl.uniform1f(u.u_lon, f.lon);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta);
    gl.uniform1i(u.u_a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tb ?? ta);
    gl.uniform1i(u.u_b, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.mark ?? this.blank);
    gl.uniform1i(u.u_mark, 2);
    gl.uniform1f(u.u_markA, this.mark ? f.markA : 0);
    gl.drawElements(gl.TRIANGLES, this.nIndex, gl.UNSIGNED_SHORT, 0);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.lostHandler, false);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
