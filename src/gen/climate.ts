/**
 * 气候:温度 + 盛行风 + 水汽输送 → 降水。
 *
 * - 温度:按纬度查表,再按海拔递减(每千米 -6.5°C)
 * - 风带:信风(0-30°,吹向西)、西风带(30-60°,吹向东)、极地东风(60°+);交界 ±5° 内平滑转向,
 *         交界线上风弱(副热带无风带 / 副极地低压带),水汽更多由本地决定
 * - 水汽:顺风一路搬运。海面蒸发补水;上陆后逐步下雨;
 *         遇山抬升猛下雨(迎风坡湿),翻过山水汽所剩无几(背风坡干 = 雨影)
 * - 纬度带修正:赤道辐合带多雨,副热带高压(~25°)干,中纬度锋面多雨,极地干
 * - 洋流(给了 currents 时,见 currents.ts):海面温度加上洋流的冷暖偏差;海风把这份冷暖顺风带上岸,
 *   越往内陆越淡,翻山再减;贴岸的地方不管风向都沾一点(海雾、海风)。寒流岸边空气稳定、不爱下雨
 *   (海边的沙漠),暖流岸边湿热
 */
import { blurField, type Mesh } from './mesh';
import { piecewise, subSeed, clamp, smoothstep, orderByKey } from './util';
import { geometryOf } from './geometry';
import type { Currents } from './currents';
import { round24 } from './civ/rand';

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

/** 洋流的冷暖顺风上岸:每走一个地块间距(世界单位)保留多少(内陆约 1500 公里淡到三分之一) */
const HEAT_KEEP_PER_UNIT = round24(Math.exp(-1 / (1500 / (40000 / 2048))));
/** 翻山时洋流的冷暖再减:每抬升 1000 米剩 exp(−1/1.5) */
const HEAT_RISE = 1500;
/** 贴岸的地方(不管风向)最多沾多少附近海面的冷暖;"附近"是几圈邻居 */
const COAST_PULL = 0.85;
const COAST_PASSES = 5;

/**
 * 只和网格(纬度)、种子有关的部分:造山侵蚀时算两次粗略降水、最后再算一次,这部分每次都一样,按网格记住
 * (种子换了只重算噪声)。存的都是和现算逐位相同的数
 */
interface ClimateBase {
  seed: number;
  /** 风向(windAt 原样的 64 位数,排顺风先后用)和存进结果的 32 位风向、风力 */
  wx: Float64Array;
  wy: Float64Array;
  windX: Float32Array;
  windY: Float32Array;
  strength: Float32Array;
  /** 海平面气温、纬度带降水修正(按纬度查表) */
  seaTemp: Float64Array;
  zonal: Float64Array;
  /** 每条邻接边的上风权重(0 = 不是上风;互为上风的已去掉)、每个地块有几个上风邻居 */
  upW: Float32Array;
  upCount: Int32Array;
  /** 邻接边 k(从 j 指向 i):j 是不是 i 的上风(拓扑排序时用,省得回头在 i 的邻居里找 j) */
  downstream: Uint8Array;
  /** 气温、降水的噪声(按种子) */
  tNoise: Float64Array;
  pNoise: Float64Array;
}
const baseCache = new WeakMap<Mesh, ClimateBase>();

function climateBase(mesh: Mesh, seed: number): ClimateBase {
  const { n, adjStart, adj, width: W } = mesh;
  const geo = geometryOf(mesh);
  const fs = 4 / W;
  let b = baseCache.get(mesh);
  if (b && b.seed === seed) return b;
  if (!b) {
    const wx = new Float64Array(n);
    const wy = new Float64Array(n);
    const windX = new Float32Array(n);
    const windY = new Float32Array(n);
    const strength = new Float32Array(n);
    const seaTemp = new Float64Array(n);
    const zonal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lat = geo.latitude(i);
      const [x, y] = windAt(lat);
      wx[i] = x;
      wy[i] = y;
      windX[i] = x;
      windY[i] = y;
      strength[i] = windStrength(lat);
      seaTemp[i] = seaLevelTemp(lat);
      zonal[i] = piecewise(RAIN_BY_LAT, Math.abs(lat));
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
    const upCount = new Int32Array(n);
    for (let i = 0; i < n; i++) for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (upW[k] > 0) upCount[i]++;
    const downstream = new Uint8Array(adj.length);
    for (let j = 0; j < n; j++) {
      for (let k = adjStart[j]; k < adjStart[j + 1]; k++) {
        const i = adj[k];
        for (let m = adjStart[i]; m < adjStart[i + 1]; m++) {
          if (adj[m] !== j) continue;
          if (upW[m] > 0) downstream[k] = 1;
          break;
        }
      }
    }
    b = { seed: NaN, wx, wy, windX, windY, strength, seaTemp, zonal, upW, upCount, downstream, tNoise: new Float64Array(n), pNoise: new Float64Array(n) };
    baseCache.set(mesh, b);
  }
  const tNoise = geo.fbm(subSeed(seed, 'temp'), 4);
  const pNoise = geo.fbm(subSeed(seed, 'rain'), 4);
  for (let i = 0; i < n; i++) {
    b.tNoise[i] = tNoise.at(i, fs);
    b.pNoise[i] = pNoise.at(i, fs);
  }
  b.seed = seed;
  return b;
}

/**
 * elev:海拔(米,海洋为负);water:0 陆地 / 1 海洋 / 2 湖泊。
 * currents:洋流(不给 = 不算洋流;造山侵蚀时用的粗略降水不算,地形和以前一样)
 */
export function computeClimate(mesh: Mesh, elev: Float32Array, water: Uint8Array, p: ClimateParams, currents?: Currents): Climate {
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const base = climateBase(mesh, p.seed);
  const { wx, wy, strength, upW, downstream } = base;

  const temperature = new Float32Array(n);
  const key = new Float32Array(n);
  // 球面上风带绕星球一整圈、没有起点:每条风带在最大的那片大洋中间切开
  const cuts = geo.windCuts(water);
  for (let i = 0; i < n; i++) {
    key[i] = geo.downwind(i, wx[i], wy[i], cuts);
    const e = water[i] === 1 ? 0 : Math.max(0, elev[i]);
    temperature[i] = base.seaTemp[i] + p.temperature - 0.0065 * e + 1.5 * base.tNoise[i];
    if (currents && water[i] === 1) temperature[i] += currents.sst[i];
  }

  // 贴岸的陆地沾附近海面的冷暖(不管风向):附近海面偏差的平均 + 附近有多少是海
  const sst = currents?.sst;
  let coastSst: Float32Array | null = null;
  let coastW: Float32Array | null = null;
  if (sst) {
    const seaF = new Float32Array(n);
    for (let i = 0; i < n; i++) seaF[i] = water[i] === 1 ? 1 : 0;
    const num = blurField(mesh, sst, COAST_PASSES);
    const den = blurField(mesh, seaF, COAST_PASSES);
    coastSst = new Float32Array(n);
    coastW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (water[i] === 1 || den[i] === 0) continue;
      coastSst[i] = num[i] / den[i];
      coastW[i] = COAST_PULL * clamp(den[i] * 3, 0, 1);
    }
  }

  const waiting = base.upCount.slice(); // 还没算完的上风邻居个数

  // 计算顺序:每个 cell 等它的上风邻居都算完再算(拓扑排序)。
  // 风向在风带交界处随纬度转弯,"位置在风向上的投影"就不再是处处一致的先后顺序,
  // 所以投影只用来在万一遇到环路时挑一个先算的。
  const byKey = orderByKey(key);
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
      if (downstream[k] && --waiting[i] === 0) {
        order[tail++] = i;
        queued[i] = 1;
      }
    }
  }

  // 地形抬升按平滑后的海拔算:气流感受的是整片山地,不是单个山头
  const landElev = new Float32Array(n);
  for (let i = 0; i < n; i++) landElev[i] = water[i] === 1 ? 0 : Math.max(0, elev[i]);
  const smoothElev = blurField(mesh, landElev, 3);

  const hum = new Float32Array(n);
  const rain = new Float32Array(n);
  /** 空气里带着的洋流冷暖(°C);陆地上就是这里的气温偏差 */
  const heat = new Float32Array(n);
  const landHeat = new Float32Array(n);
  const heatKeep = round24(HEAT_KEEP_PER_UNIT ** mesh.spacing);
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
      let sq = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const dot = upW[k];
        if (dot === 0) continue;
        const j = adj[k];
        sw += dot;
        sh += dot * hum[j];
        se += dot * smoothElev[j];
        sq += dot * heat[j];
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
        let frac = clamp(BASE + ORO * rise, 0, 0.6);
        if (sst) {
          // 顺风带来的冷暖(风越弱越少),贴岸再往附近海面的冷暖拉一把
          let q = sw > 0 ? (sq / sw) * Math.sqrt(strength[i]) : 0;
          q += (coastSst![i] - q) * coastW![i];
          // 寒流岸边空气稳定,不爱下雨;暖流岸边湿热,多下一点
          frac *= q < 0 ? Math.max(0.2, 1 + 0.2 * q) : 1 + 0.04 * Math.min(q, 5);
          heat[i] = q * heatKeep * round24(Math.exp(-rise / HEAT_RISE));
          landHeat[i] = q;
        }
        const r = hm * frac;
        hm = hm - r + r * RECYCLE * clamp(sat, 0.3, 1);
        rain[i] = r;
      }
      if (sst && isSea) {
        // 海面上的空气很快染上海水的冷暖
        const up = sw > 0 ? (sq / sw) * strength[i] : 0;
        heat[i] = up + (sst[i] - up) * 0.35;
      }
      hum[i] = hm;
    }
  }

  if (sst) for (let i = 0; i < n; i++) temperature[i] += landHeat[i];

  const precipitation = new Float32Array(n);
  const rainS = blurField(mesh, rain, 2);
  for (let i = 0; i < n; i++) {
    const rel = rainS[i] / BASE; // 沿海平地 ≈ 1
    const v = rel * base.zonal[i] * (1 + 0.18 * base.pNoise[i]);
    precipitation[i] = Math.max(0, v * 1500 * p.rainfall);
  }
  return { temperature, precipitation, windX: base.windX.slice(), windY: base.windY.slice() };
}
