/**
 * 海冰:每个海洋地块算一个"海冰程度"(0 开阔水面 – 1 整片冰盖),再在像素上碎成浮冰。
 *
 * 年均温只随纬度变,直接拿它判断会得到一条笔直的冰缘。真实的冰缘被这些因素推来推去:
 * - 冬季冷空气:大陆冬天比海洋冷得多,冷空气顺着盛行风吹到下风向的海面(鄂霍次克海、拉布拉多海);
 *   冰盖 / 高原上下来的风更冷
 * - 封闭程度:三面环陆的海湾、海峡水浅浪小、淡水多,最先封冻(哈德逊湾、波罗的海)
 * - 开阔大洋:水深、洋流带来热量,冰缘缩回去(挪威海)
 * - 洋流:低频噪声模拟暖流 / 寒流,让冰缘在开阔洋面上也有起伏
 * 世界有真正的两极:极地本来就冷,真的冷就会结冰
 *
 * 像素层:铺像素时按地块插值出海冰程度(seaIceNodes + 三角形重心插值),再用 Voronoi 浮冰块
 * 把冰缘打碎(seaIcePixels)—— 越靠外浮冰越稀、缝越宽。结果存进 Raster(ice / iceConc / iceTone),
 * 群落分类和画风都读这一份,保证"画出来是冰的地方,悬停也说是海冰",也不用再算第二遍。
 * 浮冰在三维里做:冰缘起伏、扭曲取球面上的三维噪声,浮冰块是三维 Voronoi 被球面切出来的截面
 * (见 seaIcePixels)—— 东西无缝,极地的浮冰在球面上大小均匀。
 */
import type { Mesh } from './mesh';
import { blurField } from './mesh';
import type { World } from './world';
import type { Raster } from './raster';
import { classifyBiome } from './biomes';
import { clamp, fbm3, noise3, smoothstep, subSeed } from './util';
import { geometryOf } from './geometry';

/** 有效冬季温度高于这个值:开阔水面;低于 PACK:整片冰盖(°C,按年均温尺度) */
const T_OPEN = -3;
const T_PACK = -11;

export function computeSeaIce(
  mesh: Mesh,
  elev: Float32Array,
  water: Uint8Array,
  temperature: Float32Array,
  windX: Float32Array,
  windY: Float32Array,
  seed: number,
): Float32Array {
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);

  // ---- 1. 冬季冷空气顺风搬运:过陆地变冷,过海面慢慢回暖 ----
  const key = new Float32Array(n);
  // 风带绕一整圈:和算降水时一样,在每条风带最大的那片大洋中间切开
  const cuts = geo.windCuts(water);
  for (let i = 0; i < n; i++) key[i] = geo.downwind(i, windX[i], windY[i], cuts);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => key[a] - key[b]);
  const chill = new Float32Array(n);
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let a = 0; a < n; a++) {
      const i = order[a];
      const wx = windX[i];
      const wy = windY[i];
      let sw = 0;
      let sc = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        // 风从 j 那边吹来(见 climate.ts)
        const dot = geo.edgeDot(i, j, -wx, -wy);
        if (dot <= 0.1) continue;
        sw += dot;
        sc += dot * chill[j];
      }
      const up = sw > 0 ? sc / sw : 0;
      if (water[i] !== 1) {
        // 陆地(含湖):越冷的陆地冬天越冷(温度已含海拔递减,冰盖 / 高原上吹下来的风更冷);温暖的陆地不影响
        const target = -10 * smoothstep(14, -6, temperature[i]);
        chill[i] = up + (target - up) * 0.2;
      } else {
        chill[i] = up * 0.95;
      }
    }
  }

  // ---- 2. 封闭程度:近处(海湾)和远处(大洋)各看一个尺度 ----
  const landF = new Float32Array(n);
  for (let i = 0; i < n; i++) landF[i] = water[i] === 1 ? 0 : 1;
  const near = blurField(mesh, landF, 5);
  const far = blurField(mesh, near, 30);

  // ---- 3. 边界流:大洋西侧(大陆东岸外)寒流南下,东侧(大陆西岸外)暖流北上 ----
  // 用粗网格(8 个世界单位一格)沿纬线扫描,求每个海面到西边 / 东边最近陆地的距离
  const { west: distW, east: distE } = geo.zonalLand(landF, 8);

  // ---- 4. 合成有效冬季温度 → 海冰程度 ----
  const current = geo.fbm(subSeed(seed, 'seaice-current'), 2);
  const fc = 1 / 300;
  const ice = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] !== 1) continue;
    const open = 1 - clamp(far[i] * 2.2, 0, 1); // 周围几乎没有陆地 = 开阔大洋
    const deep = smoothstep(-200, -2500, elev[i]);
    const boundary = -3.5 * Math.exp(-distW[i] / 180) + 2.5 * Math.exp(-distE[i] / 180);
    const teff =
      temperature[i] +
      chill[i] -
      3 * clamp(near[i] * 1.6, 0, 1) + // 海湾、海峡、沿岸固定冰
      1.5 * open +
      0.8 * deep +
      boundary +
      (3.5 + 4.5 * open) * current.stretched(i, fc, 0.55); // 洋流:南北向拉长,冰舌一条一条伸出去
    ice[i] = smoothstep(T_OPEN, T_PACK, teff);
  }
  return ice;
}

/**
 * 每个地块中心处的平滑海冰程度(浮冰打碎之前)。铺像素时在球面三角形里对它做重心插值(见 raster.ts),
 * 得到每个像素的平滑海冰程度,再交给 seaIcePixels 打碎成浮冰。
 * 平滑:地块 + 一圈邻居按 (1 - d²/R²)² 加权平均,R ≈ 2 个地块间距(比高斯便宜,形状差不多)。
 * 陆地 / 湖泊地块先取相邻海面的平均值,免得海岸附近的冰被"拉"成 0。
 */
export function seaIceNodes(world: World): Float32Array {
  const { mesh, seaIce, water } = world;
  const { n, adjStart, adj, spacing } = mesh;
  const geo = geometryOf(mesh);
  const node = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] === 1) {
      node[i] = seaIce[i];
      continue;
    }
    let s = 0;
    let c = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (water[j] === 1) {
        s += seaIce[j];
        c++;
      }
    }
    node[i] = c ? s / c : 0;
  }
  const invR2 = 1 / (spacing * spacing * 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sw = 0;
    let sv = 0;
    for (let k = adjStart[i] - 1; k < adjStart[i + 1]; k++) {
      const j = k < adjStart[i] ? i : adj[k];
      const t = Math.max(0, 1 - geo.dist2(j, i) * invR2);
      const wj = t * t + 1e-6;
      sw += wj;
      sv += wj * node[j];
    }
    out[i] = sv / sw;
  }
  return out;
}

/** 浮冰块尺寸(世界单位,约等于像素) */
const FLOE_BIG = 17;
const FLOE_SMALL = 7;
/** 碎冰那一层的坐标变换:放大一点再平移,和大冰块的格子错开 */
const SMALL_K = 1.07;
const SMALL_DX = 7.3;
const SMALL_DY = -3.1;
/** 碎冰那一层在第三个轴上的平移 */
const SMALL_DZ = 4.9;
/** 浮冰坐标扭曲的幅度(世界单位) */
const WARP = 3.2;
/** 冰缘起伏、坐标扭曲噪声的格点间距(世界单位,约 4 像素):格点上算原噪声,格子里双线性插值 */
const NOISE_STEP = 4;
/** 平滑海冰程度不超过这个值:没冰(铺像素时这样的像素直接记 0) */
export const SEA_ICE_MIN = 0.002;

// ---------------------------------------------------------------------------
// 像素级浮冰:浮冰长在球面上
//
// 冰缘起伏、扭曲噪声取球面上的三维噪声,浮冰块是三维 Voronoi 格子(冰块中心撒在立方格里)被球面切出来的截面。
// 这样东西没有接缝,极地的浮冰在球面上大小均匀(主图上高纬度随地形一起被横向拉宽,和真实的等距圆柱地图一样),
// 以后换投影、上地球仪也不会在极点收成一根根细条。
// 冰块边缘的抗锯齿按像素算:到冰块边缘的地面距离换算成主图上的像素距离(东西向一个像素的地面宽度是 cos 纬度),
// 高纬度的冰缘不会糊成一片。

/** 三维冰块中心表:立方格边长 L,覆盖 [x0, x1] × [y0, y1] × [z0, z1] 外加两格余量 */
interface FloeTable3 {
  L: number;
  cx0: number;
  cy0: number;
  cz0: number;
  cw: number;
  ch: number;
  cd: number;
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  h: Float32Array;
  tone: Uint8Array;
}

/** 整数哈希(三维格子)→ [0,1) */
function hash3(ix: number, iy: number, iz: number, s: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 1442695041 + s) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function floeTable3(L: number, hs: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): FloeTable3 {
  const cx0 = Math.floor(x0 / L) - 2;
  const cy0 = Math.floor(y0 / L) - 2;
  const cz0 = Math.floor(z0 / L) - 2;
  const cw = Math.floor(x1 / L) + 3 - cx0;
  const ch = Math.floor(y1 / L) + 3 - cy0;
  const cd = Math.floor(z1 / L) + 3 - cz0;
  const M = cw * ch * cd;
  const sx = new Float32Array(M);
  const sy = new Float32Array(M);
  const sz = new Float32Array(M);
  const h = new Float32Array(M);
  const tone = new Uint8Array(M);
  for (let d = 0; d < cd; d++) {
    const cz = cz0 + d;
    for (let r = 0; r < ch; r++) {
      const cy = cy0 + r;
      for (let c = 0; c < cw; c++) {
        const cx = cx0 + c;
        const q = (d * ch + r) * cw + c;
        const h1 = hash3(cx, cy, cz, hs);
        const h2 = hash3(cx, cy, cz, hs + 1);
        sx[q] = (cx + 0.1 + 0.8 * h1) * L;
        sy[q] = (cy + 0.1 + 0.8 * ((h1 * 4096) % 1)) * L;
        sz[q] = (cz + 0.1 + 0.8 * h2) * L;
        h[q] = hash3(cx, cy, cz, hs + 2);
        tone[q] = (((h[q] * 7.31) % 1) * 255 + 0.5) | 0;
      }
    }
  }
  return { L, cx0, cy0, cz0, cw, ch, cd, sx, sy, sz, h, tone };
}

/** 点所在格子的 3×3×3 邻域在表里的"左下前"角下标(出表时夹到边上) */
function blockOf3(t: FloeTable3, ux: number, uy: number, uz: number): number {
  const gx = Math.floor(ux / t.L) - 1 - t.cx0;
  const gy = Math.floor(uy / t.L) - 1 - t.cy0;
  const gz = Math.floor(uz / t.L) - 1 - t.cz0;
  const cx = gx < 0 ? 0 : gx > t.cw - 3 ? t.cw - 3 : gx;
  const cy = gy < 0 ? 0 : gy > t.ch - 3 ? t.ch - 3 : gy;
  const cz = gz < 0 ? 0 : gz > t.cd - 3 ? t.cd - 3 : gz;
  return (cz * t.ch + cy) * t.cw + cx;
}

/** 3×3×3 邻域里离 u 最近的冰块中心(表下标;一样近取先遇到的) */
function nearestSite3(t: FloeTable3, base: number, ux: number, uy: number, uz: number): number {
  const { sx, sy, sz, cw, ch } = t;
  let best = Infinity;
  let bi = base;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) {
      const row = base + (k * ch + j) * cw;
      for (let q = row; q < row + 3; q++) {
        const dx = sx[q] - ux;
        const dy = sy[q] - uy;
        const dz = sz[q] - uz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          bi = q;
        }
      }
    }
  }
  return bi;
}

/** edgeDistance3 找到的最近那条冰块边(平分面)的单位法向 */
const edgeN = [0, 0, 0];

/** u 到冰块 bi 边缘的距离:到它和邻域里其余冰块中心的平分面的最近距离;最近那个平分面的法向写进 edgeN */
function edgeDistance3(t: FloeTable3, base: number, bi: number, ux: number, uy: number, uz: number): number {
  const { sx, sy, sz, cw, ch } = t;
  const bx = sx[bi];
  const by = sy[bi];
  const bz = sz[bi];
  let ed = Infinity;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) {
      const row = base + (k * ch + j) * cw;
      for (let q = row; q < row + 3; q++) {
        if (q === bi) continue;
        const dx = bx - sx[q];
        const dy = by - sy[q];
        const dz = bz - sz[q];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < 1e-6) continue;
        const d = ((ux - (bx + sx[q]) / 2) * dx + (uy - (by + sy[q]) / 2) * dy + (uz - (bz + sz[q]) / 2) * dz) / l;
        if (d < ed) {
          ed = d;
          edgeN[0] = dx / l;
          edgeN[1] = dy / l;
          edgeN[2] = dz / l;
        }
      }
    }
  }
  return ed;
}

/**
 * 像素级海冰:把平滑海冰程度加上冰缘起伏,再用两层 Voronoi 浮冰块打碎 —— 越靠外浮冰越稀、缝越宽。
 * 纯计算、确定性:同一个世界、同一个像素,结果永远一样。
 *
 * 输入:r.ice 里放好每个海洋像素在三角形里插值出的平滑海冰程度,
 * 不超过 SEA_ICE_MIN 的(包括陆地)记 0。本函数原地改写 r.ice 为最终覆盖度,并写出:
 *   r.ice      海冰覆盖 0–1(已含浮冰破碎),非海洋像素为 0
 *   r.iceConc  冰缘起伏后的平滑海冰程度 × 255(浮冰打碎之前,画风用来给冰间水面上色)
 *   r.iceTone  这个像素所在那块浮冰的色调 × 255(让每块冰明暗略有不同)
 *   r.biome    覆盖过半的海洋像素改成"海冰"(classifyBiome),保证"画出来是冰的地方,悬停也说是海冰"
 *
 * 为了快(查表和下面几条捷径不改变结果 —— 和逐像素、逐层老老实实算的版本逐像素比对过;
 * 和改版前相比,只是平滑海冰程度改成三角形插值、噪声改成格点插值,冰缘个别浮冰有出入):
 *   - 冰缘起伏 / 扭曲噪声只在约 4 像素一格的格点上算原噪声,格子里双线性插值;只算冰区用到的格点
 *   - 按格子逐块处理(每块一次函数调用,引擎很快就把它编译成机器码),四个角只读一次
 *   - 冰块中心预先查表;冰盖深处只找落在哪块冰上(取色调),四个角都在同一块冰上时整格都不用找;
 *     用不到的那层浮冰直接跳过
 */
export function seaIcePixels(world: World, r: Raster) {
  const { w, h, scale, ice, iceConc, iceTone, biome, temp, precip } = r;
  const seed = world.params.seed;
  const R = world.width / (2 * Math.PI);
  const cosLon = new Float64Array(w);
  const sinLon = new Float64Array(w);
  for (let px = 0; px < w; px++) {
    const l = ((px + 0.5) / w) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.fround(Math.cos(l));
    sinLon[px] = Math.fround(Math.sin(l));
  }
  const cosLat = new Float64Array(h);
  const sinLat = new Float64Array(h);
  for (let py = 0; py < h; py++) {
    const l = Math.PI / 2 - ((py + 0.5) / h) * Math.PI;
    cosLat[py] = Math.fround(Math.cos(l));
    sinLat[py] = Math.fround(Math.sin(l));
  }

  // ---- 要处理的格子(有冰的像素所在的格子)和冰区的三维范围 ----
  const S = Math.max(1, Math.round(NOISE_STEP * scale));
  const invS = 1 / S;
  const gw = Math.ceil(w / S) + 1;
  const gh = Math.ceil(h / S) + 1;
  const act = new Uint8Array(gw * gh);
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let by0 = Infinity;
  let by1 = -Infinity;
  let bz0 = Infinity;
  let bz1 = -Infinity;
  let any = false;
  for (let py = 0; py < h; py++) {
    const row = py * w;
    const J = Math.floor(py * invS) * gw;
    const cl = cosLat[py] * R;
    const z = sinLat[py] * R;
    for (let px = 0; px < w; px++) {
      if (!(ice[row + px] > SEA_ICE_MIN)) continue;
      any = true;
      act[J + Math.floor(px * invS)] = 1;
      const x = cl * cosLon[px];
      const y = cl * sinLon[px];
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      if (z < bz0) bz0 = z;
      if (z > bz1) bz1 = z;
    }
  }
  if (!any) return;

  // ---- 噪声格点:S 像素一格,取格点那个方向上的三维噪声;懒算,NaN = 还没算 ----
  const warpA = noise3(subSeed(seed, 'seaice-warp-a'));
  const warpB = noise3(subSeed(seed, 'seaice-warp-b'));
  const edge = fbm3(noise3(subSeed(seed, 'seaice-edge')), 3);
  const grid = new Float32Array(gw * gh * 3).fill(NaN);
  /** 格点在球面上的位置(世界单位)+ 当地东、南方向:扭曲后的位置 = 位置 + WARP ×(a·东 + b·南) */
  const pos = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const frame = (fx: number, fy: number) => {
    const lon = (fx / w) * 2 * Math.PI - Math.PI;
    const lat = Math.PI / 2 - (fy / h) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const co = Math.cos(lon);
    const so = Math.sin(lon);
    pos[0] = R * cl * co;
    pos[1] = R * cl * so;
    pos[2] = R * sl;
    pos[3] = -so; // 东
    pos[4] = co;
    pos[5] = 0;
    pos[6] = sl * co; // 南
    pos[7] = sl * so;
    pos[8] = -cl;
  };
  const node = (gx: number, gy: number) => {
    const o = (gy * gw + gx) * 3;
    if (grid[o] === grid[o]) return o;
    frame(gx * S + 0.5, gy * S + 0.5);
    grid[o] = edge(pos[0] / 48, pos[1] / 48, pos[2] / 48);
    grid[o + 1] = warpA(pos[0] / 26, pos[1] / 26, pos[2] / 26);
    grid[o + 2] = warpB(pos[0] / 26, pos[1] / 26, pos[2] / 26);
    return o;
  };

  // ---- 冰块中心表:冰区的三维范围 ± 扭曲幅度 ----
  const hs = subSeed(seed, 'seaice-floes') | 0;
  const m = WARP + 1;
  const tB = floeTable3(FLOE_BIG, hs, bx0 - m, bx1 + m, by0 - m, by1 + m, bz0 - m, bz1 + m);
  const sk = (v: number, d: number) => v * SMALL_K + d;
  const tS = floeTable3(
    FLOE_SMALL,
    hs + 7,
    sk(bx0 - m, SMALL_DX),
    sk(bx1 + m, SMALL_DX),
    sk(by0 - m, SMALL_DY),
    sk(by1 + m, SMALL_DY),
    sk(bz0 - m, SMALL_DZ),
    sk(bz1 + m, SMALL_DZ),
  );
  const nodeSite = new Int32Array(gw * gh).fill(-1);
  const siteAt = (gx: number, gy: number, o: number) => {
    const q = gy * gw + gx;
    if (nodeSite[q] < 0) {
      frame(gx * S + 0.5, gy * S + 0.5);
      const a = WARP * grid[o + 1];
      const b = WARP * grid[o + 2];
      const ux = pos[0] + a * pos[3] + b * pos[6];
      const uy = pos[1] + a * pos[4] + b * pos[7];
      const uz = pos[2] + a * pos[5] + b * pos[8];
      nodeSite[q] = nearestSite3(tB, blockOf3(tB, ux, uy, uz), ux, uy, uz);
    }
    return nodeSite[q];
  };

  const deepK = 0.7 - 0.5 / scale;
  const DEEP = deepK > 0 ? Math.max(0.85, 1 - Math.pow(deepK / 2.6, 1 / 1.2)) : 2;

  /**
   * 冰块覆盖(抗锯齿):ed = 到最近那个平分面(法向 edgeN)的三维距离,gap = 缝宽(地面距离)。
   * 平分面法向在当地切平面上的分量 (东 ne, 南 ns):沿地面走到冰块边缘的距离 = ed / |切向分量|;
   * 主图上东西向一个像素的地面宽度是 cos 纬度,所以同一段地面距离在主图上是 1 / √(n̂e²·cos² + n̂s²) 倍的像素
   */
  const cover = (ed: number, gap: number, ex: number, ey: number, sx: number, sy: number, sz: number, cl: number) => {
    const ne = edgeN[0] * ex + edgeN[1] * ey;
    const ns = edgeN[0] * sx + edgeN[1] * sy + edgeN[2] * sz;
    const t2 = Math.max(0.05, ne * ne + ns * ns);
    const px2 = Math.max(ne * ne * cl * cl + ns * ns, 4e-4 * t2);
    return clamp((ed / Math.sqrt(t2) - gap) * scale * Math.sqrt(t2 / px2) + 0.5, 0, 1);
  };

  const square = (I: number, J: number) => {
    const py0 = J * S;
    const py1 = Math.min(h, py0 + S);
    const px0 = I * S;
    const px1 = Math.min(w, px0 + S);
    const a = node(I, J);
    const b = node(I + 1, J);
    const c = node(I, J + 1);
    const d = node(I + 1, J + 1);
    let whole = -2;
    for (let py = py0; py < py1; py++) {
      const ty = (py - py0) * invS;
      const cl = cosLat[py];
      const sl = sinLat[py];
      const eL = grid[a] + (grid[c] - grid[a]) * ty;
      const eR = grid[b] + (grid[d] - grid[b]) * ty;
      const aL = grid[a + 1] + (grid[c + 1] - grid[a + 1]) * ty;
      const aR = grid[b + 1] + (grid[d + 1] - grid[b + 1]) * ty;
      const bL = grid[a + 2] + (grid[c + 2] - grid[a + 2]) * ty;
      const bR = grid[b + 2] + (grid[d + 2] - grid[b + 2]) * ty;
      for (let px = px0; px < px1; px++) {
        const k = py * w + px;
        const c0 = ice[k];
        if (!(c0 > SEA_ICE_MIN)) continue;
        const tx = (px - px0) * invS;

        // 1. 冰缘的中尺度起伏
        const e = eL + (eR - eL) * tx;
        const conc = clamp(c0 + 0.3 * e * Math.min(1, c0 * 3) * (1 - c0 * 0.7), 0, 1);
        iceConc[k] = (conc * 255 + 0.5) | 0;
        if (conc <= 0.01) {
          ice[k] = 0;
          continue;
        }

        // 2. 浮冰:像素在球面上的位置,沿当地东、南扭一扭
        const co = cosLon[px];
        const so = sinLon[px];
        const ex = -so; // 东
        const ey = co;
        const sx = sl * co; // 南
        const sy = sl * so;
        const sz = -cl;
        const wa = WARP * (aL + (aR - aL) * tx);
        const wb = WARP * (bL + (bR - bL) * tx);
        const ux = R * cl * co + wa * ex + wb * sx;
        const uy = R * cl * so + wa * ey + wb * sy;
        const uz = R * sl + wb * sz;
        let v = 0;
        let tone = 0;
        if (conc >= DEEP) {
          v = 1;
          if (whole === -2) {
            const s0 = siteAt(I, J, a);
            whole = s0 === siteAt(I + 1, J, b) && s0 === siteAt(I, J + 1, c) && s0 === siteAt(I + 1, J + 1, d) ? s0 : -1;
          }
          tone = tB.tone[whole >= 0 ? whole : nearestSite3(tB, blockOf3(tB, ux, uy, uz), ux, uy, uz)];
        } else {
          if (conc > 0.3) {
            const base = blockOf3(tB, ux, uy, uz);
            const bi = nearestSite3(tB, base, ux, uy, uz);
            if (tB.h[bi] < smoothstep(0.3, 0.85, conc)) {
              const gapB = 2.6 * Math.pow(1 - conc, 1.2) - 0.7;
              v = cover(edgeDistance3(tB, base, bi, ux, uy, uz), gapB, ex, ey, sx, sy, sz, cl);
              tone = tB.tone[bi];
            }
          }
          if (v < 1 && conc > 0.1) {
            const qx = ux * SMALL_K + SMALL_DX;
            const qy = uy * SMALL_K + SMALL_DY;
            const qz = uz * SMALL_K + SMALL_DZ;
            const base = blockOf3(tS, qx, qy, qz);
            const si = nearestSite3(tS, base, qx, qy, qz);
            if (tS.h[si] < (conc - 0.1) * 1.3) {
              const gap = 0.45 + 1.1 * (1 - conc);
              const small = cover(edgeDistance3(tS, base, si, qx, qy, qz), gap, ex, ey, sx, sy, sz, cl);
              if (small > v) {
                v = small;
                tone = tS.tone[si];
              }
            }
          }
        }
        ice[k] = v;
        iceTone[k] = tone;
        const vs = ice[k];
        if (vs >= 0.5) biome[k] = classifyBiome(temp[k], precip[k], 1, vs);
      }
    }
  };
  for (let J = 0; J < gh - 1; J++) {
    for (let I = 0; I < gw - 1; I++) if (act[J * gw + I]) square(I, J);
  }
}
