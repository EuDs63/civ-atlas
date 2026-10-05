/**
 * 洋流:每块海面的水温偏差(和同纬度的平均水温比,°C)和表层流向。
 *
 * 不解流体方程,按地球上大洋环流的规律摆。一片够宽的大洋里:
 * - 副热带(约 10°–40°):大洋西侧(大陆东岸外)暖流流向两极(黑潮、湾流);
 *   东侧(大陆西岸外)寒流流向赤道,贴岸还有上升流,水温最低(秘鲁、本格拉、加利福尼亚寒流)
 * - 副极地(约 45°–70°):反过来,东侧(大陆西岸外)暖流流向极地(北大西洋暖流,挪威不冻),
 *   西侧(大陆东岸外)寒流流向赤道(拉布拉多寒流、亲潮)
 * - 赤道附近:东侧偏冷(赤道冷舌),西侧偏暖(暖池)
 * - 大洋中间:随风带横穿大洋(信风带向西、西风带向东、更靠极地又向西)
 * 暖流流向两极、寒流流向赤道。
 *
 * 流向用"流函数"画环流:每片大洋在每个纬度带里转一个圈(北半球副热带顺时针、副极地逆时针,南半球反过来),
 * 圈在大洋西侧挤得很窄(西边界流又窄又快),东侧铺得很开(东边界流宽而慢)。流函数在大陆岸边为 0,
 * 水就不会流进陆地;流向 = 流函数的等值线方向。
 *
 * "西侧 / 东侧"按沿纬线到最近大陆的距离算(geometry.zonalLand)。只认大块陆地:小岛挡不住环流,
 * 也免得海里放一座火山岛,整片大洋的水温跟着变。
 * 大洋太窄,环流成不了形,偏差跟着减小。偏差随离岸距离衰减,超出影响半径就是 0,远处的海面一点不受影响。
 */
import { blurField, type Mesh } from './mesh';
import { geometryOf } from './geometry';
import { piecewise, smoothstep } from './util';
import { round24 } from './civ/rand';

/** 每世界单位多少公里(赤道一圈 4 万公里 = 地图宽 2048) */
const KM = 40000 / 2048;

/** 大洋西侧(大陆东岸外)的水温偏差,按纬度(度):副热带暖、副极地冷 */
const WEST = [0, 1.5, 10, 2.5, 20, 4, 35, 4, 42, 0, 50, -5, 62, -5, 75, -2, 90, 0];
/** 大洋东侧(大陆西岸外)的水温偏差,按纬度:赤道、副热带冷(上升流),副极地暖 */
const EAST = [0, -3, 8, -3.5, 15, -6, 28, -6, 36, -3, 42, 0, 48, 5, 56, 8, 66, 7, 76, 3, 90, 0];
/** 影响半径(公里):西侧暖流窄而强;东侧寒流贴岸最冷;东侧暖流一大片 */
const R_WEST_WARM = 1500;
const R_WEST_COLD = 1300;
const R_EAST_COLD = 1500;
const R_EAST_WARM = 2200;
/** 两岸加起来这么宽(公里)以下,环流成不了形 → 0;到 FULL 起完整 */
const BASIN_MIN = 1000;
const BASIN_FULL = 3500;
/** 多大的陆地算大陆(整颗球的面积比例;约 100 万平方公里):更小的岛不挡洋流 */
const BIG_LAND = 0.002;

export interface Currents {
  /** 水温偏差(°C);陆地、湖泊为 0 */
  sst: Float32Array;
  /** 表层流向(主图上的单位向量方向 × 强弱 0–1;东为 +x,南为 +y);陆地、湖泊为 0 */
  u: Float32Array;
  v: Float32Array;
}

/** 离岸 d、影响半径 R:贴岸 1,到 R 平滑降到 0 */
function reach(d: number, R: number) {
  if (d >= R) return 0;
  const t = 1 - d / R;
  return t * t;
}

/** 环流圈的纬度带(度):副热带圈(南边一直到赤道,赤道上是向西的赤道流)、副极地圈(弱一些、转向相反) */
const GYRE_SUB = [0, 46];
const GYRE_POLAR = [46, 72];
const POLAR_STRENGTH = 0.7;
/** 西边界流的宽度(公里) */
const WEST_BOUNDARY = 300;
/** 流速多大算 1(流函数梯度,每世界单位) */
const SPEED_REF = 0.02;

/** 三角函数、exp 舍入到 24 位:各引擎最后一位的差别不会漏进世界里(见 civ/rand.ts 的 round24) */
const fsin = (v: number) => round24(Math.sin(v));
const fcos = (v: number) => round24(Math.cos(v));
const fexp = (v: number) => round24(Math.exp(v));

/** 北半球的环流强度(按纬度):副热带圈为正(顺时针),副极地圈为负(逆时针) */
function gyre(a: number) {
  if (a < GYRE_SUB[1]) return fsin((Math.PI * (a - GYRE_SUB[0])) / (GYRE_SUB[1] - GYRE_SUB[0]));
  if (a >= GYRE_POLAR[0] && a < GYRE_POLAR[1])
    return -POLAR_STRENGTH * fsin((Math.PI * (a - GYRE_POLAR[0])) / (GYRE_POLAR[1] - GYRE_POLAR[0]));
  return 0;
}

/** water:0 陆地 / 1 海洋 / 2 湖泊 */
export function computeCurrents(mesh: Mesh, water: Uint8Array): Currents {
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);

  // 大块陆地:陆地(含湖)连通片,面积够大的才算
  const comp = new Int32Array(n).fill(-1);
  const big = new Uint8Array(n);
  const minCells = BIG_LAND * n;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (water[s] === 1 || comp[s] >= 0) continue;
    const cells: number[] = [];
    comp[s] = s;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (water[j] !== 1 && comp[j] < 0) {
          comp[j] = s;
          stack.push(j);
        }
      }
    }
    if (cells.length >= minCells) for (const c of cells) big[c] = 1;
  }

  // 到西边 / 东边最近大陆的距离(世界单位,沿纬线)
  const { west, east } = geo.zonalLand(big, 4);
  const sst = new Float32Array(n);
  const psi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lat = geo.latitude(i);
    if (!big[i]) {
      // 流函数:纬度带的圈 × 东西方向的形状(西岸 0 → 很快升满 → 往东慢慢降回 0);一整圈没有大陆的纬度带只剩纬向流
      const dW = west[i] * KM;
      const dE = east[i] * KM;
      const B = dW + dE;
      const shape =
        B > 1e7 ? 1 : B > 0 ? (1 - fexp(-dW / WEST_BOUNDARY)) * (dE / B) * smoothstep(BASIN_MIN, BASIN_FULL, B) : 0;
      psi[i] = (lat >= 0 ? 1 : -1) * gyre(Math.abs(lat)) * shape;
    }
    if (water[i] !== 1) continue;
    const a = Math.abs(lat);
    const dW = west[i] * KM;
    const dE = east[i] * KM;
    const wide = smoothstep(BASIN_MIN, BASIN_FULL, dW + dE);
    if (wide === 0) continue;
    const pw = piecewise(WEST, a);
    const pe = piecewise(EAST, a);
    const kw = reach(dW, pw > 0 ? R_WEST_WARM : R_WEST_COLD);
    const ke = reach(dE, pe > 0 ? R_EAST_WARM : R_EAST_COLD);
    const tw = wide * pw * kw;
    const te = wide * pe * ke;
    sst[i] = tw + te;
  }
  // 沿纬线量出来的距离一行一行地跳,柔化两遍(只在海面之间平均,岸边的冷暖不被陆地拉淡)
  const seaF = new Float32Array(n);
  for (let i = 0; i < n; i++) seaF[i] = water[i] === 1 ? 1 : 0;
  const num = blurField(mesh, sst, 2);
  const den = blurField(mesh, seaF, 2);
  for (let i = 0; i < n; i++) sst[i] = water[i] === 1 && den[i] > 0 ? num[i] / den[i] : 0;

  // 流向 = 流函数的等值线方向:向东的流速 = −∂ψ/∂北,向北的流速 = ∂ψ/∂东。
  // 先柔化两遍(大陆边缘在相邻纬线上忽进忽出,流函数会一行一行地跳),再用邻居做最小二乘求梯度
  const ps = blurField(mesh, psi, 2);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const { x, y, width: W } = mesh;
  for (let i = 0; i < n; i++) {
    if (water[i] !== 1) continue;
    const c = fcos((geo.latitude(i) * Math.PI) / 180);
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sxp = 0;
    let syp = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      let dx = x[j] - x[i];
      dx -= W * Math.round(dx / W);
      const de = dx * c; // 向东(世界单位)
      const dn = y[i] - y[j]; // 向北
      const dp = ps[j] - ps[i];
      sxx += de * de;
      sxy += de * dn;
      syy += dn * dn;
      sxp += de * dp;
      syp += dn * dp;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) continue;
    const ge = (sxp * syy - syp * sxy) / det; // ∂ψ/∂东
    const gn = (syp * sxx - sxp * sxy) / det; // ∂ψ/∂北
    u[i] = -gn / SPEED_REF;
    v[i] = -ge / SPEED_REF; // 主图 y 向下 = 向南:向南的流速 = −向北的流速
  }
  return { sst, u, v };
}
