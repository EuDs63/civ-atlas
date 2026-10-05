/**
 * 文明细节层:地图放大以后,把文明层看得见的那一块按屏幕像素重画(什么时候画、画哪一块由 ui/CivDetail.tsx 决定)。
 *
 * 整张图的文明层(overlay.ts)和世界一样大(默认 2048 × 1024),放大十几倍后一个像素在屏幕上有八九个像素宽:
 * 色块的边一格一格的,线又粗又虚。细节层只画视口附近一块,画布像素 = 屏幕像素:
 *
 *   - 色块(国土 / 民族):逐个工作格(1 个 CSS 像素一格,回放时更粗)按 territory.ts 的 washDetail 上色 ——
 *     边按平滑后的界线判、海岸按岸线抗锯齿;浓淡、纸纹是平滑的晕染;水痕按屏幕大小;
 *     手绘风给符号"让位"的遮罩按这一块、这个缩放倍数画的符号层算(和地形细节层画出来的符号是同一套)
 *   - 州界、国界、道路、城址:矢量线(和整张图同一套画法),线宽、虚线 × pen —— 比地图放大得慢,放大后不会粗成一条带子
 *   - 选中 / 高亮:罩染同样逐格上色(边按描边那条线),描边按屏幕粗细
 *
 * 弯边投影(罗宾森、摩尔威德……):工作格按行反投影到世界坐标(同一行是一条纬线),逐格上色;线逐点投影。
 * 等距圆柱:画布可以伸进右边接的那一份(世界 x 到 2W),上色时 x 取模,线分左右两段各画一遍(各自裁在自己那一段里)。
 */
import type { World } from '../../gen/world';
import type { Raster } from '../../gen/raster';
import type { Civ, Year } from '../../gen/civ/types';
import { drawFantasyVectors, glyphScale, GLYPH_K0 } from '../fantasy';
import { clipOutline, projector, reprojectImage, relShifts } from '../projection';
import { nearX } from '../common';
import { drawBorders, mergeChains, regionChains, BAND, type SidedLine } from './borders';
import { drawRoutes } from './routes';
import { drawRegionLines, drawSites, habitatCanvas } from './debug';
import { addToPath, chaikin, meshWrap } from './lines';
import { DETAIL_EDGE_D, inkFromSymbols, regionPixels, washDetail, washFields } from './territory';
import {
  highlightBox,
  highlightFill,
  highlightMarks,
  highlightStrokes,
  RING_BELOW,
  selectionGroup,
  selectionLines,
  selectionLook,
  type CivHighlight,
  type RGBA,
  type SelectionTarget,
} from './highlight';
import { coastBlocks, detailGrid, KEEP, landCover, nearestCellPixel, nearestSide, segCell, segIndex, type DetailGrid, type PlaneToCanvas, type SegIndex } from './zoomGrid';
import type { InkMask } from '../fantasy';
import type { CivDrawParams, CivStyle } from './overlay';

/** 细节层的画布:大小(画布像素)、地图平面 → 画布、缩放倍数、画布像素 / CSS 像素 */
export interface CivDetailView extends PlaneToCanvas {
  cw: number;
  ch: number;
  k: number;
  dpr: number;
}

/**
 * 符号让位遮罩最细按几个 CSS 像素一格算(要把这一块的符号层画一遍再读回来,读回来很慢;
 * 遮罩只是让水彩在符号上淡一点,2 个 CSS 像素一格看不出差别),上色的格更细时双线性放大过去
 */
const INK_CSS = 2;

/**
 * 缩放 k 倍时线宽、虚线长短在世界坐标里的倍数:手绘风和地形细节层的墨线、符号一起按 glyphScale 收(屏幕上约按 k^0.78 变粗);
 * 写实风收得更快一点(约按 k^0.55 变粗),放大后国界、道路仍是细线。缩放 1.35 倍以下为 1(和整张图一样)
 */
export function detailPen(k: number, style: CivStyle): number {
  if (style === 'fantasy') return glyphScale(k);
  return k <= GLYPH_K0 ? 1 : Math.pow(k / GLYPH_K0, -0.45);
}

/** 选中、高亮的描边:缩放 k 倍时按 1/√k 收(和整张图的选中层一样,放大后不粗) */
const thinOf = (k: number) => 1 / Math.sqrt(Math.max(1, k));

/** 一块视口的缓存(网格、符号遮罩、上色用的草稿画布);视口换了就换一份 */
export interface DetailCache {
  grids: Map<number, DetailGrid>;
  inks: Map<number, InkMask | null>;
  scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; img: ImageData } | null;
}

export function detailCache(): DetailCache {
  return { grids: new Map(), inks: new Map(), scratch: null };
}

function gridOf(cache: DetailCache, v: CivDetailView, step: number, world: World): DetailGrid {
  let g = cache.grids.get(step);
  if (!g) cache.grids.set(step, (g = detailGrid(v, v.cw, v.ch, step, world.width, world.height)));
  return g;
}

const makeCanvas = (w: number, h: number) =>
  typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });

/** 上色用的草稿(gw × gh 的 ImageData + 一张同样大的离屏画布) */
function scratchOf(cache: DetailCache, gw: number, gh: number) {
  const s = cache.scratch;
  if (s && s.img.width === gw && s.img.height === gh) return s;
  if (s) s.canvas.width = s.canvas.height = 0;
  cache.scratch = { canvas: makeCanvas(gw, gh), img: new ImageData(gw, gh) };
  return cache.scratch;
}

/** 草稿里算好的工作格贴到画布上(按 step 放大,双线性 —— 边是一两个像素的抗锯齿,不是方块) */
function blit(ctx: CanvasRenderingContext2D, cache: DetailCache, g: DetailGrid) {
  const s = cache.scratch!;
  (s.canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(s.img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(s.canvas, 0, 0, g.gw * g.step, g.gh * g.step);
  ctx.restore();
}

/**
 * 按"地图平面 × S"(整张图的画法用的坐标)画线:等距圆柱分左右两段(右边接的那一份挪一整圈),各自裁在自己那一段里;
 * 弯边投影一段、按外轮廓裁。draw(cull) 里调整张图的画法;cull = 这一段盖住的世界范围
 */
function eachPart(ctx: CanvasRenderingContext2D, v: CivDetailView, world: World, S: number, draw: (cull: [number, number, number, number]) => void) {
  const W = world.width;
  const a = v.s / S;
  const y0 = -v.oy / v.s;
  const y1 = (v.ch - v.oy) / v.s;
  const parts: [number, number, number][] = [];
  if (v.mp) parts.push([0, v.cw, 0]);
  else {
    const seam = W * v.s + v.ox;
    if (seam >= v.cw) parts.push([0, v.cw, 0]);
    else if (seam <= 0) parts.push([0, v.cw, W]);
    else parts.push([0, seam, 0], [seam, v.cw, W]);
  }
  for (const [c0, c1, sh] of parts) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (parts.length > 1) {
      ctx.beginPath();
      ctx.rect(c0, 0, c1 - c0, v.ch);
      ctx.clip();
    }
    ctx.setTransform(a, 0, 0, a, v.ox + sh * v.s, v.oy);
    if (v.mp) clipOutline(ctx, v.mp, { s: S, ox: 0, oy: 0 });
    const cull: [number, number, number, number] = v.mp
      ? [-Infinity, -Infinity, Infinity, Infinity]
      : [(c0 - v.ox) / v.s - sh, y0, (c1 - v.ox) / v.s - sh, y1];
    draw(cull);
    ctx.restore();
  }
}

/**
 * 手绘风:这一块按细节层同样的缩放倍数画一遍符号层(按 INK_CSS 一格),读回来算"让位"遮罩;
 * 上色的格(step)更细就双线性放大到它。视口不变就不用重算(回放时每一年都用同一份)
 */
function inkOf(cache: DetailCache, v: CivDetailView, step: number, world: World): InkMask | null {
  if (cache.inks.has(step)) return cache.inks.get(step)!;
  const ms = Math.max(1, Math.round(INK_CSS * v.dpr));
  if (step < ms) {
    const src = inkOf(cache, v, ms, world)!;
    const gs = gridOf(cache, v, ms, world);
    const g = gridOf(cache, v, step, world);
    const ink = { hard: upsample(src.hard, gs.gw, gs.gh, g.gw, g.gh, step / ms), soft: upsample(src.soft, gs.gw, gs.gh, g.gw, g.gh, step / ms) };
    cache.inks.set(step, ink);
    return ink;
  }
  const g = gridOf(cache, v, step, world);
  const cv = makeCanvas(g.gw, g.gh);
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const vs = { s: v.s / step, ox: v.ox / step, oy: v.oy / step, k: v.k };
  if (v.mp) {
    ctx.save();
    clipOutline(ctx, v.mp, vs);
    drawFantasyVectors(ctx, world, { ...vs, proj: projector(v.mp) });
    ctx.restore();
  } else {
    // 跨过主图右边(180° 经线)的那一块:左右两段各画一遍,各自裁在自己那一段里(同地形细节层)
    const W = world.width;
    const seam = W * vs.s + vs.ox;
    const parts: [number, number, number][] = seam >= g.gw ? [[0, g.gw, 0]] : seam <= 0 ? [[0, g.gw, W * vs.s]] : [
      [0, seam, 0],
      [seam, g.gw, W * vs.s],
    ];
    for (const [c0, c1, sh] of parts) {
      ctx.save();
      if (parts.length > 1) {
        ctx.beginPath();
        ctx.rect(c0, 0, c1 - c0, g.gh);
        ctx.clip();
      }
      drawFantasyVectors(ctx, world, { ...vs, ox: vs.ox + sh });
      ctx.restore();
    }
  }
  const ink = inkFromSymbols(ctx.getImageData(0, 0, g.gw, g.gh).data, g.gw * g.gh);
  cv.width = cv.height = 0;
  cache.inks.set(step, ink);
  return ink;
}

/** 遮罩双线性放大:目标格 (i, j) 的中心在源网格的 ((i + 0.5)·r − 0.5, …) */
function upsample(src: Uint8Array, sw: number, sh: number, dw: number, dh: number, r: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const x0 = new Int32Array(dw);
  const x1 = new Int32Array(dw);
  const tx = new Float32Array(dw);
  for (let i = 0; i < dw; i++) {
    const u = Math.min(sw - 1, Math.max(0, (i + 0.5) * r - 0.5));
    x0[i] = Math.floor(u);
    x1[i] = Math.min(sw - 1, x0[i] + 1);
    tx[i] = u - x0[i];
  }
  for (let j = 0; j < dh; j++) {
    const v = Math.min(sh - 1, Math.max(0, (j + 0.5) * r - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = v - y0;
    const r0 = y0 * sw;
    const r1 = y1 * sw;
    const o = j * dw;
    for (let i = 0; i < dw; i++) {
      const a = src[r0 + x0[i]] + (src[r0 + x1[i]] - src[r0 + x0[i]]) * tx[i];
      const b = src[r1 + x0[i]] + (src[r1 + x1[i]] - src[r1 + x0[i]]) * tx[i];
      out[o + i] = a + (b - a) * ty + 0.5;
    }
  }
  return out;
}

export interface DetailTiming {
  /** 色块(逐格上色 + 贴上)、线、符号遮罩各多少毫秒 */
  wash: number;
  lines: number;
  ink: number;
}

/**
 * 画文明底图的细节层(画布 v.cw × v.ch;先清空)。p 和整张图同一份参数;step = 工作格是几个画布像素。
 * 返回各步耗时
 */
export function drawCivDetail(ctx: CanvasRenderingContext2D, p: CivDrawParams, v: CivDetailView, step: number, cache: DetailCache): DetailTiming {
  const { world, raster } = p;
  const S = raster.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.cw, v.ch);
  const pen = detailPen(v.k, p.style);
  const t: DetailTiming = { wash: 0, lines: 0, ink: 0 };
  // 1. 宜居度热力图(本来就是平滑的场,直接放大贴上)
  if (p.show.habitat) {
    const heat = habitatCanvas(p);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if (v.mp) reprojectImage(ctx, heat, raster.w, raster.h, v.mp, v, 'low');
    else eachPart(ctx, v, world, S, () => ctx.drawImage(heat, 0, 0, raster.w, raster.h));
    ctx.restore();
  }
  // 2. 色块
  const fl = washFields(p, p.fast ? 2 : 1);
  if (fl) {
    const t0 = performance.now();
    const ink = p.style === 'fantasy' ? inkOf(cache, v, step, world) : null;
    const t1 = performance.now();
    const g = gridOf(cache, v, step, world);
    // 离界线多远以内要按线判(最近一格的归属可能判错的范围 + 水痕 / 描边的宽度)
    const band = Math.max((0.75 * fl.f + 0.3) / S, ((DETAIL_EDGE_D + 0.2) * pen) / S);
    const segs = segIndex(fl.lines, band, g.box, meshWrap(world.mesh));
    const sc = scratchOf(cache, g.gw, g.gh);
    washDetail(sc.img.data, g, raster, world.mesh, fl, p.style, segs, ink, pen);
    blit(ctx, cache, g);
    t.ink = t1 - t0;
    t.wash = performance.now() - t1;
  }
  // 3. 州界、国界、道路、城址(矢量线,线宽 × pen)
  const t2 = performance.now();
  const pj = v.mp ? projector(v.mp) : null;
  eachPart(ctx, v, world, S, (cull) => {
    const q: CivDrawParams = { ...p, proj: pj, pen, cull };
    if (q.show.regions) drawRegionLines(ctx, q);
    drawBorders(ctx, q);
    drawRoutes(ctx, q);
    if (q.show.sites) drawSites(ctx, q);
  });
  t.lines = performance.now() - t2;
  return t;
}

// ---------------------------------------------------------------------------
// 选中 / 高亮

/** 界线平滑两遍(和整张图的描边同一条线),保留左右两侧 */
const smoothSided = (lines: SidedLine[]): SidedLine[] => lines.map((l) => ({ ...l, ...chaikin(l, 2) }));

/**
 * 一组州的罩染(逐格):value[州] > 0 的上 rgba[value] 色;边按 lines(左右两侧是 value)判,海岸抗锯齿。
 * 只算这几个州的外框附近那几行、几列
 */
function fillDetail(
  out: Uint8ClampedArray,
  g: DetailGrid,
  r: Raster,
  world: World,
  civ: Civ,
  pix: Int16Array,
  value: ArrayLike<number>,
  rgba: (RGBA | null)[],
  segs: SegIndex | null,
  paint: boolean,
): void {
  out.fill(0);
  const box = litBox(world, civ, value);
  if (!box) return;
  const { w, h, scale: S } = r;
  const W = world.width;
  const blocks = coastBlocks(r);
  const side = new Int32Array(1);
  const ks = new Int32Array(4);
  const m = BAND + 1;
  const { gw, gh } = g;
  for (let j = 0; j < gh; j++) {
    const i0 = g.i0[j];
    const i1 = g.i1[j];
    if (i1 <= i0) continue;
    const wy = g.wy[j];
    if (wy < box[1] - m || wy > box[3] + m) continue;
    const a0 = g.a[j];
    const b0 = g.b[j];
    const ry = wy * S;
    const ny = Math.min(h - 1, Math.max(0, Math.floor(ry)));
    const vy = Math.min(h - 1, Math.max(0, ry - 0.5));
    const y0 = Math.min(h - 1, Math.floor(vy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = vy - y0;
    const rpp = g.u[j] * S;
    const lat = Math.PI / 2 - (wy / world.height) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    // 这几个州(挪整圈)落在这一行的哪几段列里
    const xa = a0 + b0 * i0;
    const xb = a0 + b0 * (i1 - 1);
    for (let k = Math.ceil((xa - box[2] - m) / W); k <= Math.floor((xb - box[0] + m) / W); k++) {
      const lo = Math.max(i0, Math.ceil((box[0] - m + k * W - a0) / b0));
      const hi = Math.min(i1 - 1, Math.floor((box[2] + m + k * W - a0) / b0));
      for (let i = lo; i <= hi; i++) {
        const o = (j * gw + i) * 4;
        const wx = a0 + b0 * i;
        let rx = wx * S;
        rx -= w * Math.floor(rx / w);
        const vx = rx - 0.5;
        let x0 = Math.floor(vx);
        const fx = vx - x0;
        if (x0 < 0) x0 += w;
        let x1 = x0 + 1;
        if (x1 >= w) x1 -= w;
        const blk = blocks[y0 * w + x0];
        if (blk === 2) continue;
        let cov = 1;
        if (blk === 1) {
          cov = landCover(r, y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1, fx, fy, rpp, paint);
          if (cov <= 0) continue;
        }
        let reg = pix[ny * w + Math.min(w - 1, Math.floor(rx))];
        if (reg < 0) {
          // 岸边:取这一块里离这一点最近的一格陆地
          const wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
          const qs = [y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1];
          let best = -1;
          for (let q = 0; q < 4; q++) {
            if (pix[qs[q]] >= 0 && wts[q] > best) {
              best = wts[q];
              reg = pix[qs[q]];
            }
          }
          if (reg < 0) continue;
        }
        let c = value[reg];
        let byLine = false;
        if (segs) {
          const cell = segCell(segs, wx, wy);
          if (cell >= 0 && segs.start[cell] !== segs.start[cell + 1]) {
            const d = nearestSide(segs, cell, wx, wy, side);
            if (d < Infinity && side[0] !== KEEP) {
              c = side[0];
              byLine = true;
            }
          }
        }
        if (!byLine) {
          // 界线管不到、这一块里归属又不一样:按离哪个地块中心最近判
          ks[0] = y0 * w + x0;
          ks[1] = y0 * w + x1;
          ks[2] = y1 * w + x0;
          ks[3] = y1 * w + x1;
          const va = pix[ks[0]] >= 0 ? value[pix[ks[0]]] : c;
          if (va !== (pix[ks[1]] >= 0 ? value[pix[ks[1]]] : c) || va !== (pix[ks[2]] >= 0 ? value[pix[ks[2]]] : c) || va !== (pix[ks[3]] >= 0 ? value[pix[ks[3]]] : c)) {
            const lon = (wx / W) * 2 * Math.PI - Math.PI;
            const q = pix[ks[nearestCellPixel(world.mesh, r.cell, ks, cl, sl, lon)]];
            if (q >= 0) c = value[q];
          }
        }
        const col = c > 0 ? rgba[c] : null;
        if (!col) continue;
        out[o] = col[0];
        out[o + 1] = col[1];
        out[o + 2] = col[2];
        out[o + 3] = col[3] * cov;
      }
    }
  }
}

/** value[州] > 0 的那些州的外框(世界坐标,x 按第一个地块展开);没有 = null */
function litBox(world: World, civ: Civ, value: ArrayLike<number>): [number, number, number, number] | null {
  const { cellStart, cells } = civ.regions;
  const { x, y } = world.mesh;
  const W = world.width;
  let ref = NaN;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let r = 0; r < value.length; r++) {
    if (!(value[r] > 0)) continue;
    for (let k = cellStart[r]; k < cellStart[r + 1]; k++) {
      const c = cells[k];
      if (ref !== ref) ref = x[c];
      const cx = nearX(x[c], ref, W);
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (y[c] < y0) y0 = y[c];
      if (y[c] > y1) y1 = y[c];
    }
  }
  // 绕着极点一圈(展开后比半圈还宽):整圈都算
  if (x1 - x0 > W / 2) return [0, y0, W, y1];
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/**
 * 选中层的细节层:选中的国家 / 州淡淡罩染(边按描边那条线)+ 一道细描边;大河、山脉一道淡光。返回亮了几个州
 */
export function drawSelectionDetail(
  ctx: CanvasRenderingContext2D,
  world: World,
  raster: Raster,
  civ: Civ,
  sel: SelectionTarget | null,
  year: Year,
  style: CivStyle,
  v: CivDetailView,
  step: number,
  cache: DetailCache,
): number {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.cw, v.ch);
  if (!sel) return 0;
  const S = raster.scale;
  const look = selectionLook(style);
  const thin = thinOf(v.k);
  const a = v.s / S;
  const pj = v.mp ? projector(v.mp) : null;
  const wrap = meshWrap(world.mesh);
  if (sel.kind === 'place') {
    const sl = selectionLines(world, civ, sel, year);
    if (!sl || sl.kind !== 'band') return 0;
    eachPart(ctx, v, world, S, () => {
      const pa = new Path2D();
      addToPath(pa, sl.lines, S, wrap, pj);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = look.band;
      ctx.shadowBlur = 8 * S * thin * a;
      ctx.strokeStyle = look.band;
      ctx.lineWidth = sl.width * S * thin;
      ctx.stroke(pa);
    });
    return 0;
  }
  const grp = selectionGroup(civ, sel, year);
  if (!grp) return 0;
  const lines = smoothSided(mergeChains(regionChains(world.mesh, civ), grp.group));
  // 罩染
  const g = gridOf(cache, v, step, world);
  const segs = segIndex(lines, BAND + 0.75 / S, g.box, wrap);
  const sc = scratchOf(cache, g.gw, g.gh);
  fillDetail(sc.img.data, g, raster, world, civ, regionPixels(world, raster, civ), grp.group, [null, look.fill], segs, style === 'fantasy');
  blit(ctx, cache, g);
  // 描边(沿州界,只描陆地之间;海岸那一侧靠罩染看出来)
  eachPart(ctx, v, world, S, () => {
    const pa = new Path2D();
    addToPath(pa, lines, S, wrap, pj);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = look.line[0];
    ctx.lineWidth = 4.2 * S * thin;
    ctx.stroke(pa);
    ctx.strokeStyle = look.line[1];
    ctx.lineWidth = 1.8 * S * thin;
    ctx.stroke(pa);
  });
  return grp.lit;
}

/**
 * 高亮层的细节层(编年史点一条):事发州、相关国家的罩染(逐格,边按界线)+ 描边、光晕按屏幕粗细;
 * 事发地在屏幕上很小时外面套一个圆圈。返回每州的标记(同 drawHighlight)
 */
export function drawHighlightDetail(
  ctx: CanvasRenderingContext2D,
  world: World,
  raster: Raster,
  civ: Civ,
  hl: CivHighlight,
  style: CivStyle,
  v: CivDetailView,
  step: number,
  cache: DetailCache,
): Uint8Array {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.cw, v.ch);
  const marks = highlightMarks(civ, hl);
  if (!marks.some((m) => m)) return marks;
  const S = raster.scale;
  const thin = thinOf(v.k);
  const a = v.s / S;
  const pj = v.mp ? projector(v.mp) : null;
  const wrap = meshWrap(world.mesh);
  // 罩染:按标记(1 相关国家、2 事发州)逐格上色,边按标记之间的界线
  const g = gridOf(cache, v, step, world);
  const lines = smoothSided(mergeChains(regionChains(world.mesh, civ), marks));
  const segs = segIndex(lines, BAND + 0.75 / S, g.box, wrap);
  const sc = scratchOf(cache, g.gw, g.gh);
  const [f1, f2] = highlightFill(style);
  fillDetail(sc.img.data, g, raster, world, civ, regionPixels(world, raster, civ), marks, [null, f1, f2], segs, style === 'fantasy');
  blit(ctx, cache, g);
  // 描边、光晕(光晕的模糊半径不跟着画布变换走,另乘 a)
  const { strokes, ring } = highlightStrokes(world, civ, hl, style);
  eachPart(ctx, v, world, S, () => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const st of strokes) {
      const pa = new Path2D();
      addToPath(pa, st.lines, S, wrap, pj);
      ctx.shadowBlur = st.blur ? st.blur * S * thin * a : 0;
      ctx.shadowColor = st.glow ?? 'transparent';
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width * S * thin;
      ctx.stroke(pa);
    }
    ctx.shadowBlur = 0;
    // 事发地在屏幕上很小:外面套一个圆圈(按屏幕大小)
    const b = highlightBox(world, civ, marks);
    const k = Math.max(1, v.k);
    if (!b || Math.max(b[2] - b[0], b[3] - b[1]) * k >= RING_BELOW * world.width) return;
    const dx = b[2] - b[0];
    const dy = b[3] - b[1];
    const rad = Math.max(48 / k, Math.sqrt(dx * dx + dy * dy) / 2 + 24 / k) * S;
    const mx = (b[0] + b[2]) / 2;
    const my = (b[1] + b[3]) / 2;
    ctx.beginPath();
    if (pj) {
      const rel = pj.rel(mx);
      const K = pj.K(my);
      const cy = pj.Y(my) * S;
      for (const sh of relShifts(rel, rad / S / Math.max(1e-6, K))) {
        const cx = (pj.W / 2 + K * (rel + sh)) * S;
        ctx.moveTo(cx + rad, cy);
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      }
    } else {
      for (const sh of [-world.width, 0, world.width]) {
        const cx = (mx + sh) * S;
        ctx.moveTo(cx + rad, my * S);
        ctx.arc(cx, my * S, rad, 0, Math.PI * 2);
      }
    }
    ctx.strokeStyle = ring[0];
    ctx.lineWidth = (7 / k) * S;
    ctx.stroke();
    ctx.shadowColor = ring[2];
    ctx.shadowBlur = (8 / k) * S * a;
    ctx.strokeStyle = ring[1];
    ctx.lineWidth = (3.2 / k) * S;
    ctx.stroke();
    ctx.shadowBlur = 0;
  });
  return marks;
}
