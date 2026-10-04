/**
 * 文明用的随机数,和跨 CPU 一致的数学函数。
 *
 * - 需要"顺序取"的地方:mulberry32(subSeed(seed, 'civ-…'))。
 * - 推演里的随机决定:keyed(base, a, b, c) —— 按"谁、哪一年、做什么"直接算出一个数,
 *   和处理顺序无关。阶段 4 在某年改动一处,之前的历史完全不变,之后只有受波及的地方会变。
 *   base 一律来自 subSeed(seed, 'civ-…')。
 * - **"谁"一律用位置锚(地块),不用编号**(阶段 4 改地形):州按宜居度排名编号、国家 / 城 / 民族按出现先后编号,
 *   改地形后多一个、少一个州(或国家),后面的编号全都错开;地块网格只由种子决定,改地形也不变。所以:
 *     州 = 治所地块;民族 = 发源州的治所地块;城 = anchorTag(所在地块, 这州第几座城);
 *     国家 = anchorTag(立国时国都的地块, 这州第几个立的国)(和 gen/edits.ts 的稳定键同一个意思)。
 *   两个实体一起定的随机数(某国在某州、两国之间的战争……)用 keyed4。
 * - **超越函数(pow / exp / log)舍入到 24 位有效数字**(fpow / fexp / flog,见 round24):Math.pow 在不同 CPU(Apple 芯片 / x64)、
 *   Math.exp / log 在不同版本的 V8 上最后一位可能不同;推演里算出来、之后要比较或存下来的量都过一遍这几个函数,
 *   同一个种子在任何电脑、浏览器上都得到逐位一致的世界。加减乘除、开方是 IEEE 精确舍入的,本来就一致。
 */
import { keyed, keyed4, mulberry32, subSeed } from '../util';

export { keyed, keyed4, mulberry32, subSeed };

/** 同一个地块上最多分几个"第几个"(再多的共用最后一个;一州先后立国、建城都远到不了这么多) */
const TAG_SPAN = 1024;

/** 位置锚 → keyed 用的整数:地块 × 1024 + 同一地块上的第几个(0 起)。地块最多 20 万,不超过 2^31 */
export function anchorTag(cell: number, n = 0): number {
  return cell * TAG_SPAN + Math.min(n, TAG_SPAN - 1);
}

/** Veltkamp 拆分用的乘数 2^29 + 1:c − (c − x) 就是 x 舍入到 53 − 29 = 24 位有效二进制位 */
const SPLITTER = 536870913;

/**
 * 把 x 舍入到 24 位有效二进制位(和 Float32 一样的精度,约 7 位十进制有效数字;但不会像 Math.fround 那样上溢成
 * Infinity、下溢成 0)。只用乘、减(IEEE 精确舍入),任何 CPU 上结果都一样;两台电脑上差最后一两位的 x 舍入后几乎总是同一个数。
 * 非有限数、极大的数(|x| ≥ 1e290)原样返回
 */
export function round24(x: number): number {
  if (!(Math.abs(x) < 1e290)) return x;
  const c = x * SPLITTER;
  return c - (c - x);
}

/** Math.pow 舍入到 24 位(跨 CPU 一致,见文件头) */
export function fpow(x: number, y: number): number {
  return round24(Math.pow(x, y));
}

/** Math.exp 舍入到 24 位(跨 CPU / V8 版本一致,见文件头) */
export function fexp(x: number): number {
  return round24(Math.exp(x));
}

/** Math.log 舍入到 24 位(跨 CPU / V8 版本一致,见文件头) */
export function flog(x: number): number {
  return round24(Math.log(x));
}

/** Math.log2 舍入到 24 位(跨 CPU / V8 版本一致,见文件头) */
export function flog2(x: number): number {
  return round24(Math.log2(x));
}
