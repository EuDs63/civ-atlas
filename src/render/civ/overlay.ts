/**
 * 文明叠加层:画在地形图上面单独的一层 canvas 上(和地形图的画法 render/fantasy.ts、realistic.ts、layers.ts 分开)。
 * 切换年份 / 开关时只重画这一层,地形不动。
 *
 * 按固定顺序调用各画法;每个画法在自己的文件里:
 *   宜居度热力图(debug.ts)
 *   → 国土 / 民族色块(territory.ts;两层都开时铺民族)
 *   → 战事:正在打的仗里易手的州画斜线(warfare.ts)
 *   → 州界细线(debug.ts)
 *   → 国界(borders.ts)
 *   → 道路(routes.ts;按修建年份出现)
 *   → 城址圆点(debug.ts)
 *
 * 文字、城镇符号、战线和双剑(warfare.ts 的 drawWarfare)不画在这一层:它们在 CivLayer 里单独一张和视口一样大的画布上,随缩放、平移重画(放大后依然清晰)。
 * 数据来源是 labels.ts:civLabelItems()(地理名)、civMapLayer()(国名、城名、城镇符号,随年份变);
 * 排版、避让在 render/labels/draw.ts 的 placeMap(),城镇符号的画法在 settlements.ts。
 */
import type { World } from '../../gen/world';
import type { Raster } from '../../gen/raster';
import type { Civ, Year } from '../../gen/civ/types';
import { drawHabitat, drawRegionLines, drawSites } from './debug';
import { drawTerritory } from './territory';
import { drawBorders } from './borders';
import { drawRoutes } from './routes';
import { drawWarHatch } from './warfare';
import { clipOutline, type Projector } from '../projection';

export type CivStyle = 'realistic' | 'fantasy' | 'data';

/** 文明层的开关 */
export interface CivShow {
  /** 宜居度热力图 */
  habitat: boolean;
  /** 州界细线 */
  regions: boolean;
  /** 城址圆点 */
  sites: boolean;
  /** 道路与航线 */
  routes: boolean;
  /** 地名(默认打开) */
  labels: boolean;
  /** 民族色块 */
  cultures: boolean;
  /** 国家:国土、国界、城镇。和"民族"一起开时只画国界和城镇,色块是民族的 */
  polities: boolean;
  /** 战事:正在打的仗(战线、易手的州、交战处的双剑);要开着"国家"才画(默认打开) */
  wars: boolean;
}

export const CIV_SHOW_OFF: CivShow = {
  habitat: false,
  regions: false,
  sites: false,
  routes: false,
  labels: false,
  cultures: false,
  polities: false,
  wars: false,
};
/** 打开页面时的默认显示:地名、战事(战事要开着"国家"才画) */
export const CIV_SHOW_DEFAULT: CivShow = { ...CIV_SHOW_OFF, labels: true, wars: true };

/** 视口:缩放倍数 k、平移 x/y(CSS 像素)。文字层随缩放重画时用 */
export interface CivViewport {
  k: number;
  x: number;
  y: number;
}

export interface CivDrawParams {
  world: World;
  raster: Raster;
  civ: Civ;
  style: CivStyle;
  /** 画哪一年(时间轴拖到哪一年就画哪一年) */
  year: Year;
  show: CivShow;
  view?: CivViewport;
  /** 正在回放 / 拖时间轴:色块用半分辨率,保证每帧够快 */
  fast?: boolean;
  /**
   * 弯边投影(按投影重画):画布是地图平面(和 raster 一样大,画布像素 = 地图平面 × raster.scale)。
   * 色块、热力图这样的"面"先按等距圆柱算好再按行重投影;州界、国界、道路逐点投影,线宽、虚线按画布像素,处处一致;
   * 城址圆点在投影后的位置上画。不给 = 等距圆柱主图
   */
  proj?: Projector | null;
  /**
   * 地球仪的文明贴图(手绘):水彩按地球仪贴图的符号层让位(林块按纬度拉宽过,山丘等符号不在贴图里,
   * 见 fantasy.ts 的 fantasyGlobeInkMask)。主图不给
   */
  globeInk?: boolean;
}

export function drawCivOverlay(ctx: CanvasRenderingContext2D, p: CivDrawParams) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (p.show.habitat) drawHabitat(ctx, p);
  drawTerritory(ctx, p);
  drawWarHatch(ctx, p);
  // 弯边投影:线和点不出外轮廓(伸出 ±180° 的那截在另一边接着画)
  ctx.save();
  if (p.proj) clipOutline(ctx, p.proj.mp, { s: p.raster.scale, ox: 0, oy: 0 });
  if (p.show.regions) drawRegionLines(ctx, p);
  drawBorders(ctx, p);
  drawRoutes(ctx, p);
  if (p.show.sites) drawSites(ctx, p);
  ctx.restore();
}

/**
 * 地球仪的文明贴图:和 drawCivOverlay 一样,只是不画国界和道路 ——
 * 地球仪上这两样(还有战线、双剑)每帧按正射投影画成矢量线(render/globeLines.ts),放大后不发软
 */
export function drawCivFill(ctx: CanvasRenderingContext2D, p: CivDrawParams) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (p.show.habitat) drawHabitat(ctx, p);
  drawTerritory(ctx, p);
  drawWarHatch(ctx, p);
  if (p.show.regions) drawRegionLines(ctx, p);
  if (p.show.sites) drawSites(ctx, p);
}
