/**
 * 把网格上的世界"铺"成像素:等距圆柱主图(东西无缝、上下边是南北极)。
 * 每个像素中心的方向落在哪个球面三角形里,就在那个三角形里做重心插值,再叠一层细节噪声。
 * 结果只和世界有关、和画风无关;画风切换不用重算。
 *
 * 细节噪声不是处处一样强:
 *   - 按当地起伏走:起伏 = 地块和邻居的平均高差。平原 / 沙漠只剩几米,山地几百米
 *   - 海岸另加一层:岸线沿法向挪动几个像素。平原海岸圆润但仍有细碎的分形细节,
 *     山地海岸挪得更多、再叠一层低频扭曲,显得破碎(海湾、岬角、小岛)
 *   - 沿河道刻出河谷:河越大谷越宽越深,山里的谷更深;谷底把噪声压平
 * 噪声不逐像素现算,而是预先算两张可平铺的噪声贴图(细节 / 气候抖动),按像素在球面上的三维位置
 * 从三个方向投影取样、按法向加权("三向贴图")—— 东西没有接缝,两极不"拉丝"。
 *
 * 流程:地块上算插值源 → 球面三角形覆盖(sphereCover:跨 180° 经线的三角形像素列取模,包着极点的三角形
 * 扫到极点、整圈经度)→ 铺海拔 → 柔化(按纬度修正:高纬度一个像素的东西向地面宽度只有 cos(纬度),列下标取模)
 * → 刻河谷(沿展开后的河道,跨接缝的河在两边各刻一份)→ 逐像素(其余字段 + 噪声 + 群落)→ 海冰。
 * 几个重循环各放在独立的小函数里,引擎更快把它们优化成机器码(第一次调用也快)。
 * 结果带 wrap = true:画风据此把邻域操作的列下标取模。
 */
import type { World } from './world';
import type { Mesh } from './mesh';
import { blurField } from './mesh';
import { classifyBiome } from './biomes';
import { SEA_ICE_MIN, seaIceNodes, seaIcePixels } from './seaice';
import { sampleTile, smoothstep, subSeed, tileableFbm } from './util';
// 河谷要正好落在画出来的河下面,所以直接用画河的同一套几何(纯计算,不碰页面,worker / Node 都能跑)
import { riverGeometry } from '../render/common';

export interface Raster {
  w: number;
  h: number;
  /** 像素 / 世界单位 */
  scale: number;
  /** 海拔(米)。水面像素为水面/海底高度 */
  elev: Float32Array;
  /** 年均温 °C(已按像素海拔修正) */
  temp: Float32Array;
  /** 年降水 mm */
  precip: Float32Array;
  /** 0 陆地 / 1 海洋 / 2 湖泊 */
  water: Uint8Array;
  biome: Uint8Array;
  /** 最近的地块编号(查询用) */
  cell: Int32Array;
  /**
   * 海冰覆盖 0–1(已含浮冰破碎,见 seaice.ts),只有海洋像素可能非 0。
   * 群落 = 海冰 ⇔ ice ≥ 0.5;画风直接读它,不再重新取样
   */
  ice: Float32Array;
  /** 冰缘起伏后的平滑海冰程度 × 255(浮冰打碎之前;0 = 附近没冰)。写实风用来给冰间水面上色 */
  iceConc: Uint8Array;
  /** 这个像素所在那块浮冰的随机色调 × 255(ice > 0 时才有意义)。写实风用来让每块冰明暗略有不同 */
  iceTone: Uint8Array;
  /**
   * 等距圆柱主图东西相连 —— 第 0 列和最后一列相邻,邻域操作的列下标取模;
   * 第 py 行像素中心的纬度 = 90° − (py + 0.5) / h × 180°(上边是北极、下边是南极)
   */
  wrap: true;
}

const LAPSE = 0.0065;
/** 贴图归一化后乘的标准差:和旧版逐像素 fbm 一致,湖岸抖动 / 气候抖动的系数保持原意 */
const DETAIL_STD = 0.25;
const JITTER_STD = 0.29;
/** 细节贴图:512² 像素,最底层 36 格 → 波长约 14 像素,4 层 */
const DETAIL_SIZE = 512;
/** 气候抖动贴图:256²,最底层 18 格,3 层;采样时放大到波长约 40 像素 */
const JITTER_SIZE = 256;

/**
 * 每个三角形存 7 个字段(依次为湖泊比例、细节幅度、海岸标记、海平面等效温度、降水、海岸陡峭度、平滑海冰程度),
 * 每个字段 3 个数:重心权重的线性函数 v = P₀·w_A + P₁·w_B + P₂
 */
const PLANE = 21;

/** 当地起伏(米)→ 陆地细节噪声幅度(米):平原几米,山地几百米 */
function landAmp(rel: number): number {
  return Math.min(520, 7 + rel * (0.1 + 0.9 * smoothstep(40, 350, rel)));
}

/** 海岸有多"陡峭破碎"(0..1):按当地起伏,平原海岸 0,山地海岸 1 */
function rugged(rel: number): number {
  return smoothstep(60, 450, rel);
}

/** 每个地块上的插值源 */
interface CellFields {
  /** 海岸用的有符号海拔:陆地至少 +8m,湖按湖面 */
  sElev: Float32Array;
  lake: Float32Array;
  /** 海平面等效温度 */
  t0: Float32Array;
  precip: Float32Array;
  /** 细节噪声幅度(米) */
  amp: Float32Array;
  /** 海岸标记:海岸地块 1,其余海洋 1e-3,内陆 0(> 0 即"这里允许出现海") */
  coast: Float32Array;
  /** 海岸陡峭度 0..1 */
  rug: Float32Array;
  /** 平滑海冰程度(见 seaIceNodes) */
  ice: Float32Array;
}

function cellFields(world: World): CellFields {
  const { mesh, elevation, water, waterLevel, temperature, precipitation } = world;
  const { n, adjStart, adj } = mesh;
  const sElev = new Float32Array(n);
  const lake = new Float32Array(n);
  const t0 = new Float32Array(n);
  const ground = new Float32Array(n); // 算起伏用:海面按 0,湖按湖面
  for (let i = 0; i < n; i++) {
    const e = elevation[i];
    if (water[i] === 1) sElev[i] = e;
    else sElev[i] = Math.max(e, 8);
    if (water[i] === 2) {
      lake[i] = 1;
      sElev[i] = Math.max(waterLevel[i], 8);
    }
    t0[i] = temperature[i] + LAPSE * Math.max(0, water[i] === 1 ? 0 : sElev[i]);
    ground[i] = water[i] === 1 ? 0 : Math.max(0, water[i] === 2 ? waterLevel[i] : e);
  }

  // 当地起伏 = 和邻居的平均高差,再在网格上柔化两遍(让噪声强弱渐变,不出现分界线)
  const mad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = adjStart[i];
    const t = adjStart[i + 1];
    let acc = 0;
    for (let k = s; k < t; k++) acc += Math.abs(ground[i] - ground[adj[k]]);
    mad[i] = t > s ? acc / (t - s) : 0;
  }
  const rel = blurField(mesh, mad, 2);

  const amp = new Float32Array(n);
  const coast = new Float32Array(n);
  const rug = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sea = water[i] === 1;
    let coastal = false;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      if ((water[adj[k]] === 1) !== sea) {
        coastal = true;
        break;
      }
    }
    const la = landAmp(rel[i]);
    const seaAmp = 30 + 0.02 * -elevation[i];
    // 近岸海底不用海洋的大幅度,免得平原海岸边的陆地也被带得坑坑洼洼
    amp[i] = !sea ? la : coastal ? Math.min(seaAmp, Math.max(la, 12)) : seaAmp;
    coast[i] = coastal ? 1 : sea ? 1e-3 : 0;
    rug[i] = rugged(rel[i]);
  }
  return { sElev, lake, t0, precip: precipitation, amp, coast, rug, ice: seaIceNodes(world) };
}

/** 噪声贴图只和种子有关:记住上一次的,只调参数不换种子时直接复用 */
let tileCache: { seed: number; dTile: Float32Array; jTile: Float32Array } | null = null;
function noiseTiles(seed: number) {
  if (tileCache && tileCache.seed === seed) return tileCache;
  const dTile = tileableFbm(subSeed(seed, 'detail'), DETAIL_SIZE, 36, 4, 0.55);
  const jTile = tileableFbm(subSeed(seed, 'jitter'), JITTER_SIZE, 18, 3, 0.5);
  for (let i = 0; i < dTile.length; i++) dTile[i] *= DETAIL_STD;
  for (let i = 0; i < jTile.length; i++) jTile[i] *= JITTER_STD;
  tileCache = { seed, dTile, jTile };
  return tileCache;
}

/** 写实风画河的参数(src/render/realistic.ts):河谷宽度跟着画出来的河宽走 */
const RIVER_STYLE = { color: '', minW: 0.5, maxW: 7.5, fluxRef: 1000 };
const RIVER_FLARE = 1.7;
const RIVER_POWER = 0.65;

/**
 * 沿每条河刻出河谷:写入下切深度 carve(米)和噪声抑制系数 calm(0..1),都取各河段的最大值。
 * 河道中心线和河宽用画河的同一套几何(riverGeometry:平滑 + 样条、支流接到干流上),
 * 这样谷底正好在画出来的河下面。
 */
function carveValleys(world: World, scale: number, w: number, h: number, carve: Float32Array, calm: Float32Array) {
  // 河道的 x 已展开成连续的(可能出左右边),出边的那段在另一边再刻一份
  const lines = riverGeometry(world.rivers, world.riverThreshold, RIVER_STYLE, RIVER_FLARE, RIVER_POWER, world.width);
  const span = RIVER_STYLE.maxW - RIVER_STYLE.minW;
  for (const d of lines) {
    for (let i = 0; i < d.x.length - 1; i++) {
      const rw = 0.5 * (d.w[i] + d.w[i + 1]); // 河宽(世界单位)
      const t = Math.min(1, Math.max(0, (rw - RIVER_STYLE.minW) / span)); // 河的大小 0..1
      const flat = 0.5 * rw * scale; // 谷底 ≈ 河面半宽
      const wall = flat + (2.5 + 1.5 * t) * scale; // 谷壁在河岸外 2.5–4 像素内收住
      const reach = wall + 2 * scale; // 噪声抑制再往外延一点
      const depth = 30 + 50 * t;
      const ax = d.x[i] * scale;
      const bx = d.x[i + 1] * scale;
      for (const s of WRAP_SHIFTS) {
        const sh = s * w;
        if (Math.min(ax, bx) + sh - reach > w || Math.max(ax, bx) + sh + reach < 0) continue;
        valleySegment(carve, calm, w, h, ax + sh, d.y[i] * scale, bx + sh, d.y[i + 1] * scale, depth, flat, wall, reach);
      }
    }
  }
}

/** 东西相连的主图上,一样东西画在哪几份:本身、往左挪一整圈、往右挪一整圈(× 图宽) */
const WRAP_SHIFTS = [0, -1, 1];

/** 一小段直线河道:在它周围 reach 像素内写入河谷剖面(谷底平、谷壁平滑收起)。 */
function valleySegment(
  carve: Float32Array,
  calm: Float32Array,
  w: number,
  h: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  depth: number,
  flat: number,
  wall: number,
  reach: number,
) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach - 0.5));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + reach));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach - 0.5));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + reach));
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const R2 = reach * reach;
  for (let py = y0; py <= y1; py++) {
    const qy = py + 0.5 - ay;
    for (let px = x0; px <= x1; px++) {
      const qx = px + 0.5 - ax;
      let s = L2 > 0 ? (qx * dx + qy * dy) / L2 : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const ex = qx - s * dx;
      const ey = qy - s * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 >= R2) continue;
      const dist = Math.sqrt(d2);
      const k = py * w + px;
      const cv = depth * (1 - smoothstep(flat, wall, dist));
      if (cv > carve[k]) carve[k] = cv;
      const q = 1 - smoothstep(flat, reach, dist);
      if (q > calm[k]) calm[k] = q;
    }
  }
}

// ---------------------------------------------------------------------------
// 等距圆柱主图:球面三角形覆盖、三向贴图

/** 主栅格每列 / 每行像素中心的经度、纬度三角函数(存 Float32:各引擎最后一位的差别被舍掉) */
export interface SphereGrid {
  w: number;
  h: number;
  cosLon: Float32Array;
  sinLon: Float32Array;
  cosLat: Float32Array;
  sinLat: Float32Array;
}

/** w × h 的等距圆柱主图:第 px 列经度 = (px + 0.5) / w × 360° − 180°,第 py 行纬度 = 90° − (py + 0.5) / h × 180° */
export function sphereGrid(w: number, h: number): SphereGrid {
  const cosLon = new Float32Array(w);
  const sinLon = new Float32Array(w);
  const cosLat = new Float32Array(h);
  const sinLat = new Float32Array(h);
  for (let px = 0; px < w; px++) {
    const l = ((px + 0.5) / w) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.cos(l);
    sinLon[px] = Math.sin(l);
  }
  for (let py = 0; py < h; py++) {
    const l = Math.PI / 2 - ((py + 0.5) / h) * Math.PI;
    cosLat[py] = Math.cos(l);
    sinLat[py] = Math.sin(l);
  }
  return { w, h, cosLon, sinLon, cosLat, sinLat };
}

/** 球面三角形铺出来的主栅格:每个像素属于哪个三角形(编号 + 1,0 = 没盖到)、顶点 A / B 的重心权重(C = 1 − A − B) */
export interface SphereCover {
  tri: Int32Array;
  wa: Float32Array;
  wb: Float32Array;
  /** 没被任何三角形盖到的像素数(应为 0;单测核对) */
  holes: number;
}

/**
 * 按球面三角形铺等距圆柱主栅格。像素中心的方向 q 在三角形 ABC 里 ⇔ q 在三条边所在大圆的同一侧:
 * d_A = q·(B×C)、d_B = q·(C×A)、d_C = q·(A×B) 都 ≥ 0;这三个数归一化就是重心权重(按"有向体积"分,
 * 三角形很小时和平面重心坐标几乎一样,边上连续)。相邻两个三角形共用的边,两边算出的 d 正好互为相反数
 * (叉积、点积都对称),所以边上的像素两边都认、不会漏。
 *
 * 每个三角形只扫它的经纬度范围:
 *   - 纬度:三个顶点 + 三条边(大圆弧会往极点方向鼓出去,算出弧上的最高 / 最低点)各多放一行
 *   - 经度:三个顶点经度在圆周上最短的覆盖弧(去掉最大的空隙);跨 180° 经线时列下标取模
 *   - 包着极点的(三条边都从同一侧绕过极点),扫到极点、整圈经度;贴着极点、经度范围说不清的也扫整圈
 */
export function sphereCover(mesh: Mesh, g: SphereGrid): SphereCover {
  const { w, h, cosLon, sinLon, cosLat, sinLat } = g;
  const xyz = mesh.xyz!;
  const { triangles } = mesh;
  const N = w * h;
  const tri = new Int32Array(N);
  const wa = new Float32Array(N);
  const wb = new Float32Array(N);
  const nt = triangles.length / 3;
  const TAU = 2 * Math.PI;
  const toY = (z: number) => ((Math.PI / 2 - Math.asin(z < -1 ? -1 : z > 1 ? 1 : z)) / Math.PI) * h - 0.5;
  const toX = (l: number) => ((l + Math.PI) / TAU) * w - 0.5;
  const lon = [0, 0, 0];
  const ext = [0, 0];
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const ax = xyz[3 * a];
    const ay = xyz[3 * a + 1];
    const az = xyz[3 * a + 2];
    const bx = xyz[3 * b];
    const by = xyz[3 * b + 1];
    const bz = xyz[3 * b + 2];
    const cx = xyz[3 * c];
    const cy = xyz[3 * c + 1];
    const cz = xyz[3 * c + 2];
    // 三条边的大圆法向:n1 = A×B(对着 C)、n2 = B×C(对着 A)、n3 = C×A(对着 B)
    let n1x = ay * bz - az * by;
    let n1y = az * bx - ax * bz;
    let n1z = ax * by - ay * bx;
    let n2x = by * cz - bz * cy;
    let n2y = bz * cx - bx * cz;
    let n2z = bx * cy - by * cx;
    let n3x = cy * az - cz * ay;
    let n3y = cz * ax - cx * az;
    let n3z = cx * ay - cy * ax;
    const vol = ax * n2x + ay * n2y + az * n2z;
    if (vol === 0) continue;
    // 纬度范围(按 z):顶点 + 各条边上的最高 / 最低点
    ext[0] = Math.max(az, bz, cz);
    ext[1] = Math.min(az, bz, cz);
    arcZ(ax, ay, az, bx, by, bz, n1x, n1y, n1z, ext);
    arcZ(bx, by, bz, cx, cy, cz, n2x, n2y, n2z, ext);
    arcZ(cx, cy, cz, ax, ay, az, n3x, n3y, n3z, ext);
    if (vol < 0) {
      n1x = -n1x;
      n1y = -n1y;
      n1z = -n1z;
      n2x = -n2x;
      n2y = -n2y;
      n2z = -n2z;
      n3x = -n3x;
      n3y = -n3y;
      n3z = -n3z;
    }
    // 包着北极 / 南极:极点方向 (0, 0, ±1) 在三条边的内侧
    const north = n1z >= 0 && n2z >= 0 && n3z >= 0;
    const south = n1z <= 0 && n2z <= 0 && n3z <= 0;
    const y0 = north ? 0 : Math.max(0, Math.ceil(toY(ext[0])) - 1);
    const y1 = south ? h - 1 : Math.min(h - 1, Math.floor(toY(ext[1])) + 1);
    let x0 = 0;
    let x1 = w - 1;
    if (!north && !south && Math.max(Math.abs(az), Math.abs(bz), Math.abs(cz)) < 0.999) {
      lon[0] = Math.atan2(ay, ax);
      lon[1] = Math.atan2(by, bx);
      lon[2] = Math.atan2(cy, cx);
      lon.sort((u, v) => u - v);
      const g1 = lon[1] - lon[0];
      const g2 = lon[2] - lon[1];
      const g3 = lon[0] + TAU - lon[2];
      const gmax = Math.max(g1, g2, g3);
      // 最大的空隙要明显超过半圈才靠得住(否则三角形紧贴极点,经度范围说不清,整圈都扫)
      if (gmax > Math.PI * 1.1) {
        const lo = g3 === gmax ? lon[0] : g1 === gmax ? lon[1] : lon[2];
        const hi = g3 === gmax ? lon[2] : g1 === gmax ? lon[0] + TAU : lon[1] + TAU;
        const xa = Math.ceil(toX(lo)) - 1;
        const xb = Math.floor(toX(hi)) + 1;
        if (xb - xa < w) {
          x0 = xa;
          x1 = xb;
        }
      }
    }
    const tv = t + 1;
    for (let py = y0; py <= y1; py++) {
      const cl = cosLat[py];
      const sl = sinLat[py];
      const e1 = n1z * sl;
      const e2 = n2z * sl;
      const e3 = n3z * sl;
      const row = py * w;
      for (let xx = x0; xx <= x1; xx++) {
        const px = xx < 0 ? xx + w : xx >= w ? xx - w : xx;
        const qx = cl * cosLon[px];
        const qy = cl * sinLon[px];
        const dC = n1x * qx + n1y * qy + e1;
        if (dC < 0) continue;
        const dA = n2x * qx + n2y * qy + e2;
        if (dA < 0) continue;
        const dB = n3x * qx + n3y * qy + e3;
        if (dB < 0) continue;
        const s = dA + dB + dC;
        if (!(s > 0)) continue;
        const k = row + px;
        tri[k] = tv;
        wa[k] = dA / s;
        wb[k] = dB / s;
      }
    }
  }
  // 没盖到的像素(应为 0):沿用左边像素的三角形和权重
  let holes = 0;
  for (let py = 0; py < h; py++) {
    const row = py * w;
    for (let px = 0; px < w; px++) {
      const k = row + px;
      if (tri[k]) continue;
      holes++;
      const j = row + (px > 0 ? px - 1 : w - 1);
      tri[k] = tri[j];
      wa[k] = wa[j];
      wb[k] = wb[j];
    }
  }
  return { tri, wa, wb, holes };
}

/**
 * 大圆弧 p → q(法向 n = p × q)上 z 的最高 / 最低点,把 ext = [最大 z, 最小 z] 往外推。
 * 大圆上 z 最大的点的方向 m = ẑ − (ẑ·n̂) n̂;它在这段弧上 ⇔ (p × m)·n ≥ 0 且 (m × q)·n ≥ 0;最低点是 −m(两个判别式都变号)
 */
function arcZ(px: number, py: number, pz: number, qx: number, qy: number, qz: number, nx: number, ny: number, nz: number, ext: number[]) {
  const nn = nx * nx + ny * ny + nz * nz;
  if (!(nn > 0)) return;
  const t2 = (nz * nz) / nn;
  if (t2 >= 1) return;
  const mx = -nz * nx;
  const my = -nz * ny;
  const mz = nn - nz * nz;
  const s1 = (py * mz - pz * my) * nx + (pz * mx - px * mz) * ny + (px * my - py * mx) * nz;
  const s2 = (my * qz - mz * qy) * nx + (mz * qx - mx * qz) * ny + (mx * qy - my * qx) * nz;
  const top = Math.sqrt(1 - t2);
  if (s1 >= 0 && s2 >= 0 && top > ext[0]) ext[0] = top;
  if (s1 <= 0 && s2 <= 0 && -top < ext[1]) ext[1] = -top;
}

/** 三向贴图的投影面在自己平面里转一个角度,贴图的格子不和经纬线对齐 */
const TRI_C = Math.cos(0.61);
const TRI_S = Math.sin(0.61);
/** 三向贴图的混合:法向分量超过这个值的投影面才参与(极点、赤道附近只取一两个面,省一半取样) */
const TRI_T = 0.45;

/**
 * 三向贴图取样:球面上一点 (X, Y, Z)(世界单位)处,可平铺贴图 tile 在频率 f(每世界单位几个贴图像素)下的值。
 * 三个投影面(YZ、ZX、XY)各取一次,按权重 w0..w2 混合(调用方已按 √Σw² 归一:混合后标准差不变)。
 * o 是这一层的偏移,同一张贴图不同的 o 互不相关。
 */
function tri3(tile: Float32Array, size: number, f: number, o: number, X: number, Y: number, Z: number, w0: number, w1: number, w2: number): number {
  let s = 0;
  if (w0 > 0) {
    const u = Y * f;
    const v = Z * f;
    s += w0 * sampleTile(tile, size, TRI_C * u - TRI_S * v + o, TRI_S * u + TRI_C * v + 0.37 * o + 17.9);
  }
  if (w1 > 0) {
    const u = Z * f;
    const v = X * f;
    s += w1 * sampleTile(tile, size, TRI_C * u - TRI_S * v + 1.31 * o + 131.3, TRI_S * u + TRI_C * v + 0.73 * o + 7.7);
  }
  if (w2 > 0) {
    const u = X * f;
    const v = Y * f;
    s += w2 * sampleTile(tile, size, TRI_C * u - TRI_S * v + 0.59 * o + 61.1, TRI_S * u + TRI_C * v + 1.13 * o + 233.9);
  }
  return s;
}

/** 铺像素(流程见文件头) */
export function rasterize(world: World, scale = 1): Raster {
  const w = Math.round(world.width * scale);
  const h = Math.round(world.height * scale);
  const N = w * h;
  const mesh = world.mesh;
  const f = cellFields(world);
  const g = sphereGrid(w, h);
  const { tri, wa, wb } = sphereCover(mesh, g);

  // 海拔、最近地块;其余字段存成"权重的线性函数":v = P₀·w_A + P₁·w_B + P₂(P₀ = v_A − v_C,P₁ = v_B − v_C,P₂ = v_C)
  const { triangles } = mesh;
  const nt = triangles.length / 3;
  const planes = new Float32Array(nt * PLANE);
  const fields = [f.lake, f.amp, f.coast, f.t0, f.precip, f.rug, f.ice];
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    for (let q = 0; q < 7; q++) {
      const fv = fields[q];
      const o = t * PLANE + q * 3;
      planes[o] = fv[a] - fv[c];
      planes[o + 1] = fv[b] - fv[c];
      planes[o + 2] = fv[c];
    }
  }
  const elev = new Float32Array(N);
  const cell = new Int32Array(N);
  sphereFill(triangles, f.sElev, tri, wa, wb, elev, cell);

  // 柔化(约半个地块宽;东西向按纬度放宽,列下标取模)
  const br = Math.max(1, Math.round(mesh.spacing * scale * 0.35));
  const scratch = new Float32Array(N);
  blurSphere(elev, w, h, br, scratch, g.cosLat);
  blurSphere(elev, w, h, br, scratch, g.cosLat);

  const carve = scratch.fill(0);
  const calm = new Float32Array(N);
  carveValleys(world, scale, w, h, carve, calm);

  const { dTile, jTile } = noiseTiles(world.params.seed);
  const out: Raster = {
    w,
    h,
    scale,
    elev: new Float32Array(N),
    temp: new Float32Array(N),
    precip: new Float32Array(N),
    water: new Uint8Array(N),
    biome: new Uint8Array(N),
    cell,
    ice: new Float32Array(N),
    iceConc: new Uint8Array(N),
    iceTone: new Uint8Array(N),
    wrap: true,
  };
  shadeSphere(out, tri, wa, wb, planes, elev, carve, calm, dTile, jTile, g, world.width / (2 * Math.PI));
  seaIcePixels(world, out);
  return out;
}

/** 按重心权重插值一个地块字段(海拔),同时定最近地块(权重最大的顶点) */
function sphereFill(
  triangles: Uint32Array,
  field: Float32Array,
  tri: Int32Array,
  wa: Float32Array,
  wb: Float32Array,
  out: Float32Array,
  cell: Int32Array | null,
) {
  for (let k = 0; k < out.length; k++) {
    const t = tri[k] - 1;
    if (t < 0) continue;
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const ua = wa[k];
    const ub = wb[k];
    const uc = 1 - ua - ub;
    out[k] = ua * field[a] + ub * field[b] + uc * field[c];
    if (cell) cell[k] = ua >= ub ? (ua >= uc ? a : c) : ub >= uc ? b : c;
  }
}

/** 球面网格上的一个标量场按球面三角形插值到 w × h 的等距圆柱主图(回放帧用;三角形覆盖按尺寸缓存) */
export function sphereField(mesh: Mesh, field: Float32Array, w: number, h: number): Float32Array {
  let c = coverCache.get(mesh);
  if (!c || c.w !== w || c.h !== h) coverCache.set(mesh, (c = { w, h, cover: sphereCover(mesh, sphereGrid(w, h)) }));
  const out = new Float32Array(w * h);
  sphereFill(mesh.triangles, field, c.cover.tri, c.cover.wa, c.cover.wb, out, null);
  return out;
}
const coverCache = new WeakMap<Mesh, { w: number; h: number; cover: SphereCover }>();

/**
 * 球面主图的盒式模糊(原地):东西向列下标取模,半径按纬度放宽(round(r / cos 纬度),极点附近整行平均 ——
 * 那几行本来就挤在极点周围一小块地方);南北向同平面(上下边按最近一行延伸)。
 */
function blurSphere(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array, cosLat: Float32Array) {
  const maxR = (w - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const rx = Math.min(maxR, Math.round(r / Math.max(cosLat[y], 1e-3)));
    const inv = 1 / (2 * rx + 1);
    let acc = 0;
    for (let x = -rx; x <= rx; x++) acc += src[row + (x < 0 ? x + w : x >= w ? x - w : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      const add = x + rx + 1;
      const sub = x - rx;
      acc += src[row + (add >= w ? add - w : add)] - src[row + (sub < 0 ? sub + w : sub)];
    }
  }
  const acc = new Float64Array(w);
  for (let y = -r; y <= r; y++) {
    const row = (y < 0 ? 0 : y > h - 1 ? h - 1 : y) * w;
    for (let x = 0; x < w; x++) acc[x] += tmp[row + x];
  }
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const add = (y + r + 1 > h - 1 ? h - 1 : y + r + 1) * w;
    const sub = (y - r < 0 ? 0 : y - r) * w;
    for (let x = 0; x < w; x++) {
      src[row + x] = acc[x] * inv;
      acc[x] += tmp[add + x] - tmp[sub + x];
    }
  }
}

/**
 * 主图的逐像素:字段按重心权重插值;噪声是三向贴图(按像素在球面上的三维位置取样,
 * 波长按地面上的世界单位算);海岸挪动的东西向位移按纬度放大(同样的地面距离,高纬度占更多像素)、列下标取模。
 * R = 球半径(世界单位)。
 */
function shadeSphere(
  out: Raster,
  tri: Int32Array,
  wA: Float32Array,
  wB: Float32Array,
  P: Float32Array,
  base: Float32Array,
  carve: Float32Array,
  calm: Float32Array,
  dTile: Float32Array,
  jTile: Float32Array,
  g: SphereGrid,
  R: number,
) {
  const { w, h, scale } = out;
  const { elev: oElev, temp: oTemp, precip: oPrecip, water: oWater, biome: oBiome, ice: oIce } = out;
  const { cosLon, sinLon, cosLat, sinLat } = g;
  // 贴图频率(每世界单位几个贴图像素):细节 1(波长约 14)、海岸低频 1/3、山地细纹理 2.37、气候抖动(波长约 40)
  const FJ = JITTER_SIZE / 18 / 40;
  let ti = 0;
  for (let py = 0; py < h; py++) {
    const row = py * w;
    const cl = cosLat[py];
    const sl = sinLat[py];
    const Z = sl * R;
    const a2 = (sl < 0 ? -sl : sl) - TRI_T;
    const w2r = a2 > 0 ? a2 * a2 : 0;
    // 海岸挪动的东西向位移:同样的地面距离在高纬度占 1 / cos(纬度) 个像素(极点附近封顶)
    const stretch = 1 / Math.max(cl, 0.05);
    for (let px = 0; px < w; px++) {
      const k = row + px;
      const tv = tri[k];
      if (tv > 0) ti = tv - 1;
      const o = ti * PLANE;
      const fx = wA[k];
      const fy = wB[k];
      const lake = P[o] * fx + P[o + 1] * fy + P[o + 2];
      const amp = P[o + 3] * fx + P[o + 4] * fy + P[o + 5];
      const cw = P[o + 6] * fx + P[o + 7] * fy + P[o + 8];

      // 三向贴图的权重(按像素在球面上的法向),归一到"混合后标准差不变"
      const qx = cl * cosLon[px];
      const qy = cl * sinLon[px];
      const X = qx * R;
      const Y = qy * R;
      const a0 = (qx < 0 ? -qx : qx) - TRI_T;
      const a1 = (qy < 0 ? -qy : qy) - TRI_T;
      let w0 = a0 > 0 ? a0 * a0 : 0;
      let w1 = a1 > 0 ? a1 * a1 : 0;
      let w2 = w2r;
      const nrm = 1 / Math.sqrt(w0 * w0 + w1 * w1 + w2 * w2);
      w0 *= nrm;
      w1 *= nrm;
      w2 *= nrm;

      const e = base[k];
      const d = tri3(dTile, DETAIL_SIZE, 1, 0, X, Y, Z, w0, w1, w2);
      const isLake = lake + 0.12 * d > 0.5;
      let ee = e;
      if (!isLake) {
        const q = 1 - 0.85 * calm[k];
        let eb = e;
        if (cw > 0.01) {
          const rug = P[o + 15] * fx + P[o + 16] * fy + P[o + 17];
          const D = ((1.2 + 3.5 * rug) * scale * smoothstep(0.01, 0.5, cw)) / DETAIL_STD;
          let wx = tri3(dTile, DETAIL_SIZE, 1, 211.3, X, Y, Z, w0, w1, w2);
          let wy = tri3(dTile, DETAIL_SIZE, 1, 53.9, X, Y, Z, w0, w1, w2);
          if (rug > 0.02) {
            wx += 1.3 * rug * tri3(dTile, DETAIL_SIZE, 1 / 3, 101.7, X, Y, Z, w0, w1, w2);
            wy += 1.3 * rug * tri3(dTile, DETAIL_SIZE, 1 / 3, 157.1, X, Y, Z, w0, w1, w2);
          }
          eb = sampleWrapped(base, w, h, px + D * wx * stretch, py + D * wy);
        }
        let dd = d;
        if (amp > 60 && e > 0) dd += 0.5 * smoothstep(60, 250, amp) * tri3(dTile, DETAIL_SIZE, 2.37, 33.1, X, Y, Z, w0, w1, w2);
        ee = eb + amp * q * dd;
        if (cw === 0 && ee < 2) ee = 2;
        const cv = carve[k];
        if (cv > 0 && ee > 0) ee = Math.max(ee - cv * (1 + amp / 250), Math.min(ee, 1));
      }
      oElev[k] = ee;
      const wtr = isLake ? 2 : ee < 0 ? 1 : 0;
      oWater[k] = wtr;
      const j = tri3(jTile, JITTER_SIZE, FJ, 3.7, X, Y, Z, w0, w1, w2);
      const t = P[o + 9] * fx + P[o + 10] * fy + P[o + 11] - LAPSE * Math.max(0, wtr === 1 ? 0 : ee) + 1.2 * j;
      oTemp[k] = t;
      const pr = (P[o + 12] * fx + P[o + 13] * fy + P[o + 14]) * (1 + 0.22 * j);
      oPrecip[k] = pr;
      oBiome[k] = classifyBiome(t, pr, wtr, 0);
      if (wtr === 1 && tv > 0) {
        const c0 = P[o + 18] * fx + P[o + 19] * fy + P[o + 20];
        if (c0 > SEA_ICE_MIN) oIce[k] = c0;
      }
    }
  }
}

/** 东西相连的主图上双线性取值:列下标取模,行夹在上下边(极点)之内 */
function sampleWrapped(base: Float32Array, w: number, h: number, sx: number, sy: number): number {
  sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
  const xf = Math.floor(sx);
  const tx = sx - xf;
  let x0 = xf % w;
  if (x0 < 0) x0 += w;
  const x1 = x0 + 1 === w ? 0 : x0 + 1;
  const y0 = Math.floor(sy);
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const ty = sy - y0;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const top = base[r0 + x0] + (base[r0 + x1] - base[r0 + x0]) * tx;
  const bot = base[r1 + x0] + (base[r1 + x1] - base[r1 + x0]) * tx;
  return top + (bot - top) * ty;
}
