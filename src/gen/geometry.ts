/**
 * 几何层:"世界是什么形状"的计算全在这里。生成(src/gen/)和文明(src/gen/civ/)的代码不直接拿 x、y 算距离、
 * 取噪声、定纬度、找最近的地块,而是问这个接口 —— 以后要换一种世界形状,只要再写一种实现。
 *
 * 现在只有一种实现:**球面**(SphereGeometry)。世界直接长在一颗球上,东西无缝、有真正的南北极;
 * 平面主图 = 等距圆柱投影。
 *
 * 约定:
 *   - 世界坐标 (x, y):x ∈ [0, 2048) 对应经度 −180°…180°,y ∈ [0, 1024] 对应纬度 90°…−90°(等距圆柱主图)。
 *     网格的地块另有单位向量 (px, py, pz)(Mesh.xyz);世界坐标只用来进出(改地形的笔画、标注路径、画图)
 *   - 球半径 R = 2048 / 2π 个世界单位(赤道一圈 = 地图宽),所以"以世界单位计的宽度"(板块缓坡、碰撞带……)就是赤道上的长度
 *   - 距离用弦长 R·|p − q|(只用开方,各浏览器逐位一致);短距离上和大圆距离几乎一样
 *   - 当地方向一律用(东, 南)两个分量表示,和屏幕坐标一致(y 向下 = 南),就是当地切平面的东、南单位向量
 *   - 三角函数(经纬度换算、沿大圆走、球面三角形面积)结果舍入到 24 位(round24),任何电脑上逐位一致
 *
 * 用法:`const geo = geometryOf(mesh)`,在循环外取一次(按网格缓存),循环里只调方法,不造对象。
 * 网格怎么撒点、剖分(buildSphereMesh)、间距怎么定(sphereSpacing)也在这里。
 *
 * 不在这里的"主图算式"(都是画成平面图那一步的事):铺像素(raster.ts、history.ts、seaice.ts 的 seaIcePixels)、
 * 画风(src/render/)、界面(src/ui/)。
 */
import { Delaunay } from 'd3-delaunay';
import type { Mesh } from './mesh';
import { clamp, fbm3, noise3, ridged3, type Noise3, type Rng } from './util';
import { round24 } from './civ/rand';

/**
 * 定义在世界表面上的噪声:在单位向量 p 上取 3D 噪声,频率换算 F = f·R(波长仍以世界单位计)。
 *
 * 频率常写成两个因子 f·g(例如 "海岸噪声的频率 × 1.3"):分开传,浮点运算的先后顺序固定。
 */
export interface SurfaceNoise {
  /** 地块 i 处,频率 f·g(每世界单位),偏移 (ox, oy):n3(px·F·g + ox, py·F·g + oy, pz·F·g) */
  at(i: number, f: number, g?: number, ox?: number, oy?: number): number;
  /** 地块 i 处,按"尺度"s(世界单位,= 1 / 频率) */
  atScale(i: number, s: number, ox?: number, oy?: number): number;
  /** 世界坐标点 (px, py) 处,按尺度 s(先把点换成单位向量) */
  pointScale(px: number, py: number, s: number, ox?: number, oy?: number): number;
  /** 地块 i 处,南北向拉长 1/sy 倍(沿地轴 z 方向乘 sy) */
  stretched(i: number, f: number, sy: number): number;
}

/** 改地形的一条笔画(折线;火山、湖只有一个点):点到折线的最近点 */
export interface Polyline {
  /** 各点的累计长度 */
  readonly cum: Float64Array;
  readonly len: number;
  /** 地块 i 可能在影响范围内(粗筛:笔画的包围球外扩 reach) */
  covers(i: number): boolean;
  /**
   * 点 (px, py) 到折线的最近点:距离 d、最近点沿线的位置 a(累计长度)、最近点坐标 qx / qy。
   * 返回同一个对象(每次覆盖,不分配)
   */
  nearest(px: number, py: number): { d: number; a: number; qx: number; qy: number };
}

/**
 * 局部平面(切平面):在一片不太大的区域里做 2D 几何用(地名的主轴、标注路径、射线、聚类)。
 * 以中心地块为切点的方位等距投影,u 向东、v 向南(世界单位)
 */
export interface Chart {
  /** 地块 c 的局部坐标 */
  u(c: number): number;
  v(c: number): number;
  /** 世界坐标 → 局部坐标 */
  toU(px: number, py: number): number;
  toV(px: number, py: number): number;
  /** 局部坐标 → 世界坐标 */
  toX(u: number, v: number): number;
  toY(u: number, v: number): number;
}

/**
 * 风带的"切口"(顺风排序用,见 Geometry.downwind):信风、西风带绕星球一整圈,没有起点,
 * 每条风带在最大的那片大洋中间选一条经线切开
 */
export type WindCuts = Float64Array;

/** 板块的刚体运动:绕欧拉轴转动,速度 = ω × p,离质心越远方向越跟着转(真实的板块就是这样动的) */
export interface PlateMotion {
  /** 板块 k 在地块 i 处的漂移速度:东、南分量写进 out */
  at(k: number, i: number, out: number[]): void;
  /** 每个板块的角速度向量 ω(交错存 x, y, z;|ω| = 质心处的速度) */
  readonly omega: Float32Array;
}

export interface Geometry {
  /** 世界的形状(现在只有球面;留着这个字段,以后别的形状 / 投影还用得上) */
  readonly kind: 'sphere';
  readonly mesh: Mesh;
  /** 整个世界表面的面积(世界单位²):4πR² */
  readonly area: number;

  // ---- 距离 ----

  /** 地块 i、j 中心的距离:弦长 R·|pᵢ − pⱼ| */
  dist(i: number, j: number): number;
  /** 距离的平方(同上,不开方) */
  dist2(i: number, j: number): number;
  /** 地块 i 到世界坐标点 (px, py) 的距离 */
  distTo(i: number, px: number, py: number): number;
  /** 两个世界坐标点的距离 */
  pointDist(ax: number, ay: number, bx: number, by: number): number;
  /** 以地块 c 为中心、半径 R 的粗筛:地块 i 离得不超过 R 返回距离的平方,否则 −1 */
  near2(i: number, c: number, R: number): number;
  /** 以世界坐标点 (px, py) 为中心的粗筛(同上),在范围内返回距离(开过方),否则 −1 */
  nearTo(i: number, px: number, py: number, R: number): number;

  // ---- 方向与位移(当地切平面,分量 = 东、南) ----

  /** 从地块 i 指向 j 的单位方向(d = pⱼ − pᵢ)点乘 i 处的切向量 ve·东ᵢ + vs·南ᵢ(重合时除以 1) */
  edgeDot(i: number, j: number, ve: number, vs: number): number;
  /** 两个世界坐标点:从 a 指向 b 的单位方向点乘 a 处的切向量 (ve, vs)(同上) */
  pointDot(ax: number, ay: number, bx: number, by: number, ve: number, vs: number): number;
  /**
   * 地块 i 的位置在方向 (ve, vs) 上的投影:顺风排序用(先算上风的地块)。
   * 风带绕一圈没有起点,在每条风带里从切口(cuts,见 windCuts)那条经线切开,经度从切口往东量:x' ·ve + y·vs
   */
  downwind(i: number, ve: number, vs: number, cuts?: WindCuts | null): number;
  /**
   * 每条风带的切口(顺风排序用):water 非 1 = 陆地 / 湖。
   * 六条风带(0–30°、30–60°、60–90°,南北各三)各选一条经线,在陆地最少(最大的那片大洋中间)的地方
   */
  windCuts(water: ArrayLike<number>): WindCuts | null;
  /** 地块 to 相对地块 from 的位移,写进 out = [东, 南]:from 处切平面上的方位等距坐标 */
  offset(from: number, to: number, out: number[]): void;
  /** 世界坐标点 b 相对 a 的位移(同上) */
  pointOffset(ax: number, ay: number, bx: number, by: number, out: number[]): void;
  /**
   * 从地块 i 沿当地(东, 南)挪 (e1 + e2 + e3, s1 + s2 + s3) 个世界单位(沿大圆走),落点的世界坐标写进 out。
   * 分几段传是为了固定加法的先后顺序
   */
  moveCell(out: number[], i: number, e1: number, s1: number, e2?: number, s2?: number, e3?: number, s3?: number): void;
  /** 把世界坐标点规整到表面上(原地改 out):纬度夹在两极以内 */
  clampPoint(out: number[]): void;
  /** 地块 a、b 连线的中点(世界坐标写进 out):(pₐ + p_b) 归一 */
  mid(a: number, b: number, out: number[]): void;

  /**
   * 板块运动(见 PlateMotion)。vx / vy = 每个板块在质心 (cx, cy) 处的速度(东、南分量);
   * spin = 每个板块绕自己质心的自转(−1…1,乘上质心处的速度:欧拉轴从"和质心垂直"往质心偏一点)
   */
  plateMotion(vx: Float32Array, vy: Float32Array, cx: Float32Array, cy: Float32Array, spin: ArrayLike<number>): PlateMotion;

  // ---- 质心 ----

  /**
   * 加权质心:items 里每一项取地块 cellOf(k)、权重 weightOf(k),质心的世界坐标写进 out,返回总权重。
   * 单位向量加权平均再归一
   */
  centroid<T>(items: Iterable<T>, cellOf: (k: T) => number, weightOf: (k: T) => number, out: number[]): number;
  /** 不加权的平均位置 */
  meanPoint<T>(items: readonly T[], cellOf: (k: T) => number, out: number[]): void;
  /**
   * 分组质心:group[i] 是地块 i 属于第几组(0..count−1),size[k] 是第 k 组的地块数。
   * 3D 平均再归一,换回世界坐标
   */
  groupCentroids(group: ArrayLike<number>, count: number, size: ArrayLike<number>): { x: Float32Array; y: Float32Array };

  // ---- 纬度 ----

  /** 地块 i 的纬度(度,北正南负,±90°) */
  latitude(i: number): number;

  // ---- 噪声 ----

  /** 单层噪声(seed 直接喂给随机数发生器) */
  noise(seed: number): SurfaceNoise;
  /** 分形叠加(见 util.fbm3) */
  fbm(seed: number, octaves: number, persistence?: number): SurfaceNoise;
  /** 山脊噪声(见 util.ridged3) */
  ridged(seed: number, octaves: number, persistence?: number): SurfaceNoise;

  // ---- 最近的地块 ----

  /** 世界坐标点所在的地块(最近的地块中心;hint = 从哪块附近开始找)。按 3D 位置分桶 + 沿 Delaunay 邻居贪心走 */
  nearest(px: number, py: number, hint: number): number;
  /** 连续查最近地块(地名标注沿路径取样):每次从上一次找到的地块附近开始找 */
  locator(): (px: number, py: number) => number;

  // ---- 面积、折线、局部平面 ----

  /** 每个地块的面积(世界单位²):球面 Delaunay 三角形面积三等分给三个顶点 */
  cellAreas(): Float32Array;
  /** 改地形的笔画(pts = [x0, y0, x1, y1, …],reach = 影响范围,粗筛用) */
  polyline(pts: readonly number[], reach: number): Polyline;
  /** 以地块 center 为中心的局部平面 */
  chart(center: number): Chart;
  /**
   * 一片地块的局部平面,切点取这片地块按 weight 加权的质心附近的地块:片越大,离切点越远的地方变形越大,切在中间最准
   * (地名的主轴、山脊线)
   */
  chartOf(cells: ArrayLike<number>, weight: (c: number) => number): Chart;
  /**
   * 主图上的局部平面:以世界坐标点 (px, py) 为原点,u 沿纬线向东、v 沿经线向南(世界单位)——
   * 过原点的纬线、经线在主图上横平竖直,标注沿"水平 / 竖直"摆字时用它,字在主图上是正的。
   * u 按原点纬度的 cos 折算(离原点南北越远越不准,只在一行字的范围里用);
   * 换回世界坐标时 x 不取模(跨 180° 经线的标注路径是连着的一笔)
   */
  mapChart(px: number, py: number): Chart;
  /**
   * 标注路径(世界坐标折线 x, y, x, y…,原地改)整条挪整数个地图宽,让它按长度的中点落在地图里 [0, 宽)。
   * 跨 180° 经线的路径是连着的一笔(x 可以超出地图),字摆在中点附近,中点得在图上
   */
  centerPath(path: Float32Array): void;

  // ---- 主图上的方位 ----

  /**
   * 大洋的方位(按在主图上的位置:西 / 东 / 北 / 南大洋,居中的 null)。
   * 主图是等距圆柱,经度 0 在正中:经度离中央经线远的叫东 / 西,纬度高的叫北 / 南;
   * 180° 经线是主图的左右边,两侧的大洋不按东西起名
   */
  mapSide(c: number): 'n' | 's' | 'e' | 'w' | null;
  /**
   * 每个地块到西边 / 东边最近陆地的距离(沿纬线圈首尾相接,粗网格 G 个世界单位一格;land 非 0 = 陆地)
   */
  zonalLand(land: ArrayLike<number>, G: number): { west: Float32Array; east: Float32Array };
}

/** 球半径(世界单位):赤道一圈 = 地图宽 */
export function sphereRadius(width: number): number {
  return width / TAU;
}

/**
 * 网格间距:整颗球(面积 4πR²)撒大约 cells 个点(泊松圆盘填满约 66% 的面积)。精细度(cells)的意思是"整颗球的地块数"
 */
export function sphereSpacing(width: number, cells: number): number {
  const R = sphereRadius(width);
  return Math.sqrt((4 * Math.PI * R * R * 0.66) / cells);
}

const cache = new WeakMap<Mesh, Geometry>();

/** 网格的几何(按网格缓存:同一个网格只建一次) */
export function geometryOf(mesh: Mesh): Geometry {
  let g = cache.get(mesh);
  if (!g) {
    g = new SphereGeometry(mesh);
    cache.set(mesh, g);
  }
  return g;
}

const TAU = Math.PI * 2;
/** 三角函数舍入到 24 位:各引擎最后一位的差别不会漏进世界里(见 civ/rand.ts 的 round24) */
const fsin = (v: number) => round24(Math.sin(v));
const fcos = (v: number) => round24(Math.cos(v));
const fatan2 = (y: number, x: number) => round24(Math.atan2(y, x));
const fasin = (v: number) => round24(Math.asin(v < -1 ? -1 : v > 1 ? 1 : v));

/**
 * 主图上的方位(大洋起名用):(fx, fy) = 在主图上的位置(0–1)。离中心横向 / 纵向(纵向 × 1.3)都不到 0.28 的居中(null),
 * 否则哪个方向更偏取哪个
 */
function sideOnMap(fx: number, fy: number): 'n' | 's' | 'e' | 'w' | null {
  const ex = Math.abs(fx - 0.5);
  const ey = Math.abs(fy - 0.5) * 1.3;
  if (Math.max(ex, ey) < 0.28) return null;
  return ex > ey ? (fx < 0.5 ? 'w' : 'e') : fy < 0.5 ? 'n' : 's';
}

// ===========================================================================
// 球面网格:球面泊松圆盘撒点 + 立体投影剖分

/**
 * 球面泊松圆盘(Bridson):任意两点弦长 ≥ r(单位球上),候选点在切平面里取再投回球面。
 * 邻居查找用 3D 网格(格子边长 = r,查周围 27 格),格子很稀疏(只有球壳附近有点),存成定长哈希桶
 * (桶里串成链表,撞桶只是多比几个点的距离,不影响结果)。
 */
function poissonSphere(r: number, rng: Rng): number[] {
  const r2 = r * r;
  const expect = (4 * Math.PI * 0.66) / r2;
  let TB = 1;
  while (TB < expect * 4) TB <<= 1;
  const bucket = (a: number, b: number, c: number) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (TB - 1);
  const head = new Int32Array(TB).fill(-1);
  const xs: number[] = [];
  const next: number[] = [];
  const put = (x: number, y: number, z: number) => {
    const id = xs.length / 3;
    xs.push(x, y, z);
    const k = bucket(Math.floor((x + 1) / r), Math.floor((y + 1) / r), Math.floor((z + 1) / r));
    next.push(head[k]);
    head[k] = id;
    return id;
  };
  const far = (x: number, y: number, z: number) => {
    const gx = Math.floor((x + 1) / r);
    const gy = Math.floor((y + 1) / r);
    const gz = Math.floor((z + 1) / r);
    for (let a = gx - 1; a <= gx + 1; a++)
      for (let b = gy - 1; b <= gy + 1; b++)
        for (let c = gz - 1; c <= gz + 1; c++) {
          for (let id = head[bucket(a, b, c)]; id >= 0; id = next[id]) {
            const dx = xs[3 * id] - x;
            const dy = xs[3 * id + 1] - y;
            const dz = xs[3 * id + 2] - z;
            if (dx * dx + dy * dy + dz * dz < r2) return false;
          }
        }
    return true;
  };
  // 第一个点随机放(不放在极点上:极点处"东"没有定义)
  const z0 = 2 * rng() - 1;
  const a0 = TAU * rng();
  const q0 = Math.sqrt(Math.max(0, 1 - z0 * z0));
  const active = [put(q0 * fcos(a0), q0 * fsin(a0), z0)];
  const K = 24;
  while (active.length) {
    const ai = Math.floor(rng() * active.length);
    const p = active[ai];
    const px = xs[3 * p];
    const py = xs[3 * p + 1];
    const pz = xs[3 * p + 2];
    // 切平面的一组基
    let ux = -py;
    let uy = px;
    let uz = 0;
    if (Math.abs(pz) > 0.9) {
      ux = 0;
      uy = -pz;
      uz = py;
    }
    let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = py * uz - pz * uy;
    const vy = pz * ux - px * uz;
    const vz = px * uy - py * ux;
    let placed = false;
    for (let k = 0; k < K; k++) {
      const a = rng() * TAU;
      const d = r * (1 + rng());
      const ca = fcos(a);
      const sa = fsin(a);
      let x = px + d * (ca * ux + sa * vx);
      let y = py + d * (ca * uy + sa * vy);
      let z = pz + d * (ca * uz + sa * vz);
      ul = Math.sqrt(x * x + y * y + z * z);
      x /= ul;
      y /= ul;
      z /= ul;
      if (!far(x, y, z)) continue;
      active.push(put(x, y, z));
      placed = true;
    }
    if (!placed) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }
  return xs;
}

/**
 * 球面 Delaunay:把 z 最小的那个点 p0 转到南极,其余点从南极做立体投影到平面(立体投影保圆,平面 Delaunay 就是球面 Delaunay),
 * 用 d3-delaunay 剖分,再把凸包一圈和 p0 连起来补上最后一圈三角形。三角形数 = 2n − 4(闭合球面三角网)。
 */
function sphereDelaunay(xyz: Float32Array): { triangles: Uint32Array; adjStart: Int32Array; adj: Int32Array } {
  const n = xyz.length / 3;
  let p0 = 0;
  for (let i = 1; i < n; i++) if (xyz[3 * i + 2] < xyz[3 * p0 + 2]) p0 = i;
  const vx = xyz[3 * p0];
  const vy = xyz[3 * p0 + 1];
  const vz = xyz[3 * p0 + 2];
  // 旋转轴 = v0 × (0,0,-1) = (-vy, vx, 0);sin = |轴|,cos = v0·(0,0,-1) = -vz
  let kx = -vy;
  let ky = vx;
  const sn = Math.sqrt(kx * kx + ky * ky);
  const cs = -vz;
  if (sn > 1e-12) {
    kx /= sn;
    ky /= sn;
  }
  const coords = new Float64Array(2 * (n - 1));
  const back = new Int32Array(n - 1);
  const local = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (i === p0) continue;
    const x = xyz[3 * i];
    const y = xyz[3 * i + 1];
    const z = xyz[3 * i + 2];
    let qx = x;
    let qy = y;
    let qz = z;
    if (sn > 1e-12) {
      // Rodrigues:q = p·cos + (k×p)·sin + k(k·p)(1-cos),k = (kx, ky, 0)
      const kdp = kx * x + ky * y;
      qx = x * cs + ky * z * sn + kx * kdp * (1 - cs);
      qy = y * cs - kx * z * sn + ky * kdp * (1 - cs);
      qz = z * cs + (kx * y - ky * x) * sn;
    } else if (cs < 0) {
      // 投影点在北极:绕 x 轴转半圈
      qy = -y;
      qz = -z;
    }
    const den = 1 + qz;
    coords[2 * m] = qx / den;
    coords[2 * m + 1] = qy / den;
    back[m] = i;
    local[i] = m;
    m++;
  }
  const del = new Delaunay(coords);
  const hull = del.hull;
  const nt = del.triangles.length / 3 + hull.length;
  const triangles = new Uint32Array(3 * nt);
  for (let t = 0; t < del.triangles.length; t++) triangles[t] = back[del.triangles[t]];
  let o = del.triangles.length;
  for (let h = 0; h < hull.length; h++) {
    triangles[o++] = back[hull[h]];
    triangles[o++] = back[hull[(h + 1) % hull.length]];
    triangles[o++] = p0;
  }
  // 邻接(CSR):平面邻居 + 凸包上的点多一个邻居 p0
  const onHull = new Uint8Array(n - 1);
  for (let h = 0; h < hull.length; h++) onHull[hull[h]] = 1;
  const adjStart = new Int32Array(n + 1);
  const tmp: number[] = [];
  for (let i = 0; i < n; i++) {
    adjStart[i] = tmp.length;
    if (i === p0) {
      for (let h = 0; h < hull.length; h++) tmp.push(back[hull[h]]);
      continue;
    }
    const li = local[i];
    for (const j of del.neighbors(li)) tmp.push(back[j]);
    if (onHull[li]) tmp.push(p0);
  }
  adjStart[n] = tmp.length;
  return { triangles, adjStart, adj: Int32Array.from(tmp) };
}

/**
 * 球面网格:整颗球撒点(间距 spacing 世界单位,半径 R = width / 2π),剖分成 2n − 4 个球面三角形。
 * 地块位置存 Float32(xyz);世界坐标 x、y 是等距圆柱主图上的位置(经纬度换算舍入到 24 位)。
 */
export function buildSphereMesh(width: number, height: number, spacing: number, rng: Rng): Mesh {
  const R = sphereRadius(width);
  const xyz = Float32Array.from(poissonSphere(spacing / R, rng));
  const n = xyz.length / 3;
  const { triangles: tris, adjStart, adj } = sphereDelaunay(xyz);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lon = fatan2(xyz[3 * i + 1], xyz[3 * i]);
    const lat = fasin(xyz[3 * i + 2]);
    const fx = Math.fround(((lon + Math.PI) / TAU) * width);
    x[i] = fx >= width ? 0 : fx;
    y[i] = ((Math.PI / 2 - lat) / Math.PI) * height;
  }
  // 跨 180° 经线、包着极点的三角形(在主图上横跨半张图以上)排在最前面(见 Mesh.triangles)
  const nt = tris.length / 3;
  const triangles = new Uint32Array(tris.length);
  let o = 0;
  for (const wrapped of [true, false]) {
    for (let t = 0; t < nt; t++) {
      const a = tris[3 * t];
      const b = tris[3 * t + 1];
      const c = tris[3 * t + 2];
      const span = Math.max(x[a], x[b], x[c]) - Math.min(x[a], x[b], x[c]);
      if (span > width / 2 !== wrapped) continue;
      triangles[o++] = a;
      triangles[o++] = b;
      triangles[o++] = c;
    }
  }
  return { width, height, spacing, n, x, y, adjStart, adj, triangles, xyz };
}

// ---------------------------------------------------------------------------
// 球面实现

/** 世界坐标点 → 单位向量(连同当地的经纬度三角函数),记住上一次的点(循环里反复问同一个点时不重算) */
class PointVec {
  x = NaN;
  y = NaN;
  readonly v = new Float64Array(3);
  sinLon = 0;
  cosLon = 1;
  sinLat = 0;
  cosLat = 1;
  constructor(
    private readonly W: number,
    private readonly H: number,
  ) {}
  set(px: number, py: number): Float64Array {
    if (px === this.x && py === this.y) return this.v;
    this.x = px;
    this.y = py;
    const lon = (px / this.W) * TAU - Math.PI;
    const lat = Math.PI / 2 - (py / this.H) * Math.PI;
    this.sinLon = fsin(lon);
    this.cosLon = fcos(lon);
    this.sinLat = fsin(lat);
    this.cosLat = fcos(lat);
    this.v[0] = this.cosLat * this.cosLon;
    this.v[1] = this.cosLat * this.sinLon;
    this.v[2] = this.sinLat;
    return this.v;
  }
  /** 当地东向单位向量点乘 (dx, dy, ·)(先 set) */
  east(dx: number, dy: number): number {
    return -this.sinLon * dx + this.cosLon * dy;
  }
  /** 当地南向单位向量点乘 (dx, dy, dz)(先 set) */
  south(dx: number, dy: number, dz: number): number {
    return this.sinLat * this.cosLon * dx + this.sinLat * this.sinLon * dy - this.cosLat * dz;
  }
}

class SphereNoise implements SurfaceNoise {
  constructor(
    private readonly fn: Noise3,
    private readonly p: Float32Array,
    private readonly R: number,
    private readonly pt: PointVec,
  ) {}
  at(i: number, f: number, g = 1, ox = 0, oy = 0): number {
    const F = f * this.R * g;
    const a = 3 * i;
    return this.fn(this.p[a] * F + ox, this.p[a + 1] * F + oy, this.p[a + 2] * F);
  }
  atScale(i: number, s: number, ox = 0, oy = 0): number {
    const F = this.R / s;
    const a = 3 * i;
    return this.fn(this.p[a] * F + ox, this.p[a + 1] * F + oy, this.p[a + 2] * F);
  }
  pointScale(px: number, py: number, s: number, ox = 0, oy = 0): number {
    const v = this.pt.set(px, py);
    const F = this.R / s;
    return this.fn(v[0] * F + ox, v[1] * F + oy, v[2] * F);
  }
  stretched(i: number, f: number, sy: number): number {
    const F = f * this.R;
    const a = 3 * i;
    return this.fn(this.p[a] * F, this.p[a + 1] * F, this.p[a + 2] * F * sy);
  }
}

/**
 * 改地形的笔画在球面上:笔画的点是世界坐标(经纬度),两点之间按主图上的直线走(横着画的一笔沿纬线,
 * 跨 180° 经线的一段走短的那边),每 STEP 个世界单位取一个点投到球面上,成一串很短的弦;
 * 点到笔画的最近点 = 到这串弦的最近点。弦按 GROUP 段一组算包围球,离得远的整组跳过。
 */
class SpherePolyline implements Polyline {
  readonly cum: Float64Array;
  readonly len: number;
  /** 加密后的点(单位向量)和累计长度 */
  private readonly v: Float64Array;
  private readonly vc: Float64Array;
  private readonly m: number;
  /** 每组弦的包围球(中心单位向量 + 半径,弦长) */
  private readonly gc: Float64Array;
  private readonly gr: Float64Array;
  /** 整条笔画的包围球(covers 粗筛) */
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly cr2: number;
  private readonly hit = { d: 0, a: 0, qx: 0, qy: 0 };
  private readonly back = [0, 0];
  constructor(
    private readonly geo: SphereGeometry,
    pts: readonly number[],
    reach: number,
  ) {
    const { W, R } = geo;
    const k = pts.length >> 1;
    const vs: number[] = [];
    const cum = new Float64Array(k);
    const vcum: number[] = [];
    const pv = new PointVec(W, geo.H);
    const push = (px: number, py: number) => {
      const q = pv.set(px, py);
      const j = vs.length;
      const L = j ? vcum[vcum.length - 1] + R * Math.sqrt((q[0] - vs[j - 3]) ** 2 + (q[1] - vs[j - 2]) ** 2 + (q[2] - vs[j - 1]) ** 2) : 0;
      vs.push(q[0], q[1], q[2]);
      vcum.push(L);
    };
    push(pts[0], pts[1]);
    for (let s = 1; s < k; s++) {
      const x0 = pts[2 * s - 2];
      const y0 = pts[2 * s - 1];
      let dx = pts[2 * s] - x0;
      if (dx > W / 2) dx -= W;
      else if (dx <= -W / 2) dx += W;
      const dy = pts[2 * s + 1] - y0;
      const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / POLY_STEP));
      for (let t = 1; t <= steps; t++) push(x0 + (dx * t) / steps, y0 + (dy * t) / steps);
      cum[s] = vcum[vcum.length - 1];
    }
    this.cum = cum;
    this.len = cum[k - 1];
    this.v = Float64Array.from(vs);
    this.vc = Float64Array.from(vcum);
    this.m = vs.length / 3;
    const G = POLY_GROUP;
    const ng = Math.max(1, Math.ceil((this.m - 1) / G));
    this.gc = new Float64Array(3 * ng);
    this.gr = new Float64Array(ng);
    for (let g = 0; g < ng; g++) this.gr[g] = this.ball(g * G, Math.min(this.m, g * G + G + 1), this.gc, 3 * g);
    const c = new Float64Array(3);
    const rad = this.ball(0, this.m, c, 0) + reach / R;
    this.cx = c[0];
    this.cy = c[1];
    this.cz = c[2];
    this.cr2 = rad * rad;
  }
  /** 加密点 [from, to) 的包围球:中心 = 平均方向(写进 out[o..o+2]),返回半径(弦长) */
  private ball(from: number, to: number, out: Float64Array, o: number): number {
    const v = this.v;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let j = from; j < to; j++) {
      sx += v[3 * j];
      sy += v[3 * j + 1];
      sz += v[3 * j + 2];
    }
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (l > 1e-12) {
      sx /= l;
      sy /= l;
      sz /= l;
    } else {
      sx = v[3 * from];
      sy = v[3 * from + 1];
      sz = v[3 * from + 2];
    }
    let r2 = 0;
    for (let j = from; j < to; j++) r2 = Math.max(r2, (v[3 * j] - sx) ** 2 + (v[3 * j + 1] - sy) ** 2 + (v[3 * j + 2] - sz) ** 2);
    out[o] = sx;
    out[o + 1] = sy;
    out[o + 2] = sz;
    return Math.sqrt(r2);
  }
  covers(i: number): boolean {
    const p = this.geo.p;
    return (p[3 * i] - this.cx) ** 2 + (p[3 * i + 1] - this.cy) ** 2 + (p[3 * i + 2] - this.cz) ** 2 <= this.cr2;
  }
  nearest(px: number, py: number) {
    const { v, vc, m, hit, gc, gr } = this;
    const q = this.geo.ptA.set(px, py);
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    let best = Math.sqrt((qx - v[0]) ** 2 + (qy - v[1]) ** 2 + (qz - v[2]) ** 2);
    let bx = v[0];
    let by = v[1];
    let bz = v[2];
    hit.a = 0;
    const G = POLY_GROUP;
    for (let g = 0; g * G < m - 1; g++) {
      const lb = Math.sqrt((qx - gc[3 * g]) ** 2 + (qy - gc[3 * g + 1]) ** 2 + (qz - gc[3 * g + 2]) ** 2) - gr[g];
      if (lb >= best) continue;
      const end = Math.min(m - 1, g * G + G);
      for (let j = g * G; j < end; j++) {
        const ax = v[3 * j];
        const ay = v[3 * j + 1];
        const az = v[3 * j + 2];
        const dx = v[3 * j + 3] - ax;
        const dy = v[3 * j + 4] - ay;
        const dz = v[3 * j + 5] - az;
        const L2 = dx * dx + dy * dy + dz * dz;
        if (L2 <= 0) continue;
        const t = clamp(((qx - ax) * dx + (qy - ay) * dy + (qz - az) * dz) / L2, 0, 1);
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        const cz = az + dz * t;
        const d = Math.sqrt((qx - cx) ** 2 + (qy - cy) ** 2 + (qz - cz) ** 2);
        if (d < best) {
          best = d;
          bx = cx;
          by = cy;
          bz = cz;
          hit.a = vc[j] + (vc[j + 1] - vc[j]) * t;
        }
      }
    }
    hit.d = best * this.geo.R;
    this.geo.fromVec(bx, by, bz, this.back);
    hit.qx = this.back[0];
    hit.qy = this.back[1];
    return hit;
  }
}
/** 笔画加密的步长(世界单位)、包围球分组 */
const POLY_STEP = 4;
const POLY_GROUP = 16;

/** 球面的局部平面:以中心地块为切点的方位等距投影,u 向东、v 向南(世界单位) */
class SphereChart implements Chart {
  private readonly c = new Float64Array(3);
  private readonly e = new Float64Array(3);
  private readonly s = new Float64Array(3);
  private lastC = -1;
  private cu = 0;
  private cv = 0;
  private lastX = NaN;
  private lastY = NaN;
  private pu = 0;
  private pv = 0;
  private lastU = NaN;
  private lastV = NaN;
  private readonly back = [0, 0];
  private readonly pt: PointVec;
  /** 切点的 x:换回世界坐标时 x 取离它近的那一侧(不取模),跨 180° 经线的折线是连着的 */
  private readonly x0: number;
  constructor(
    private readonly geo: SphereGeometry,
    center: number,
  ) {
    geo.frame(center, this.c, this.e, this.s);
    this.pt = new PointVec(geo.W, geo.H);
    this.x0 = geo.mesh.x[center];
  }
  /** 单位向量 q 的方位等距坐标 → pu, pv */
  private aeq(qx: number, qy: number, qz: number): void {
    const { c, e, s } = this;
    const qe = qx * e[0] + qy * e[1] + qz * e[2];
    const qs = qx * s[0] + qy * s[1] + qz * s[2];
    const qc = qx * c[0] + qy * c[1] + qz * c[2];
    const t = Math.sqrt(qe * qe + qs * qs);
    if (t < 1e-15) {
      this.pu = 0;
      this.pv = 0;
      return;
    }
    const k = (this.geo.R * fatan2(t, qc)) / t;
    this.pu = qe * k;
    this.pv = qs * k;
  }
  private cell(c: number): void {
    if (c === this.lastC) return;
    const p = this.geo.p;
    this.aeq(p[3 * c], p[3 * c + 1], p[3 * c + 2]);
    this.lastC = c;
    this.cu = this.pu;
    this.cv = this.pv;
    this.lastX = NaN;
  }
  private point(px: number, py: number): void {
    if (px === this.lastX && py === this.lastY) return;
    const q = this.pt.set(px, py);
    this.aeq(q[0], q[1], q[2]);
    this.lastX = px;
    this.lastY = py;
  }
  private inv(u: number, v: number): void {
    if (u === this.lastU && v === this.lastV) return;
    this.lastU = u;
    this.lastV = v;
    const { c, e, s } = this;
    const L = Math.sqrt(u * u + v * v);
    if (L === 0) {
      this.geo.fromVec(c[0], c[1], c[2], this.back);
      return;
    }
    const th = L / this.geo.R;
    const ct = fcos(th);
    const st = fsin(th) / L;
    this.geo.fromVec(
      c[0] * ct + (u * e[0] + v * s[0]) * st,
      c[1] * ct + (u * e[1] + v * s[1]) * st,
      c[2] * ct + (u * e[2] + v * s[2]) * st,
      this.back,
    );
  }
  u(c: number): number {
    this.cell(c);
    return this.cu;
  }
  v(c: number): number {
    this.cell(c);
    return this.cv;
  }
  toU(px: number, py: number): number {
    this.point(px, py);
    return this.pu;
  }
  toV(px: number, py: number): number {
    this.point(px, py);
    return this.pv;
  }
  toX(u: number, v: number): number {
    this.inv(u, v);
    const x = this.back[0];
    const W = this.geo.W;
    return x - this.x0 > W / 2 ? x - W : this.x0 - x > W / 2 ? x + W : x;
  }
  toY(u: number, v: number): number {
    this.inv(u, v);
    return this.back[1];
  }
}

/** 大洋方位:离 180° 经线不到 30°(主图上离左右边不到 1/12)的不按东西起名 */
const SEAM_SIDE = 150 / 360;

/** 主图局部平面在高纬度按 cos 纬度折算东西向距离,cos 最小取这么多(约纬度 84°),极点附近不至于除以 0 */
const MAP_CHART_MIN_COS = 0.1;

/**
 * 球面的主图局部平面(见 Geometry.mapChart):以世界坐标点 (x0, y0) 为原点,u = 经度差 × 当地纬线的长度(东正)、
 * v = 纬度差 × 经线的长度(南正)。经度差取短的一边;换回世界坐标时 x 不取模,y 夹在主图里
 */
class SphereMapChart implements Chart {
  /** 主图横向 1 单位 = 多少世界单位(原点纬度上)、纵向 1 单位 = 多少世界单位 */
  private readonly kx: number;
  private readonly ky: number;
  constructor(
    private readonly W: number,
    private readonly H: number,
    private readonly x: Float32Array,
    private readonly y: Float32Array,
    private readonly x0: number,
    private readonly y0: number,
  ) {
    // 赤道一圈 = 主图宽,所以赤道上横向 1 单位就是 1 世界单位;经线半圈(πR)对应主图高
    this.kx = Math.max(MAP_CHART_MIN_COS, fcos(Math.PI / 2 - (y0 / H) * Math.PI));
    this.ky = W / (2 * H);
  }
  private du(px: number): number {
    let d = px - this.x0;
    if (d > this.W / 2) d -= this.W;
    else if (d < -this.W / 2) d += this.W;
    return d * this.kx;
  }
  u(c: number): number {
    return this.du(this.x[c]);
  }
  v(c: number): number {
    return (this.y[c] - this.y0) * this.ky;
  }
  toU(px: number): number {
    return this.du(px);
  }
  toV(_px: number, py: number): number {
    return (py - this.y0) * this.ky;
  }
  toX(u: number): number {
    return this.x0 + u / this.kx;
  }
  toY(_u: number, v: number): number {
    return clamp(this.y0 + v / this.ky, 0, this.H);
  }
}

/** 六条风带(90–60–30–0–−30–−60–−90)按主图上的 y 等分;经度分 256 格找切口 */
const WIND_BANDS = 6;
const CUT_BINS = 256;
/** 找切口时陆地数按 ±12 格(约 ±17°)的窗口加起来:切口落在一大片海的中间,不是两块陆地之间的窄缝 */
const CUT_WINDOW = 12;

class SphereGeometry implements Geometry {
  readonly kind = 'sphere' as const;
  readonly area: number;
  readonly W: number;
  readonly H: number;
  readonly R: number;
  readonly p: Float32Array;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  /** 每个地块当地的东(ex, ey, 0)、南(sx, sy, sz)单位向量 */
  private readonly ex: Float64Array;
  private readonly ey: Float64Array;
  private readonly sx: Float64Array;
  private readonly sy: Float64Array;
  private readonly sz: Float64Array;
  /** 世界坐标点换单位向量(几份:一次问两个点时各用一份,噪声 / 找地块另用一份) */
  readonly ptA: PointVec;
  private readonly ptB: PointVec;
  private readonly ptN: PointVec;
  private readonly ptF: PointVec;
  private finder: ((q: Float64Array, hint: number) => number) | null = null;
  private readonly qTmp = new Float64Array(3);

  constructor(readonly mesh: Mesh) {
    const { n } = mesh;
    this.W = mesh.width;
    this.H = mesh.height;
    this.R = sphereRadius(mesh.width);
    this.area = 4 * Math.PI * this.R * this.R;
    this.p = mesh.xyz!;
    this.x = mesh.x;
    this.y = mesh.y;
    this.ptA = new PointVec(this.W, this.H);
    this.ptB = new PointVec(this.W, this.H);
    this.ptN = new PointVec(this.W, this.H);
    this.ptF = new PointVec(this.W, this.H);
    this.ex = new Float64Array(n);
    this.ey = new Float64Array(n);
    this.sx = new Float64Array(n);
    this.sy = new Float64Array(n);
    this.sz = new Float64Array(n);
    const p = this.p;
    for (let i = 0; i < n; i++) {
      const px = p[3 * i];
      const py = p[3 * i + 1];
      const pz = p[3 * i + 2];
      const rho = Math.sqrt(px * px + py * py);
      if (rho < 1e-12) {
        // 正好在极点上:经度按 0 算
        this.ex[i] = 0;
        this.ey[i] = 1;
        this.sx[i] = pz > 0 ? 1 : -1;
        this.sy[i] = 0;
        this.sz[i] = 0;
        continue;
      }
      this.ex[i] = -py / rho;
      this.ey[i] = px / rho;
      this.sx[i] = (pz * px) / rho;
      this.sy[i] = (pz * py) / rho;
      this.sz[i] = -rho;
    }
  }

  /** 地块 c 的单位向量和当地东、南单位向量 */
  frame(c: number, cv: Float64Array, e: Float64Array, s: Float64Array): void {
    const p = this.p;
    cv[0] = p[3 * c];
    cv[1] = p[3 * c + 1];
    cv[2] = p[3 * c + 2];
    e[0] = this.ex[c];
    e[1] = this.ey[c];
    e[2] = 0;
    s[0] = this.sx[c];
    s[1] = this.sy[c];
    s[2] = this.sz[c];
  }

  /** 向量(不必是单位长)→ 世界坐标 */
  fromVec(qx: number, qy: number, qz: number, out: number[]): void {
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const lon = fatan2(qy, qx);
    const lat = l > 0 ? fasin(qz / l) : 0;
    let x = ((lon + Math.PI) / TAU) * this.W;
    if (x >= this.W) x -= this.W;
    else if (x < 0) x += this.W;
    out[0] = x;
    out[1] = ((Math.PI / 2 - lat) / Math.PI) * this.H;
  }

  // ---- 距离 ----

  dist(i: number, j: number): number {
    const p = this.p;
    const a = 3 * i;
    const b = 3 * j;
    const dx = p[a] - p[b];
    const dy = p[a + 1] - p[b + 1];
    const dz = p[a + 2] - p[b + 2];
    return this.R * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  dist2(i: number, j: number): number {
    const p = this.p;
    const a = 3 * i;
    const b = 3 * j;
    const dx = p[a] - p[b];
    const dy = p[a + 1] - p[b + 1];
    const dz = p[a + 2] - p[b + 2];
    return this.R * this.R * (dx * dx + dy * dy + dz * dz);
  }
  distTo(i: number, px: number, py: number): number {
    const q = this.ptA.set(px, py);
    const p = this.p;
    const a = 3 * i;
    const dx = p[a] - q[0];
    const dy = p[a + 1] - q[1];
    const dz = p[a + 2] - q[2];
    return this.R * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  pointDist(ax: number, ay: number, bx: number, by: number): number {
    const a = this.ptA.set(ax, ay);
    const b = this.ptB.set(bx, by);
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return this.R * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  near2(i: number, c: number, R: number): number {
    const d2 = this.dist2(i, c);
    return d2 <= R * R ? d2 : -1;
  }
  nearTo(i: number, px: number, py: number, R: number): number {
    const d = this.distTo(i, px, py);
    return d <= R ? d : -1;
  }

  // ---- 方向与位移 ----

  edgeDot(i: number, j: number, ve: number, vs: number): number {
    const p = this.p;
    const a = 3 * i;
    const b = 3 * j;
    const dx = p[b] - p[a];
    const dy = p[b + 1] - p[a + 1];
    const dz = p[b + 2] - p[a + 2];
    const t = (ve * this.ex[i] + vs * this.sx[i]) * dx + (ve * this.ey[i] + vs * this.sy[i]) * dy + vs * this.sz[i] * dz;
    return t / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
  }
  pointDot(ax: number, ay: number, bx: number, by: number, ve: number, vs: number): number {
    const A = this.ptA;
    const a = A.set(ax, ay);
    const b = this.ptB.set(bx, by);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const t = ve * A.east(dx, dy) + vs * A.south(dx, dy, dz);
    return t / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
  }
  downwind(i: number, ve: number, vs: number, cuts?: WindCuts | null): number {
    const x = this.x[i];
    const y = this.y[i];
    if (!cuts) return x * ve + y * vs;
    const b = Math.min(WIND_BANDS - 1, Math.floor((y * WIND_BANDS) / this.H));
    let xr = x - cuts[b];
    if (xr < 0) xr += this.W;
    return xr * ve + y * vs;
  }
  windCuts(water: ArrayLike<number>): WindCuts {
    const { n } = this.mesh;
    const cnt = new Float64Array(WIND_BANDS * CUT_BINS);
    for (let i = 0; i < n; i++) {
      if (water[i] === 1) continue;
      const b = Math.min(WIND_BANDS - 1, Math.floor((this.y[i] * WIND_BANDS) / this.H));
      const c = Math.min(CUT_BINS - 1, Math.floor((this.x[i] * CUT_BINS) / this.W));
      cnt[b * CUT_BINS + c]++;
    }
    const cuts = new Float64Array(WIND_BANDS);
    for (let b = 0; b < WIND_BANDS; b++) {
      let best = 0;
      let bestV = Infinity;
      for (let c = 0; c < CUT_BINS; c++) {
        let v = 0;
        for (let k = -CUT_WINDOW; k <= CUT_WINDOW; k++) v += cnt[b * CUT_BINS + ((c + k + CUT_BINS) % CUT_BINS)];
        if (v < bestV) {
          bestV = v;
          best = c;
        }
      }
      cuts[b] = ((best + 0.5) * this.W) / CUT_BINS;
    }
    return cuts;
  }
  offset(from: number, to: number, out: number[]): void {
    const p = this.p;
    const qx = p[3 * to];
    const qy = p[3 * to + 1];
    const qz = p[3 * to + 2];
    const qe = qx * this.ex[from] + qy * this.ey[from];
    const qs = qx * this.sx[from] + qy * this.sy[from] + qz * this.sz[from];
    const qc = qx * p[3 * from] + qy * p[3 * from + 1] + qz * p[3 * from + 2];
    this.aeqOut(qe, qs, qc, out);
  }
  pointOffset(ax: number, ay: number, bx: number, by: number, out: number[]): void {
    const A = this.ptA;
    const a = A.set(ax, ay);
    const b = this.ptB.set(bx, by);
    this.aeqOut(A.east(b[0], b[1]), A.south(b[0], b[1], b[2]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2], out);
  }
  /** 方位等距坐标:q 在当地东、南、径向上的分量 → 沿大圆的距离 × 方向 */
  private aeqOut(qe: number, qs: number, qc: number, out: number[]): void {
    const t = Math.sqrt(qe * qe + qs * qs);
    if (t < 1e-15) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const k = (this.R * fatan2(t, qc)) / t;
    out[0] = qe * k;
    out[1] = qs * k;
  }
  moveCell(out: number[], i: number, e1: number, s1: number, e2 = 0, s2 = 0, e3 = 0, s3 = 0): void {
    const e = e1 + e2 + e3;
    const s = s1 + s2 + s3;
    const L = Math.sqrt(e * e + s * s);
    if (L === 0) {
      out[0] = this.x[i];
      out[1] = this.y[i];
      return;
    }
    const th = L / this.R;
    const ct = fcos(th);
    const st = fsin(th) / L;
    const p = this.p;
    const a = 3 * i;
    // 沿大圆走:q = p·cos θ + 方向·sin θ
    this.fromVec(
      p[a] * ct + (e * this.ex[i] + s * this.sx[i]) * st,
      p[a + 1] * ct + (e * this.ey[i] + s * this.sy[i]) * st,
      p[a + 2] * ct + s * this.sz[i] * st,
      out,
    );
  }
  clampPoint(out: number[]): void {
    let x = out[0] % this.W;
    if (x < 0) x += this.W;
    out[0] = x;
    out[1] = clamp(out[1], 0, this.H);
  }
  mid(a: number, b: number, out: number[]): void {
    const p = this.p;
    this.fromVec(p[3 * a] + p[3 * b], p[3 * a + 1] + p[3 * b + 1], p[3 * a + 2] + p[3 * b + 2], out);
  }
  plateMotion(vx: Float32Array, vy: Float32Array, cx: Float32Array, cy: Float32Array, spin: ArrayLike<number>): PlateMotion {
    const P = vx.length;
    const omega = new Float32Array(3 * P);
    const A = this.ptA;
    for (let k = 0; k < P; k++) {
      const c = A.set(cx[k], cy[k]);
      // 质心处的速度(3D):vx·东 + vy·南
      const tx = -A.sinLon * vx[k] + A.sinLat * A.cosLon * vy[k];
      const ty = A.cosLon * vx[k] + A.sinLat * A.sinLon * vy[k];
      const tz = -A.cosLat * vy[k];
      const sp = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]) * spin[k];
      // ω = c × t(ω × c = t:质心处正好是这个速度)+ 绕质心自转 sp·c
      omega[3 * k] = c[1] * tz - c[2] * ty + sp * c[0];
      omega[3 * k + 1] = c[2] * tx - c[0] * tz + sp * c[1];
      omega[3 * k + 2] = c[0] * ty - c[1] * tx + sp * c[2];
    }
    const p = this.p;
    const { ex, ey, sx, sy, sz } = this;
    return {
      omega,
      at(k: number, i: number, out: number[]) {
        const wx = omega[3 * k];
        const wy = omega[3 * k + 1];
        const wz = omega[3 * k + 2];
        const px = p[3 * i];
        const py = p[3 * i + 1];
        const pz = p[3 * i + 2];
        // v = ω × p,再分解到当地的东、南
        const vx3 = wy * pz - wz * py;
        const vy3 = wz * px - wx * pz;
        const vz3 = wx * py - wy * px;
        out[0] = vx3 * ex[i] + vy3 * ey[i];
        out[1] = vx3 * sx[i] + vy3 * sy[i] + vz3 * sz[i];
      },
    };
  }

  // ---- 质心 ----

  centroid<T>(items: Iterable<T>, cellOf: (k: T) => number, weightOf: (k: T) => number, out: number[]): number {
    let W = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const p = this.p;
    for (const k of items) {
      const w = weightOf(k);
      const c = cellOf(k);
      W += w;
      sx += w * p[3 * c];
      sy += w * p[3 * c + 1];
      sz += w * p[3 * c + 2];
    }
    if (W === 0) {
      out[0] = NaN;
      out[1] = NaN;
      return W;
    }
    this.fromVec(sx, sy, sz, out);
    return W;
  }
  meanPoint<T>(items: readonly T[], cellOf: (k: T) => number, out: number[]): void {
    if (!items.length) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const p = this.p;
    for (const k of items) {
      const c = cellOf(k);
      sx += p[3 * c];
      sy += p[3 * c + 1];
      sz += p[3 * c + 2];
    }
    this.fromVec(sx, sy, sz, out);
  }
  groupCentroids(group: ArrayLike<number>, count: number, size: ArrayLike<number>): { x: Float32Array; y: Float32Array } {
    const s = new Float64Array(3 * count);
    const n = this.mesh.n;
    const p = this.p;
    for (let i = 0; i < n; i++) {
      const a = 3 * group[i];
      s[a] += p[3 * i];
      s[a + 1] += p[3 * i + 1];
      s[a + 2] += p[3 * i + 2];
    }
    const cx = new Float32Array(count);
    const cy = new Float32Array(count);
    const out = [0, 0];
    for (let k = 0; k < count; k++) {
      if (!(size[k] > 0) || s[3 * k] ** 2 + s[3 * k + 1] ** 2 + s[3 * k + 2] ** 2 === 0) continue;
      this.fromVec(s[3 * k], s[3 * k + 1], s[3 * k + 2], out);
      cx[k] = out[0];
      cy[k] = out[1];
    }
    return { x: cx, y: cy };
  }

  // ---- 纬度 ----

  latitude(i: number): number {
    return 90 - (180 * this.y[i]) / this.H;
  }

  // ---- 噪声 ----

  noise(seed: number): SurfaceNoise {
    return new SphereNoise(noise3(seed), this.p, this.R, this.ptN);
  }
  fbm(seed: number, octaves: number, persistence?: number): SurfaceNoise {
    return new SphereNoise(fbm3(noise3(seed), octaves, persistence), this.p, this.R, this.ptN);
  }
  ridged(seed: number, octaves: number, persistence?: number): SurfaceNoise {
    return new SphereNoise(ridged3(noise3(seed), octaves, persistence), this.p, this.R, this.ptN);
  }

  // ---- 最近的地块 ----

  nearest(px: number, py: number, hint: number): number {
    this.finder ??= sphereFinder(this.mesh, this.p);
    return this.finder(this.ptF.set(px, py), hint);
  }
  /** 球面上直接找真正最近的那块(从上一次找到的地块附近开始) */
  locator(): (px: number, py: number) => number {
    let last = 0;
    return (px: number, py: number) => (last = this.nearest(px, py, last));
  }

  // ---- 面积、折线、局部平面 ----

  cellAreas(): Float32Array {
    const { n, triangles } = this.mesh;
    const p = this.p;
    const R2 = this.R * this.R;
    const out = new Float32Array(n);
    for (let t = 0; t < triangles.length; t += 3) {
      const a = 3 * triangles[t];
      const b = 3 * triangles[t + 1];
      const c = 3 * triangles[t + 2];
      const ax = p[a];
      const ay = p[a + 1];
      const az = p[a + 2];
      const bx = p[b];
      const by = p[b + 1];
      const bz = p[b + 2];
      const cx = p[c];
      const cy = p[c + 1];
      const cz = p[c + 2];
      // 球面三角形面积(球面角盈 E):tan(E/2) = |a·(b×c)| / (1 + a·b + b·c + c·a)
      const triple = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      const den = 1 + ax * bx + ay * by + az * bz + bx * cx + by * cy + bz * cz + cx * ax + cy * ay + cz * az;
      const area = (2 * fatan2(Math.abs(triple), den) * R2) / 3;
      out[triangles[t]] += area;
      out[triangles[t + 1]] += area;
      out[triangles[t + 2]] += area;
    }
    return out;
  }
  polyline(pts: readonly number[], reach: number): Polyline {
    return new SpherePolyline(this, pts, reach);
  }
  chart(center: number): Chart {
    return new SphereChart(this, center);
  }
  chartOf(cells: ArrayLike<number>, weight: (c: number) => number): Chart {
    const p = this.p;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      const w = weight(c);
      sx += w * p[3 * c];
      sy += w * p[3 * c + 1];
      sz += w * p[3 * c + 2];
    }
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(l > 0) || !cells.length) return new SphereChart(this, cells.length ? cells[0] : 0);
    this.finder ??= sphereFinder(this.mesh, this.p);
    const q = this.qTmp;
    q[0] = sx / l;
    q[1] = sy / l;
    q[2] = sz / l;
    return new SphereChart(this, this.finder(q, cells[0]));
  }
  mapChart(px: number, py: number): Chart {
    return new SphereMapChart(this.W, this.H, this.mesh.x, this.mesh.y, px, py);
  }
  centerPath(path: Float32Array): void {
    const m = path.length >> 1;
    if (!m) return;
    // 按长度的中点(主图上的折线长度)
    let L = 0;
    for (let k = 1; k < m; k++) {
      const dx = path[2 * k] - path[2 * k - 2];
      const dy = path[2 * k + 1] - path[2 * k - 1];
      L += Math.sqrt(dx * dx + dy * dy);
    }
    let xm = path[0];
    let acc = 0;
    for (let k = 1; k < m; k++) {
      const dx = path[2 * k] - path[2 * k - 2];
      const dy = path[2 * k + 1] - path[2 * k - 1];
      const l = Math.sqrt(dx * dx + dy * dy);
      if (acc + l >= L / 2) {
        xm = path[2 * k - 2] + (l > 0 ? ((L / 2 - acc) / l) * dx : 0);
        break;
      }
      acc += l;
    }
    const shift = -this.W * Math.floor(xm / this.W);
    if (shift === 0) return;
    for (let k = 0; k < m; k++) path[2 * k] += shift;
  }

  // ---- 主图上的方位 ----

  /**
   * 大洋的方位:按在主图上的位置(x = 经度,y = 纬度):|经度| 超过约 100° 叫东 / 西,|纬度| 超过约 39° 叫北 / 南。
   * 180° 经线两侧(|经度| > 150°)在一颗球上既是最东也是最西:那里的大洋不按东西起名(南北照旧),
   * 主图左右两边的两片大洋不会一个叫"东"、一个叫"西"却隔着 180° 经线挨在一起
   */
  mapSide(c: number): 'n' | 's' | 'e' | 'w' | null {
    const fx = this.x[c] / this.W;
    const fy = this.y[c] / this.H;
    return sideOnMap(Math.abs(fx - 0.5) > SEAM_SIDE ? 0.5 : fx, fy);
  }
  /**
   * 沿纬线圈找西边 / 东边最近的陆地:主图上 G 个世界单位一格的粗网格,每行首尾相接扫两圈;
   * 距离按这一行纬度上真实的东西向长度(× cos 纬度)。一整行没有陆地 = 很远
   */
  zonalLand(land: ArrayLike<number>, G: number): { west: Float32Array; east: Float32Array } {
    const { n } = this.mesh;
    const { x, y } = this;
    const gw = Math.ceil(this.W / G);
    const gh = Math.ceil(this.H / G);
    const col = (px: number) => Math.min(gw - 1, Math.floor(px / G));
    const row = (py: number) => Math.min(gh - 1, Math.floor(py / G));
    const gLand = new Uint8Array(gw * gh);
    for (let i = 0; i < n; i++) if (land[i]) gLand[row(y[i]) * gw + col(x[i])] = 1;
    const distW = new Float32Array(gw * gh);
    const distE = new Float32Array(gw * gh);
    const FAR = 1e9;
    for (let r = 0; r < gh; r++) {
      const k = fcos(Math.PI / 2 - (((r + 0.5) * G) / this.H) * Math.PI) * G;
      let last = -FAR;
      for (let c = 0; c < 2 * gw; c++) {
        const cc = c % gw;
        if (gLand[r * gw + cc]) last = c;
        if (c >= gw) distW[r * gw + cc] = (c - last) * k;
      }
      last = FAR;
      for (let c = 2 * gw - 1; c >= 0; c--) {
        const cc = c % gw;
        if (gLand[r * gw + cc]) last = c;
        if (c < gw) distE[r * gw + cc] = (last - c) * k;
      }
    }
    const west = new Float32Array(n);
    const east = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = row(y[i]) * gw + col(x[i]);
      west[i] = distW[g];
      east[i] = distE[g];
    }
    return { west, east };
  }
}

/**
 * 球面上按位置找最近的地块:3D 哈希网格分桶(格子边长 = 2 个地块间距),先在所在的格子(没有就周围 27 格)里找一个近的,
 * 再沿 Delaunay 邻居贪心走到真正最近的那个(按弦长;Delaunay 上贪心一定能走到最近点)
 */
function sphereFinder(mesh: Mesh, p: Float32Array) {
  const { n, adjStart, adj } = mesh;
  const h = (2 * mesh.spacing) / sphereRadius(mesh.width);
  let TB = 1;
  while (TB < n * 2) TB <<= 1;
  const key = (a: number, b: number, c: number) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (TB - 1);
  const cellOf = (v: number) => Math.floor((v + 1) / h);
  const head = new Int32Array(TB).fill(-1);
  const next = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const k = key(cellOf(p[3 * i]), cellOf(p[3 * i + 1]), cellOf(p[3 * i + 2]));
    next[i] = head[k];
    head[k] = i;
  }
  const d2 = (i: number, q: Float64Array) => (p[3 * i] - q[0]) ** 2 + (p[3 * i + 1] - q[1]) ** 2 + (p[3 * i + 2] - q[2]) ** 2;
  return (q: Float64Array, hint: number) => {
    const gx = cellOf(q[0]);
    const gy = cellOf(q[1]);
    const gz = cellOf(q[2]);
    let best = hint >= 0 && hint < n ? hint : 0;
    let bd = d2(best, q);
    const scan = (a: number, b: number, c: number) => {
      for (let i = head[key(a, b, c)]; i >= 0; i = next[i]) {
        const d = d2(i, q);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    };
    scan(gx, gy, gz);
    if (bd > h * h)
      for (let a = gx - 1; a <= gx + 1; a++) for (let b = gy - 1; b <= gy + 1; b++) for (let c = gz - 1; c <= gz + 1; c++) scan(a, b, c);
    // 贪心走
    let c = best;
    for (;;) {
      let nx = -1;
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        const d = d2(j, q);
        if (d < bd) {
          bd = d;
          nx = j;
        }
      }
      if (nx < 0) return c;
      c = nx;
    }
  };
}
