/**
 * 主图的一块补丁:地形大事(civ/upheaval.ts)以后地形变了,主图(gen/raster.ts 的 Raster,2048 × 1024 起)只有附近一块不一样。
 * 每件大事各存一整张主图太占内存,只存"和上一段比变了的那一块":后台线程铺好两张整图,比出框(diffRaster),只交回框里的一块;
 * 主线程按时间轴所在的那一段,把原来的主图复制一份、按先后贴上各件大事的补丁(composeRaster)。纯计算,不碰 DOM。
 *
 * 框按"看得出来的差别"划(TOL:海拔 1 米、气温 0.05 度、降水 0.005 毫米、沟 0.5 米、冰 0.01;水陆、群落、冰的样子一变就算),
 * 框里的像素整块照抄(一位不差);框外的差别小到看不出来,沿用上一段。
 * 主图东西相连:框的列可以跨过右边接回左边(x0 + w 超过主图宽的部分取模)。
 */
import type { Raster } from './raster';

/** 补丁里有的字段(cell 只由网格定,各段一样,不存) */
const F32 = ['elev', 'temp', 'precip', 'ice', 'gully'] as const;
const U8 = ['water', 'biome', 'iceConc', 'iceTone'] as const;
type F32Key = (typeof F32)[number];
type U8Key = (typeof U8)[number];

/** 看得出来的差别(超过它才算变了);U8 的字段一变就算 */
const TOL: Record<F32Key, number> = { elev: 1, temp: 0.05, precip: 0.005, ice: 0.01, gully: 0.5 };

export interface RasterPatch {
  /** 主图的大小(贴的时候核对) */
  W: number;
  H: number;
  /** 框:左上角列 x0(0 ≤ x0 < W)、行 y0,宽 w、高 h(列跨过右边的取模) */
  x0: number;
  y0: number;
  w: number;
  h: number;
  f32: Partial<Record<F32Key, Float32Array>>;
  u8: Partial<Record<U8Key, Uint8Array>>;
}

/** b 比 a 变了的那一块(两张主图一样大);一个像素也没变 = null */
export function diffRaster(a: Raster, b: Raster): RasterPatch | null {
  const W = b.w;
  const H = b.h;
  if (a.w !== W || a.h !== H) throw new Error('主图大小不一样');
  const col = new Uint8Array(W);
  let y0 = H;
  let y1 = -1;
  const mark = (i: number) => {
    const y = (i / W) | 0;
    col[i - y * W] = 1;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const k of F32) {
    const p = a[k];
    const q = b[k];
    if (!p || !q) continue;
    const t = TOL[k];
    for (let i = 0; i < p.length; i++) if (Math.abs(p[i] - q[i]) > t) mark(i);
  }
  for (const k of U8) {
    const p = a[k];
    const q = b[k];
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) mark(i);
  }
  if (y1 < 0) return null;
  // 列:找最长的一段没变的(东西相连,绕一圈),框 = 剩下的那一段
  let best = 0;
  let bestEnd = 0;
  let run = 0;
  for (let k = 0; k < 2 * W; k++) {
    if (col[k % W]) run = 0;
    else if (++run > best && run <= W) {
      best = run;
      bestEnd = k;
    }
  }
  const w = W - best;
  const x0 = best ? (bestEnd + 1) % W : 0;
  const h = y1 - y0 + 1;
  const f32: RasterPatch['f32'] = {};
  const u8: RasterPatch['u8'] = {};
  for (const k of F32) {
    const q = b[k];
    if (q) f32[k] = cut(q, W, x0, y0, w, h, new Float32Array(w * h));
  }
  for (const k of U8) u8[k] = cut(b[k], W, x0, y0, w, h, new Uint8Array(w * h));
  return { W, H, x0, y0, w, h, f32, u8 };
}

function cut<T extends Float32Array | Uint8Array>(src: T, W: number, x0: number, y0: number, w: number, h: number, out: T): T {
  for (let y = 0; y < h; y++) {
    const row = (y0 + y) * W;
    const first = Math.min(w, W - x0);
    out.set(src.subarray(row + x0, row + x0 + first), y * w);
    if (first < w) out.set(src.subarray(row, row + w - first), y * w + first);
  }
  return out;
}

function paste<T extends Float32Array | Uint8Array>(dst: T, W: number, p: RasterPatch, src: T): void {
  const first = Math.min(p.w, W - p.x0);
  for (let y = 0; y < p.h; y++) {
    const row = (p.y0 + y) * W;
    dst.set(src.subarray(y * p.w, y * p.w + first), row + p.x0);
    if (first < p.w) dst.set(src.subarray(y * p.w + first, (y + 1) * p.w), row);
  }
}

/** 把补丁贴到 r 上(就地改) */
export function applyPatch(r: Raster, p: RasterPatch): void {
  if (r.w !== p.W || r.h !== p.H) throw new Error('补丁和主图大小不一样');
  for (const k of F32) {
    const s = p.f32[k];
    if (!s) continue;
    if (!r[k]) r[k] = new Float32Array(r.w * r.h);
    paste(r[k]!, r.w, p, s);
  }
  for (const k of U8) {
    const s = p.u8[k];
    if (s) paste(r[k], r.w, p, s);
  }
}

/** 原来的主图复制一份,按先后贴上补丁(原图不动;cell 共用) */
export function composeRaster(base: Raster, patches: readonly RasterPatch[]): Raster {
  if (!patches.length) return base;
  const out: Raster = {
    ...base,
    elev: base.elev.slice(),
    temp: base.temp.slice(),
    precip: base.precip.slice(),
    water: base.water.slice(),
    biome: base.biome.slice(),
    ice: base.ice.slice(),
    iceConc: base.iceConc.slice(),
    iceTone: base.iceTone.slice(),
    gully: base.gully?.slice(),
  };
  for (const p of patches) applyPatch(out, p);
  return out;
}

/** 补丁里的数组(交给主线程时转移,不复制) */
export function patchTransferables(p: RasterPatch): ArrayBuffer[] {
  return [...Object.values(p.f32), ...Object.values(p.u8)].map((a) => a!.buffer as ArrayBuffer);
}

/** 补丁占多少字节 */
export function patchBytes(p: RasterPatch): number {
  return [...Object.values(p.f32), ...Object.values(p.u8)].reduce((s, a) => s + a!.byteLength, 0);
}
