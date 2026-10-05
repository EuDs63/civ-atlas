/**
 * 3D 地球仪视图:把球面世界显示成一个可以拖着转、滚轮缩放的地球仪(render/globe.ts 画球)。
 *
 * 贴图(都是等距圆柱,和主图同一套像素):
 *   - 地形:地球仪专用的一张 —— 手绘不带山、丘陵、沙丘、草丛、火山(每帧正立着画,见下),林块按纬度横向拉宽
 *     (fantasy.ts 的 fantasyGlobeBase,主线程几毫秒);写实是不打光的底色 + 坡度(realistic.ts 的 realisticGlobeMaps),
 *     着色器按"光从屏幕左上方来"重新打光,两极不会光从背后来 —— 这张要重算整张图的明暗,后台线程画(globeWorker.ts),
 *     画好之前先用主图那张;数据图层直接用主图那张。
 *     放大到 1.5 倍以上、贴图不够清楚时,后台线程按两倍像素重铺一张换上。缩放 1 倍、换画风、换世界都不会自己去铺高清的;
 *     铺好的缩回去以后留着,换画风再换回来直接用,换世界才扔
 *   - 文明贴图:国土 / 民族色块(还有宜居度、州界细线、城址这几个调试图层),这里自己画一张(drawCivFill,不含国界和道路),
 *     时间轴一动就重画、重新上传(手绘风停着时水彩按地球仪贴图的林块让位);选中的国家 / 州的罩染也是自己画的一张(不含描边)
 *   - 高亮层(编年史闪烁):罩染自己画一张,描边、圆圈每帧画成矢量(见下)
 *   - 回放世界形成:回放帧(1024×512)淡入盖在上面
 * 球上面一层 2D 画布(和屏幕一样大,按屏幕像素画):
 *   - 手绘符号(山、丘陵、沙丘、草丛、火山):每帧投影到屏幕上正立着画(render/globeGlyphs.ts),大小、分级和平面主图同样缩放时一样,
 *     背面的不画,靠近球边缘的淡出
 *   - 矢量线:国界、道路与航线、选中的国家 / 州的描边、选中的大河 / 山脉的淡光、编年史高亮的描边 —— 每帧按正射投影逐顶点画
 *     (render/globeLines.ts),线宽按屏幕像素定,放大到 8 倍也锐利;背面裁掉,跨 180° 经线不断
 *   - 战事(render/civ/warfare.ts):战线在矢量线里,朝守方的短齿、交战处的双剑按投影后的位置用画布像素画;
 *     易手的州的斜线画在文明贴图里
 *   - 城镇符号和文字:和平面主图同一套排版(render/globeLabels.ts):山名沿山脊、河名逐字正立沿河、国名顺着国土、
 *     城名在符号旁、海名疏排,一起避让,按缩放分级出现;始终正立朝着屏幕,背面的不画,靠近球边缘的淡出。
 *     转动、拖时间轴时只排大字(国名、大洋和海、国都和大城的名字),停下约 0.15 秒后排全部
 *
 * 交互:拖动旋转(松手有惯性)、滚轮 / 双指缩放、双击回正(北在上、赤道居中、整个球);球上不放按钮 ——
 * 经纬网在图层与投影弹层里开关,"导出地球仪这一面"在导出菜单里(exportGlobeView);
 * 状态(没有 WebGL2、高清贴图加载得慢)用顶部提示条。
 * 单击由 App 统一处理(和主图同一套选中逻辑),这里提供"屏幕点 → 主图像素""点到了哪个符号 / 字""世界坐标 → 屏幕"(GlobeApi)。
 * 右侧的国家面板打开时球心往左挪半个面板宽(0.6 秒过渡),转到的国家落在去掉面板后的可见区域正中。
 *
 * 没有 WebGL2(或网址加 globe=cpu)时退回 CPU 画:同样的公式逐像素算,拖动时降一半分辨率。
 *
 * 开关就是"投影"切换里的 globe(ui/projection.ts;"图层与投影"弹层的投影、地图右下角的"地球仪 / 平面地图"按钮都改它,网址 proj=globe,旧的 view=globe 也认);
 * 经纬网和平面投影共用一个开关;中心经度和 mapWrap.ts 的中心互通(打开时从当前中心转起,停下来就记下正对着的经度)。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import type { LayerId } from '../render/layers';
import {
  GLOBE_BG,
  GLOBE_DEFAULT_LAT,
  GLOBE_K_MAX,
  GLOBE_K_MIN,
  GlobeGL,
  clampView,
  dragView,
  equivalentZoom,
  globeFrame,
  graticuleLines,
  graticuleStep,
  lerpView,
  lonLatToScreen,
  pickGlobeMark,
  renderGlobeCpu,
  screenToLonLat,
  screenToPixel,
  worldToLonLat,
  zoomAt,
  type GlobeLook,
  type GlobeTexSource,
  type GlobeView,
  type PixelSource,
  type RgbaImage,
  wantHdTexture,
} from '../render/globe';
import { getCivFeed, subscribeCivFeed } from './CivLayer';
import { getProjection, lastFlatProjection, setProjection, useGraticule, useProjection } from './projection';
import { clearToast, showToast } from './toastStore';
import { getMapCenter, publishMapCenter } from './mapWrap';
import { drawSettlementMarks, type SettlementMarkInfo } from '../render/civ/settlements';
import { REF_MAP_CSS, drawPlacedLabels, placeMap, placedMarkBox, type LabelItem, type LabelMark, type LabelView, type Placement } from '../render/labels/draw';
import { glyphBox } from '../render/labels/layout';
import { getCivTime, setSelection, subscribeCivTime, useCivHighlight, useCivShow, useSelection } from './civView';
import {
  drawHighlight,
  drawSelectionLabels,
  drawSelectionWash,
  highlightBox,
  highlightMarks,
  highlightStrokes,
  selectionLines,
  selectionLook,
  type SelectionTarget,
} from '../render/civ/highlight';
import { drawCivFill, type CivDrawParams, type CivShow } from '../render/civ/overlay';
import { borderLines } from '../render/civ/borders';
import { routeLines } from '../render/civ/routes';
import { labelSurface } from '../render/civ/labels';
import { Layer } from '../gen/civ/types';
import {
  borderStrokes,
  buildLineSet,
  drawGlobeWarTeeth,
  fadeRim,
  globeBorderSets,
  globePoint,
  globeProjector,
  globeRouteSets,
  globeWarSet,
  routeStrokes,
  strokeGlobeLines,
  warStrokes,
  type GlobeLineSet,
  type GlobeLineStroke,
  type GlobeProjector,
} from '../render/globeLines';
import { MARK_MIN_D, globeGlyphAlpha, globeLabelView, globePolityItem, globeToCanvas, isQuickLabel, visibleMarks, type GlobeLabelView } from '../render/globeLabels';
import { ALL_FIGHTS_K, drawSwords, swordHalf, warFront, warMarkPoints, warsShown } from '../render/civ/warfare';
import { drawGlobeGlyphs, globeGlyphSet, placeGlobeGlyphs, type GlobeGlyphSet, type GlobeGlyphView, type PlacedGlobeGlyph } from '../render/globeGlyphs';
import { fantasyGlobeBase, releaseFantasyGlobeBase } from '../render/fantasy';
import type { LabelPick } from './mapPick';
import { AVOID_MS, measureAvoid, type Box } from './uiAvoid';
import type { GlobeTexRequest, GlobeTexResponse } from '../globeWorker';
import { fileBaseName } from '../gen/savefile';
import { currentWorld } from './saveStore';
import { createWheelReader, inGesturePinch, wheelSample } from './wheel';
import './globe.css';

const D = Math.PI / 180;

// ---------------------------------------------------------------------------
// 开关:平面主图 / 地球仪

export function getGlobeOn(): boolean {
  return getProjection() === 'globe';
}

/** 切到地球仪 / 切回上一个平面投影(网址由 App 写:proj=globe) */
export function setGlobeOn(on: boolean): void {
  if (on === getGlobeOn()) return;
  setProjection(on ? 'globe' : lastFlatProjection());
}

export function useGlobeOn(): boolean {
  return useProjection() === 'globe';
}

/** 导出的"地球仪这一面":PNG 图片、建议的文件名、像素尺寸 */
export interface GlobeExport {
  blob: Blob;
  name: string;
  w: number;
  h: number;
}

/** 开着的地球仪的导出函数(没开 = null) */
let globeExporter: (() => Promise<GlobeExport>) | null = null;

/**
 * 导出菜单用:把地球仪现在看到的这一面画成 PNG(两倍像素密度,长边不超过 3000;不带选中的记号,文字按导出的密度重排)。
 * 地球仪没开 = null。下载、提示由调用方负责
 */
export function exportGlobeView(): Promise<GlobeExport> | null {
  return globeExporter ? globeExporter() : null;
}

// ---------------------------------------------------------------------------

/** App 用:地球仪上的点选、平移 */
export interface GlobeApi {
  /** 屏幕坐标(clientX / clientY)→ 主图像素;不在球上 = null */
  pixelAt(cx: number, cy: number): [number, number] | null;
  /** 点到的城镇符号 / 国名 / 地名;没点到 = null */
  labelAt(cx: number, cy: number): LabelPick | null;
  /** 刚才那一下按下以后拖动过(拖过就不算单击) */
  dragged(): boolean;
  /**
   * 转到某经纬度(度;纬度不给 = 不变),约 0.6 秒。转到的地方落在球心 —— 宽屏上球心在侧栏卡片右边那一块的正中
   * (见 GlobeProps.leftRoom)
   */
  flyTo(lon: number, lat?: number): void;
  /** 视图中心的经度(度) */
  centerLon(): number;
  /** 回正:北在上、赤道居中、整个球(和双击一样;手指点两下时 App 调它) */
  reset(): void;
  /**
   * 以屏幕上 (cx, cy)(clientX / clientY)为中心缩放 f 倍(右下角的 + −、Safari 的触控板捏合);
   * live = 连着来的一串(捏合):按在动画,停下再画全分辨率
   */
  zoomBy(f: number, cx: number, cy: number, live?: boolean): void;
  /** 世界坐标(主图坐标,和 App 的 worldToClient 一样)→ 屏幕坐标(clientX / clientY);在球的背面(或贴着边缘)= null */
  worldToClient(wx: number, wy: number): [number, number] | null;
  /** 经纬度(度)→ 屏幕坐标(clientX / clientY);在球的背面(或贴着边缘)= null */
  lonLatToClient(lon: number, lat: number): [number, number] | null;
}

export interface GlobeProps {
  world: World;
  raster: Raster;
  /** 套上改名的 civ(城名、国名用) */
  civ: Civ | null;
  /**
   * 生成出来的原始 civ:文明贴图、矢量线只看地理和归属、不看名字,用它画(和主图的文明层共用国界、道路的缓存,
   * 改名时也不重画)。不给 = civ
   */
  geo?: Civ | null;
  style: 'realistic' | 'fantasy' | 'data';
  layer: LayerId;
  /** 主图上画好的地形画布(当前画风);terrainKey 变了 = 重画过 */
  terrain: HTMLCanvasElement | null;
  terrainKey: unknown;
  /** 正在回放世界形成:这一帧(等距圆柱 RGBA);不在回放 = null */
  replay: { w: number; h: number; frame: Uint8ClampedArray } | null;
  /** 打开时的中心经度(度;主图当前的中心) */
  startLon: number;
  apiRef: MutableRefObject<GlobeApi | null>;
  /** 悬停在球上的主图像素(离开 = null) */
  onHover: (p: [number, number] | null) => void;
  /** 左边被侧栏卡片挡住多宽(CSS 像素;没有 = 0):球心往右挪一半,落在剩下那一块的正中(宽度变了约 0.6 秒过渡) */
  leftRoom?: number;
  /** 右边被助手面板挡住多宽(同上,球心往左挪一半) */
  rightRoom?: number;
}

/** 调试 / 冒烟检查用 */
interface GlobeDebug {
  ready: boolean;
  renderer: 'webgl2' | 'cpu';
  gpu: string;
  /** 从打开到第一帧(带地形贴图)画出来 */
  openMs?: number;
  frames: number;
  /** 最近一帧:着色器 + 矢量线 + 符号文字层(主线程耗时) */
  frameMs: number;
  overlayMs: number;
  /** 最近一帧:矢量线描了多少个点;最近一次排文字的耗时、是不是快速档(只排大字) */
  lineVerts: number;
  placeMs: number;
  quick: boolean;
  /** 最近一次画文明贴图的耗时 */
  civMs: number;
  upload: Record<string, number>;
  civVer: number;
  selVer: number;
  /** 选中的描边 / 淡光有几个顶点(没有 = 0) */
  selVerts: number;
  /** 地形贴图:1 = 主图那张,2 = 两倍像素的高清那张 */
  tier: number;
  hiMs?: number;
  /** 起过几次高清贴图的后台线程;缓存着几张高清贴图 */
  hdStarted: number;
  hdCached: number;
  /** 正在后台画地形贴图(高清或地球仪专用的那张) */
  texPending: boolean;
  lon: number;
  lat: number;
  k: number;
  marks: number;
  labels: number;
  texts: string[];
  /** 放上去的地理名按种类数(海、山、河……;截图、冒烟检查用) */
  places: Record<string, number>;
  style: string;
  graticule: boolean;
  /** 回放帧盖上去的程度 0–1 */
  replay: number;
  /** 转动时的分辨率比例(慢的显卡上自动降低) */
  q: number;
  /**
   * 地形贴图是哪一种:globe = 地球仪专用(手绘不带山丘等符号、写实不打光 + 等效坡度),
   * main = 主图画好的那张(数据图层、CPU 画法)
   */
  tex: 'globe' | 'main';
  /** 写实风在着色器里按屏幕方向重新打光 */
  relief: boolean;
  /** 手绘符号:这一帧画了几个、挑选 + 画用了多少毫秒 */
  glyphs: number;
  glyphMs: number;
  /** 球心横向挪了多少(CSS 像素;国家面板打开时往左) */
  shift: number;
  /** 画地球仪专用地形贴图用了多少毫秒(手绘:主线程;写实:后台线程从起到画好) */
  texMs?: number;
  /** 起过几次画"主图那么大的写实地球仪贴图"的后台线程 */
  globeTexStarted: number;
}

/** 转动 / 拖时间轴停下来这么久(毫秒)以后,文字从"只排大字"换成排全部 */
const SETTLE_MS = 150;
/** 转动时手绘符号也只画第一级(全图就有的),停下来再补全 */
const GLYPH_QUICK = false;
/** 左边挡住的宽度变了,球心挪过去用多久(毫秒;和转到选中的国家一样长) */
const SHIFT_MS = 600;
/** 按下到松开移动不超过这么多(屏幕像素)算单击 */
const CLICK_SLOP = 5;
/** 点选符号的容差(CSS 像素) */
const PICK_SLOP = 9;
/** 事件标签等"钉在球上"的东西:朝向不到这么多(贴着球的边缘)就当看不见 */
const EDGE_D = 0.08;
/** 编年史高亮闪烁(和主图 CivLayer 的一样):约两秒,亮 → 暗 → 亮 → 暗 → 亮,最后淡出 */
const FLASH: [number, number][] = [
  [0, 0],
  [0.08, 1],
  [0.24, 0.3],
  [0.4, 1],
  [0.56, 0.3],
  [0.72, 1],
  [1, 0],
];
const FLASH_MS = 2200;
/** 高清贴图最多留几张(每张 4096×2048,约 32 MB;换画风再换回来不用重铺) */
const HD_CACHE = 3;

function flashAt(t: number): number {
  for (let i = 1; i < FLASH.length; i++) {
    const [t1, v1] = FLASH[i];
    if (t <= t1) {
      const [t0, v0] = FLASH[i - 1];
      const u = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    }
  }
  return 0;
}

/** 铺好的高清地形贴图(写实风另带一张等效坡度) */
interface HdTexture {
  bitmap: ImageBitmap;
  slope?: PixelSource;
}

/** 高清贴图按什么存:画风(数据图层再加上是哪一层) */
const hdKey = (p: { style: string; layer: string }) => (p.style === 'data' ? `data:${p.layer}` : p.style);

/** 画布 → RGBA 像素(CPU 画法用;先复制到一张单独的画布再读,不让主图画布降级成软件渲染) */
function readPixels(src: CanvasImageSource & { width: number; height: number }): RgbaImage | null {
  if (!src.width || !src.height) return null;
  const cv = document.createElement('canvas');
  cv.width = src.width;
  cv.height = src.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  cv.width = cv.height = 0;
  return { w: img.width, h: img.height, data: img.data };
}

/** 球上排字、放符号时要让开的界面(和球同在 .app 里;和平面主图同一份清单,见 uiAvoid.ts) */

/** 球上放好的符号 / 文字(CSS 像素,点选用) */
interface GlobePlaced {
  marks: { id: number; x: number; y: number; d: number; box: Box }[];
  labels: { pick: LabelPick; box: Box; text: string }[];
  /** 矢量线描了多少个点 */
  verts: number;
  /** 画手绘符号用了多少毫秒 */
  glyphMs: number;
}

/** 排好的文字 + 画的时候要用的视图(停着不动时直接重画,不重排) */
interface GlobePlacement {
  placed: Placement;
  lv: GlobeLabelView;
  facing: Map<number, number>;
  /** 按快速档排的(只排大字) */
  quick: boolean;
  ms: number;
}

interface OverlayInput {
  view: GlobeView;
  /** CSS 像素的画布大小 */
  w: number;
  h: number;
  dpr: number;
  style: 'realistic' | 'fantasy' | 'data';
  world: World;
  selection: SelectionTarget | null;
  /** 选中的城在哪(世界坐标;符号没放上去时按它画细环) */
  selWorld: [number, number] | null;
  /** CPU 画法:经纬网、手绘外框由这一层画 */
  cpuDecor: boolean;
  graticule: boolean;
  /** 矢量线(国界、道路、选中的描边),线宽按 unit(一个世界单位是几个 CSS 像素) */
  lines: GlobeLineStroke[];
  unit: number;
  /** 矢量线的不透明度(回放世界形成时和文明贴图一起淡出) */
  lineAlpha: number;
  /** 这一帧的文字排版(见 placeGlobeLabels);null = 不画字和符号 */
  placement: GlobePlacement | null;
  /** 球心横向挪了多少(CSS 像素) */
  shift: number;
  /** 手绘符号(山、丘陵……,每帧正立着画;贴图里带着符号时 = null),不透明度跟着矢量线 */
  glyphs: { set: GlobeGlyphSet; placed: PlacedGlobeGlyph[]; view: GlobeGlyphView } | null;
  /** 战事(战线的短齿、双剑每帧按画布像素画;战线本身在 lines 里);没开 / 不画 = null */
  war: CivDrawParams | null;
  /** 编年史高亮的描边、圆圈(不闪的时候 = null),alpha = 闪到多亮 */
  hl: { strokes: GlobeLineStroke[]; ring: { box: [number, number, number, number]; colors: [string, string, string] } | null; alpha: number } | null;
}

/** 排版要用的东西 */
interface PlaceInput {
  view: GlobeView;
  w: number;
  h: number;
  dpr: number;
  world: World;
  items: LabelItem[];
  marks: (LabelMark & SettlementMarkInfo)[];
  surface?: LabelView['surface'];
  reserved?: Box[];
  quick: boolean;
  shift: number;
}

/**
 * 标注的路径有没有一点落在球的正面、画布附近(背面的、屏幕外的不交给排版,省得每条都去投影、试摆法)。
 * 城名跟着自家符号走(符号没放上去名字也不放),这里不筛
 */
function onFront(it: LabelItem, lv: GlobeLabelView): boolean {
  if (it.mark !== undefined) return true;
  const p = it.path;
  const n = p.length >> 1;
  if (!n) return false;
  const cw = lv.canvasW ?? Infinity;
  const ch = lv.canvasH ?? Infinity;
  const slack = 80 * lv.dpr;
  const step = Math.max(1, Math.floor(n / 12));
  for (let i = 0; i < n; i += step) {
    const [x, y, d] = globeToCanvas(lv, p[2 * i], p[2 * i + 1]);
    if (d > 0.05 && x > -slack && y > -slack && x < cw + slack && y < ch + slack) return true;
  }
  const [x, y, d] = globeToCanvas(lv, p[2 * n - 2], p[2 * n - 1]);
  return d > 0.05 && x > -slack && y > -slack && x < cw + slack && y < ch + slack;
}

/**
 * 球上的文字排版:和平面主图同一套(placeMap),世界坐标按正射投影换成屏幕位置(render/globeLabels.ts)。
 * quick = 转动 / 拖时间轴时只排大字(国名、大洋和海、国都和大城的名字),停下来再排全部
 */
function placeGlobeLabels(o: PlaceInput): GlobePlacement {
  const t0 = performance.now();
  const lv = globeLabelView({ view: o.view, w: o.w, h: o.h, dpr: o.dpr, worldW: o.world.width, worldH: o.world.height, surface: o.surface, reserved: o.reserved, shift: o.shift });
  const vm = visibleMarks(o.marks, lv);
  const items = o.items.filter((it) => lv.k >= it.minZoom * 0.92 && (!o.quick || isQuickLabel(it)) && onFront(it, lv)).map(globePolityItem);
  const placed = placeMap(items, vm.marks, lv);
  return { placed, lv, facing: vm.facing, quick: o.quick, ms: performance.now() - t0 };
}

/**
 * 球上面那层 2D 画布:手绘符号(山、丘陵……)→ 矢量线(国界、道路、选中的描边)→(CPU 画法:经纬网、手绘外框)
 * → 选中的名字底下的光晕 → 城镇符号 → 文字(和平面主图一样:符号在地形里、线压在符号上、字在最上面)。
 * 返回放上去的东西(CSS 像素),点选用
 */
function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayInput): GlobePlaced {
  const { view, w, h, dpr, style } = o;
  const f = globeFrame(view, w, h, o.shift);
  const placed: GlobePlaced = { marks: [], labels: [], verts: 0, glyphMs: 0 };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // 1. 手绘符号:正立、按屏幕像素定大小;回放世界形成时和文明层一起淡出
  const gl = o.glyphs;
  if (gl && gl.placed.length && o.lineAlpha > 0.01) {
    const t0 = performance.now();
    drawGlobeGlyphs(ctx, gl.set, gl.placed, gl.view, o.lineAlpha);
    placed.glyphMs = performance.now() - t0;
  }
  // 2. 矢量线:按画布像素逐顶点投影,线宽不随缩放变;靠近球边缘的淡一点(符号在边缘本来就淡出了,一起乘也看不出来)
  const P = globeProjector(view, globeFrame(view, w * dpr, h * dpr, o.shift * dpr));
  if (o.lines.length && o.lineAlpha > 0.01) {
    ctx.globalAlpha = o.lineAlpha;
    placed.verts = strokeGlobeLines(ctx, P, o.lines, o.unit * dpr);
    // 战线朝守方的短齿
    if (o.war) drawGlobeWarTeeth(ctx, P, globeWarSet(warFront(o.war), o.world.width, o.world.height), o.unit * dpr, style);
    ctx.globalAlpha = 1;
  }
  // 编年史高亮:描边(线宽和国界一样按屏幕定)、事发地很小时外面套一个圆圈(按屏幕大小),不透明度跟着闪
  const hl = o.hl;
  if (hl) {
    ctx.globalAlpha = hl.alpha;
    placed.verts += strokeGlobeLines(ctx, P, hl.strokes, o.unit * dpr);
    if (hl.ring) drawHighlightRing(ctx, hl.ring.box, hl.ring.colors, P, o.world, dpr);
    ctx.globalAlpha = 1;
  }
  if ((o.lines.length && o.lineAlpha > 0.01) || gl?.placed.length || hl) fadeRim(ctx, P);
  // 战事的双剑:州治往右上挪一点,大小和线宽一样按 unit(放大以后不再变);背面、贴着球边缘的不画
  if (o.war && o.lineAlpha > 0.01) {
    const kEq = equivalentZoom(f.R, REF_MAP_CSS);
    const sh = swordHalf(o.unit * dpr, 1, dpr);
    const swords: { x: number; y: number; h: number; a: number }[] = [];
    for (const m of warMarkPoints(o.war, kEq >= ALL_FIGHTS_K)) {
      const [x, y, d] = globePoint(P, m.x, m.y, o.world.width, o.world.height);
      if (d < MARK_MIN_D) continue;
      swords.push({ x: x + 0.9 * sh, y: y - 0.9 * sh, h: sh, a: m.alpha * o.lineAlpha });
    }
    drawSwords(ctx, swords, style);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (o.cpuDecor) {
    if (o.graticule) {
      ctx.strokeStyle = style === 'fantasy' ? 'rgba(77,51,31,0.42)' : 'rgba(235,242,255,0.26)';
      ctx.lineWidth = 1;
      for (const l of graticuleLines(view, f, graticuleStep(view.k))) {
        ctx.beginPath();
        ctx.moveTo(l[0], l[1]);
        for (let i = 2; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]);
        ctx.stroke();
      }
    }
    if (style === 'fantasy') {
      ctx.strokeStyle = 'rgba(59,38,23,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, f.R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, f.R + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const pl = o.placement;
  if (!pl) return placed;
  // 3. 选中的名字底下的光晕、选中的城外一圈细环 → 城镇符号 → 文字(和主图文字层一样的顺序)
  const { lv } = pl;
  const sel = o.selection;
  let at: [number, number] | null = null;
  if (sel?.kind === 'settlement' && o.selWorld) {
    const [x, y, d] = globeToCanvas(lv, o.selWorld[0], o.selWorld[1]);
    if (d > 0) at = [x, y];
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSelectionLabels(ctx, pl.placed, lv, sel, style, at);
  drawSettlementMarks(ctx, pl.placed.marks, style);
  drawPlacedLabels(ctx, pl.placed.labels, lv, globeGlyphAlpha(lv));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 点选用:CSS 像素
  for (const m of pl.placed.marks) {
    const b = placedMarkBox(m);
    placed.marks.push({ id: m.mark.id, x: m.x / dpr, y: m.y / dpr, d: pl.facing.get(m.mark.id) ?? 1, box: [b[0] / dpr, b[1] / dpr, b[2] / dpr, b[3] / dpr] });
  }
  for (const l of pl.placed.labels) {
    if (!l.item.pick) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const g of l.glyphs) {
      const b = glyphBox(g, l.px, 0);
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    }
    placed.labels.push({ pick: l.item.pick, box: [x0 / dpr, y0 / dpr, x1 / dpr, y1 / dpr], text: l.item.text });
  }
  return placed;
}

/**
 * 编年史高亮:事发地(外框 box,世界坐标)在屏幕上很小时,外面套一个金色圆圈(和主图一样,整个球上也一眼找得到)。
 * 按屏幕大小画;在背面、或事发地够大(外框 × 等效缩放超过地图宽的 5%,同主图)就不画
 */
function drawHighlightRing(ctx: CanvasRenderingContext2D, box: [number, number, number, number], colors: [string, string, string], P: GlobeProjector, world: World, dpr: number) {
  const W = world.width;
  const [x0, y0, x1, y1] = box;
  const kEq = equivalentZoom(P.R / dpr, REF_MAP_CSS);
  if (Math.max(x1 - x0, y1 - y0) * kEq >= 0.05 * W) return;
  const [lon, lat] = worldToLonLat((x0 + x1) / 2, (y0 + y1) / 2, W, world.height);
  const cl = Math.cos(lat);
  const p = [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
  const d = p[0] * P.c[0] + p[1] * P.c[1] + p[2] * P.c[2];
  if (d < 0.1) return;
  const sx = P.cx + P.R * (p[0] * P.e[0] + p[1] * P.e[1] + p[2] * P.e[2]);
  const sy = P.cy - P.R * (p[0] * P.n[0] + p[1] * P.n[1] + p[2] * P.n[2]);
  const diag = Math.hypot(x1 - x0, y1 - y0) * ((2 * Math.PI * P.R) / W);
  const rad = Math.max(36 * dpr, diag / 2 + 18 * dpr);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, rad, 0, Math.PI * 2);
  ctx.strokeStyle = colors[0];
  ctx.lineWidth = 5 * dpr;
  ctx.stroke();
  ctx.shadowColor = colors[2];
  ctx.shadowBlur = 6 * dpr;
  ctx.strokeStyle = colors[1];
  ctx.lineWidth = 2.4 * dpr;
  ctx.stroke();
  ctx.restore();
}

/** 文明贴图、矢量线要用的参数(和主图文明层同一年、同样的开关;世界和文明对不上时 = null) */
function civParamsOf(p: { world: World; raster: Raster; civ: Civ | null; geo?: Civ | null; style: CivDrawParams['style']; show: CivShow }): CivDrawParams | null {
  const base = p.geo ?? p.civ;
  if (!p.civ || !base || base.habitat.suitability.length !== p.world.mesh.n || base.regions !== p.civ.regions) return null;
  const t = getCivTime();
  return { world: p.world, raster: p.raster, civ: base, style: p.style, year: t.year ?? base.endYear, show: p.show, fast: t.playing || t.scrubbing };
}

/**
 * "一个世界单位是几个 CSS 像素"(矢量线的线宽按它):平面主图同样缩放时的比例 ——
 * 缩到 1 倍以下跟着变细,放大到 1 倍以上不再变(线宽固定,放大后照样是细线)
 */
function lineUnit(view: GlobeView, w: number, h: number, W: number, shift: number): number {
  const kEq = equivalentZoom(globeFrame(view, w, h, shift).R, REF_MAP_CSS);
  const kEq1 = equivalentZoom(globeFrame({ ...view, k: 1 }, w, h, shift).R, REF_MAP_CSS);
  return (REF_MAP_CSS / W) * Math.min(kEq, kEq1);
}

/** 这一年的国界、道路 → 描法(线组按年份缓存,见 globeLines.ts) */
function civLineStrokes(cp: CivDrawParams | null): GlobeLineStroke[] {
  if (!cp) return [];
  const { world, civ, style } = cp;
  const out: GlobeLineStroke[] = [];
  if (cp.show.polities && civ.polities.length) {
    const sets = globeBorderSets(borderLines(cp, Layer.Polity), world.width, world.height, style === 'fantasy');
    out.push(...borderStrokes(sets, style));
    // 战事的战线压在国界上(短齿、双剑在 drawOverlay 里按画布像素画)
    if (warsShown(cp)) out.push(...warStrokes(globeWarSet(warFront(cp), world.width, world.height), style));
  }
  if (cp.show.routes && civ.routes.length) out.push(...routeStrokes(globeRouteSets(routeLines(world.mesh, civ, cp.year), world.width, world.height), style));
  return out;
}

/** 两组依赖是不是一样(逐个比引用) */
const sameKey = (a: readonly unknown[] | null, b: readonly unknown[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------

export function Globe({ world, raster, civ, geo, style, layer, terrain, terrainKey, replay, startLon, apiRef, onHover, leftRoom = 0, rightRoom = 0 }: GlobeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const [cpu, setCpu] = useState(false);
  // 经纬网:和平面投影共用一个开关(ui/projection.ts)
  const graticule = useGraticule();
  const [hiLoading, setHiLoading] = useState(false);
  const { sel } = useSelection();
  const hl = useCivHighlight();
  const show = useCivShow();

  /** 所有每帧要用的东西放在一个 ref 里(不触发 React 重新渲染) */
  const s = useRef({
    t0: performance.now(),
    view: clampView({ lon: startLon * D, lat: GLOBE_DEFAULT_LAT, k: 1 }) as GlobeView,
    size: { w: 0, h: 0, dpr: 1 },
    gl: null as GlobeGL | null,
    gpu: '',
    raf: 0,
    frames: 0,
    opened: false,
    fly: null as { from: GlobeView; to: GlobeView; t0: number; dur: number } | null,
    inertia: null as { vx: number; vy: number; t: number } | null,
    flash: null as { t0: number } | null,
    replayMix: 0,
    replayTarget: 0,
    drag: null as { id: number; x0: number; y0: number; x: number; y: number; t: number; vx: number; vy: number } | null,
    moved: false,
    /** 要让开的界面(相对球的根元素,CSS 像素)、上次量的时间 */
    avoid: [] as Box[],
    avoidAt: -1e9,
    pointers: new Map<number, { x: number; y: number }>(),
    pinch: null as { d: number; k: number } | null,
    uploaded: { terrainKey: undefined as unknown, civ: -1, sel: -1, hl: -1, replay: null as Uint8ClampedArray | null, water: null as Raster | null },
    /**
     * 自己画的文明贴图(国土色块,不含国界道路)、选中的罩染:画布、按什么画的(依赖变了才重画)、画过几次;
     * 选中的描边 / 淡光(矢量线组)
     */
    civTex: { canvas: null as HTMLCanvasElement | null, key: null as unknown[] | null, ver: 0, ms: 0 },
    selTex: { canvas: null as HTMLCanvasElement | null, key: null as unknown[] | null, ver: 0, lines: null as { kind: 'outline' | 'band'; set: GlobeLineSet; width: number } | null },
    /**
     * 编年史高亮:罩染(自己画的一张,不含描边)、描边(矢量线组,每帧按投影画,不透明度跟着闪)、
     * 事发地很小时外面套的圆圈(外框,世界坐标)
     */
    hlTex: {
      canvas: null as HTMLCanvasElement | null,
      key: null as unknown[] | null,
      strokes: [] as GlobeLineStroke[],
      ring: null as { box: [number, number, number, number]; colors: [string, string, string] } | null,
    },
    /** 最近一次文字排版(停着不动、只是重画时直接用)和它的依赖;最近一次在动(转动 / 拖时间轴)的时刻 */
    place: { key: null as unknown[] | null, pl: null as GlobePlacement | null },
    lastMove: -1e9,
    settle: 0,
    lineVerts: 0,
    /** 量每帧耗时时按"拖着转"算(见 __wfGlobeBench) */
    benchDrag: false,
    extras: { key: null as unknown[] | null, surface: undefined as LabelView['surface'] },
    tier: 1,
    /**
     * 高清贴图:这个世界里已经铺好的(按画风 / 图层存,缩回去、换画风再换回来都留着,换世界才扔)、
     * 正在铺的是哪一张、铺失败过的、一共起过几次后台线程
     */
    hd: { world: null as World | null, cache: new Map<string, HdTexture>(), pending: null as string | null, failed: new Set<string>(), started: 0 },
    /** 后台画好的、主图那么大的地球仪贴图(写实风;按画风存,换世界才扔)、画失败过的 */
    lo: { cache: new Map<string, HdTexture>(), failed: new Set<string>(), started: 0 },
    cpuSrc: { terrain: null as RgbaImage | null, civ: null as RgbaImage | null, sel: null as RgbaImage | null, replay: null as RgbaImage | null },
    cpuImg: null as ImageData | null,
    cpuIdle: 0,
    /** 滚轮 / 触控板(转动、缩放、捏合)最后一下的时刻:之后 SETTLE_MS 以内也算在动;停下后补画一帧的定时器 */
    wheelAt: -Infinity,
    wheelIdle: 0,
    /** 转动时的分辨率比例(按帧间隔自动调)、帧间隔的滑动平均、上一帧的时刻、上一帧是不是在动 */
    q: 1,
    frameEma: 16,
    lastTick: 0,
    lastBusy: false,
    placed: { marks: [], labels: [], verts: 0, glyphMs: 0 } as GlobePlaced,
    debug: { upload: {} as Record<string, number> },
    /**
     * 球心横向挪了多少(CSS 像素;宽屏往右挪侧栏卡片宽的一半)、正在往哪挪(约 0.6 秒,和转动一样的缓动)
     */
    shift: 0,
    shiftAnim: null as { from: number; to: number; t0: number; dur: number } | null,
    /** 地形贴图是哪一种(见 GlobeDebug.tex)、写实风要不要在着色器里打光、画地球仪专用贴图用了多少毫秒 */
    tex: 'main' as 'globe' | 'main',
    relief: false,
    texMs: undefined as number | undefined,
    /** 这一帧的手绘符号(挑选结果);挑选 + 画用了多少毫秒 */
    glyphs: null as OverlayInput['glyphs'],
    glyphMs: 0,
    /** 这一帧编年史高亮闪到多亮(0–1) */
    hlA: 0,
  }).current;

  // 最新的 props(帧回调里读)
  const props = useRef({ world, raster, civ, geo, style, layer, terrain, terrainKey, replay, graticule, sel, show, leftRoom, rightRoom, hl });
  props.current = { world, raster, civ, geo, style, layer, terrain, terrainKey, replay, graticule, sel, show, leftRoom, rightRoom, hl };

  /** 左边被侧栏卡片挡住的宽度(画布太窄就不让) */
  const leftOf = () => (s.size.w > 2 * props.current.leftRoom ? props.current.leftRoom : 0);
  /** 右边被助手面板挡住的宽度(App 只在窗口够宽、面板让位时给;剩下的地方太窄就不让) */
  const rightOf = () => (s.size.w - leftOf() - props.current.rightRoom >= s.size.w / 3 ? props.current.rightRoom : 0);
  /** 这一帧的球(w、h 是什么像素单位,unit = 一个 CSS 像素是几个那种像素:球心挪的量跟着换算) */
  const frameOf = (view: GlobeView, w: number, h: number, unit = 1) => globeFrame(view, w, h, s.shift * unit);

  const invalidate = () => {
    if (!s.raf) s.raf = requestAnimationFrame(tick);
  };

  // ---- 贴图 ----
  const uploadAll = () => {
    const p = props.current;
    const gl = s.gl;
    const up = s.debug.upload;
    if (s.uploaded.terrainKey !== p.terrainKey && p.terrain && p.terrain.width) {
      s.uploaded.terrainKey = p.terrainKey;
      // 换了世界:上一个世界后台画的贴图全部作废
      if (s.hd.world !== p.world) {
        for (const c of [s.hd.cache, s.lo.cache]) {
          for (const b of c.values()) b.bitmap.close();
          c.clear();
        }
        s.hd.failed.clear();
        s.lo.failed.clear();
        s.hd.world = p.world;
      }
      // 这个画风铺过高清的就直接用它,没有就先用主图那么大的(放大了再去铺)
      const hd = s.hd.cache.get(hdKey(p));
      s.tier = hd && gl ? 2 : 1;
      if (gl) {
        // 地球仪专用的地形贴图:手绘不带山丘等符号(每帧正立着画,这张在主线程画,几毫秒);
        // 写实不打光 + 坡度(着色器按屏幕方向打光;后台画好之前先用主图那张,见 maybeGlobeTex);数据图层直接用主图那张
        const lo = hd ? undefined : s.lo.cache.get(hdKey(p));
        const tex = hd ?? lo;
        let src: GlobeTexSource = p.terrain;
        let slope: PixelSource | null = null;
        let own = p.style === 'fantasy';
        if (tex) {
          src = tex.bitmap;
          slope = tex.slope ?? null;
          own = p.style !== 'data';
        } else if (p.style === 'fantasy') {
          const t0 = performance.now();
          src = fantasyGlobeBase(p.world, p.raster);
          s.texMs = performance.now() - t0;
        }
        s.tex = own ? 'globe' : 'main';
        s.relief = own && p.style === 'realistic';
        up.terrain = gl.upload('terrain', src);
        up.slope = gl.upload('slope', slope);
      } else {
        s.cpuSrc.terrain = readPixels(p.terrain);
        s.tex = 'main';
        s.relief = false;
      }
    }
    // 文明贴图:国土色块(不含国界、道路,那两样画成矢量线);年份、开关、画风变了才重画。
    // 手绘:停着的时候水彩按地球仪贴图的符号让位(林块按纬度拉宽过,山丘不在贴图里);
    // 回放 / 拖时间轴时和主图共用同一年算好的那份(省一次计算,高纬度林块上的让位略有错位,动着看不出)
    const cp = civParamsOf(p);
    const globeInk = !!cp && !cp.fast && s.tex === 'globe';
    const ck = cp ? [cp.world, cp.raster, cp.civ, cp.style, cp.year, cp.show, cp.fast, globeInk] : [p.world];
    if (!sameKey(s.civTex.key, ck)) {
      s.civTex.key = ck;
      const t0 = performance.now();
      let cv = s.civTex.canvas;
      if (cp) {
        if (!cv) cv = s.civTex.canvas = document.createElement('canvas');
        if (cv.width !== p.raster.w || cv.height !== p.raster.h) {
          cv.width = p.raster.w;
          cv.height = p.raster.h;
        }
        drawCivFill(cv.getContext('2d')!, { ...cp, globeInk });
      }
      s.civTex.ms = performance.now() - t0;
      s.civTex.ver++;
    }
    if (s.uploaded.civ !== s.civTex.ver) {
      s.uploaded.civ = s.civTex.ver;
      const src = cp ? s.civTex.canvas : null;
      if (gl) up.civ = gl.upload('civ', src);
      else s.cpuSrc.civ = src ? readPixels(src) : null;
    }
    // 选中的国家 / 州:罩染画在贴图里(回放 / 拖时间轴时国家的国土每 5 年才重画一次,和主图一样),描边是矢量线
    const sl = p.sel;
    const selYear = cp ? Math.floor(cp.year) - (cp.fast ? Math.floor(cp.year) % 5 : 0) : 0;
    const sk = cp && sl && sl.kind !== 'settlement' ? [cp.world, cp.raster, cp.civ, cp.style, sl.kind, sl.id, sl.kind === 'polity' ? selYear : 0] : [null];
    if (!sameKey(s.selTex.key, sk)) {
      s.selTex.key = sk;
      let cv = s.selTex.canvas;
      let lit = 0;
      if (cp && sl && sl.kind !== 'settlement') {
        if (sl.kind === 'polity' || sl.kind === 'region') {
          if (!cv) cv = s.selTex.canvas = document.createElement('canvas');
          if (cv.width !== p.raster.w || cv.height !== p.raster.h) {
            cv.width = p.raster.w;
            cv.height = p.raster.h;
          }
          lit = drawSelectionWash(cv.getContext('2d')!, cp.world, cp.raster, cp.civ, sl, selYear, cp.style);
        }
        const L = selectionLines(cp.world, cp.civ, sl, selYear);
        s.selTex.lines = L ? { kind: L.kind, set: buildLineSet(L.lines, cp.world.width, cp.world.height), width: L.kind === 'band' ? L.width : 0 } : null;
      } else s.selTex.lines = null;
      s.selTex.ver++;
      const src = lit && cv ? cv : null;
      if (gl) up.sel = gl.upload('sel', src);
      else s.cpuSrc.sel = src ? readPixels(src) : null;
    }
    // 编年史高亮:罩染画进贴图,描边、圆圈每帧按投影画成矢量(放大后锐利、两极不扁);点一次闪一次
    const hl = p.hl;
    const hk = cp && hl ? [hl.stamp, cp.civ, cp.style, cp.raster] : [null];
    if (!sameKey(s.hlTex.key, hk)) {
      s.hlTex.key = hk;
      let src: HTMLCanvasElement | null = null;
      s.hlTex.strokes = [];
      s.hlTex.ring = null;
      if (cp && hl) {
        let cv = s.hlTex.canvas;
        if (!cv) cv = s.hlTex.canvas = document.createElement('canvas');
        if (cv.width !== p.raster.w || cv.height !== p.raster.h) {
          cv.width = p.raster.w;
          cv.height = p.raster.h;
        }
        const marks = drawHighlight(cv.getContext('2d')!, cp.world, cp.raster, cp.civ, hl, cp.style, 1, null, true);
        if (marks.some((m) => m)) {
          src = cv;
          const { strokes, ring } = highlightStrokes(cp.world, cp.civ, hl, cp.style);
          const sets = new Map<unknown, GlobeLineSet>();
          for (const st of strokes) {
            let set = sets.get(st.lines);
            if (!set) sets.set(st.lines, (set = buildLineSet(st.lines, cp.world.width, cp.world.height)));
            s.hlTex.strokes.push({ sets: [set], color: st.color, width: st.width, blur: st.blur, glow: st.glow });
          }
          const box = highlightBox(cp.world, cp.civ, marks);
          if (box) s.hlTex.ring = { box, colors: ring };
          s.flash = { t0: performance.now() };
        }
      }
      if (gl) up.hl = gl.upload('hl', src);
    }
    const rp = p.replay;
    if (rp && s.uploaded.replay !== rp.frame) {
      s.uploaded.replay = rp.frame;
      if (gl) up.replay = gl.upload('replay', { w: rp.w, h: rp.h, data: rp.frame });
      else s.cpuSrc.replay = { w: rp.w, h: rp.h, data: rp.frame };
    }
    if (gl && s.uploaded.water !== p.raster) {
      s.uploaded.water = p.raster;
      const r = p.raster;
      const m = new Uint8Array(r.w * r.h);
      for (let i = 0; i < m.length; i++) m[i] = r.water[i] !== 0 && r.ice[i] < 0.5 ? 255 : 0;
      up.water = gl.upload('water', { w: r.w, h: r.h, data: m, gray: true });
    }
  };

  // ---- 后台线程画的地形贴图 ----
  //   - 高清(两倍像素):放大到 1.5 倍以上、主图那张不够清楚时(见 render/globe.ts 的 wantHdTexture)
  //   - 写实风的地球仪贴图(主图那么大):不打光的底色 + 坡度要把整张图的明暗重算一遍(约 0.3 秒),
  //     打开地球仪时先用主图那张(烤好了明暗,地球仪正中看和重新打光的几乎一样),后台画好了再换上,打开时不卡
  /** 起一个后台线程画 scale 倍像素的地形贴图;画好了留着,还是这个画风(高清:还没换上别的高清)就换上 */
  const texWorker = (scale: 1 | 2) => {
    const p = props.current;
    const key = hdKey(p);
    const world = p.world;
    s.hd.pending = `${key}@${scale}`;
    if (scale === 2) s.hd.started++;
    else s.lo.started++;
    if (scale === 2) setHiLoading(true);
    const t0 = performance.now();
    const wk = new Worker(new URL('../globeWorker.ts', import.meta.url), { type: 'module' });
    const done = () => {
      wk.terminate();
      s.hd.pending = null;
      if (scale === 2) setHiLoading(false);
    };
    const fail = scale === 2 ? s.hd.failed : s.lo.failed;
    wk.onmessage = (e: MessageEvent<GlobeTexResponse>) => {
      done();
      const r = e.data;
      if (!r.ok) {
        fail.add(key);
        console.warn('地球仪的地形贴图没画出来:', r.error);
        return;
      }
      // 画的这段时间里换了世界(或地球仪关了):作废
      if (s.hd.world !== world || !s.gl) {
        r.bitmap.close();
        return;
      }
      // 留着(换画风再换回来不用重画);超过 HD_CACHE 张扔掉最早的
      const tex: HdTexture = { bitmap: r.bitmap, slope: r.slope ? { w: r.slope.w, h: r.slope.h, data: r.slope.data, raw: true } : undefined };
      const cache = scale === 2 ? s.hd.cache : s.lo.cache;
      cache.set(key, tex);
      while (cache.size > HD_CACHE) {
        const [k0, b0] = cache.entries().next().value as [string, HdTexture];
        if (k0 === key) break;
        b0.bitmap.close();
        cache.delete(k0);
      }
      if (scale === 2) (s as { hiMs?: number }).hiMs = performance.now() - t0;
      else s.texMs = performance.now() - t0;
      // 还是这个画风:马上换上(主图那么大的那张只在没换上高清的时候换);画的这段时间里换了画风:先留着,换回来再用
      if (hdKey(props.current) === key && (scale === 2 || s.tier === 1)) {
        const up = s.debug.upload;
        up[scale === 2 ? 'terrainHi' : 'terrainGlobe'] = s.gl.upload('terrain', tex.bitmap);
        up[scale === 2 ? 'slopeHi' : 'slopeGlobe'] = s.gl.upload('slope', tex.slope ?? null);
        s.tier = scale;
        s.tex = props.current.style === 'data' ? 'main' : 'globe';
        s.relief = props.current.style === 'realistic';
      }
      invalidate();
    };
    wk.onerror = () => {
      done();
      fail.add(key);
    };
    const req: GlobeTexRequest = { world: p.world, style: p.style, layer: p.layer, scale };
    wk.postMessage(req);
  };
  /** 放大到 1.5 倍以上、主图那张不够清楚时,后台线程按两倍像素重铺一张 */
  const maybeHiRes = () => {
    const gl = s.gl;
    const p = props.current;
    if (!gl || !p.terrain || s.hd.world !== p.world) return;
    const key = hdKey(p);
    const { w, h, dpr } = s.size;
    const f = frameOf(s.view, w, h);
    const want = wantHdTexture({
      k: s.view.k,
      texel: (2 * Math.PI * f.R * dpr) / p.terrain.width,
      have: s.hd.cache.has(key),
      pending: s.hd.pending !== null,
      failed: s.hd.failed.has(key),
      replaying: !!p.replay,
      maxTexture: gl.maxTextureSize,
      hdWidth: p.terrain.width * 2,
    });
    if (want) texWorker(2);
  };
  /** 写实风:还在用主图那张(烤好了明暗)时,后台画地球仪用的那张(不打光 + 坡度) */
  const maybeGlobeTex = () => {
    const p = props.current;
    if (!s.gl || p.style !== 'realistic' || s.tex === 'globe' || s.hd.world !== p.world || s.hd.pending !== null || p.replay) return;
    const key = hdKey(p);
    if (s.lo.cache.has(key) || s.lo.failed.has(key)) return;
    texWorker(1);
  };

  // ---- 球上面那层:矢量线 + 文字排版 ----
  /** 地面查询(海名在水上、山名在陆上……;河道蒙版用细格子,放大很多时紧挨着河的河名也放得上):每个世界算一份 */
  const surfaceOf = (): LabelView['surface'] => {
    const p = props.current;
    const k = [p.world, p.raster];
    if (!sameKey(s.extras.key, k)) {
      s.extras.key = k;
      s.extras.surface = labelSurface(p.world, p.raster, 1);
    }
    return s.extras.surface;
  };
  /** 选中的国家 / 州的描边、大河 / 山脉的淡光(和主图选中层同样的颜色,线宽按屏幕) */
  const selStrokes = (w: number, h: number): GlobeLineStroke[] => {
    const L = s.selTex.lines;
    if (!L) return [];
    const look = selectionLook(props.current.style);
    const kEq = equivalentZoom(frameOf(s.view, w, h).R, REF_MAP_CSS);
    const kEq1 = equivalentZoom(frameOf({ ...s.view, k: 1 }, w, h).R, REF_MAP_CSS);
    const thin = 1 / Math.sqrt(Math.max(1, Math.min(kEq, kEq1)));
    if (L.kind === 'band') return [{ sets: [L.set], color: look.band, width: L.width * thin, blur: 8 * thin }];
    return [
      { sets: [L.set], color: look.line[0], width: 4.2 * thin },
      { sets: [L.set], color: look.line[1], width: 1.8 * thin },
    ];
  };
  /**
   * 这一帧球上面那层画什么:矢量线(国界、道路、选中的描边)+ 文字排版。
   * cache = true:视图、文字数据都没变时用上次排好的(停着不动时的重画、闪烁高亮时不重排)
   */
  const overlayInput = (w: number, h: number, dpr: number, quick: boolean, reserved: Box[], cache: boolean): OverlayInput => {
    const p = props.current;
    const cp = civParamsOf(p);
    const feed = getCivFeed();
    const items = feed.fontsOk ? feed.places.concat(feed.layer?.items ?? []) : [];
    const marks = feed.layer?.marks ?? [];
    let pl: GlobePlacement | null = null;
    if (p.civ && (items.length || marks.length)) {
      const key = [s.view.lon, s.view.lat, s.view.k, s.shift, w, h, dpr, feed.layer, feed.places, feed.fontsOk, p.style, p.world, quick, reserved.join(',')];
      if (cache && sameKey(s.place.key, key)) pl = s.place.pl;
      else {
        pl = placeGlobeLabels({ view: s.view, w, h, dpr, world: p.world, items, marks, surface: surfaceOf(), reserved, quick, shift: s.shift });
        if (cache) {
          s.place.key = key;
          s.place.pl = pl;
        }
      }
    }
    // 手绘符号:地形贴图不带符号时每帧正立着画(按画布像素)
    let glyphs: OverlayInput['glyphs'] = null;
    if (s.tex === 'globe' && p.style === 'fantasy') {
      const t0 = performance.now();
      const set = globeGlyphSet(p.world);
      const f = frameOf(s.view, w, h);
      const gv: GlobeGlyphView = {
        P: globeProjector(s.view, frameOf(s.view, w * dpr, h * dpr, dpr)),
        kEq: equivalentZoom(f.R, REF_MAP_CSS),
        unit: (2 * Math.PI * f.R * dpr) / p.world.width,
        quick: quick && GLYPH_QUICK,
      };
      glyphs = { set, placed: placeGlobeGlyphs(set, gv), view: gv };
      s.glyphMs = performance.now() - t0;
    }
    const sl = p.sel;
    const st = sl?.kind === 'settlement' ? p.civ?.settlements[sl.id] : undefined;
    return {
      view: s.view,
      w,
      h,
      dpr,
      style: p.style,
      world: p.world,
      selection: sl,
      selWorld: st ? [p.world.mesh.x[st.cell], p.world.mesh.y[st.cell]] : null,
      cpuDecor: !s.gl,
      graticule: p.graticule,
      lines: civLineStrokes(cp).concat(selStrokes(w, h)),
      unit: lineUnit(s.view, w, h, p.world.width, s.shift),
      lineAlpha: 1 - s.replayMix,
      war: cp && warsShown(cp) ? cp : null,
      hl: s.hlA > 0.001 && (s.hlTex.strokes.length || s.hlTex.ring) ? { strokes: s.hlTex.strokes, ring: s.hlTex.ring, alpha: s.hlA } : null,
      placement: pl,
      shift: s.shift,
      glyphs,
    };
  };

  // ---- 每一帧 ----
  const tick = (now: number) => {
    s.raf = 0;
    const cvs = glRef.current;
    const ov = ovRef.current;
    if (!cvs || !ov || !s.size.w) return;
    const t0 = performance.now();
    let more = false;
    if (s.fly) {
      const t = Math.min(1, (now - s.fly.t0) / s.fly.dur);
      const e = 1 - (1 - t) ** 3;
      s.view = clampView(lerpView(s.fly.from, s.fly.to, e));
      if (t < 1) more = true;
      else s.fly = null;
    } else if (s.inertia) {
      const dt = Math.min(50, now - s.inertia.t);
      s.inertia.t = now;
      const decay = Math.exp(-dt / 320);
      s.inertia.vx *= decay;
      s.inertia.vy *= decay;
      const R = frameOf(s.view, s.size.w, s.size.h).R;
      s.view = dragView(s.view, R, s.inertia.vx * dt, s.inertia.vy * dt);
      if (Math.hypot(s.inertia.vx, s.inertia.vy) > 0.01) more = true;
      else s.inertia = null;
    }
    const p = props.current;
    // 宽屏:球心往右挪侧栏卡片宽的一半(右边开着助手面板再往左挪它的一半),落在两边中间那一块的正中;
    // 卡片宽度变了(窗口拉宽拉窄、开关面板)就挪过去,和转到选中的国家同样的时长、缓动。窄屏不挪
    const shiftTo = (leftOf() - rightOf()) / 2;
    if (!s.frames) {
      // 打开地球仪时面板已经开着:直接在挪好的位置上画第一帧
      s.shift = shiftTo;
      s.shiftAnim = null;
    } else if ((s.shiftAnim ? s.shiftAnim.to : s.shift) !== shiftTo) s.shiftAnim = { from: s.shift, to: shiftTo, t0: now, dur: SHIFT_MS };
    if (s.shiftAnim) {
      const t = Math.min(1, Math.max(0, (now - s.shiftAnim.t0) / s.shiftAnim.dur));
      s.shift = s.shiftAnim.from + (s.shiftAnim.to - s.shiftAnim.from) * (1 - (1 - t) ** 3);
      if (t < 1) more = true;
      else s.shiftAnim = null;
    }
    s.replayTarget = p.replay ? 1 : 0;
    if (s.replayMix !== s.replayTarget) {
      s.replayMix = s.replayTarget > s.replayMix ? Math.min(1, s.replayMix + 0.06) : Math.max(0, s.replayMix - 0.06);
      more = true;
    }
    // 贴图先换上(编年史高亮在这里开始闪)
    uploadAll();
    let hlA = 0;
    if (s.flash) {
      const t = (now - s.flash.t0) / FLASH_MS;
      if (t >= 1) s.flash = null;
      else {
        hlA = flashAt(Math.max(0, t));
        more = true;
      }
    }
    s.hlA = hlA;
    const look: GlobeLook = { style: p.style, relief: s.relief, graticule: p.graticule, hl: hlA, replay: s.replayMix };
    const { w, h, dpr } = s.size;
    const busy = !!(s.drag || s.fly || s.inertia || s.pinch || s.shiftAnim) || now - s.wheelAt < SETTLE_MS;
    // 中心经度和弹层里的"中央经线"、平面地图互通:停下来时记下正对着的经度(转动中不记,免得整页跟着重排)
    if (!busy) {
      const lon = (((s.view.lon / D + 180) % 360) + 360) % 360 - 180;
      if (Math.abs(lon - getMapCenter()) > 0.01) publishMapCenter(lon);
    }
    if (s.gl) {
      // 转动时按实际帧间隔调分辨率:慢的显卡(或软件渲染)上也跟手;停下来再按全分辨率画一遍
      // (很慢的机器上一帧要几百毫秒,也照样算进去;停过一秒以上的不算)
      if (busy && s.lastBusy && now - s.lastTick < 1000) {
        s.frameEma = s.frameEma * 0.7 + Math.min(120, now - s.lastTick) * 0.3;
        if (s.frameEma > 28 && s.q > 0.4) s.q = Math.max(0.4, s.q * 0.8);
        else if (s.frameEma < 18 && s.q < 1) s.q = Math.min(1, s.q * 1.1);
      }
      const q = busy ? s.q : 1;
      const cw = Math.max(1, Math.round(w * dpr * q));
      const ch = Math.max(1, Math.round(h * dpr * q));
      if (cvs.width !== cw || cvs.height !== ch) {
        cvs.width = cw;
        cvs.height = ch;
      }
      s.gl.render(s.view, frameOf(s.view, cw, ch, dpr * q), dpr * q, look);
    } else {
      // CPU:动着的时候降一半分辨率,停下来再画一遍全分辨率
      const q = busy ? 0.5 : 1;
      const cw = Math.max(1, Math.round(w * dpr * q));
      const ch = Math.max(1, Math.round(h * dpr * q));
      if (cvs.width !== cw || cvs.height !== ch) {
        cvs.width = cw;
        cvs.height = ch;
      }
      const ctx = cvs.getContext('2d');
      if (ctx) {
        if (!s.cpuImg || s.cpuImg.width !== cw || s.cpuImg.height !== ch) s.cpuImg = ctx.createImageData(cw, ch);
        const img = s.cpuImg;
        renderGlobeCpu({ w: cw, h: ch, data: img.data }, s.view, frameOf(s.view, cw, ch, dpr * q), look, {
          terrain: s.cpuSrc.terrain,
          civ: s.cpuSrc.civ,
          sel: s.cpuSrc.sel,
          replay: s.replayMix > 0 ? s.cpuSrc.replay : null,
        });
        ctx.putImageData(img, 0, 0);
      }
      window.clearTimeout(s.cpuIdle);
      if (busy) s.cpuIdle = window.setTimeout(invalidate, 180);
    }
    s.lastTick = now;
    s.lastBusy = busy;
    const t1 = performance.now();
    const octx = ov.getContext('2d')!;
    // 地图上的按钮、时间轴、面板、提示下面不放字和符号(AVOID_UI;每 AVOID_MS 量一次)
    const root = rootRef.current;
    if (root && now - s.avoidAt > AVOID_MS) {
      s.avoidAt = now;
      const rr = root.getBoundingClientRect();
      s.avoid = measureAvoid(root.closest('.app')).map((b) => [b[0] - rr.left, b[1] - rr.top, b[2] - rr.left, b[3] - rr.top]);
    }
    const reserved: Box[] = [...s.avoid];
    // 在动(转动、拖时间轴、文明回放):文字只排大字;停下 SETTLE_MS 以后再排全部
    const ct = getCivTime();
    const moving = busy || s.benchDrag || ct.playing || ct.scrubbing;
    if (moving) s.lastMove = now;
    const quick = now - s.lastMove < SETTLE_MS;
    window.clearTimeout(s.settle);
    if (quick && !moving) s.settle = window.setTimeout(invalidate, SETTLE_MS - (now - s.lastMove) + 8);
    const oi = overlayInput(w, h, dpr, quick, reserved, true);
    s.placed = drawOverlay(octx, oi);
    s.lineVerts = s.placed.verts;
    s.glyphs = oi.glyphs;
    const t2 = performance.now();
    s.frames++;
    if (!s.opened && s.uploaded.terrainKey !== undefined) {
      s.opened = true;
      (s as { openMs?: number }).openMs = t2 - s.t0;
    }
    const places: Record<string, number> = {};
    const civNow = p.civ;
    for (const l of s.placed.labels) {
      if (l.pick.kind !== 'place' || !civNow?.places[l.pick.id]) continue;
      const kind = civNow.places[l.pick.id].kind;
      places[kind] = (places[kind] ?? 0) + 1;
    }
    const dbg: GlobeDebug = {
      ready: s.opened,
      renderer: s.gl ? 'webgl2' : 'cpu',
      gpu: s.gpu,
      openMs: (s as { openMs?: number }).openMs,
      frames: s.frames,
      frameMs: t2 - t0,
      overlayMs: t2 - t1,
      lineVerts: s.lineVerts,
      placeMs: s.place.pl?.ms ?? 0,
      quick: !!s.place.pl?.quick,
      civMs: s.civTex.ms,
      upload: { ...s.debug.upload },
      civVer: s.civTex.ver,
      selVer: s.selTex.ver,
      selVerts: s.selTex.lines?.set.vertices ?? 0,
      tier: s.tier,
      hiMs: (s as { hiMs?: number }).hiMs,
      hdStarted: s.hd.started,
      globeTexStarted: s.lo.started,
      hdCached: s.hd.cache.size,
      texPending: !!s.hd.pending,
      lon: s.view.lon / D,
      lat: s.view.lat / D,
      k: s.view.k,
      marks: s.placed.marks.length,
      labels: s.placed.labels.length,
      texts: s.placed.labels.map((l) => l.text),
      places,
      style: p.style,
      graticule: p.graticule,
      replay: s.replayMix,
      q: s.q,
      tex: s.tex,
      relief: s.relief,
      glyphs: s.glyphs?.placed.length ?? 0,
      glyphMs: s.glyphMs + s.placed.glyphMs,
      shift: s.shift,
      texMs: s.texMs,
    };
    (window as unknown as { __wfGlobe: GlobeDebug }).__wfGlobe = dbg;
    if (!busy) {
      maybeHiRes();
      maybeGlobeTex();
    }
    if (more) invalidate();
  };

  // ---- 建立画法、画布大小 ----
  useLayoutEffect(() => {
    const cvs = glRef.current;
    const root = rootRef.current;
    if (!cvs || !root) return;
    const forceCpu = new URLSearchParams(location.search).get('globe') === 'cpu';
    const gl = forceCpu ? null : GlobeGL.create(cvs);
    s.gl = gl;
    setCpu(!gl);
    if (gl) {
      const ext = gl.gl.getExtension('WEBGL_debug_renderer_info');
      s.gpu = String(ext ? gl.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.gl.getParameter(gl.gl.RENDERER));
      cvs.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        gl.lost = true;
      });
      cvs.addEventListener('webglcontextrestored', () => {
        // 显卡重置:重新建一个(贴图全部重新上传)
        s.gl = GlobeGL.create(cvs);
        s.uploaded = { terrainKey: undefined, civ: -1, sel: -1, hl: -1, replay: null, water: null };
        s.selTex.key = null;
        s.hlTex.key = null;
        setCpu(!s.gl);
        invalidate();
      });
    }
    const resize = () => {
      const r = root.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      s.size = { w: r.width, h: r.height, dpr };
      const ov = ovRef.current!;
      const W = Math.max(1, Math.round(r.width * dpr));
      const H = Math.max(1, Math.round(r.height * dpr));
      if (s.gl) {
        cvs.width = W;
        cvs.height = H;
      }
      ov.width = W;
      ov.height = H;
      invalidate();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      window.clearTimeout(s.cpuIdle);
      window.clearTimeout(s.wheelIdle);
      s.gl?.dispose();
      for (const c of [s.hd.cache, s.lo.cache]) {
        for (const b of c.values()) b.bitmap.close();
        c.clear();
      }
      s.gl = null;
      // 地球仪专用的手绘地形贴图(主线程那份)不再留着
      releaseFantasyGlobeBase();
      const w = window as unknown as { __wfGlobe?: GlobeDebug };
      delete w.__wfGlobe;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 贴图来源、开关变了:下一帧上传、重画
  useEffect(invalidate, [terrain, terrainKey, replay, raster, graticule, style, civ, geo, sel, show, leftRoom, rightRoom, hl]);
  useEffect(() => subscribeCivFeed(invalidate), []);
  // 时间轴一动:文明贴图、国界道路的矢量线换成那一年的
  useEffect(() => subscribeCivTime(invalidate), []);

  // ---- 编年史点一条:事发地不在球的正面中间,就把球转过去(走短边) ----
  const hlStamp = hl?.stamp;
  useEffect(() => {
    if (!hl || !civ || civ.regions.of.length !== world.mesh.n) return;
    const b = highlightBox(world, civ, highlightMarks(civ, hl));
    if (!b) return;
    const [lon, lat] = worldToLonLat((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, world.width, world.height);
    const { w, h } = s.size;
    const f = frameOf(s.view, w, h);
    const [x, y, d] = lonLatToScreen(s.view, f, lon, lat);
    // 左边被侧栏卡片、右边被助手面板挡住的那一截不算看得见
    if (d > 0.55 && x > 60 + leftOf() && x < w - 60 - rightOf() && y > 60 && y < h - 90) return;
    s.inertia = null;
    s.fly = { from: s.view, to: clampView({ lon, lat: lat * 0.85, k: s.view.k }), t0: performance.now(), dur: 650 };
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlStamp]);

  // ---- App 用的接口 ----
  const local = (cx: number, cy: number): [number, number] | null => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? [cx - r.left, cy - r.top] : null;
  };
  const labelAt = (cx: number, cy: number): LabelPick | null => {
    const q = local(cx, cy);
    if (!q) return null;
    const [x, y] = q;
    const m = pickGlobeMark(s.placed.marks, x, y, PICK_SLOP);
    let best: LabelPick | null = null;
    let bestD = Infinity;
    if (m >= 0) {
      best = { kind: 'settlement', id: s.placed.marks[m].id };
      bestD = Math.hypot(s.placed.marks[m].x - x, s.placed.marks[m].y - y);
    }
    for (const l of s.placed.labels) {
      const b = l.box;
      if (x < b[0] - 3 || x > b[2] + 3 || y < b[1] - 3 || y > b[3] + 3) continue;
      const d = Math.hypot(x - (b[0] + b[2]) / 2, y - (b[1] + b[3]) / 2);
      if (d < bestD) {
        bestD = d;
        best = l.pick;
      }
    }
    return best;
  };
  const pixelAt = (cx: number, cy: number): [number, number] | null => {
    const q = local(cx, cy);
    if (!q) return null;
    const r = props.current.raster;
    return screenToPixel(s.view, frameOf(s.view, s.size.w, s.size.h), q[0], q[1], r.w, r.h);
  };
  /** 经纬度(弧度)→ 屏幕坐标(clientX / clientY);背面、贴着球的边缘(朝向不到 EDGE_D)= null */
  const llToClient = (lon: number, lat: number): [number, number] | null => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || !s.size.w) return null;
    const [x, y, d] = lonLatToScreen(s.view, frameOf(s.view, s.size.w, s.size.h), lon, lat);
    return d > EDGE_D ? [r.left + x, r.top + y] : null;
  };
  const worldToClient = (wx: number, wy: number): [number, number] | null => {
    const W = props.current.world;
    const [lon, lat] = worldToLonLat(wx, wy, W.width, W.height);
    return llToClient(lon, lat);
  };
  const flyTo = (lonDeg: number, latDeg?: number, k?: number, dur = 600) => {
    s.inertia = null;
    s.fly = {
      from: s.view,
      to: clampView({ lon: lonDeg * D, lat: latDeg === undefined ? s.view.lat : latDeg * D, k: k ?? s.view.k }),
      t0: performance.now(),
      dur,
    };
    invalidate();
  };
  apiRef.current = {
    pixelAt,
    labelAt,
    dragged: () => s.moved,
    flyTo: (lon, lat) => flyTo(lon, lat),
    centerLon: () => s.view.lon / D,
    reset: () => reset(),
    zoomBy: (f, cx, cy, live) => zoomBy(f, cx, cy, live),
    worldToClient,
    lonLatToClient: (lon, lat) => llToClient(lon * D, lat * D),
  };
  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [apiRef],
  );

  // 截图脚本、冒烟检查用
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__wfGlobeSet = (lon: number, lat: number, k?: number) => {
      s.fly = null;
      s.inertia = null;
      s.view = clampView({ lon: lon * D, lat: lat * D, k: k ?? s.view.k });
      invalidate();
    };
    /** 世界坐标 → 屏幕坐标 [clientX, clientY, 朝向](朝向 ≤ 0 = 在背面) */
    w.__wfGlobeWorldToClient = (wx: number, wy: number): [number, number, number] | null => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return null;
      const W = props.current.world;
      const [lon, lat] = worldToLonLat(wx, wy, W.width, W.height);
      const [x, y, d] = lonLatToScreen(s.view, frameOf(s.view, s.size.w, s.size.h), lon, lat);
      return [r.left + x, r.top + y, d];
    };
    /** 选中球上写着这个名字的东西(截图、冒烟检查用);没有 = false */
    w.__wfGlobeSelectName = (text: string): boolean => {
      const l = s.placed.labels.find((x) => x.text === text);
      if (!l) return false;
      setSelection(l.pick);
      return true;
    };
    /** 放上去的城镇符号(屏幕坐标) */
    w.__wfGlobeMarks = () => {
      const r = rootRef.current?.getBoundingClientRect();
      const civ = props.current.civ;
      return r ? s.placed.marks.map((m) => ({ id: m.id, name: civ?.settlements[m.id]?.name ?? '', x: r.left + m.x, y: r.top + m.y, d: m.d })) : [];
    };
    /**
     * 量每帧耗时:转 n 帧,每帧等显卡画完(读回一个像素 —— 浏览器的 gl.finish 不一定真的等),返回毫秒。
     * drag = true:按"拖着转"算(文字只排大字,和真拖动时一样;显卡按全分辨率画);默认每帧都排全部文字(最慢的情况)。
     * 另外给出球上面那层(矢量线 + 文字)的耗时、其中排文字的耗时、矢量线描了多少个点(都是中位数)
     */
    w.__wfGlobeBench = (n = 60, drag = false) => {
      const out: number[] = [];
      const ov: number[] = [];
      const pm: number[] = [];
      const lv: number[] = [];
      const v0 = s.view;
      const px = new Uint8Array(4);
      s.benchDrag = drag;
      for (let i = 0; i < n; i++) {
        s.view = clampView({ ...v0, lon: v0.lon + i * 0.02 });
        const t = performance.now();
        tick(performance.now());
        const g = s.gl?.gl;
        g?.readPixels(g.drawingBufferWidth >> 1, g.drawingBufferHeight >> 1, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
        out.push(performance.now() - t);
        const d = (window as unknown as { __wfGlobe: GlobeDebug }).__wfGlobe;
        ov.push(d.overlayMs);
        pm.push(d.placeMs);
        lv.push(d.lineVerts);
      }
      s.benchDrag = false;
      s.lastMove = -1e9;
      s.view = v0;
      invalidate();
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      out.sort((a, b) => a - b);
      return {
        n,
        median: out[n >> 1],
        p90: out[Math.floor(n * 0.9)],
        max: out[n - 1],
        overlay: med(ov),
        place: med(pm),
        lineVerts: med(lv),
        drag,
        renderer: s.gl ? 'webgl2' : 'cpu',
        w: s.size.w,
        h: s.size.h,
        dpr: s.size.dpr,
      };
    };
    return () => {
      for (const k of ['__wfGlobeSet', '__wfGlobeWorldToClient', '__wfGlobeMarks', '__wfGlobeBench', '__wfGlobeSelectName']) delete w[k];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 拖动、缩放 ----
  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const q = local(e.clientX, e.clientY);
    if (!q) return;
    s.pointers.set(e.pointerId, { x: q[0], y: q[1] });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    s.fly = null;
    s.inertia = null;
    if (s.pointers.size === 2) {
      const [a, b] = [...s.pointers.values()];
      s.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: s.view.k };
      s.drag = null;
      s.moved = true;
      return;
    }
    s.drag = { id: e.pointerId, x0: q[0], y0: q[1], x: q[0], y: q[1], t: performance.now(), vx: 0, vy: 0 };
    s.moved = false;
    onHover(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const q = local(e.clientX, e.clientY);
    if (!q) return;
    const [x, y] = q;
    if (s.pointers.has(e.pointerId)) s.pointers.set(e.pointerId, { x, y });
    if (s.pinch && s.pointers.size >= 2) {
      const [a, b] = [...s.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (s.pinch.d > 0) s.view = zoomAt(s.view, s.size.w, s.size.h, (a.x + b.x) / 2, (a.y + b.y) / 2, (s.pinch.k * d) / s.pinch.d, s.shift);
      invalidate();
      return;
    }
    const dr = s.drag;
    if (dr && dr.id === e.pointerId) {
      const now = performance.now();
      const dx = x - dr.x;
      const dy = y - dr.y;
      if (Math.abs(x - dr.x0) + Math.abs(y - dr.y0) > CLICK_SLOP) s.moved = true;
      if (!s.moved) return;
      const R = frameOf(s.view, s.size.w, s.size.h).R;
      s.view = dragView(s.view, R, dx, dy);
      const dt = Math.max(1, now - dr.t);
      // 速度(像素 / 毫秒)做一点平滑,松手时的惯性按它
      dr.vx = dr.vx * 0.6 + (dx / dt) * 0.4;
      dr.vy = dr.vy * 0.6 + (dy / dt) * 0.4;
      dr.x = x;
      dr.y = y;
      dr.t = now;
      invalidate();
      return;
    }
    if (s.pointers.size) return;
    // 悬停:主图像素交给 App 写悬停信息;在符号 / 字上显示手指
    const r = props.current.raster;
    onHover(screenToPixel(s.view, frameOf(s.view, s.size.w, s.size.h), x, y, r.w, r.h));
    if (rootRef.current) rootRef.current.style.cursor = labelAt(e.clientX, e.clientY) ? 'pointer' : '';
  };
  const onPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    s.pointers.delete(e.pointerId);
    if (s.pinch) {
      if (s.pointers.size >= 2) {
        // 第三根手指松开:按剩下的两根接着捏合
        const [a, b] = [...s.pointers.values()];
        s.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: s.view.k };
      } else {
        s.pinch = null;
        // 捏合完还剩一根手指:接着单指转动
        const [id] = [...s.pointers.keys()];
        const q = id !== undefined ? s.pointers.get(id) : undefined;
        if (q) s.drag = { id, x0: q.x, y0: q.y, x: q.x, y: q.y, t: performance.now(), vx: 0, vy: 0 };
      }
      return;
    }
    const dr = s.drag;
    if (!dr || dr.id !== e.pointerId) return;
    s.drag = null;
    // 停了一会儿才松手:不甩
    if (s.moved && performance.now() - dr.t < 80 && Math.hypot(dr.vx, dr.vy) > 0.05) s.inertia = { vx: dr.vx, vy: dr.vy, t: performance.now() };
    invalidate();
  };
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // 鼠标滚轮 / 捏合 = 缩放,触控板两指滑动 = 转动(方向和滑动网页一样;怎么分见 wheel.ts)
    const read = createWheelReader();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Safari 的捏合 App 按 gesture 事件交给 zoomBy 了
      if (e.ctrlKey && inGesturePinch()) return;
      const a = read(wheelSample(e));
      if (!a) return;
      if (a.kind === 'zoom') return zoomBy(a.f, e.clientX, e.clientY, true);
      s.fly = null;
      s.inertia = null;
      s.view = dragView(s.view, frameOf(s.view, s.size.w, s.size.h).R, -a.dx, -a.dy);
      hoverRef.current(null);
      wheeled();
      invalidate();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 回正:北在上、赤道居中、整个球 */
  const reset = () => flyTo(s.view.lon / D, 0, 1, 700);
  /**
   * 滚轮 / 触控板一下:接下来按"在动"画(低分辨率、文字只排大字、先不记中心经度),
   * 停下 SETTLE_MS 后补画一帧全分辨率的
   */
  const wheeled = () => {
    s.wheelAt = performance.now();
    window.clearTimeout(s.wheelIdle);
    s.wheelIdle = window.setTimeout(invalidate, SETTLE_MS + 10);
  };
  /** 以屏幕上 (cx, cy)(clientX / clientY)为中心缩放 f 倍;live = 滚轮、捏合这类连着来的(按在动画) */
  const zoomBy = (f: number, cx: number, cy: number, live = false) => {
    const el = rootRef.current;
    if (!el || !(f > 0) || !Number.isFinite(f)) return;
    const r = el.getBoundingClientRect();
    s.fly = null;
    s.inertia = null;
    const k2 = Math.min(GLOBE_K_MAX, Math.max(GLOBE_K_MIN, s.view.k * f));
    s.view = zoomAt(s.view, s.size.w, s.size.h, cx - r.left, cy - r.top, k2, s.shift);
    if (live) wheeled();
    invalidate();
  };

  // ---- 导出当前视图(导出菜单里的"导出地球仪这一面",见 exportGlobeView) ----
  const exportView = async (): Promise<GlobeExport> => {
    const cvs = glRef.current;
    const p = props.current;
    if (!cvs) throw new Error('地球仪还没画出来');
    try {
      const { w, h } = s.size;
      // 按两倍像素密度导出(长边不超过 3000 像素)
      const sc = Math.min(2, 3000 / Math.max(w, h));
      const W = Math.round(w * sc);
      const H = Math.round(h * sc);
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const octx = out.getContext('2d')!;
      const look: GlobeLook = { style: p.style, relief: s.relief, graticule: p.graticule, hl: 0, replay: s.replayMix };
      if (s.gl) {
        const ow = cvs.width;
        const oh = cvs.height;
        cvs.width = W;
        cvs.height = H;
        s.gl.render(s.view, frameOf(s.view, W, H, sc), sc, look);
        octx.drawImage(cvs, 0, 0);
        cvs.width = ow;
        cvs.height = oh;
      } else {
        const img = octx.createImageData(W, H);
        renderGlobeCpu({ w: W, h: H, data: img.data }, s.view, frameOf(s.view, W, H, sc), look, { ...s.cpuSrc, replay: s.replayMix > 0 ? s.cpuSrc.replay : null });
        octx.putImageData(img, 0, 0);
      }
      const ov = document.createElement('canvas');
      ov.width = W;
      ov.height = H;
      // 导出的图不带选中的记号;文字按导出的像素密度重新排一遍(排全部)
      drawOverlay(ov.getContext('2d')!, { ...overlayInput(w, h, sc, false, [], false), selection: null, selWorld: null, lines: civLineStrokes(civParamsOf(p)) });
      octx.drawImage(ov, 0, 0);
      ov.width = ov.height = 0;
      // 文件名在编码之前定下:编码要一会儿,这期间换了年份、打开了别的世界,名字照样对得上画出来的这一张
      const civ = p.civ;
      const year = civ ? Math.floor(Math.max(0, Math.min(civ.endYear, getCivTime().year ?? civ.endYear))) : 0;
      const styleName = p.style === 'realistic' ? '写实' : p.style === 'fantasy' ? '手绘' : '数据图层';
      const name = `${fileBaseName({ title: currentWorld()?.title, seed: p.world.params.seed })}-第${year}年-地球仪-${styleName}.png`;
      const blob = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('图片太大,浏览器编码不了'))), 'image/png'));
      out.width = out.height = 0;
      (window as unknown as { __wfGlobeExport: unknown }).__wfGlobeExport = { name, w: W, h: H, bytes: blob.size };
      return { blob, name, w: W, h: H };
    } finally {
      invalidate();
    }
  };
  const exportRef = useRef(exportView);
  exportRef.current = exportView;
  useEffect(() => {
    const f = () => exportRef.current();
    globeExporter = f;
    return () => {
      if (globeExporter === f) globeExporter = null;
    };
  }, []);

  // ---- 状态用顶部提示条:没有 WebGL2(改用 CPU 画);高清贴图加载得慢(超过 1 秒才提示,快的时候不打扰) ----
  useEffect(() => {
    if (!cpu) return;
    showToast({ id: 'globe-cpu', kind: 'info', text: '地球仪改用兼容画法,转动会慢一些', ttl: 6000 });
    return () => clearToast('globe-cpu');
  }, [cpu]);
  useEffect(() => {
    if (!hiLoading) return;
    const t = window.setTimeout(() => showToast({ id: 'globe-hd', kind: 'progress', text: '正在加载高清贴图' }), 1000);
    return () => {
      window.clearTimeout(t);
      clearToast('globe-hd');
    };
  }, [hiLoading]);

  return (
    <div
      ref={rootRef}
      className={`globe globe-${style}`}
      style={{ background: GLOBE_BG[style], ['--globe-bg' as string]: GLOBE_BG[style] }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => onHover(null)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        reset();
      }}
    >
      <canvas ref={glRef} className="globe-gl" />
      <canvas ref={ovRef} className="globe-overlay" />
    </div>
  );
}
