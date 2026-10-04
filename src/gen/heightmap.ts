/**
 * 高度图导出(阶段 4):把铺好的像素海拔(Raster.elev)编码成灰度 PNG,给别的工具继续加工。
 * 纯计算(PNG 编码见 png.ts),worker 和 Node 里都能跑。
 *
 * 地图本身就是全球等距圆柱投影(经度沿横向、纬度沿纵向均匀分布,上边北极、下边南极;宽高比 2:1),高度图和主图一样大、一一对应
 * (正中是 0° 经线)。东西两边相接(最右一列和最左一列是邻居),可以直接当球面贴图用。
 * 海、陆按像素的水域标记分(Raster.water),不按海拔正负猜:湖算陆地(取湖面高度)。
 *
 * 两种:
 *   16 位(游戏引擎、World Machine、Gaea 等):整个世界的海拔线性铺满 0–65535 —— 最深的海底 = 0,最高峰 = 65535;
 *     海平面(0 米)落在哪个灰度每个世界不同,写进说明(heightmapNote)和 PNG 的文字块。
 *     陆地一律比海平面亮、海一律比海平面暗(各至少差一级),引擎里按海平面放水面不会淹掉海岸、也不会露出海底。
 *   8 位(Azgaar Fantasy Map Generator 的"图片转换"导入):按 Azgaar 的高度刻度 0–100(灰度 ÷ 2.55),
 *     海平面 = Azgaar 的 20 = 灰度 51:陆地 51(海岸)→ 255(最高峰);海 0(最深)→ 46(近岸浅海),
 *     47–50 空着不用,不论转换时按什么方式取亮度、怎么四舍五入,海岸都不会错位。
 *     陆地按 Azgaar 默认的高度指数 1.8 反推(它把高度 h 换成米是 (h − 18)^1.8),导入后平原、丘陵、山地的比例和这里一致,
 *     不会因为线性映射把低地全挤成一片平地。
 */
import type { Raster } from './raster';
import { encodeGrayPng } from './png';

export type HeightmapBits = 8 | 16;

/** 8 位:海平面灰度(= Azgaar 高度 20 × 2.55) */
export const AZGAAR_SEA_GRAY = 51;
/** 8 位:海里最亮的灰度(近岸浅海);47–50 空着 */
export const AZGAAR_WATER_MAX = 46;
/** Azgaar 默认的高度指数:米 = (h − 18)^指数 */
export const AZGAAR_EXPONENT = 1.8;
const U16 = 65535;

export interface HeightmapInfo {
  width: number;
  height: number;
  bits: HeightmapBits;
  /** 海平面的灰度:≥ 它是陆地(含湖),< 它是海 */
  seaLevel: number;
  /** 最深的海底 / 最高峰(米) */
  minElev: number;
  maxElev: number;
  /** 16 位:灰度 0 和 65535 各对应多少米(海拔 = lo + 灰度 / 65535 × (hi − lo));8 位同 minElev / maxElev */
  lo: number;
  hi: number;
  /** 陆地、海各占多少像素 */
  land: number;
  sea: number;
}

export interface Heightmap {
  data: Uint8Array | Uint16Array;
  info: HeightmapInfo;
}

type ElevRaster = Pick<Raster, 'w' | 'h' | 'elev' | 'water'>;

/** 海拔 → 灰度(不编码 PNG)。同一张 Raster 永远得到同样的结果 */
export function heightmapGray(r: ElevRaster, bits: HeightmapBits): Heightmap {
  const { w, h, elev, water } = r;
  const N = w * h;
  let minSea = 0;
  let maxLand = 0;
  let minAll = Infinity;
  let maxAll = -Infinity;
  let land = 0;
  for (let k = 0; k < N; k++) {
    const e = elev[k];
    if (!Number.isFinite(e)) continue;
    if (water[k] === 1) minSea = Math.min(minSea, e);
    else {
      maxLand = Math.max(maxLand, e);
      land++;
    }
    if (e < minAll) minAll = e;
    if (e > maxAll) maxAll = e;
  }
  if (!Number.isFinite(minAll)) minAll = maxAll = 0;
  const sea = N - land;

  if (bits === 16) {
    // 两头各至少留 1 米:全是海 / 全是陆地的世界也有一个明确的海平面
    const lo = Math.min(minSea, -1);
    const hi = Math.max(maxLand, 1);
    const k16 = U16 / (hi - lo);
    const S = Math.round(-lo * k16);
    const data = new Uint16Array(N);
    for (let k = 0; k < N; k++) {
      const e = Number.isFinite(elev[k]) ? elev[k] : 0;
      const v = Math.round((e - lo) * k16);
      data[k] = water[k] === 1 ? Math.max(0, Math.min(S - 1, v)) : Math.min(U16, Math.max(S + 1, v));
    }
    return { data, info: { width: w, height: h, bits, seaLevel: S, minElev: minAll, maxElev: maxAll, lo, hi, land, sea } };
  }

  const data = new Uint8Array(N);
  const top = Math.max(maxLand, 1);
  const deep = Math.max(-minSea, 1);
  const inv = 1 / AZGAAR_EXPONENT;
  for (let k = 0; k < N; k++) {
    const e = Number.isFinite(elev[k]) ? elev[k] : 0;
    if (water[k] === 1) {
      const t = Math.min(1, Math.max(0, -e / deep));
      data[k] = Math.round(AZGAAR_WATER_MAX * (1 - t));
    } else {
      const t = Math.min(1, Math.max(0, e / top)) ** inv;
      data[k] = AZGAAR_SEA_GRAY + Math.round((255 - AZGAAR_SEA_GRAY) * t);
    }
  }
  return { data, info: { width: w, height: h, bits, seaLevel: AZGAAR_SEA_GRAY, minElev: minAll, maxElev: maxAll, lo: minSea, hi: top, land, sea } };
}

/** 编码成 PNG(字节)。PNG 里另写几行英文说明(tEXt 块),换了文件名也能查到海平面 */
export async function heightmapPng(r: ElevRaster, bits: HeightmapBits, seed?: number): Promise<{ png: Uint8Array; info: HeightmapInfo }> {
  const { data, info } = heightmapGray(r, bits);
  const text: Record<string, string> = {
    Software: 'Wenming Ditu (civilization map generator)',
    Description:
      bits === 16
        ? `16-bit grayscale heightmap, equirectangular (latitude linear top to bottom), 2:1. Gray 0 = ${Math.round(info.lo)} m, ` +
          `65535 = ${Math.round(info.hi)} m, linear. Sea level (0 m) = gray ${info.seaLevel}; land is brighter, sea is darker.`
        : `8-bit grayscale heightmap for Azgaar's Fantasy Map Generator (gray / 2.55 = Azgaar height 0-100). ` +
          `Sea level = gray ${info.seaLevel} (Azgaar height 20); land ${AZGAAR_SEA_GRAY}-255 (exponent ${AZGAAR_EXPONENT}), sea 0-${AZGAAR_WATER_MAX}.`,
  };
  if (seed !== undefined) text.Source = `seed ${seed}`;
  const png = await encodeGrayPng({ width: info.width, height: info.height, bitDepth: bits, data }, text);
  return { png, info };
}

const m = (v: number) => `${Math.round(v).toLocaleString('en-US')} 米`;

/** 同名 .txt 说明(中文):尺寸、投影、海平面在哪个灰度、怎么换算回米、怎么导入 */
export function heightmapNote(info: HeightmapInfo, opts: { seed: number; file: string; params?: string }): string {
  const lines = [
    '文明与地图 · 高度图说明',
    '',
    `文件:${opts.file}`,
    `世界:种子 ${opts.seed}${opts.params ? `(${opts.params})` : ''}`,
    `尺寸:${info.width} × ${info.height} 像素,和地图同宽高比 2:1,上北下南`,
    '投影:全球等距圆柱投影(±90°、东西无缝)—— 经度沿横向、纬度沿纵向均匀分布;上边是北极(北纬 90°),下边是南极(南纬 90°);',
    '  正中是 0° 经线,左右两边是同一条 180° 经线:图的最右一列和最左一列相接,左右拼起来没有接缝(可以直接当球面贴图用)',
    `这个世界:最深的海底 ${m(info.minElev)},最高峰 ${m(info.maxElev)}`,
    '',
  ];
  if (info.bits === 16) {
    const step = (info.hi - info.lo) / U16;
    lines.push(
      '格式:16 位灰度 PNG(游戏引擎、World Machine、Gaea 等常用)',
      `灰度 0 = ${m(info.lo)},灰度 65535 = ${m(info.hi)},中间按海拔线性分布,每一级约 ${step.toFixed(2)} 米`,
      `海平面(0 米)= 灰度 ${info.seaLevel}(约 ${((info.seaLevel / U16) * 100).toFixed(1)}%):比它亮的是陆地(湖按湖面高度),比它暗的是海`,
      `换算回海拔:海拔(米)= ${Math.round(info.lo)} + 灰度 ÷ 65535 × ${Math.round(info.hi - info.lo)}`,
      '',
      '导入游戏引擎(以 Unity / Unreal 为例):',
      `  地形总高度设为 ${Math.round(info.hi - info.lo)} 米,再把整块地形往下移 ${Math.round(-info.lo)} 米,海平面就在 0 米;`,
      `  或者不移地形,把水面放在 ${Math.round(-info.lo)} 米高处。地形的长宽按 2:1 设,不会被拉伸。`,
    );
  } else {
    lines.push(
      '格式:8 位灰度 PNG,按 Azgaar Fantasy Map Generator 的高度刻度(灰度 ÷ 2.55 = Azgaar 高度 0–100)',
      `海平面 = 灰度 ${AZGAAR_SEA_GRAY}(Azgaar 的高度 20):${AZGAAR_SEA_GRAY} 及以上是陆地,${AZGAAR_WATER_MAX} 及以下是海(越深越黑),中间几级空着`,
      `陆地:灰度 ${AZGAAR_SEA_GRAY}(海岸)→ 255(最高峰),按 Azgaar 默认的高度指数 ${AZGAAR_EXPONENT} 换算,平原、丘陵、山地的比例和这里一致`,
      `海:灰度 ${AZGAAR_WATER_MAX}(近岸)→ 0(最深的海底),按水深线性分布`,
      '',
      '导入 Azgaar:先把它的地图尺寸设成 2:1(如 2048 × 1024),免得被拉伸;',
      '  再在高度图编辑器里用"图片转换"(Image Converter)载入这张图,按亮度自动分配高度。',
    );
  }
  lines.push('', '同一个种子 + 参数永远得到同一张高度图。');
  return lines.join('\n') + '\n';
}
