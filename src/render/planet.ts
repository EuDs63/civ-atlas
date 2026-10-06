/**
 * 新建世界里的星球:一张经纬网格,在几种投影和地球仪之间连续变形(换投影、平面卷成地球仪都是动画)。
 *
 * 做法:
 *   - 网格:经度 NX 格 × 纬度 NY 格的顶点,每个顶点记它的经纬度(相对中央经线)
 *   - 每种平面投影事先算好每个顶点在投影平面上的位置(伪圆柱:x = kx(φ) · λ,y = y(φ),和平常地图同一套公式);
 *     换投影 = 两组位置之间插值
 *   - 地球仪 = 把等距圆柱平面按半径 1/m 往后卷:m = 0 是平面,m = 1 正好卷成单位球。卷的过程中经纬度不变,
 *     贴图照样按经纬度取色,所以"平面 → 地球仪"是一张纸弯成球,不是两张图淡入淡出
 *   - 板块漂移(开场动画):每块板块绕自己的欧拉极往回转一段角度(最多 DRIFT_MAX),再放回今天的位置。
 *     片元着色器对每个点试每块板块:"这块板块转回去以后,它原来在哪"—— 查到的位置正好属于这块板块就取那里的颜色;
 *     几块都落到这一点时陆地盖住海、大陆盖住洋壳。只是演示,不改生成的世界
 *
 * 坐标和平常的地图一致(见 globe.ts 文件头):经度 −π…π,世界 x = 0 是 180° 经线;纬度 = π/2 − y / 高 × π;
 * 三维单位向量 p = (cos 纬 cos 经, cos 纬 sin 经, sin 纬)。
 *
 * 纯计算 + 着色器源码,不碰 DOM;WebGL 的部分在 ui/studio/planetGL.ts。
 */
import { PROJECTIONS, type ProjectionId } from './projection';

export type PlanetProjection = ProjectionId | 'globe';

/** 网格:经度方向格数、纬度方向格数(顶点数 (NX+1)(NY+1) < 65536,用 16 位下标) */
export const PLANET_NX = 180;
export const PLANET_NY = 90;
/** 板块往回转的最大角度(弧度,约 30°);转得最快的板块转这么多,其余按速度比例 */
export const DRIFT_MAX = 0.55;
/** 着色器里最多试多少块板块(世界参数里板块数最多 60) */
export const PLATE_MAX = 64;

export interface PlanetMesh {
  /** 每个顶点的(相对经度, 纬度),弧度 */
  ll: Float32Array;
  /** 三角形下标 */
  index: Uint16Array;
  vertexCount: number;
}

export function planetMesh(nx = PLANET_NX, ny = PLANET_NY): PlanetMesh {
  const nv = (nx + 1) * (ny + 1);
  const ll = new Float32Array(nv * 2);
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const o = (j * (nx + 1) + i) * 2;
      ll[o] = -Math.PI + (2 * Math.PI * i) / nx;
      ll[o + 1] = Math.PI / 2 - (Math.PI * j) / ny;
    }
  const index = new Uint16Array(nx * ny * 6);
  let o = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      index[o++] = a;
      index[o++] = c;
      index[o++] = b;
      index[o++] = b;
      index[o++] = c;
      index[o++] = d;
    }
  return { ll, index, vertexCount: nv };
}

/** 一种投影下每个顶点的位置(投影平面,单位球),和整张图的宽高 */
export interface PlanetLayout {
  pos: Float32Array;
  w: number;
  h: number;
}

/**
 * 顶点在某种投影下的位置。地球仪给的是等距圆柱的位置(着色器再按 m 卷起来),宽高按卷好的球算(直径 2)。
 * 墨卡托两极画不出来:纬度截在它的 latMax,两头几行顶点挤在上下边上(那几行的颜色仍按真纬度取)。
 */
export function planetLayout(mesh: PlanetMesh, id: PlanetProjection): PlanetLayout {
  const n = mesh.vertexCount;
  const pos = new Float32Array(n * 2);
  if (id === 'globe') {
    pos.set(mesh.ll);
    return { pos, w: 2, h: 2 };
  }
  const def = PROJECTIONS[id];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let v = 0; v < n; v++) {
    const lam = mesh.ll[v * 2];
    const phi = Math.max(-def.latMax, Math.min(def.latMax, mesh.ll[v * 2 + 1]));
    const x = def.kx(phi) * lam;
    const y = def.y(phi);
    pos[v * 2] = x;
    pos[v * 2 + 1] = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { pos, w: x1 - x0, h: y1 - y0 };
}

/**
 * 板块漂移用的转轴表:每块板块一个 vec4(单位转轴 x, y, z, 最大转角)。
 * omega 是 tectonics 的角速度向量(每块 3 个数,方向 = 欧拉极,长度 = 转速);转得最快的转 DRIFT_MAX,其余按比例。
 */
export function plateRotations(omega: ArrayLike<number>, count: number): Float32Array {
  const n = Math.min(count, PLATE_MAX);
  const out = new Float32Array(PLATE_MAX * 4);
  let max = 0;
  for (let k = 0; k < n; k++) max = Math.max(max, Math.hypot(omega[3 * k], omega[3 * k + 1], omega[3 * k + 2]));
  if (!(max > 0)) return out;
  for (let k = 0; k < n; k++) {
    const x = omega[3 * k];
    const y = omega[3 * k + 1];
    const z = omega[3 * k + 2];
    const w = Math.hypot(x, y, z);
    if (!(w > 0)) {
      out.set([0, 0, 1, 0], k * 4);
      continue;
    }
    out.set([x / w, y / w, z / w, (w / max) * DRIFT_MAX], k * 4);
  }
  return out;
}

/**
 * 板块贴图的像素:R = 板块编号,G = 陆地 255 / 水 0,B = 大陆板块 255 / 洋壳 0,A = 255。
 * cell 是每个像素最近的地块(Raster.cell);按 (w, h) 取样(可以比 Raster 小:隔行隔列取)。
 */
export function plateTexels(
  cell: Int32Array,
  rw: number,
  rh: number,
  plate: ArrayLike<number>,
  water: ArrayLike<number>,
  continental: ArrayLike<number>,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(rh - 1, Math.floor(((y + 0.5) / h) * rh));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(rw - 1, Math.floor(((x + 0.5) / w) * rw));
      const c = cell[sy * rw + sx];
      const k = plate[c];
      const o = (y * w + x) * 4;
      out[o] = Math.min(255, k);
      out[o + 1] = water[c] === 0 ? 255 : 0;
      out[o + 2] = continental[k] ? 255 : 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** 把经度差取到 (−π, π] */
export function wrapPi(a: number): number {
  const t = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

// ---------------------------------------------------------------------------
// 着色器(WebGL 1 / GLSL ES 1.0)

/**
 * 顶点:位置在 a_pa、a_pb 两种投影之间按 u_s 插值;u_m > 0 时按半径 1/u_m 往后卷;再绕球心(0,0,−1)俯仰 u_tilt。
 * 光照只在卷起来时有(平面地图不打光):朗伯 + 边缘压暗,和地球仪视图差不多的观感。
 */
export const PLANET_VS = `
attribute vec2 a_ll;
attribute vec2 a_pa;
attribute vec2 a_pb;
uniform float u_s, u_m, u_k, u_tilt;
uniform vec2 u_c, u_view;
varying vec2 v_ll;
varying float v_light;
void main() {
  vec2 p = mix(a_pa, a_pb, u_s);
  vec3 q;
  vec3 n;
  if (u_m < 0.0005) {
    q = vec3(p, 0.0);
    n = vec3(0.0, 0.0, 1.0);
  } else {
    float r = 1.0 / u_m;
    // 东西方向比南北方向先合拢(卷到 0.94 时背后的缝已经合上),快卷好时从北极的口里看进去不会看穿到背后
    float mx = min(1.0, u_m + 0.06 * smoothstep(0.5, 0.94, u_m));
    n = vec3(cos(u_m * p.y) * sin(mx * p.x), sin(u_m * p.y), cos(u_m * p.y) * cos(mx * p.x));
    q = r * n - vec3(0.0, 0.0, r);
  }
  float ct = cos(u_tilt), st = sin(u_tilt);
  vec3 c = vec3(0.0, 0.0, -1.0);
  vec3 d = q - c;
  q = vec3(d.x, d.y * ct - d.z * st, d.y * st + d.z * ct) + c;
  n = vec3(n.x, n.y * ct - n.z * st, n.y * st + n.z * ct);
  vec3 L = normalize(vec3(-0.45, 0.5, 0.75));
  float lam = max(dot(n, L), 0.0);
  float limb = 0.6 + 0.4 * smoothstep(0.0, 0.55, n.z);
  v_light = mix(1.0, (0.38 + 0.78 * lam) * limb, u_m);
  v_ll = a_ll;
  vec2 s = u_c + vec2(q.x, -q.y) * u_k;
  gl_Position = vec4(s.x / u_view.x * 2.0 - 1.0, 1.0 - s.y / u_view.y * 2.0, -q.z * 0.3 - 0.4, 1.0);
}`;

/**
 * 片元:按经纬度取两张样式贴图混合(u_mix = 1 全是 u_a);叠上标记层(助手要改的地方,不受光照)。
 * 经度不取模:贴图横向是 REPEAT,网格上经度连续,接缝处不会因为取模算错 mipmap 层而出一道细线。
 * 板块漂移时 u_a 换成漂移那一遍画出来的贴图(driftShader),这里不用管。
 */
export const PLANET_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_a, u_b, u_mark;
uniform float u_mix, u_lon, u_markA;
varying vec2 v_ll;
varying float v_light;
const float PI = 3.14159265;
void main() {
  vec2 uv = vec2((v_ll.x + u_lon + PI) / (2.0 * PI), (0.5 * PI - v_ll.y) / PI);
  vec3 c = mix(texture2D(u_b, uv).rgb, texture2D(u_a, uv).rgb, u_mix);
  vec3 o = c * v_light;
  if (u_markA > 0.001) {
    vec4 mk = texture2D(u_mark, uv);
    o = mix(o, mk.rgb, mk.a * u_markA);
  }
  gl_FragColor = vec4(o, 1.0);
}`;

/** 漂移那一遍:铺满一张等距圆柱贴图的三角形 */
export const DRIFT_VS = `
attribute vec2 a_xy;
varying vec2 v_uv;
void main() {
  v_uv = a_xy * 0.5 + 0.5;
  gl_Position = vec4(a_xy, 0.0, 1.0);
}`;

/**
 * 漂移那一遍的片元:这个像素(今天的经纬度)在 t 时刻(u_t:0 = 最早,1 = 今天)是哪块板块的哪里。
 * 每块板块:把这一点绕它的转轴转 θ(1 − t),查板块贴图,正好是这块板块就算一个候选;陆地优先、大陆板块优先。
 * 没有候选(板块之间裂开的地方)= 深海色。
 * 贴图的第 0 行是北边(和画布一样从上往下),画到帧缓冲里 v_uv.y = 0 那一行也要是北,所以纬度 = (0.5 − y)π。
 * n = 循环几块(GLSL ES 1.0 的循环次数要是常数):按板块数取 16 的倍数,手机上统一变量不够时少编一些。
 */
export function driftShader(n: number): string {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_real, u_plates;
uniform vec4 u_rot[${n}];
uniform float u_t;
uniform int u_count;
varying vec2 v_uv;
const float PI = 3.14159265;
void main() {
  float lon = v_uv.x * 2.0 * PI - PI;
  float lat = (0.5 - v_uv.y) * PI;
  vec3 p = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float best = -1.0;
  vec3 col = vec3(0.10, 0.27, 0.46);
  for (int k = 0; k < ${n}; k++) {
    if (k >= u_count) break;
    vec4 r = u_rot[k];
    float th = r.w * (1.0 - u_t);
    float cs = cos(th), sn = sin(th);
    vec3 q = p * cs + cross(r.xyz, p) * sn + r.xyz * dot(r.xyz, p) * (1.0 - cs);
    vec2 uv = vec2((atan(q.y, q.x) + PI) / (2.0 * PI), (0.5 * PI - asin(clamp(q.z, -1.0, 1.0))) / PI);
    vec4 pl = texture2D(u_plates, uv);
    if (abs(pl.r * 255.0 - float(k)) < 0.5) {
      float score = pl.g * 2.0 + pl.b;
      if (score > best) {
        best = score;
        col = texture2D(u_real, uv).rgb;
      }
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;
}

/** 漂移着色器循环几块:板块数往上取 16 的倍数(最多 PLATE_MAX);统一变量放不下(手机上可能只有 64 个)就返回 0 = 不放漂移 */
export function driftLoop(count: number, maxUniforms: number): number {
  const n = Math.min(PLATE_MAX, Math.max(16, Math.ceil(count / 16) * 16));
  return n + 8 <= maxUniforms ? n : 0;
}

/**
 * 陆地最集中的那条经线(弧度,−π … π):开场把它摆在正中,卷成地球仪时正对着人的是大陆而不是一片海。
 * px 是 plateTexels 的结果(G 通道 = 陆地);只看纬度 ±60° 以内、按 cos 纬度加权,前后各约 40° 平滑以后取最大
 * (平滑时离得越近权重越大:一块比 80° 窄的大陆取到它正中,而不是它西边的边)。
 */
export function landCenterLon(px: Uint8Array, w: number, h: number): number {
  const col = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    if (Math.abs(lat) > Math.PI / 3) continue;
    const wt = Math.cos(lat);
    for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 1] > 127) col[x] += wt;
  }
  const r = Math.max(1, Math.round((w * 40) / 360));
  let best = -1;
  let bx = 0;
  // 三角形权重的窗口(东西相连)
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += col[(((x + i) % w) + w) % w] * (r + 1 - Math.abs(i));
    if (s > best) {
      best = s;
      bx = x;
    }
  }
  return ((bx + 0.5) / w) * 2 * Math.PI - Math.PI;
}
