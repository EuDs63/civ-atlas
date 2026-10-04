/**
 * 放大后的"细节层":地图放大到 DETAIL_K 倍以上时,按视口(和屏幕像素一样细)重画地形图的矢量部分,
 * 底下垫上放大的像素层 —— 盖住视口里的地形图。
 *
 *   手绘:岸线外的波纹、近岸排线(drawFantasySeaLines)、海岸墨线、湖岸描边(drawFantasyCoasts)——
 *         像素层换成不带这几样的那一份(fantasyBaseClean),不然放大后是一格一格的方块、台阶;
 *         林块、河流、山 / 丘陵 / 沙丘 / 草丛 / 火山(drawFantasyVectors)。
 *         符号、墨线按缩放倍数逐级变大、细节变多(fantasy.ts 的 glyphScale、GLYPH_TIERS),不跟着地图等比放大,也不糊
 *   写实:河流(drawRealisticRivers):小溪逐级出现,主干放大后才显出粗
 *
 * 缩放 1 倍附近直接用铺进地形图的那一份(同一套画法、k = 1),细节层不画。
 * 弯边投影按投影重画(drawTerrainProjected):地形图本身(缩放 1 倍)和放大后的细节层都用它。
 * 纯画图(不碰 React);什么时候重画由 ui/TerrainDetail.tsx 决定。
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { VecView } from './common';
import { drawFantasyCoasts, drawFantasySeaLines, drawFantasyVectors, fantasyBaseClean, fantasyBaseNoInk, fantasySymbolLayerProj } from './fantasy';
import { drawRealisticRivers, realisticBase } from './realistic';
import { clipOutline, projector, reprojectImage, type MapProj } from './projection';

/** 放大到几倍以上才启用细节层(以下直接看铺进地形图的那一份;两者在这附近画出来一样大) */
export const DETAIL_K = 1.2;

export type DetailStyle = 'realistic' | 'fantasy';

/** 在画布上画细节层:v = 世界坐标 → 画布像素的变换,v.k = 缩放倍数 */
export function drawTerrainDetail(ctx: CanvasRenderingContext2D, world: World, raster: Raster, style: DetailStyle, v: VecView) {
  const fantasy = style === 'fantasy';
  const base = fantasy ? fantasyBaseClean(world, raster) : realisticBase(raster);
  // 像素层按视口变换放大贴上(和地形图被 CSS 放大时一样是双线性插值;放大用不着更贵的高质量缩放)
  const ps = v.s / raster.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(base, v.ox, v.oy, raster.w * ps, raster.h * ps);
  ctx.restore();
  if (fantasy) {
    drawFantasySeaLines(ctx, world, raster, v);
    drawFantasyCoasts(ctx, raster, v);
    drawFantasyVectors(ctx, world, v);
  } else drawRealisticRivers(ctx, world, raster, v);
}

/**
 * 弯边投影(罗宾森、摩尔威德……)按投影重画地形:画布 = 地图平面 × v.s + (v.ox, v.oy)(整张图或放大后的一块视口)。
 *   1. "面"(纸、水彩、海、晕渲)按行重投影铺上(render/projection.ts 的 reprojectImage)。手绘风:整张图用不带海岸墨线的那一份
 *      (波纹、近岸排线还在像素层里),放大后的一块视口用连波纹、排线也不带的那一份;
 *   2. 按外轮廓裁剪,再把"线和符号"直接画在画布上:手绘 —— (放大后)波纹、近岸排线,海岸墨线、湖岸(逐点投影的矢量线)、林块、河、山 / 丘陵……
 *      (在投影后的位置上正立、按屏幕大小画,大小和等距圆柱同缩放时一样);写实 —— 河(逐点投影)。
 * v.k = 缩放倍数(细节层级,同 drawTerrainDetail)。整张图、缩放 1 倍(铺进地形图)时符号层用缓存的那一张(文明层"让位"也用它)。
 * 不清空画布,外轮廓外面不画
 */
export function drawTerrainProjected(ctx: CanvasRenderingContext2D, world: World, raster: Raster, style: DetailStyle, mp: MapProj, v: { s: number; ox: number; oy: number; k: number }): void {
  const fantasy = style === 'fantasy';
  const whole = v.k <= 1 && v.ox === 0 && v.oy === 0 && Math.abs(v.s - raster.scale) < 1e-9 && ctx.canvas.width === raster.w && ctx.canvas.height === raster.h;
  const base = !fantasy ? realisticBase(raster) : whole ? fantasyBaseNoInk(world, raster) : fantasyBaseClean(world, raster);
  reprojectImage(ctx, base, raster.w, raster.h, mp, v, whole ? 'medium' : 'low');
  const pv = { ...v, proj: projector(mp) };
  ctx.save();
  clipOutline(ctx, mp, v);
  if (fantasy) {
    if (!whole) drawFantasySeaLines(ctx, world, raster, pv);
    drawFantasyCoasts(ctx, raster, pv);
    if (whole) ctx.drawImage(fantasySymbolLayerProj(world, raster, mp), 0, 0);
    else drawFantasyVectors(ctx, world, pv);
  } else drawRealisticRivers(ctx, world, raster, pv);
  ctx.restore();
}
