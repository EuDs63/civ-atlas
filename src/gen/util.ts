/**
 * 生成管线共用的小工具:确定性随机数、噪声、最小堆、插值。
 * 所有生成步骤只通过 seed 取随机,保证"同一个种子 = 同一个世界"。
 */
import { createNoise2D, createNoise3D } from 'simplex-noise';

export type Rng = () => number;

/** mulberry32:32 位种子 → [0,1) 伪随机序列。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从主种子派生出互不相关的子种子,让每个步骤各用一条随机流。 */
export function subSeed(seed: number, salt: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** 32 位整数混合(murmur3 fmix32) */
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 按实体取随机数:[0, 1)。a、b、c 是整数(位置锚、年份、用途编号……),缺省为 0。
 * 同样的参数永远得到同样的数,和取的先后无关(文明推演见 civ/rand.ts;地形里按地块取的也用它)。
 */
export function keyed(base: number, a = 0, b = 0, c = 0): number {
  let h = fmix((base ^ 0x2545f491) >>> 0);
  h = fmix((h ^ Math.imul(a | 0, 0x9e3779b1)) >>> 0);
  h = fmix((h ^ Math.imul(b | 0, 0x85ebca77)) >>> 0);
  h = fmix((h ^ Math.imul(c | 0, 0xc2b2ae3d)) >>> 0);
  return h / 4294967296;
}

/** 四个整数的 keyed(两个实体的位置锚 + 第几次 + 用途):[0, 1) */
export function keyed4(base: number, a: number, b: number, c: number, d: number): number {
  let h = fmix((base ^ 0x2545f491) >>> 0);
  h = fmix((h ^ Math.imul(a | 0, 0x9e3779b1)) >>> 0);
  h = fmix((h ^ Math.imul(b | 0, 0x85ebca77)) >>> 0);
  h = fmix((h ^ Math.imul(c | 0, 0xc2b2ae3d)) >>> 0);
  h = fmix((h ^ Math.imul(d | 0, 0x27d4eb2f)) >>> 0);
  return h / 4294967296;
}

export type Noise2 = (x: number, y: number) => number;

export function noise2(seed: number): Noise2 {
  return createNoise2D(mulberry32(seed));
}

/** 分形布朗运动:多层噪声叠加,输出约 [-1,1]。 */
export function fbm(n: Noise2, octaves: number, persistence = 0.5, lacunarity = 2): Noise2 {
  return (x, y) => {
    let v = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += amp * n(x * f + o * 17.3, y * f - o * 9.1);
      norm += amp;
      amp *= persistence;
      f *= lacunarity;
    }
    return v / norm;
  };
}

/** 山脊噪声:在噪声零线处形成尖脊,输出 [0,1]。用来做古老山系。 */
export function ridged(n: Noise2, octaves: number, persistence = 0.5): Noise2 {
  return (x, y) => {
    let v = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(n(x * f + o * 31.7, y * f + o * 7.7));
      r *= r;
      r *= weight;
      weight = Math.min(1, r * 2);
      v += amp * r;
      norm += amp;
      amp *= persistence;
      f *= 2;
    }
    return v / norm;
  };
}

export type Noise3 = (x: number, y: number, z: number) => number;

/** 3D simplex 噪声(球面世界在单位球面上取样:没有接缝,极点不收缩) */
export function noise3(seed: number): Noise3 {
  return createNoise3D(mulberry32(seed));
}

/** 3D 分形叠加(同 fbm,各层再错开一点 z) */
export function fbm3(n: Noise3, octaves: number, persistence = 0.5, lacunarity = 2): Noise3 {
  return (x, y, z) => {
    let v = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += amp * n(x * f + o * 17.3, y * f - o * 9.1, z * f + o * 5.7);
      norm += amp;
      amp *= persistence;
      f *= lacunarity;
    }
    return v / norm;
  };
}

/** 3D 山脊噪声(同 ridged) */
export function ridged3(n: Noise3, octaves: number, persistence = 0.5): Noise3 {
  return (x, y, z) => {
    let v = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(n(x * f + o * 31.7, y * f + o * 7.7, z * f - o * 3.1));
      r *= r;
      r *= weight;
      weight = Math.min(1, r * 2);
      v += amp * r;
      norm += amp;
      amp *= persistence;
      f *= 2;
    }
    return v / norm;
  };
}

/**
 * 平面距离 √(dx² + dy²)。生成代码里一律用它,不用 Math.hypot:
 * 各 JS 引擎的 Math.hypot 末位精度不同(V8 与 JavaScriptCore 实测有差),
 * 会让同一种子在不同浏览器里长出略有差别的世界;sqrt 和加减乘除是 IEEE 754 精确舍入的,各引擎一致。
 */
export const hypot2 = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 分段线性查表:table 为 [x0,y0,x1,y1,...],x 递增。 */
export function piecewise(table: number[], x: number): number {
  if (x <= table[0]) return table[1];
  for (let i = 2; i < table.length; i += 2) {
    if (x <= table[i]) {
      const x0 = table[i - 2];
      const y0 = table[i - 1];
      return y0 + ((table[i + 1] - y0) * (x - x0)) / (table[i] - x0);
    }
  }
  return table[table.length - 1];
}

/**
 * 0..n−1 按 key 从小到大排的顺序,key 相同的按编号从小到大 —— 和 `下标数组.sort((a, b) => key[a] - key[b])`(稳定排序)
 * 结果一样,但快得多:每项编成"key 的排序码 × 2^21 + 编号"(53 位以内,双精度里是精确整数),用 Float64Array 自带的数值排序。
 * key 不能有 NaN;+0 和 −0 算相同(和那个比较函数一样)。超过 2^21 项时照旧用比较函数排
 */
export function orderByKey(key: Float32Array): Int32Array {
  const n = key.length;
  const order = new Int32Array(n);
  if (n > ORDER_SPAN) {
    for (let i = 0; i < n; i++) order[i] = i;
    return order.sort((a, b) => key[a] - key[b]);
  }
  const bits = new Uint32Array(key.buffer, key.byteOffset, n);
  const code = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bits[i] === 0x80000000 ? 0 : bits[i]; // −0 当 +0
    // 32 位浮点的位 → 保序的无符号整数:负数各位取反,正数最高位置 1
    const u = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
    code[i] = u * ORDER_SPAN + i;
  }
  code.sort();
  for (let q = 0; q < n; q++) order[q] = code[q] % ORDER_SPAN;
  return order;
}
const ORDER_SPAN = 2 ** 21;

/** 二叉最小堆(id + 优先级),容量自动增长。Dijkstra / Priority-Flood 用。 */
export class MinHeap {
  ids: Int32Array;
  pri: Float64Array;
  size = 0;
  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.pri = new Float64Array(capacity);
  }
  push(id: number, p: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      ids.set(this.ids);
      const pri = new Float64Array(this.size * 2);
      pri.set(this.pri);
      this.ids = ids;
      this.pri = pri;
    }
    let i = this.size++;
    const ids = this.ids;
    const pr = this.pri;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= p) break;
      ids[i] = ids[parent];
      pr[i] = pr[parent];
      i = parent;
    }
    ids[i] = id;
    pr[i] = p;
  }
  /** 弹出最小项,返回 id;其优先级写入 lastPri。 */
  lastPri = 0;
  pop(): number {
    const ids = this.ids;
    const pr = this.pri;
    const top = ids[0];
    this.lastPri = pr[0];
    const n = --this.size;
    if (n > 0) {
      const id = ids[n];
      const p = pr[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= p) break;
        ids[i] = ids[c];
        pr[i] = pr[c];
        i = c;
      }
      ids[i] = id;
      pr[i] = p;
    }
    return top;
  }
}

/** 可分离盒式模糊(原地,单通道 Float32)。 */
export function boxBlur(src: Float32Array, w: number, h: number, radius: number) {
  const tmp = new Float32Array(w * h);
  const r = radius;
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc * inv;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/**
 * 可无缝平铺的分形噪声贴图(周期梯度噪声多层叠加),size×size,左右 / 上下边缘首尾相接。
 * 铺像素时用"查贴图 + 双线性插值"代替逐像素算多层噪声,快一个数量级。
 * cells:最底层每边多少格(整数才能无缝,波长 = size / cells 像素);之后每层格数 ×2、幅度 ×persistence。
 * 输出已归一化:均值 0、标准差 1。size 必须是 2 的幂(采样时用位运算取模)。
 */
export function tileableFbm(seed: number, size: number, cells: number, octaves: number, persistence = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  const rng = mulberry32(seed);
  // 256 个均匀分布的单位方向,格点梯度从里面随机挑
  const DIRS = 256;
  const ux = new Float32Array(DIRS);
  const uy = new Float32Array(DIRS);
  for (let i = 0; i < DIRS; i++) {
    ux[i] = Math.cos((i / DIRS) * Math.PI * 2);
    uy[i] = Math.sin((i / DIRS) * Math.PI * 2);
  }
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    const c = cells * (1 << o);
    // 每个格点一个随机单位梯度;格点下标对 c 取模 → 周期正好是 size 个像素
    const gx = new Float32Array(c * c);
    const gy = new Float32Array(c * c);
    for (let i = 0; i < c * c; i++) {
      const di = (rng() * DIRS) | 0;
      gx[i] = ux[di];
      gy[i] = uy[di];
    }
    // 每层随机平移,避免各层格点重合(否则会出现规则排列的"平点")
    const ox = rng() * c;
    const oy = rng() * c;
    const f = c / size;
    // 坐标都在 [0, 2c) 内:取模用一次减法即可
    for (let py = 0; py < size; py++) {
      const v = py * f + oy;
      const vi = v | 0;
      const ty = v - vi;
      const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
      const y0 = vi >= c ? vi - c : vi;
      const r0 = y0 * c;
      const r1 = (y0 + 1 === c ? 0 : y0 + 1) * c;
      const row = py * size;
      for (let px = 0; px < size; px++) {
        const u = px * f + ox;
        const ui = u | 0;
        const tx = u - ui;
        const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
        const c0 = ui >= c ? ui - c : ui;
        const c1 = c0 + 1 === c ? 0 : c0 + 1;
        const n00 = gx[r0 + c0] * tx + gy[r0 + c0] * ty;
        const n10 = gx[r0 + c1] * (tx - 1) + gy[r0 + c1] * ty;
        const n01 = gx[r1 + c0] * tx + gy[r1 + c0] * (ty - 1);
        const n11 = gx[r1 + c1] * (tx - 1) + gy[r1 + c1] * (ty - 1);
        const a0 = n00 + (n10 - n00) * sx;
        const a1 = n01 + (n11 - n01) * sx;
        out[row + px] += amp * (a0 + (a1 - a0) * sy);
      }
    }
    amp *= persistence;
  }
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < out.length; i++) {
    s += out[i];
    s2 += out[i] * out[i];
  }
  const mean = s / out.length;
  const inv = 1 / Math.sqrt(Math.max(1e-12, s2 / out.length - mean * mean));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) * inv;
  return out;
}
