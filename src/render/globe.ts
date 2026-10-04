/**
 * 3D 地球仪(正射投影):把等距圆柱主图(地形画风 + 文明层)当贴图贴到球上。
 *
 * 做法:画一个铺满画布的三角形,片元着色器对每个像素反算"它看到球上哪一点"(正射反投影 + 旋转),
 * 再去等距圆柱贴图里取色 —— 没有球体网格,两极、180° 经线处都没有三角形接缝。
 *
 *   - 视图:中心经纬度(弧度)+ 缩放 k。"北在上":不滚转,中心纬度夹在 ±90° 以内
 *   - 贴图层级自己算(textureGrad,按反投影的解析导数):180° 经线处的经度从 +180° 跳到 −180°,
 *     显卡自己求导会以为这里要用最模糊的一层,画出一道细线;两极一整行收成一个点,横向导数无穷大,
 *     按纵向导数的 ANISO 倍封顶,不糊成一片
 *   - 贴图:地形(当前画风;放大到 GLOBE_HD_ZOOM 倍以上换 2× 的那张)、文明底图、选中层、高亮层(编年史闪烁)、回放帧、
 *     水面蒙版(写实风的海面反光)、坡度(写实风重新打光用)
 *   - 外观:写实 = 夜空 + 星星 + 大气光晕 + 海面反光;手绘 = 纸色底、墨线外框、投影、暗面排线;数据图层 = 深灰底
 *   - 写实风的地貌明暗(relief):地形贴图是不打光的底色,另传一张坡度(细节晕渲、大尺度晕渲各两个方向),
 *     按"光从屏幕左上方来、高度角和平面主图一样"在着色器里算明暗 —— 平面主图的光是按地图的西北烤进去的,
 *     包到球上转到两极,一半的地形光从背后来,出现暗块;重新打光以后从哪个角度看都一致,正对着看时和平面主图几乎一样
 *   - 经纬网在着色器里画(按屏幕像素定线宽,放大不变粗)
 *
 * 没有 WebGL2 时 renderGlobeCpu 在 CPU 上按同样的公式逐像素画(慢一些,拖动时降分辨率)。
 * 这里的数学函数(屏幕 ↔ 经纬度、拖动、缩放)是纯计算,单测在 Node 里跑。
 *
 * 坐标约定(和主图一致,见 ui/mapWrap.ts):经度 −180°…180°,世界 x = 0 是 180° 经线,主图正中是 0°;
 * 纬度 = 90° − y / 高 × 180°。三维单位向量 p = (cos 纬 cos 经, cos 纬 sin 经, sin 纬)。
 */

import { RELIEF_DETAIL_W, RELIEF_MACRO_W, RELIEF_SEA_W, SLOPE_MAX } from './realistic';

export type Vec3 = [number, number, number];

/** 地球仪视图:中心经纬度(弧度)、缩放倍数(1 = 整个球放进舞台) */
export interface GlobeView {
  lon: number;
  lat: number;
  k: number;
}

/** 屏幕上的球:画布大小、球心、半径(同一种像素单位:CSS 像素或画布像素) */
export interface GlobeFrame {
  w: number;
  h: number;
  cx: number;
  cy: number;
  R: number;
}

export const GLOBE_K_MIN = 0.55;
export const GLOBE_K_MAX = 8;
/** 缩放 1 倍时球的半径 = 舞台短边 × 这个比例 */
export const GLOBE_FILL = 0.43;
/** 打开地球仪时的默认视图:中心纬度(北纬 18°,略微俯视) */
export const GLOBE_DEFAULT_LAT = (18 * Math.PI) / 180;

const PI = Math.PI;
const TAU = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** 经度差取到 (−π, π] */
export function wrapAngle(a: number): number {
  const v = (((a + PI) % TAU) + TAU) % TAU;
  return v - PI === -PI ? PI : v - PI;
}

export function clampView(v: GlobeView): GlobeView {
  return { lon: wrapAngle(v.lon), lat: clamp(v.lat, -HALF_PI, HALF_PI), k: clamp(v.k, GLOBE_K_MIN, GLOBE_K_MAX) };
}

/**
 * 画布上的球:球心在画布正中稍偏上(下面有时间轴),半径按短边和缩放倍数。
 * shift = 球心横向挪多少(和 w、h 同一种像素单位;右侧的国家面板打开时往左挪半个面板宽,见 GLOBE_PANEL_SHIFT)
 */
export function globeFrame(v: GlobeView, w: number, h: number, shift = 0): GlobeFrame {
  return { w, h, cx: w / 2 + shift, cy: h * 0.48, R: GLOBE_FILL * Math.min(w, h) * v.k };
}

/** 右侧的国家面板打开时球心往左挪多少(CSS 像素):面板宽 360 的一半,球落在"去掉面板后的可见区域"正中 */
export const GLOBE_PANEL_SHIFT = -180;

/** 视图的三个方向(世界坐标):c = 朝着观察者(球心 → 视图中心),e = 屏幕右(中心处的东),n = 屏幕上(中心处的北) */
export function globeBasis(lon: number, lat: number): { c: Vec3; e: Vec3; n: Vec3 } {
  const cl = Math.cos(lat);
  const sl = Math.sin(lat);
  const co = Math.cos(lon);
  const so = Math.sin(lon);
  return { c: [cl * co, cl * so, sl], e: [-so, co, 0], n: [-sl * co, -sl * so, cl] };
}

export function lonLatToVec(lon: number, lat: number): Vec3 {
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

/** 屏幕坐标 → [经度, 纬度](弧度);不在球上 = null */
export function screenToLonLat(v: GlobeView, f: GlobeFrame, sx: number, sy: number): [number, number] | null {
  const u = (sx - f.cx) / f.R;
  const t = (f.cy - sy) / f.R;
  const r2 = u * u + t * t;
  if (!(r2 <= 1)) return null;
  const w = Math.sqrt(1 - r2);
  const { c, e, n } = globeBasis(v.lon, v.lat);
  const x = u * e[0] + t * n[0] + w * c[0];
  const y = u * e[1] + t * n[1] + w * c[1];
  const z = u * e[2] + t * n[2] + w * c[2];
  return [Math.atan2(y, x), Math.asin(clamp(z, -1, 1))];
}

/**
 * 经纬度 → 屏幕坐标 [x, y, 朝向];朝向 = 这一点的法向和视线的夹角余弦(1 = 正对着,0 = 球的边缘,< 0 = 背面)
 */
export function lonLatToScreen(v: GlobeView, f: GlobeFrame, lon: number, lat: number): [number, number, number] {
  const p = lonLatToVec(lon, lat);
  const { c, e, n } = globeBasis(v.lon, v.lat);
  const d = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
  const x = p[0] * e[0] + p[1] * e[1] + p[2] * e[2];
  const y = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  return [f.cx + f.R * x, f.cy - f.R * y, d];
}

/** 世界坐标(主图像素坐标,宽 W 高 H)→ 经纬度(弧度);x 可以超出 [0, W)(按整圈算) */
export function worldToLonLat(x: number, y: number, W: number, H: number): [number, number] {
  return [wrapAngle((x / W) * TAU - PI), HALF_PI - (y / H) * PI];
}

/** 经纬度 → 世界坐标(x 取到 [0, W)) */
export function lonLatToWorld(lon: number, lat: number, W: number, H: number): [number, number] {
  const t = (lon + PI) / TAU;
  return [(t - Math.floor(t)) * W, ((HALF_PI - lat) / PI) * H];
}

/** 屏幕坐标 → 等距圆柱主图上的像素(宽 w 高 h 的栅格);不在球上 = null */
export function screenToPixel(v: GlobeView, f: GlobeFrame, sx: number, sy: number, w: number, h: number): [number, number] | null {
  const ll = screenToLonLat(v, f, sx, sy);
  if (!ll) return null;
  const [x, y] = lonLatToWorld(ll[0], ll[1], w, h);
  return [Math.min(w - 1, Math.floor(x)), clamp(Math.floor(y), 0, h - 1)];
}

/**
 * 拖动:横着拖 dx 像素 = 绕地轴转 dx / R(赤道上正对着的地方跟着手走),竖着拖 = 俯仰(最多到极点正上方)
 */
export function dragView(v: GlobeView, R: number, dx: number, dy: number): GlobeView {
  return clampView({ lon: v.lon - dx / R, lat: v.lat + dy / R, k: v.k });
}

/**
 * 以屏幕上的 (sx, sy) 为中心缩放到 k2:那一点下面的地方缩放后还在那里(点在球外时按球心缩放)。shift 见 globeFrame
 */
export function zoomAt(v: GlobeView, w: number, h: number, sx: number, sy: number, k2: number, shift = 0): GlobeView {
  let next = clampView({ ...v, k: k2 });
  const ll = screenToLonLat(v, globeFrame(v, w, h, shift), sx, sy);
  if (!ll) return next;
  for (let i = 0; i < 4; i++) {
    const l2 = screenToLonLat(next, globeFrame(next, w, h, shift), sx, sy);
    if (!l2) break;
    const dl = wrapAngle(ll[0] - l2[0]);
    const db = ll[1] - l2[1];
    if (Math.abs(dl) + Math.abs(db) < 1e-7) break;
    next = clampView({ lon: next.lon + dl, lat: next.lat + db, k: next.k });
  }
  return next;
}

/**
 * 点选符号:屏幕上的一组点(d = 朝向,≤ 0 在背面),取离 (sx, sy) 最近、在 slop 像素以内、朝着观察者的那一个;没有 = −1
 */
export function pickGlobeMark(pts: readonly { x: number; y: number; d: number }[], sx: number, sy: number, slop: number): number {
  let best = -1;
  let bestD = slop;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!(p.d > 0)) continue;
    const dd = Math.hypot(p.x - sx, p.y - sy);
    if (dd <= bestD) {
      bestD = dd;
      best = i;
    }
  }
  return best;
}

/** 两个视图之间插值(经度走短边) */
export function lerpView(a: GlobeView, b: GlobeView, t: number): GlobeView {
  return {
    lon: wrapAngle(a.lon + wrapAngle(b.lon - a.lon) * t),
    lat: a.lat + (b.lat - a.lat) * t,
    k: a.k * Math.pow(b.k / a.k, t),
  };
}

/** 放大到这个倍数以上,才在后台铺两倍像素的高清地形贴图(缩放 1 倍看整个球时主图那张够用,不白费几秒钟的后台计算) */
export const GLOBE_HD_ZOOM = 1.5;

/**
 * 现在要不要去铺高清地形贴图:放大到 GLOBE_HD_ZOOM 倍以上,而且主图那张在屏幕上确实被放大了
 * (一个贴图像素超过一个屏幕像素;小屏幕上放大 1.5 倍也不一定需要)。
 * 已经铺好的(缩回去以后也留着)、正在铺的、铺失败过的、正在回放世界形成的,都不再铺
 */
export function wantHdTexture(o: {
  k: number;
  /** 主图那张贴图的一个像素在屏幕上占几个像素(赤道上) */
  texel: number;
  /** 这个画风的高清贴图已经有了 */
  have: boolean;
  /** 正在铺(任何一张) */
  pending: boolean;
  /** 这个画风铺失败过 */
  failed: boolean;
  replaying: boolean;
  /** 显卡最大贴图边长、两倍像素的贴图边长 */
  maxTexture: number;
  hdWidth: number;
}): boolean {
  if (o.have || o.pending || o.failed || o.replaying) return false;
  if (o.hdWidth > o.maxTexture) return false;
  return o.k >= GLOBE_HD_ZOOM && o.texel > 1;
}

/** "等效的主图缩放倍数":球上正中那一块的比例尺,换成主图(按 refCss 像素宽显示整圈)放大了几倍。符号、地名的显示门槛按它算 */
export function equivalentZoom(R: number, refCss: number): number {
  return (TAU * R) / refCss;
}

/**
 * 经纬网(给 CPU 画法、导出用;WebGL 画法在着色器里画):每 step 弧度一条,只画朝着观察者的那一半。
 * 返回屏幕折线(断在背面)
 */
export function graticuleLines(v: GlobeView, f: GlobeFrame, step: number): number[][] {
  const out: number[][] = [];
  const d = (2 * PI) / 180;
  const run = (pts: (t: number) => [number, number], t0: number, t1: number) => {
    let cur: number[] = [];
    for (let t = t0; t <= t1 + 1e-9; t += d) {
      const [lon, lat] = pts(t);
      const s = lonLatToScreen(v, f, lon, lat);
      if (s[2] > 0) cur.push(s[0], s[1]);
      else if (cur.length) {
        if (cur.length >= 4) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 4) out.push(cur);
  };
  const lim = HALF_PI - (10 * PI) / 180;
  for (let lon = -PI; lon < PI - 1e-9; lon += step) {
    const full = Math.abs(Math.round(lon / (PI / 2)) * (PI / 2) - lon) < 1e-6;
    run((t) => [lon, t], full ? -HALF_PI : -lim, full ? HALF_PI : lim);
  }
  for (let lat = -HALF_PI + step; lat < HALF_PI - 1e-9; lat += step) run((t) => [t, lat], -PI, PI);
  return out;
}

/** 经纬网间距:缩放越大越密(30° → 15° → 10°) */
export function graticuleStep(k: number): number {
  return ((k >= 4 ? 10 : k >= 2 ? 15 : 30) * PI) / 180;
}

/**
 * 写实风的地貌明暗(和着色器里的 relief 同一个公式;单测用):底色 c(0–255)、细节坡度 gd、大尺度坡度 gm(都是 [东, 南],
 * 见 realistic.ts 的 GlobeCapture)、是不是开阔水面、单位向量 p 和经纬度、视图的屏幕右 e / 屏幕上 n 方向 → 打好光的颜色
 */
export function reliefShade(c: Vec3, gd: [number, number], gm: [number, number], water: boolean, p: Vec3, lon: number, lat: number, e: Vec3, n: Vec3): Vec3 {
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  const sl = Math.sin(lat);
  const Ep: Vec3 = [-so, co, 0];
  const Np: Vec3 = [-sl * co, -sl * so, Math.cos(lat)];
  const Ls: Vec3 = [n[0] - e[0], n[1] - e[1], n[2] - e[2]];
  const lp = Ls[0] * p[0] + Ls[1] * p[1] + Ls[2] * p[2];
  let L: Vec3 = [Ls[0] - lp * p[0], Ls[1] - lp * p[1], Ls[2] - lp * p[2]];
  const tl = Math.hypot(L[0], L[1], L[2]);
  L = tl > 1e-4 ? [L[0] / tl, L[1] / tl, L[2] / tl] : Np;
  const LT = 0.736214;
  const LZ = 0.676753;
  const Lr: Vec3 = [(L[0] * LT + p[0] * LZ) / LZ, (L[1] * LT + p[1] * LZ) / LZ, (L[2] * LT + p[2] * LZ) / LZ];
  const shade = (g: [number, number]) => {
    const v: Vec3 = [-g[0] * Ep[0] + g[1] * Np[0] + p[0], -g[0] * Ep[1] + g[1] * Np[1] + p[1], -g[0] * Ep[2] + g[1] * Np[2] + p[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    return (v[0] * Lr[0] + v[1] * Lr[1] + v[2] * Lr[2]) / l;
  };
  const s = 1 + RELIEF_DETAIL_W * (shade(gd) - 1) + (water ? RELIEF_SEA_W : RELIEF_MACRO_W) * (shade(gm) - 1);
  let f: number;
  let cool = 0;
  if (s >= 1) f = Math.min(1.4, 1 + (s - 1) * 0.7);
  else {
    const a = 1 - Math.exp((s - 1) / 0.45);
    f = 1 - 0.45 * a;
    cool = 0.4 * a;
  }
  const sky: Vec3 = [60, 70, 90];
  return [0, 1, 2].map((i) => c[i] * f + (sky[i] - c[i] * f) * cool) as Vec3;
}

// ---------------------------------------------------------------------------
// 外观

export type GlobeStyle = 'realistic' | 'fantasy' | 'data';

export interface GlobeLook {
  style: GlobeStyle;
  /**
   * 写实风:地形贴图是不打光的底色,另有一张等效坡度(槽位 slope),着色器按屏幕方向重新打光(光从左上,
   * 高度角和平面主图一样)—— 转到两极也不会光从背后来。不给 / false = 贴图里已经烤好了明暗(CPU 画法、回放)
   */
  relief?: boolean;
  graticule: boolean;
  /** 高亮层(编年史点一条)的不透明度 0–1 */
  hl: number;
  /** 回放帧盖上去的程度 0–1 */
  replay: number;
}

/** 背景色(导出、CPU 画法、CSS 共用) */
export const GLOBE_BG: Record<GlobeStyle, string> = {
  realistic: '#070b14',
  fantasy: '#e6d8ba',
  data: '#0d0f12',
};

// ---------------------------------------------------------------------------
// WebGL2 画法

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec2 uCenter;
uniform float uR;
uniform float uDpr;
uniform vec3 uC;
uniform vec3 uE;
uniform vec3 uN;
uniform int uStyle;
uniform float uGrid;
uniform float uGridStep;
uniform float uHl;
uniform float uReplay;
uniform float uAniso;
uniform vec2 uTexSize;
uniform sampler2D uTerrain;
uniform sampler2D uCiv;
uniform sampler2D uSel;
uniform sampler2D uHlTex;
uniform sampler2D uReplayTex;
uniform sampler2D uWater;
uniform sampler2D uSlope;
uniform float uRelief;
out vec4 outColor;

const float PI = 3.141592653589793;
// 等效坡度的编码(和 realistic.ts 的 encodeSlope 一致):字节 → v ∈ [−1, 1] → 坡度 = sign(v) v² × SLOPE_MAX
const float SLOPE_MAX = ${SLOPE_MAX.toFixed(2)};
// 几样晕渲的权重(realistic.ts 的 RELIEF_*)
const float RELIEF_DETAIL_W = ${RELIEF_DETAIL_W.toFixed(4)};
const float RELIEF_MACRO_W = ${RELIEF_MACRO_W.toFixed(4)};
const float RELIEF_SEA_W = ${RELIEF_SEA_W.toFixed(4)};
// 平面主图的暗面天空色(realistic.ts 的 SKY_SHADOW)
const vec3 SKY_SHADOW = vec3(60.0, 70.0, 90.0) / 255.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 光在屏幕上固定:左上前方(和主图"光从西北来"一致)
const vec3 L = vec3(-0.4575, 0.5083, 0.7295);

// 写实风的地貌明暗:这一点的坡度 g(东、南两个方向,平面主图晕渲的单位)按"光从屏幕左上方来、高度角和平面主图一样"重新打光。
// 光的水平方向 = 屏幕左上方投到这一点的切平面上 —— 地球仪正中、北在上时就是平面主图的西北光,
// 转到两极、从哪个角度看都是左上方来的光,不会有一半地形光从背后来。明暗曲线(亮面提亮、暗面压暗混天空冷色)同 realistic.ts
vec3 relief(vec3 c, vec4 g, float water, vec3 p, float lon, float lat) {
  float so = sin(lon);
  float co = cos(lon);
  float sl = sin(lat);
  vec3 Ep = vec3(-so, co, 0.0);
  vec3 Np = vec3(-sl * co, -sl * so, cos(lat));
  vec3 Ls = uN - uE;
  vec3 Lt = Ls - dot(Ls, p) * p;
  float lt = length(Lt);
  Lt = lt > 1e-4 ? Lt / lt : Np;
  // (√2, 1.3) / √3.69:和 hillshade 的 (−1, −1, 1.3) 同一个高度角
  vec3 Lr = (Lt * 0.736214 + p * 0.676753) / 0.676753;
  // 细节晕渲、大尺度晕渲各算一次(平地 = 1),按平面主图的权重加起来
  float sd = dot(normalize(-g.x * Ep + g.y * Np + p), Lr);
  float sm = dot(normalize(-g.z * Ep + g.w * Np + p), Lr);
  float s = 1.0 + RELIEF_DETAIL_W * (sd - 1.0) + (water > 0.5 ? RELIEF_SEA_W : RELIEF_MACRO_W) * (sm - 1.0);
  float f;
  float cool = 0.0;
  if (s >= 1.0) f = min(1.4, 1.0 + (s - 1.0) * 0.7);
  else {
    float a = 1.0 - exp((s - 1.0) / 0.45);
    f = 1.0 - 0.45 * a;
    cool = 0.4 * a;
  }
  vec3 cf = c * f;
  return cf + (SKY_SHADOW - cf) * cool;
}

vec3 background(vec2 px, vec2 d, float r) {
  vec2 q = px / uDpr;
  vec2 m = px / uSize - 0.5;
  if (uStyle == 1) {
    // 纸:暖色、四角压暗、纤维噪声
    vec3 paper = vec3(0.905, 0.851, 0.735);
    float n = vnoise(q * 0.045) * 0.6 + vnoise(q * 0.21) * 0.4;
    paper *= 0.965 + 0.06 * n;
    paper = mix(paper, vec3(0.80, 0.70, 0.54), smoothstep(0.35, 0.95, length(m * vec2(1.25, 1.6))) * 0.55);
    // 球在纸上的投影(右下方,柔和)
    float sd = length(d - vec2(0.05, -0.07));
    paper *= 1.0 - 0.2 * smoothstep(1.16, 0.93, sd);
    return paper;
  }
  if (uStyle == 2) {
    vec3 bg = vec3(0.051, 0.059, 0.071);
    float g = exp(-max(r - 1.0, 0.0) * 18.0) * step(1.0, r);
    return bg + vec3(0.10, 0.12, 0.15) * g;
  }
  // 夜空:深蓝,越往四角越暗;星星按 CSS 像素撒(不同像素密度一样稀)
  vec3 bg = mix(vec3(0.032, 0.048, 0.086), vec3(0.008, 0.012, 0.024), smoothstep(0.1, 0.8, length(m * vec2(1.3, 1.0))));
  vec2 cell = floor(q / 3.0);
  float h = hash12(cell);
  if (h > 0.9955) {
    vec2 o = hash22(cell) * 3.0;
    float dd = length(q - cell * 3.0 - o);
    float b = (h - 0.9955) / 0.0045;
    bg += vec3(0.85, 0.9, 1.0) * (0.25 + 0.75 * b) * smoothstep(1.1, 0.2, dd);
  }
  // 大气光晕:朝着光的一侧亮一些
  if (r > 1.0) {
    float side = 0.65 + 0.35 * dot(normalize(d), normalize(L.xy));
    float g = exp(-(r - 1.0) * 11.0) * 0.85 * side;
    bg += vec3(0.28, 0.52, 1.0) * g;
  }
  return bg;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec2 d = (px - uCenter) / uR;
  d.y = -d.y;
  float r = length(d);
  vec3 bg = background(px, d, r);
  float cover = clamp((1.0 - r) * uR + 0.5, 0.0, 1.0);
  vec3 col = bg;
  if (cover > 0.0) {
    vec2 uv = r > 0.9995 ? d * (0.9995 / r) : d;
    float w = sqrt(max(0.0, 1.0 - dot(uv, uv)));
    vec3 p = uv.x * uE + uv.y * uN + w * uC;
    float lon = atan(p.y, p.x);
    float lat = asin(clamp(p.z, -1.0, 1.0));
    vec2 st = vec2((lon + PI) / (2.0 * PI), (0.5 * PI - lat) / PI);
    // 解析导数:屏幕右移 1 像素 → u 加 1/R;下移 1 像素 → v 减 1/R
    float wi = 1.0 / max(w, 0.02);
    vec3 dpu = uE - uv.x * wi * uC;
    vec3 dpv = uN - uv.y * wi * uC;
    float rho2 = max(p.x * p.x + p.y * p.y, 1e-10);
    float rho = sqrt(rho2);
    vec2 gu = vec2((p.x * dpu.y - p.y * dpu.x) / rho2 / (2.0 * PI), -dpu.z / rho / PI);
    vec2 gv = vec2((p.x * dpv.y - p.y * dpv.x) / rho2 / (2.0 * PI), -dpv.z / rho / PI);
    vec2 gx = gu / uR;
    vec2 gy = -gv / uR;
    vec2 gx0 = gx;
    vec2 gy0 = gy;
    // 两极:横向(经度方向)的取样范围按纵向的 uAniso 倍封顶(见 ANISO)
    float ls = length(vec2(gx.x, gy.x)) * uTexSize.x;
    float lt = max(length(vec2(gx.y, gy.y)) * uTexSize.y, 1e-4);
    if (ls > uAniso * lt) {
      float f = uAniso * lt / ls;
      gx.x *= f;
      gy.x *= f;
    }
    vec3 c = textureGrad(uTerrain, st, gx, gy).rgb;
    if (uRelief > 0.5) {
      vec4 e = textureGrad(uSlope, st, gx, gy) * 2.0 - 1.0;
      c = relief(c, sign(e) * e * e * SLOPE_MAX, textureGrad(uWater, st, gx, gy).r, p, lon, lat);
    }
    vec4 cv = textureGrad(uCiv, st, gx, gy);
    c = c * (1.0 - cv.a) + cv.rgb;
    vec4 sv = textureGrad(uSel, st, gx, gy);
    c = c * (1.0 - sv.a) + sv.rgb;
    if (uHl > 0.0) {
      vec4 hv = textureGrad(uHlTex, st, gx, gy) * uHl;
      c = c * (1.0 - hv.a) + hv.rgb;
    }
    if (uReplay > 0.0) c = mix(c, textureGrad(uReplayTex, st, gx, gy).rgb, uReplay);

    vec3 N = vec3(uv, w);
    float diff = max(dot(N, L), 0.0);
    float rim = 1.0 - w;
    if (uStyle == 0) {
      c *= 0.5 + 0.62 * diff;
      float water = textureGrad(uWater, st, gx, gy).r * (1.0 - uReplay);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      // 海面反光:一片柔和的亮光(不是一个刺眼的小白点)
      c += vec3(1.0, 0.96, 0.88) * pow(max(dot(N, H), 0.0), 26.0) * 0.13 * water;
      c = mix(c, vec3(0.50, 0.68, 0.96), pow(rim, 2.6) * 0.62);
    } else if (uStyle == 1) {
      c *= 0.84 + 0.22 * diff;
      c = mix(c, c * vec3(0.70, 0.58, 0.44), pow(rim, 2.0) * 0.6);
      // 暗面排线(铜版画那样的斜线)
      float dark = smoothstep(0.42, 0.12, diff);
      float line = smoothstep(0.35, 0.0, abs(fract((px.x + px.y) / (4.2 * uDpr)) - 0.5) * 2.0 - 0.35);
      c = mix(c, c * vec3(0.66, 0.56, 0.44), dark * line * 0.32);
    } else {
      c *= 0.72 + 0.36 * diff;
      c = mix(c, vec3(0.62, 0.66, 0.72), pow(rim, 3.0) * 0.35);
    }

    if (uGrid > 0.5) {
      float stp = uGridStep;
      float dl = abs(fract(lon / stp + 0.5) - 0.5) * stp;
      float db = abs(fract(lat / stp + 0.5) - 0.5) * stp;
      float fl = max(length(vec2(gx0.x, gy0.x)) * 2.0 * PI, 1e-6);
      float fb = max(length(vec2(gx0.y, gy0.y)) * PI, 1e-6);
      float hw = 0.55 * uDpr;
      float ml = 1.0 - smoothstep(hw - 0.5, hw + 0.7, dl / fl);
      float mb = 1.0 - smoothstep(hw - 0.5, hw + 0.7, db / fb);
      // 高纬度的经线挤在一起:只留 0°、90°、180°,到极点附近也淡掉
      float major = 1.0 - step(0.001, abs(fract(lon / (0.5 * PI) + 0.5) - 0.5));
      ml *= max(major, 1.0 - smoothstep(radians(72.0), radians(80.0), abs(lat))) * (1.0 - smoothstep(radians(82.0), radians(87.0), abs(lat)));
      float eq = 1.0 - smoothstep(hw - 0.5, hw + 0.9, abs(lat) / fb);
      float g = max(max(ml, mb), eq);
      vec3 gc = uStyle == 1 ? vec3(0.30, 0.20, 0.12) : vec3(0.92, 0.95, 1.0);
      float ga = uStyle == 1 ? 0.42 : uStyle == 0 ? 0.2 : 0.3;
      c = mix(c, gc, g * ga * (0.4 + 0.6 * smoothstep(0.0, 0.25, w)));
    }
    col = mix(bg, c, cover);
  }
  if (uStyle == 1) {
    // 墨线外框 + 外面一道细线
    float e1 = abs(r - 1.0) * uR;
    float e2 = abs(r - 1.0 - 6.0 * uDpr / uR) * uR;
    vec3 ink = vec3(0.23, 0.15, 0.09);
    col = mix(col, ink, (1.0 - smoothstep(0.9 * uDpr, 1.8 * uDpr, e1)) * 0.9);
    col = mix(col, ink, (1.0 - smoothstep(0.25 * uDpr, 0.95 * uDpr, e2)) * 0.55);
  } else if (uStyle == 0 && cover > 0.0) {
    // 球的边缘一圈亮一点的大气
    col = mix(col, vec3(0.62, 0.8, 1.0), (1.0 - smoothstep(0.0, 2.2 * uDpr, abs(r - 1.0) * uR)) * 0.35);
  }
  outColor = vec4(col, 1.0);
}`;

/**
 * 两极:经度方向的取样范围最多是纬度方向的这么多倍。按球面上的真实大小,纬度 φ 处本该是 1 / cos φ 倍 ——
 * 手绘符号在主图上正立着画,到了极点附近在球上被挤成放射状的细条,按真实大小平均掉才不扎眼;
 * 只在最后一度多里封顶(极点本身是奇点)
 */
const ANISO = 48;

/** 贴图的槽位 */
export type GlobeSlot = 'terrain' | 'civ' | 'sel' | 'hl' | 'replay' | 'water' | 'slope';
const SLOTS: GlobeSlot[] = ['terrain', 'civ', 'sel', 'hl', 'replay', 'water', 'slope'];
const UNIFORM_OF: Record<GlobeSlot, string> = {
  terrain: 'uTerrain',
  civ: 'uCiv',
  sel: 'uSel',
  hl: 'uHlTex',
  replay: 'uReplayTex',
  water: 'uWater',
  slope: 'uSlope',
};

/** 原始像素(RGBA、单通道或双通道) */
export interface PixelSource {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
  /** 单通道(水面蒙版) */
  gray?: boolean;
  /** 四个通道是数据、不是颜色(写实风的坡度,见 realistic.ts 的 realisticGlobeMaps):上传时不按透明度预乘 */
  raw?: boolean;
}

export type GlobeTexSource = TexImageSource | PixelSource;

const isPixels = (s: GlobeTexSource): s is PixelSource => 'data' in s && 'w' in s;
/** 空槽位放的 1×1 贴图:透明;地形是灰色;水面蒙版 = 没有水;坡度 = 平的 */
const emptyPixels = (slot: GlobeSlot): PixelSource =>
  slot === 'terrain'
    ? { w: 1, h: 1, data: new Uint8Array([90, 96, 104, 255]) }
    : slot === 'water'
      ? { w: 1, h: 1, data: new Uint8Array(1), gray: true }
      : slot === 'slope'
        ? { w: 1, h: 1, data: new Uint8Array([128, 128, 128, 128]), raw: true }
        : { w: 1, h: 1, data: new Uint8Array(4) };
const srcSize = (s: GlobeTexSource): [number, number] => {
  if (isPixels(s)) return [s.w, s.h];
  const a = s as { width: number; height: number; videoWidth?: number; videoHeight?: number };
  return [a.videoWidth || a.width, a.videoHeight || a.height];
};

/**
 * WebGL2 地球仪。create() 拿不到 WebGL2(或着色器编不过)时返回 null,调用方改用 CPU 画法
 */
export class GlobeGL {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private tex = new Map<GlobeSlot, { t: WebGLTexture; w: number; h: number; fmt: number }>();
  private loc = new Map<string, WebGLUniformLocation | null>();
  private aniso = 1;
  lost = false;

  static create(canvas: HTMLCanvasElement | OffscreenCanvas): GlobeGL | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new GlobeGL(gl);
    } catch (e) {
      console.warn('地球仪:WebGL2 初始化失败,改用 CPU 画', e);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '着色器编译失败');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '着色器链接失败');
    this.prog = p;
    this.vao = gl.createVertexArray()!;
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.aniso = Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number);
    gl.useProgram(p);
    SLOTS.forEach((s, i) => {
      gl.uniform1i(gl.getUniformLocation(p, UNIFORM_OF[s]), i);
      // 先放一张 1×1 的空贴图(透明;地形是灰色;坡度是平的)
      this.upload(s, null);
    });
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  /**
   * 换一个槽位的贴图(null = 清空)。画布 / 图片按"预乘透明度"上传(文明层半透明的边缘缩小以后不发黑),
   * 生成全套缩小层级(mipmap)。返回用了多少毫秒
   */
  upload(slot: GlobeSlot, src: GlobeTexSource | null): number {
    const gl = this.gl;
    const t0 = performance.now();
    if (!src || !srcSize(src)[0] || !srcSize(src)[1]) src = emptyPixels(slot);
    const [w, h] = srcSize(src);
    let cur = this.tex.get(slot);
    const gray = isPixels(src) && !!src.gray;
    const raw = isPixels(src) && !!src.raw;
    const fmt = gray ? gl.R8 : gl.RGBA8;
    if (cur && cur.fmt !== fmt) {
      gl.deleteTexture(cur.t);
      this.tex.delete(slot);
      cur = undefined;
    }
    if (!cur || cur.w !== w || cur.h !== h) {
      if (cur) gl.deleteTexture(cur.t);
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + SLOTS.indexOf(slot));
      gl.bindTexture(gl.TEXTURE_2D, t);
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.aniso > 1) gl.texParameterf(gl.TEXTURE_2D, 0x84fe /* TEXTURE_MAX_ANISOTROPY_EXT */, this.aniso);
      cur = { t, w, h, fmt };
      this.tex.set(slot, cur);
    }
    gl.activeTexture(gl.TEXTURE0 + SLOTS.indexOf(slot));
    gl.bindTexture(gl.TEXTURE_2D, cur.t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !gray && !raw);
    if (isPixels(src)) {
      const data = src.data instanceof Uint8Array ? src.data : new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gray ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, data);
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    return performance.now() - t0;
  }

  /** 贴图大小(没有 = [0, 0]) */
  size(slot: GlobeSlot): [number, number] {
    const t = this.tex.get(slot);
    return t ? [t.w, t.h] : [0, 0];
  }

  /** 画一帧。frame 用画布像素;dpr = 画布像素 / CSS 像素(线宽、星星按 CSS 像素定) */
  render(view: GlobeView, frame: GlobeFrame, dpr: number, look: GlobeLook): void {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    const { c, e, n } = globeBasis(view.lon, view.lat);
    gl.viewport(0, 0, frame.w, frame.h);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    SLOTS.forEach((s, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.get(s)!.t);
    });
    gl.uniform2f(this.u('uSize'), frame.w, frame.h);
    gl.uniform2f(this.u('uCenter'), frame.cx, frame.cy);
    gl.uniform1f(this.u('uR'), frame.R);
    gl.uniform1f(this.u('uDpr'), dpr);
    gl.uniform3f(this.u('uC'), c[0], c[1], c[2]);
    gl.uniform3f(this.u('uE'), e[0], e[1], e[2]);
    gl.uniform3f(this.u('uN'), n[0], n[1], n[2]);
    gl.uniform1i(this.u('uStyle'), look.style === 'realistic' ? 0 : look.style === 'fantasy' ? 1 : 2);
    gl.uniform1f(this.u('uGrid'), look.graticule ? 1 : 0);
    gl.uniform1f(this.u('uGridStep'), graticuleStep(view.k));
    gl.uniform1f(this.u('uHl'), look.hl);
    gl.uniform1f(this.u('uReplay'), look.replay);
    gl.uniform1f(this.u('uRelief'), look.relief && look.style === 'realistic' ? 1 : 0);
    gl.uniform1f(this.u('uAniso'), ANISO);
    const [tw, th] = this.size('terrain');
    gl.uniform2f(this.u('uTexSize'), tw, th);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.tex.values()) gl.deleteTexture(t.t);
    this.tex.clear();
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ---------------------------------------------------------------------------
// CPU 画法(没有 WebGL2 时的退路;同样的公式,双线性取地形、最近邻取文明层)

/** RGBA 像素(非预乘,ImageData 那样) */
export interface RgbaImage {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export interface CpuSources {
  terrain: RgbaImage | null;
  civ?: RgbaImage | null;
  sel?: RgbaImage | null;
  replay?: RgbaImage | null;
}

const hexRgb = (h: string): Vec3 => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 在 CPU 上画一帧到 out(画布像素)。经纬网、外框由调用方另画(见 graticuleLines) */
export function renderGlobeCpu(out: RgbaImage, view: GlobeView, f: GlobeFrame, look: GlobeLook, src: CpuSources): void {
  const { w, h, data } = out;
  const { c, e, n } = globeBasis(view.lon, view.lat);
  const bg = hexRgb(GLOBE_BG[look.style]);
  const glow: Vec3 = look.style === 'fantasy' ? [0, 0, 0] : look.style === 'realistic' ? [72, 132, 255] : [26, 30, 38];
  const T = src.terrain;
  const overlays = [src.civ, src.sel].filter((x): x is RgbaImage => !!x && x.w > 1);
  const rp = look.replay > 0 && src.replay && src.replay.w > 1 ? src.replay : null;
  const L: Vec3 = [-0.4575, 0.5083, 0.7295];
  const rgb: Vec3 = [0, 0, 0];
  const sample = (img: RgbaImage, s: number, t: number, bilinear: boolean): number => {
    const fx = s * img.w - 0.5;
    const fy = clamp(t * img.h - 0.5, 0, img.h - 1);
    if (!bilinear) {
      const x = (((Math.round(fx) % img.w) + img.w) % img.w) | 0;
      const y = Math.round(fy) | 0;
      const i = (y * img.w + x) * 4;
      rgb[0] = img.data[i];
      rgb[1] = img.data[i + 1];
      rgb[2] = img.data[i + 2];
      return img.data[i + 3] / 255;
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % img.w) + img.w) % img.w;
    const xb = (xa + 1) % img.w;
    const yb = Math.min(img.h - 1, y0 + 1);
    const i00 = (y0 * img.w + xa) * 4;
    const i10 = (y0 * img.w + xb) * 4;
    const i01 = (yb * img.w + xa) * 4;
    const i11 = (yb * img.w + xb) * 4;
    for (let k = 0; k < 3; k++) {
      const top = img.data[i00 + k] * (1 - tx) + img.data[i10 + k] * tx;
      const bot = img.data[i01 + k] * (1 - tx) + img.data[i11 + k] * tx;
      rgb[k] = top * (1 - ty) + bot * ty;
    }
    return 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const u = (x + 0.5 - f.cx) / f.R;
      const t = (f.cy - y - 0.5) / f.R;
      const r = Math.sqrt(u * u + t * t);
      let br = bg[0];
      let bgG = bg[1];
      let bb = bg[2];
      if (r > 1 && look.style !== 'fantasy') {
        const g = Math.exp(-(r - 1) * (look.style === 'realistic' ? 11 : 18)) * (look.style === 'realistic' ? 0.85 : 1);
        br += glow[0] * g;
        bgG += glow[1] * g;
        bb += glow[2] * g;
      }
      const cover = clamp((1 - r) * f.R + 0.5, 0, 1);
      if (cover <= 0) {
        data[o] = br;
        data[o + 1] = bgG;
        data[o + 2] = bb;
        data[o + 3] = 255;
        continue;
      }
      const s0 = r > 0.9995 ? 0.9995 / r : 1;
      const uu = u * s0;
      const tt = t * s0;
      const ww = Math.sqrt(Math.max(0, 1 - uu * uu - tt * tt));
      const px = uu * e[0] + tt * n[0] + ww * c[0];
      const py = uu * e[1] + tt * n[1] + ww * c[1];
      const pz = uu * e[2] + tt * n[2] + ww * c[2];
      const lon = Math.atan2(py, px);
      const lat = Math.asin(clamp(pz, -1, 1));
      const s = (lon + PI) / TAU;
      const tv = (HALF_PI - lat) / PI;
      let cr = 90;
      let cg = 96;
      let cb = 104;
      if (T) {
        sample(T, s, tv, true);
        [cr, cg, cb] = rgb;
      }
      for (const img of overlays) {
        const a = sample(img, s, tv, false);
        if (a > 0) {
          cr = cr * (1 - a) + rgb[0] * a;
          cg = cg * (1 - a) + rgb[1] * a;
          cb = cb * (1 - a) + rgb[2] * a;
        }
      }
      if (rp) {
        sample(rp, s, tv, false);
        cr += (rgb[0] - cr) * look.replay;
        cg += (rgb[1] - cg) * look.replay;
        cb += (rgb[2] - cb) * look.replay;
      }
      const diff = Math.max(0, uu * L[0] + tt * L[1] + ww * L[2]);
      const rim = 1 - ww;
      let sh: number;
      if (look.style === 'realistic') sh = 0.5 + 0.62 * diff;
      else if (look.style === 'fantasy') sh = (0.84 + 0.22 * diff) * (1 - 0.35 * rim * rim);
      else sh = 0.72 + 0.36 * diff;
      cr *= sh;
      cg *= sh;
      cb *= sh;
      if (look.style === 'realistic') {
        const a = Math.pow(rim, 2.6) * 0.62;
        cr += (128 - cr) * a;
        cg += (173 - cg) * a;
        cb += (245 - cb) * a;
      }
      data[o] = br + (cr - br) * cover;
      data[o + 1] = bgG + (cg - bgG) * cover;
      data[o + 2] = bb + (cb - bb) * cover;
      data[o + 3] = 255;
    }
  }
}
