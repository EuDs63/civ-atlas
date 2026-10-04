/**
 * 气候:温度 + 盛行风 + 水汽输送 → 降水。
 *
 * - 温度:按纬度查表,再按海拔递减(每千米 -6.5°C)
 * - 风带:信风(0-30°,吹向西)、西风带(30-60°,吹向东)、极地东风(60°+);交界 ±5° 内平滑转向,
 *         交界线上风弱(副热带无风带 / 副极地低压带),水汽更多由本地决定
 * - 水汽:顺风一路搬运。海面蒸发补水;上陆后逐步下雨;
 *         遇山抬升猛下雨(迎风坡湿),翻过山水汽所剩无几(背风坡干 = 雨影)
 * - 纬度带修正:赤道辐合带多雨,副热带高压(~25°)干,中纬度锋面多雨,极地干
 */
import { blurField, type Mesh } from './mesh';
import { piecewise, subSeed, clamp, smoothstep } from './util';
import { geometryOf } from './geometry';

export interface ClimateParams {
  seed: number;
  /** 全局温度偏移 °C */
  temperature: number;
  /** 全局降水倍率 */
  rainfall: number;
}

export interface Climate {
  /** 年均温 °C */
  temperature: Float32Array;
  /** 年降水 mm */
  precipitation: Float32Array;
  windX: Float32Array;
  windY: Float32Array;
}

const TEMP_BY_LAT = [0, 27, 15, 26, 30, 20, 45, 11, 60, 1, 75, -11, 90, -24];
const RAIN_BY_LAT = [0, 1.25, 8, 1.1, 16, 0.7, 24, 0.38, 32, 0.5, 42, 0.85, 55, 0.9, 65, 0.6, 78, 0.35, 90, 0.2];

/** 主图上 y 处的纬度(等距圆柱:上边北极 90°、下边南极 −90°;界面、图层用。生成时每个地块的纬度走 geometry 的 latitude) */
export function latitudeAt(y: number, height: number) {
  return 90 - (180 * y) / height;
}

/** 信风 / 极地东风的风向角(北半球,屏幕坐标:0 = 向东,+90° = 向南即朝赤道):吹向西、略偏赤道 */
const EASTERLY_ANGLE = Math.atan2(0.4, -1);
/** 风带交界(30°、60°)两侧各 BLEND 度内平滑转向 */
const BLEND = 5;

/**
 * 盛行风方向(屏幕坐标,y 向下 = 向南),返回单位向量。
 *
 * 西风带正好是信风掉头 180°。交界处不直接混合两个向量(正中间会抵消成零),
 * 而是让风向角度按 smoothstep 转过去:30° 处转半圈、60° 处再转回来,
 * 两次都从"朝赤道"那一侧转,所以过渡带中间的风偏向赤道吹,南北分量不为零。
 */
export function windAt(lat: number): [number, number] {
  const a = Math.abs(lat);
  const toEq = lat >= 0 ? 1 : -1; // 北半球"朝赤道" = y 增大;南半球上下镜像
  const ang =
    EASTERLY_ANGLE -
    Math.PI * smoothstep(30 - BLEND, 30 + BLEND, a) +
    Math.PI * smoothstep(60 - BLEND, 60 + BLEND, a);
  return [Math.cos(ang), Math.sin(ang) * toEq];
}

/**
 * 风力(0-1):风带内部为 1,交界线(30°、60°)上为 0,±BLEND 度内平滑变化。
 * 交界处两股风相互抵消、风弱且乱(副热带无风带 / 副极地低压带),
 * 那里的空气主要来自本地(高空下沉或就地蒸发),不是从远处顺风搬来的。
 */
function windStrength(lat: number) {
  const a = Math.abs(lat);
  const s30 = smoothstep(30 - BLEND, 30 + BLEND, a);
  const s60 = smoothstep(60 - BLEND, 60 + BLEND, a);
  // 平方:交界线附近风力降得更快,且在交界线上平滑过零(没有尖角)
  return (1 - 2 * s30) ** 2 * (1 - 2 * s60) ** 2;
}

export function seaLevelTemp(lat: number) {
  return piecewise(TEMP_BY_LAT, Math.abs(lat));
}

/**
 * elev:海拔(米,海洋为负);water:0 陆地 / 1 海洋 / 2 湖泊。
 */
export function computeClimate(mesh: Mesh, elev: Float32Array, water: Uint8Array, p: ClimateParams): Climate {
  const { n, adjStart, adj, width: W } = mesh;
  const geo = geometryOf(mesh);
  const tNoise = geo.fbm(subSeed(p.seed, 'temp'), 4);
  const fs = 4 / W;

  const temperature = new Float32Array(n);
  const windX = new Float32Array(n);
  const windY = new Float32Array(n);
  const key = new Float32Array(n);
  const strength = new Float32Array(n);
  // 球面上风带绕星球一整圈、没有起点:每条风带在最大的那片大洋中间切开
  const cuts = geo.windCuts(water);
  for (let i = 0; i < n; i++) {
    const lat = geo.latitude(i);
    const [wx, wy] = windAt(lat);
    windX[i] = wx;
    windY[i] = wy;
    strength[i] = windStrength(lat);
    key[i] = geo.downwind(i, wx, wy, cuts);
    const e = water[i] === 1 ? 0 : Math.max(0, elev[i]);
    temperature[i] = seaLevelTemp(lat) + p.temperature - 0.0065 * e + 1.5 * tNoise.at(i, fs);
  }

  // 每条邻接边:邻居 j 是否在 i 的上风向,以及权重(与风向越一致越大;0 = 不是上风)
  const upW = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      // 风从 j 那边吹来:从 i 看 j 的方向和"逆风"一致
      const dot = geo.edgeDot(i, adj[k], -windX[i], -windY[i]);
      if (dot > 0.1) upW[k] = dot;
    }
  }
  // 辐散带(副热带高压,风从这里向南北两边分开)两侧的 cell 会互相把对方当上风。
  // 其实空气是从它俩中间分开的,谁也不给谁送水汽,这种"互为上风"两边都不算。
  // 风带内部风向一致,不会出现这种情况。
  for (let i = 0; i < n; i++) {
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (j <= i || upW[k] === 0) continue;
      for (let m = adjStart[j]; m < adjStart[j + 1]; m++) {
        if (adj[m] !== i) continue;
        if (upW[m] > 0) upW[k] = upW[m] = 0;
        break;
      }
    }
  }
  const waiting = new Int32Array(n); // 还没算完的上风邻居个数
  for (let i = 0; i < n; i++) for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (upW[k] > 0) waiting[i]++;

  // 计算顺序:每个 cell 等它的上风邻居都算完再算(拓扑排序)。
  // 风向在风带交界处随纬度转弯,"位置在风向上的投影"就不再是处处一致的先后顺序,
  // 所以投影只用来在万一遇到环路时挑一个先算的。
  const byKey = new Int32Array(n);
  for (let i = 0; i < n; i++) byKey[i] = i;
  byKey.sort((a, b) => key[a] - key[b]);
  const order = new Int32Array(n);
  const queued = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  let nextKey = 0;
  let cycles = 0;
  for (let a = 0; a < n; a++) {
    const i = byKey[a];
    if (waiting[i] === 0) {
      order[tail++] = i;
      queued[i] = 1;
    }
  }
  while (tail < n) {
    if (head === tail) {
      cycles++;
      while (queued[byKey[nextKey]]) nextKey++;
      const i = byKey[nextKey];
      order[tail++] = i;
      queued[i] = 1;
    }
    const j = order[head++];
    for (let k = adjStart[j]; k < adjStart[j + 1]; k++) {
      const i = adj[k];
      if (queued[i]) continue;
      for (let m = adjStart[i]; m < adjStart[i + 1]; m++) {
        if (adj[m] !== j) continue;
        if (upW[m] > 0 && --waiting[i] === 0) {
          order[tail++] = i;
          queued[i] = 1;
        }
        break;
      }
    }
  }

  // 地形抬升按平滑后的海拔算:气流感受的是整片山地,不是单个山头
  const landElev = new Float32Array(n);
  for (let i = 0; i < n; i++) landElev[i] = water[i] === 1 ? 0 : Math.max(0, elev[i]);
  const smoothElev = blurField(mesh, landElev, 3);

  const hum = new Float32Array(n);
  const rain = new Float32Array(n);
  const BASE = 0.01; // 平地每个 cell 降掉的水汽比例
  const ORO = 0.00018; // 每米抬升额外降水比例
  const RECYCLE = 0.7; // 陆地降水被植被 / 土壤再蒸发回空气的比例
  const satOf = (i: number) => clamp((temperature[i] + 12) / 38, 0.12, 1);
  /** 没有风送来水汽时的本地湿度:海面接近饱和,陆地偏干 */
  const localHum = (i: number) => (water[i] !== 0 ? satOf(i) : 0.3);
  // 按上风先算的顺序扫一遍就是准确解。万一有环路,环路里先算的那个 cell 只能用初值,
  // 再扫第二遍用上一遍的结果补救
  for (let i = 0; i < n; i++) hum[i] = localHum(i);
  for (let sweep = 0; sweep < (cycles > 0 ? 2 : 1); sweep++) {
    for (let a = 0; a < n; a++) {
      const i = order[a];
      let sw = 0;
      let sh = 0;
      let se = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const dot = upW[k];
        if (dot === 0) continue;
        const j = adj[k];
        sw += dot;
        sh += dot * hum[j];
        se += dot * smoothElev[j];
      }
      const isSea = water[i] !== 0;
      const sat = satOf(i);
      // 风越弱,顺风搬来的水汽占比越小,越接近本地湿度
      const local = localHum(i);
      let hm = sw > 0 ? local + (sh / sw - local) * strength[i] : local;
      const ue = sw > 0 ? se / sw : 0;
      if (isSea) {
        hm += (sat - hm) * 0.22;
        rain[i] = hm * BASE * 1.2;
      } else {
        const rise = Math.max(0, smoothElev[i] - ue);
        const frac = clamp(BASE + ORO * rise, 0, 0.6);
        const r = hm * frac;
        hm = hm - r + r * RECYCLE * clamp(sat, 0.3, 1);
        rain[i] = r;
      }
      hum[i] = hm;
    }
  }

  const precipitation = new Float32Array(n);
  const rainS = blurField(mesh, rain, 2);
  const pNoise = geo.fbm(subSeed(p.seed, 'rain'), 4);
  for (let i = 0; i < n; i++) {
    const lat = geo.latitude(i);
    const zonal = piecewise(RAIN_BY_LAT, Math.abs(lat));
    const rel = rainS[i] / BASE; // 沿海平地 ≈ 1
    const v = rel * zonal * (1 + 0.18 * pNoise.at(i, fs));
    precipitation[i] = Math.max(0, v * 1500 * p.rainfall);
  }
  return { temperature, precipitation, windX, windY };
}
