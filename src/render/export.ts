/**
 * 导出(阶段 4):整张地图合成一张图片(不是当前视口),另有图例图片。
 *
 * 分两步,重活放后台线程(src/exportWorker.ts),界面不卡:
 *   1. drawMapBase(后台线程,OffscreenCanvas):地形(当前画风;2× 时用重新铺的两倍像素)+ 文明底图(国土 / 民族色块、国界、道路,
 *      当前时间轴年份、和屏幕上开着的一样)+ 写实风 / 数据图层的外框和罗盘(手绘风的外框、罗盘本来就画在地形里)。
 *   2. drawMapLabels(主线程,要用页面里加载好的字体):地名、国名、城名和城镇符号(还有战事的战线、双剑),按"整图、缩放 1 倍"排版 ——
 *      地图按世界宽(2048 CSS 像素)显示、2× 时像素密度 × 2:2× 和 1× 排出来一模一样,只是更清楚。
 *      排版、避让和屏幕上是同一套(render/labels/draw.ts 的 placeMap),文字之间不重叠、国名落在国土上。
 *
 * 图例(drawLegend):国家 / 民族列表 + 颜色(和世界概览的国家页一样按当年的州数排;信仰图层再列信仰)、道路和城镇符号,和地图用同一套字体与配色。
 *
 * 投影(和屏幕上一样):等距圆柱按当前中心左右转;弯边投影(罗宾森、摩尔威德……)按投影重画(和屏幕上停着时一样:
 * 面按行重投影,海岸、河、国界、道路逐点投影,符号正立,见 drawProjectedBase),外框换成投影轮廓、罗盘在轮廓外的左下角,
 * 文字按投影排。经纬网开着时也画上。
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ, Year } from '../gen/civ/types';
import { renderRealistic } from './realistic';
import { drawFrame, drawPaperVignette, renderFantasy } from './fantasy';
import { bakedView, wrapOf } from './common';
import { renderLayer, type LayerId } from './layers';
import { drawCivOverlay, type CivShow, type CivStyle } from './civ/overlay';
import { civLabelChars, civLabelItems, civMapLayer, labelViewExtras } from './civ/labels';
import { drawSettlementMarks, SYMBOL_BOX, SYMBOL_GROW, type SettlementKind } from './civ/settlements';
import { drawWarfare, warsShown } from './civ/warfare';
import { REF_MAP_CSS, drawPlacedLabels, placeMap, type LabelMark, type LabelView, type PlacedMark, type Placement } from './labels/draw';
import { ensureFonts, familyFor, fontCss } from './labels/fonts';
import { capitalAt, polityAlive, polityName } from '../gen/civ/growth';
import { ownersAt } from '../gen/civ/timeline';
import { KIND_INFO, cultureLabel } from '../gen/civ/display';
import { faithRows } from '../gen/civ/religionText';
import { drawGraticule, labelProjection, mapProj, outlineOnCanvas, pageColor, projectWorld, projector, reprojectImage, type MapProj, type ProjectionId } from './projection';
import { NAME_ZOOM, canvasMeasure, drawMarks, layoutMarks, placedTextBoxes, type MarkFrame, type MarkItem } from './marks';
import { drawTerrainProjected } from './detail';
import { drawTrail, layoutTrail, type TrailInput } from './trail';
import { compassSpot, drawProjFrame } from './fantasy';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type ExportScale = 1 | 2;

/** 地图图片的格式:PNG 无损;JPEG 有损、没有透明,文件小好几倍(2× 手绘 PNG 约 16 MB → JPEG 约 1.9 MB),方便贴帖子 */
export type ImageFormat = 'png' | 'jpeg';

/** JPEG 质量:0.9 时墨线、文字边缘看不出块状杂色 */
export const JPEG_QUALITY = 0.9;

export const IMAGE_FORMATS: Record<ImageFormat, { mime: string; ext: string; quality?: number }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', quality: JPEG_QUALITY },
};

export interface ExportMapParams {
  world: World;
  /** 铺好的像素;drawMapBase 按它的大小画(2× 时是两倍像素的那张) */
  raster: Raster;
  civ: Civ | null;
  style: CivStyle;
  layer: LayerId;
  /** 画哪一年(时间轴当前的年份) */
  year: Year;
  show: CivShow;
  /**
   * 图片正中是哪条经线(世界 x,和屏幕上当前视图的中心一样);左右边 = 它 ± 180°。
   * 不给 = 主图原样(正中是 0° 经线)
   */
  center?: number;
  /** 投影(和屏幕上一样);不给 / 'equirect' = 等距圆柱 */
  projection?: ProjectionId;
  /** 画不画经纬网 */
  graticule?: boolean;
}

/** 弯边投影:图片按哪种投影、哪条中央经线画(等距圆柱 = null) */
export function exportProj(p: Pick<ExportMapParams, 'world' | 'center' | 'projection'>): MapProj | null {
  if (!p.projection || p.projection === 'equirect') return null;
  const W = p.world.width;
  const lon0 = p.center === undefined ? 0 : (p.center / W) * 360 - 180;
  return mapProj(p.projection, lon0, W, p.world.height);
}

/** 导出时图片左边的世界 x(= 中心 − 半圈);没给中心 = 0 */
export function exportLeft(p: Pick<ExportMapParams, 'world' | 'center'>): number {
  const W = wrapOf(p.world);
  if (p.center === undefined) return 0;
  const l = p.center - W / 2;
  return l - W * Math.floor(l / W);
}

/** 世界和文明是同一次生成的(地块数对得上)才画文明层 */
function civOk(p: ExportMapParams): p is ExportMapParams & { civ: Civ } {
  return !!p.civ && p.civ.habitat.suitability.length === p.world.mesh.n;
}

// ---------------------------------------------------------------------------
// 1. 底图(后台线程)

/** 写实风 / 数据图层导出时加的罗盘:中心、半径(世界单位,和手绘风的罗盘同一个位置,见 fantasy.ts 的 drawFrame) */
const COMPASS = { x: 95, dy: 95, r: 40 };

/** 导出时文字要让开的区域(世界坐标):手绘风的罗盘 labelViewExtras 已经算了,这里补写实风 / 数据图层加的罗盘。left = 图片左边的世界 x */
export function exportReserved(style: CivStyle, worldH: number, left = 0): [number, number, number, number][] {
  if (style === 'fantasy') return [];
  const { x, dy, r } = COMPASS;
  return [[left + x - r - 12, worldH - dy - r - 22, left + x + r + 12, worldH - dy + r + 12]];
}

/** 地形 + 文明底图 + 外框罗盘,画在和 raster 一样大的画布上(后台线程和主线程都能用) */
export function drawMapBase(ctx: Ctx2D, p: ExportMapParams, makeCanvas: (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement): void {
  const { world, raster, style } = p;
  const c2d = ctx as CanvasRenderingContext2D;
  const mp = exportProj(p);
  if (mp) {
    drawProjectedBase(c2d, p, mp, makeCanvas);
    return;
  }
  if (style === 'realistic') renderRealistic(c2d, world, raster);
  else if (style === 'fantasy') renderFantasy(c2d, world, raster);
  else renderLayer(c2d, world, raster, p.layer);
  if (civOk(p)) {
    // 文明底图先画在单独一张透明画布上(drawCivOverlay 会清空整张画布),再贴上去 —— 和屏幕上两张画布叠起来一样
    const cv = makeCanvas(raster.w, raster.h);
    const octx = cv.getContext('2d') as CanvasRenderingContext2D;
    drawCivOverlay(octx, { world, raster, civ: p.civ, style, year: p.year, show: p.show });
    ctx.drawImage(cv, 0, 0);
    cv.width = cv.height = 0;
  }
  // 按当前视图的中心把整张图左右转一下(左右边 = 中心 ± 180°),外框、罗盘、纸边做旧画在转好的图上
  const left = exportLeft(p);
  if (left) {
    const sp = Math.round(left * (raster.w / world.width));
    const tmp = makeCanvas(raster.w, raster.h);
    const tctx = tmp.getContext('2d') as CanvasRenderingContext2D;
    tctx.drawImage(ctx.canvas, 0, 0);
    ctx.clearRect(0, 0, raster.w, raster.h);
    ctx.drawImage(tmp, -sp, 0);
    ctx.drawImage(tmp, raster.w - sp, 0);
    tmp.width = tmp.height = 0;
  }
  if (p.graticule) drawGraticule(ctx, null, world.width, world.height, { s: raster.scale, ox: -left * raster.scale, oy: 0 }, style, 0, raster.scale);
  if (style === 'fantasy') {
    const v = bakedView(raster.scale);
    drawPaperVignette(ctx, world.width, world.height, v);
    drawFrame(ctx, world.width, world.height, v);
  }
  if (style !== 'fantasy') drawNeatFrame(ctx, raster.w, raster.h, raster.scale, style);
}

/**
 * 弯边投影的底图(和屏幕上停着时一样按投影重画;中央经线在投影里转,不用先左右转):
 * 外轮廓外面铺底色 → 地形(手绘 / 写实:面按行重投影,海岸、河逐点投影,符号正立;数据图层:整图重投影)
 * → 文明底图(色块重投影,国界、道路逐点投影)→ 经纬网、纸边做旧、外框罗盘
 */
function drawProjectedBase(ctx: CanvasRenderingContext2D, p: ExportMapParams, mp: MapProj, makeCanvas: (w: number, h: number) => OffscreenCanvas | HTMLCanvasElement): void {
  const { world, raster, style } = p;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = pageColor(style);
  ctx.fillRect(0, 0, raster.w, raster.h);
  if (style === 'fantasy' || style === 'realistic') drawTerrainProjected(ctx, world, raster, style, mp, { s: raster.scale, ox: 0, oy: 0, k: 1 });
  else {
    const src = makeCanvas(raster.w, raster.h);
    renderLayer(src.getContext('2d') as CanvasRenderingContext2D, world, raster, p.layer);
    reprojectImage(ctx, src, raster.w, raster.h, mp, { s: raster.scale, ox: 0, oy: 0 });
    src.width = src.height = 0;
  }
  ctx.restore();
  if (civOk(p)) {
    const cv = makeCanvas(raster.w, raster.h);
    const octx = cv.getContext('2d') as CanvasRenderingContext2D;
    drawCivOverlay(octx, { world, raster, civ: p.civ, style, year: p.year, show: p.show, proj: projector(mp) });
    ctx.drawImage(cv, 0, 0);
    cv.width = cv.height = 0;
  }
  const v = bakedView(raster.scale);
  if (p.graticule) drawGraticule(ctx, mp, world.width, world.height, v, style, 0, raster.scale);
  if (style === 'fantasy') {
    drawPaperVignette(ctx, world.width, world.height, v);
    drawProjFrame(ctx, mp, v);
  } else drawNeatProjFrame(ctx, mp, raster.scale, style);
}

/** 写实风 / 数据图层在弯边投影下的外框:沿外轮廓一道深色粗线 + 一道浅色细线,罗盘在轮廓外的左下角 */
function drawNeatProjFrame(ctx: Ctx2D, mp: MapProj, S: number, style: CivStyle) {
  const ink = style === 'data' ? 'rgba(30, 32, 36, 0.92)' : 'rgba(14, 24, 34, 0.94)';
  ctx.save();
  ctx.lineJoin = 'round';
  outlineOnCanvas(ctx, mp, S, 0, 0, 2.5);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 5 * S;
  ctx.stroke();
  outlineOnCanvas(ctx, mp, S, 0, 0, 0);
  ctx.strokeStyle = 'rgba(236, 232, 220, 0.75)';
  ctx.lineWidth = 1.2 * S;
  ctx.stroke();
  ctx.restore();
  const [cx, cy] = compassSpot(mp);
  drawNeatCompass(ctx, cx * S, cy * S, S, ink);
}

/**
 * 写实风 / 数据图层的外框和罗盘:地图集那样的细边框(深色外框 + 一道浅色细线),左下角一个带底盘的罗盘
 * (底盘是半透明的浅色圆,压在深海、冰原上都看得清)。
 */
function drawNeatFrame(ctx: Ctx2D, w: number, h: number, S: number, style: CivStyle) {
  ctx.save();
  const ink = style === 'data' ? 'rgba(30, 32, 36, 0.92)' : 'rgba(14, 24, 34, 0.94)';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 8 * S;
  ctx.strokeRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(236, 232, 220, 0.75)';
  ctx.lineWidth = 1.2 * S;
  ctx.strokeRect(6.5 * S, 6.5 * S, w - 13 * S, h - 13 * S);
  ctx.restore();
  drawNeatCompass(ctx, COMPASS.x * S, h - COMPASS.dy * S, S, ink);
}

/** 写实风 / 数据图层的罗盘(带半透明浅色底盘):中心 (cx, cy) 画布像素 */
function drawNeatCompass(ctx: Ctx2D, cx: number, cy: number, S: number, ink: string) {
  ctx.save();
  const R = COMPASS.r * S;
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.86, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(244, 241, 232, 0.72)';
  ctx.fill();
  ctx.lineWidth = 1 * S;
  ctx.strokeStyle = ink;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.62, 0, Math.PI * 2);
  ctx.lineWidth = 0.6 * S;
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const long = i % 2 === 0;
    const L = long ? R * 0.8 : R * 0.48;
    const wv = long ? R * 0.13 : R * 0.1;
    const tx = Math.cos(a) * L;
    const ty = Math.sin(a) * L;
    const nx = -Math.sin(a) * wv;
    const ny = Math.cos(a) * wv;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tx, ty);
    ctx.lineTo(nx, ny);
    ctx.closePath();
    ctx.fillStyle = i === 0 ? 'rgba(150, 40, 34, 0.95)' : ink;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tx, ty);
    ctx.lineTo(-nx, -ny);
    ctx.closePath();
    ctx.fillStyle = 'rgb(248, 246, 240)';
    ctx.fill();
    ctx.lineWidth = 0.6 * S;
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
  ctx.font = `700 ${13 * S}px "Noto Serif SC", "Songti SC", "STSong", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3 * S;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(244, 241, 232, 0.85)';
  ctx.strokeText('北', 0, -R * 0.86 - 2 * S);
  ctx.fillStyle = ink;
  ctx.fillText('北', 0, -R * 0.86 - 2 * S);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 2. 地图文字(主线程)

/** 导出时文字层的视口:整张图、缩放 1 倍;地图按世界宽显示,像素密度 = 导出倍数 */
export function exportLabelView(p: ExportMapParams, S: ExportScale): LabelView {
  const W = p.world.width;
  const H = p.world.height;
  const mp = exportProj(p);
  if (mp) {
    // 弯边投影:文字按投影排,不出外轮廓(罗盘在轮廓外面)
    const extras = labelViewExtras({ world: p.world, raster: p.raster, civ: p.civ!, style: p.style, year: p.year, show: p.show }, 0);
    return { ...extras, reserved: [], wrap: 0, frameLeft: 0, proj: labelProjection(mp), scale: S, ox: 0, oy: 0, dpr: S, k: 1, mapCss: W, canvasW: W * S, canvasH: H * S };
  }
  // 球面世界:图片左边是 left(展开的世界坐标),外框 = 图片边
  const left = exportLeft(p);
  const extras = labelViewExtras({ world: p.world, raster: p.raster, civ: p.civ!, style: p.style, year: p.year, show: p.show }, left);
  return {
    ...extras,
    reserved: [...(extras.reserved ?? []), ...exportReserved(p.style, H, left)],
    frameLeft: left,
    scale: S,
    ox: -left * S,
    oy: 0,
    dpr: S,
    k: 1,
    mapCss: W,
    canvasW: W * S,
    canvasH: H * S,
  };
}

/**
 * 画地图文字(地名、国名、城名、城镇符号)。p.raster 用 1× 的那张就行(只查地面、拟合国名,和导出倍数无关)。
 * 先等字体加载好。返回画了几条文字、几个符号。
 */
export async function drawMapLabels(ctx: CanvasRenderingContext2D, p: ExportMapParams, S: ExportScale): Promise<{ labels: number; marks: number; placed?: Placement }> {
  if (!civOk(p)) return { labels: 0, marks: 0 };
  const params = { world: p.world, raster: p.raster, civ: p.civ, style: p.style, year: p.year, show: p.show };
  // 地理名不随年份变(和屏幕上一样按结束年份取);国名、城名、城镇符号按当年
  const geo = civLabelItems({ ...params, year: p.civ.endYear });
  // 弯边投影:国名按投影后的国土拟合
  const layer = civMapLayer(params, { proj: exportProj(p) });
  const items = geo.concat(layer.items);
  const wars = warsShown(params);
  if (!items.length && !layer.marks.length && !wars) return { labels: 0, marks: 0 };
  await ensureFonts(p.style, civLabelChars(p.civ), 15000);
  const lv = exportLabelView(p, S);
  const placed = placeMap(items, layer.marks, lv);
  // 战事的战线、双剑:压在国界上、城镇符号和字底下(和屏幕上一样)
  if (wars) {
    const mp = exportProj(p);
    drawWarfare(ctx, params, lv, mp ? projector(mp) : null);
  }
  drawSettlementMarks(ctx, placed.marks, p.style);
  drawPlacedLabels(ctx, placed.labels, lv);
  return { labels: placed.labels.length, marks: placed.marks.length, placed };
}

/**
 * 作者标记、人物足迹在导出图上摆放用的坐标:世界坐标 ÷ f(f = √(图宽 / REF_MAP_CSS)),画的时候整体放大 S × f,
 * 图钉、头像和字跟着地名一样按图片宽放大(地图按 REF_MAP_CSS 宽显示时就是屏幕上的大小)
 */
function exportMarkFrame(p: Pick<ExportMapParams, 'world' | 'center' | 'projection'>): { frame: MarkFrame; f: number } {
  const W = p.world.width;
  const H = p.world.height;
  const f = Math.sqrt(W / REF_MAP_CSS);
  const mp = exportProj(p);
  const left = mp ? 0 : exportLeft(p);
  const frame: MarkFrame = mp
    ? {
        pt: (wx, wy) => {
          const [x, y] = projectWorld(mp, wx, wy);
          return [x / f, y / f];
        },
        period: 0,
        win: [0, W / f],
        w: W / f,
        h: H / f,
        k: NAME_ZOOM,
        cut: (0.4 * W) / f,
      }
    : { pt: (wx, wy) => [(wx - left) / f, wy / f], period: wrapOf(p.world) ? W / f : 0, win: [0, W / f], w: W / f, h: H / f, k: NAME_ZOOM, cut: 0 };
  return { frame, f };
}

/**
 * 作者标记(导出菜单里选了"带上"):和屏幕上同样的图钉、铺色、名字,都写名字、不合并;items = 这一年有的(几个州的形状算好)。
 * placed = drawMapLabels 排好的地图文字:名字尽量不压城名、地名。返回画了几个
 */
export function drawExportMarks(ctx: CanvasRenderingContext2D, p: Pick<ExportMapParams, 'world' | 'center' | 'projection'>, S: ExportScale, items: readonly MarkItem[], placed?: Placement): number {
  if (!items.length) return 0;
  const { frame, f } = exportMarkFrame(p);
  ctx.save();
  ctx.scale(S * f, S * f);
  // 文字层的画布像素 = 摆放坐标 × S × f
  const avoid = placed ? placedTextBoxes(placed).map((b) => b.map((v) => v / (S * f))) : [];
  const layout = layoutMarks(items, frame, { names: true, measure: canvasMeasure(ctx), avoid });
  drawMarks(ctx, layout, S * f);
  ctx.restore();
  return layout.pins.length + layout.areas.length;
}

/** 正选着的作者人物的足迹(和屏幕上一样的线、圆点、年份、头像);年份尽量不压地图上的字。返回画了几个点 */
export function drawExportTrail(ctx: CanvasRenderingContext2D, p: Pick<ExportMapParams, 'world' | 'center' | 'projection'>, S: ExportScale, trail: TrailInput, placed?: Placement): number {
  const { frame, f } = exportMarkFrame(p);
  ctx.save();
  ctx.scale(S * f, S * f);
  const avoid = placed ? placedTextBoxes(placed).map((b) => b.map((v) => v / (S * f))) : [];
  const layout = layoutTrail(trail, frame, { measure: canvasMeasure(ctx), avoid });
  drawTrail(ctx, layout);
  ctx.restore();
  return layout.dots.length;
}

// ---------------------------------------------------------------------------
// 3. 图例

export interface LegendRow {
  color: [number, number, number];
  name: string;
  /** 右边的小字:"12 州 · 都 汾城" */
  note: string;
}

/** 这一年的国家(按州数排,和世界概览的国家页一样)、民族(按地盘排;已消亡的不列) */
export function legendRows(civ: Civ, year: Year): { polities: LegendRow[]; cultures: LegendRow[]; tribal: number } {
  const y = Math.floor(year);
  const own = ownersAt(civ, y);
  const pc = new Array<number>(civ.polities.length).fill(0);
  const cc = new Array<number>(civ.cultures.length).fill(0);
  let tribal = 0;
  for (let r = 0; r < civ.regions.count; r++) {
    const p = own.polity[r];
    const c = own.culture[r];
    if (p >= 0) pc[p]++;
    else if (c >= 0) tribal++;
    if (c >= 0) cc[c]++;
  }
  const polities = civ.polities
    .filter((p) => polityAlive(p, y) && pc[p.id] > 0)
    .sort((a, b) => pc[b.id] - pc[a.id] || a.id - b.id)
    .map((p) => {
      const cap = civ.settlements[capitalAt(p, y)]?.name;
      return { color: p.color, name: polityName(p, y), note: `${pc[p.id]} 州${cap ? ` · 都${cap}` : ''}` };
    });
  const cultures = civ.cultures
    .filter((c) => cc[c.id] > 0)
    .sort((a, b) => cc[b.id] - cc[a.id] || a.id - b.id)
    .map((c) => ({ color: c.color, name: cultureLabel(c), note: `${KIND_INFO[c.kind].name} · ${cc[c.id]} 州` }));
  return { polities, cultures, tribal };
}

/** 信仰图层的图例:和侧栏信仰列表同样的几行(大教按信众排,教派跟在本教后面,各族民间信仰合成一行) */
export function faithLegendRows(civ: Civ, year: Year): LegendRow[] {
  const F = civ.religion?.faiths ?? [];
  return faithRows(civ, Math.floor(year)).map((r) => {
    const form = r.id >= 0 && !r.sect ? F[r.id]?.form : undefined;
    return { color: [r.color[0], r.color[1], r.color[2]], name: r.name, note: `${r.sect ? '教派 · ' : form ? `${form} · ` : ''}${r.n} 州` };
  });
}

interface LegendLook {
  paper: string;
  edge: string;
  ink: string;
  muted: string;
  rule: string;
}

const LEGEND_LOOK: Record<CivStyle, LegendLook> = {
  fantasy: { paper: '#efe2c2', edge: 'rgba(58,45,34,0.9)', ink: 'rgb(58,45,34)', muted: 'rgba(58,45,34,0.62)', rule: 'rgba(58,45,34,0.35)' },
  realistic: { paper: '#f6f4ee', edge: 'rgba(14,24,34,0.9)', ink: 'rgb(24,30,38)', muted: 'rgba(24,30,38,0.58)', rule: 'rgba(24,30,38,0.25)' },
  data: { paper: '#f6f4ee', edge: 'rgba(30,32,36,0.9)', ink: 'rgb(28,30,34)', muted: 'rgba(28,30,34,0.58)', rule: 'rgba(28,30,34,0.25)' },
};

export interface LegendParams {
  civ: Civ;
  style: CivStyle;
  year: Year;
  show: CivShow;
  seed: number;
}

/** 图例里的城镇符号:国都 → 村,再加故城遗址 */
const SYMBOL_ROWS: { kind: SettlementKind; name: string }[] = [
  { kind: 4, name: '国都' },
  { kind: 3, name: '大城' },
  { kind: 2, name: '城' },
  { kind: 1, name: '镇' },
  { kind: 0, name: '村' },
  { kind: 5, name: '故城遗址' },
];

/**
 * 图例图片:标题(第 N 年)、国家(色块 + 当年国号 + 州数、国都)、民族(色块 + 族名 + 类型、州数)或信仰(色块 + 名字 + 类型、州数)、城镇符号、道路。
 * 地图上开着"民族"或"信仰"时色块是民族 / 信仰的,国家只画国界 —— 国家的色块就画成空心框。
 * 两个表都没开时两个都列。行多了分两栏。
 */
export async function drawLegend(p: LegendParams, scale: ExportScale): Promise<HTMLCanvasElement> {
  // 图例按 1.5 倍画:1× 时约 530 像素宽,高度和 1× 地图差不多,放在地图旁边正合适
  const S = scale * 1.5;
  const { civ, style, show } = p;
  const y = Math.floor(p.year);
  const look = LEGEND_LOOK[style];
  const family = familyFor(style);
  const rows = legendRows(civ, y);
  // 信仰图层:地图铺的是信仰(国家只画国界),图例列国家(空心框)和信仰
  const faithOn = show.faiths && !!civ.religion?.faiths.length;
  const faiths = faithOn ? faithLegendRows(civ, y) : [];
  const wantPol = show.polities || (!show.cultures && !faithOn);
  const wantCul = !faithOn && (show.cultures || !show.polities);
  const outline = show.cultures || faithOn;
  const withMarks = show.polities || show.routes;
  const withRoutes = show.routes;

  const allText = [...rows.polities, ...rows.cultures, ...faiths].map((r) => r.name + r.note).join('') + '图例第年国家民族信仰教派城镇道路大路小路航线部落地带种子州都';
  await ensureFonts(style, allText, 15000);

  // ---- 版式(CSS 像素,最后 × S)----
  const PAD = 28;
  const COL = 300;
  const ROW = 26;
  const HEAD = 34;
  type Block = { title: string; rows: LegendRow[]; kind: 'pol' | 'cul' | 'faith' };
  const blocks: Block[] = [];
  if (wantPol) blocks.push({ title: '国家', rows: rows.polities, kind: 'pol' });
  if (wantCul) blocks.push({ title: '民族', rows: rows.cultures, kind: 'cul' });
  if (faithOn) blocks.push({ title: '信仰', rows: faiths, kind: 'faith' });
  const most = Math.max(1, ...blocks.map((b) => b.rows.length));
  const cols = most > 14 ? 2 : 1;
  const W = PAD * 2 + COL * cols + (cols - 1) * 24;
  let h = PAD + 58; // 标题
  for (const b of blocks) h += HEAD + Math.max(1, Math.ceil(b.rows.length / cols)) * ROW + 14;
  if (wantPol && rows.tribal) h += 20;
  if (withMarks) h += HEAD + 2 * ROW + 14;
  if (withRoutes) h += HEAD + ROW + 14;
  h += PAD - 8;

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * S);
  cv.height = Math.round(h * S);
  const ctx = cv.getContext('2d')!;
  ctx.scale(S, S);
  ctx.fillStyle = look.paper;
  ctx.fillRect(0, 0, W, h);
  ctx.strokeStyle = look.edge;
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, W - 8, h - 8);
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, W - 20, h - 20);
  ctx.textBaseline = 'middle';

  const text = (s: string, x: number, yy: number, px: number, color: string, weight = 500, align: CanvasTextAlign = 'left') => {
    ctx.font = fontCss(family, weight, px);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, yy);
  };
  const fit = (s: string, px: number, max: number) => {
    ctx.font = fontCss(family, 500, px);
    if (ctx.measureText(s).width <= max) return s;
    let t = s;
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  };

  let cy = PAD + 18;
  text(`第 ${y} 年`, PAD, cy, 26, look.ink, style === 'realistic' || style === 'data' ? 700 : 500);
  text(`图例 · 种子 ${p.seed}`, W - PAD, cy + 3, 14, look.muted, 500, 'right');
  cy += 40;

  const rule = (yy: number) => {
    ctx.beginPath();
    ctx.moveTo(PAD, yy);
    ctx.lineTo(W - PAD, yy);
    ctx.strokeStyle = look.rule;
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  for (const b of blocks) {
    rule(cy - 6);
    text(b.title, PAD, cy + HEAD / 2 - 2, 17, look.ink, style === 'fantasy' ? 500 : 700);
    cy += HEAD;
    if (!b.rows.length) {
      text(`这一年还没有${b.title}`, PAD, cy + ROW / 2, 14, look.muted);
      cy += ROW;
    }
    const per = Math.ceil(b.rows.length / cols);
    b.rows.forEach((r, i) => {
      const col = Math.floor(i / Math.max(1, per));
      const x = PAD + col * (COL + 24);
      const yy = cy + (i % Math.max(1, per)) * ROW + ROW / 2;
      const rgb = `rgb(${r.color.join(',')})`;
      if (b.kind === 'pol' && outline) {
        ctx.strokeStyle = rgb;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, yy - 7, 14, 14);
      } else {
        ctx.fillStyle = rgb;
        ctx.fillRect(x, yy - 8, 16, 16);
        ctx.strokeStyle = look.rule;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, yy - 7.5, 15, 15);
      }
      ctx.font = fontCss(family, 500, 12.5);
      const noteW = ctx.measureText(r.note).width;
      text(fit(r.name, 15, COL - 30 - noteW - 10), x + 24, yy + 1, 15, look.ink);
      text(r.note, x + COL, yy + 1, 12.5, look.muted, 500, 'right');
    });
    cy += Math.ceil(b.rows.length / cols) * ROW;
    if (b.kind === 'pol' && rows.tribal) {
      text(`另有 ${rows.tribal} 州是部落地带(有人居住、还没有国家)`, PAD, cy + 10, 12.5, look.muted);
      cy += 20;
    }
    cy += 14;
  }

  if (withMarks) {
    rule(cy - 6);
    text('城镇', PAD, cy + HEAD / 2 - 2, 17, look.ink, style === 'fantasy' ? 500 : 700);
    cy += HEAD;
    const boxes = SYMBOL_BOX[style === 'fantasy' ? 'fantasy' : 'realistic'];
    const per = 3;
    const cw = (W - PAD * 2) / per;
    const placed: PlacedMark[] = [];
    const cap = rows.polities.length ? rows.polities[0].color : ([150, 60, 50] as [number, number, number]);
    SYMBOL_ROWS.forEach((r, i) => {
      const x = PAD + (i % per) * cw + 12;
      const yy = cy + Math.floor(i / per) * ROW + ROW / 2;
      const mark = { id: -1 - i, x, y: yy, box: boxes[r.kind], grow: SYMBOL_GROW, minZoom: 1, priority: 0, kind: r.kind, color: cap };
      placed.push({ mark: mark as unknown as LabelMark, x: x * S, y: yy * S, s: 1.6 * S });
      text(r.name, x + 16, yy + 1, 14, look.ink);
    });
    // 符号按画布像素画(drawSettlementMarks 里会先重置变换,画完 save / restore 还原)
    drawSettlementMarks(ctx, placed, style);
    cy += 2 * ROW + 14;
  }

  if (withRoutes) {
    rule(cy - 6);
    text('道路', PAD, cy + HEAD / 2 - 2, 17, look.ink, style === 'fantasy' ? 500 : 700);
    cy += HEAD;
    const names = { road: '大路', trail: '小路', sea: '航线' } as const;
    const cw = (W - PAD * 2) / 3;
    (['road', 'trail', 'sea'] as const).forEach((kind, i) => {
      const x = PAD + i * cw;
      const yy = cy + ROW / 2;
      routeSample(ctx, kind, style, x, yy, 46);
      text(names[kind], x + 56, yy + 1, 14, look.ink);
    });
  }
  return cv;
}

/**
 * 图例里的一小段路:和地图上同样的笔法(render/civ/routes.ts),放大 1.6 倍;
 * 垫一小块地面 / 海面的底色(写实风的路是浅色的,直接画在浅色纸上看不见)
 */
function routeSample(ctx: CanvasRenderingContext2D, kind: 'road' | 'trail' | 'sea', style: CivStyle, x: number, y: number, len: number) {
  const S = 1.6;
  const fantasy = style === 'fantasy';
  ctx.save();
  ctx.fillStyle = kind === 'sea' ? (fantasy ? '#8fabb0' : '#1f4a70') : fantasy ? '#e6d6ae' : '#7d8a57';
  ctx.beginPath();
  ctx.roundRect(x - 4, y - 8, len + 8, 16, 4);
  ctx.fill();
  const seg = (color: string, width: number, dash: number[]) => {
    ctx.beginPath();
    ctx.moveTo(x + 3, y);
    ctx.lineTo(x + len - 3, y);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  if (fantasy) {
    if (kind === 'sea') seg('rgba(52,58,66,0.62)', 1.25 * S, [0.01, 3.4 * S]);
    else if (kind === 'trail') {
      seg('rgba(246,236,210,0.3)', 2 * S, []);
      seg('rgba(74,46,28,0.7)', 0.8 * S, [2.2 * S, 2.4 * S]);
    } else {
      seg('rgba(246,236,210,0.45)', 2.8 * S, []);
      seg('rgba(74,42,24,0.9)', 1.2 * S, [4.6 * S, 2.6 * S]);
    }
  } else if (kind === 'sea') seg('rgba(226,238,246,0.7)', 1.2 * S, [0.01, 3.2 * S]);
  else if (kind === 'trail') {
    seg('rgba(38,28,14,0.24)', 2 * S, []);
    seg('rgba(246,230,186,0.85)', 0.9 * S, [2.4 * S, 2 * S]);
  } else {
    seg('rgba(38,28,14,0.36)', 2.5 * S, []);
    seg('rgba(248,228,174,0.97)', 1.2 * S, []);
  }
  ctx.restore();
}
