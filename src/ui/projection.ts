/**
 * 主图的投影设置(界面状态)+ 把一层画布按投影铺到屏幕上。
 *
 * - getProjection / useProjection / setProjection:主图用哪种投影('equirect' 等距圆柱、'robinson' 罗宾森……,
 *   见 render/projection.ts);'globe' = 3D 地球仪视图(ui/Globe.tsx;平面地图藏在下面、按等距圆柱画,地球仪借它的画布当贴图)。
 *   地图右下角"地球仪 / 平面地图"按钮 = 切到 globe / 切回上一个平面投影(lastFlatProjection)。
 * - 中央经线用 mapWrap.ts 的 getMapCenter / useMapCenter / requestMapCenter(所有投影共用同一个中心):
 *   等距圆柱里拖到哪哪是中心;弯边投影里左右拖动、滑条、"设为中心"改它,整图按新中心重投影。
 * - getGraticule / useGraticule / setGraticule:经纬网图层开没开。
 * - useMapMoving:弯边投影里正在拖动中心(拖动时国名先按世界坐标拟合的摆法投过去,停下来再按投影后的国土重新拟合)。
 * - ProjLayer:一层"和世界一样大"的画布(地形、文明底图、选中、高亮、回放帧)在弯边投影下的做法 ——
 *   先画在离屏的等距圆柱原图上,再按投影铺到显示的画布上;只改中心时不重画原图,只重铺(几毫秒)。
 *   拖动中心时用它(快);停下来以后地形、文明层按投影重画(presentTerrain、CivLayer:线逐点投影,符号正立),
 *   数据图层、回放帧这样的"面"一直用它。
 */
import { useSyncExternalStore } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import { doubleCanvas, drawProjected, isProjectionId, mapProj, pageColor, type MapProj, type ProjectionId } from '../render/projection';
import { drawTerrainProjected, type DetailStyle } from '../render/detail';
import { releaseFantasyProjCaches } from '../render/fantasy';
import { releaseWashScratch } from '../render/civ/territory';

export { pageColor };

/** 主图的投影;'globe' = 3D 地球仪(单独的视图) */
export type MapProjection = ProjectionId | 'globe';

/** 地球仪视图可用("图层与投影"弹层的投影里列"地球仪";网址、存档里的 globe 照样打开) */
export const GLOBE_READY = true;

export function isMapProjection(x: unknown): x is MapProjection {
  return x === 'globe' || isProjectionId(x);
}

/** 平面地图用哪种投影画:地球仪时底下的平面地图按等距圆柱画 */
export function flatProjection(p: MapProjection): ProjectionId {
  return p === 'globe' ? 'equirect' : p;
}

/** 弯边(非等距圆柱)的平面投影:整图重投影、左右拖动改中心 */
export function isCurved(p: MapProjection): p is Exclude<ProjectionId, 'equirect'> {
  return p !== 'equirect' && p !== 'globe';
}

/** 当前投影 + 中心 → 地图平面(弯边投影才有;等距圆柱 = null,照原来的办法画) */
export function curvedProj(p: MapProjection, lon0: number, W: number, H: number): MapProj | null {
  return isCurved(p) ? mapProj(p, lon0, W, H) : null;
}

// ---------------------------------------------------------------------------
// 小 store

function store<T>(init: T) {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (x: T) => {
      if (Object.is(x, v)) return;
      v = x;
      for (const f of subs) f();
    },
    use: () =>
      useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => v,
        () => v,
      ),
  };
}

const projection = store<MapProjection>('equirect');
export const getProjection = projection.get;
export const useProjection = projection.use;
/** 切到地球仪之前用的平面投影(从地球仪切回平面时回到它) */
let lastFlat: ProjectionId = 'equirect';
/** flat:连"上一个平面投影"一起指定(换回原来的地球仪时,把它原来的平面投影也还原) */
export function setProjection(p: MapProjection, flat?: ProjectionId): void {
  const cur = projection.get();
  if (cur !== 'globe') lastFlat = cur;
  if (flat) lastFlat = flat;
  projection.set(isMapProjection(p) ? p : 'equirect');
}
/** 上一个平面投影(现在就是平面的 = 它自己) */
export function lastFlatProjection(): ProjectionId {
  const cur = projection.get();
  return cur === 'globe' ? lastFlat : cur;
}

/** 经纬网:平面投影和地球仪共用一个开关("图层与投影"弹层里的"经纬网"改它;网址 grat=1) */
const graticule = store(false);
export const getGraticule = graticule.get;
export const useGraticule = graticule.use;
export const setGraticule = graticule.set;

const moving = store(false);
export const getMapMoving = moving.get;
export const useMapMoving = moving.use;
export const setMapMoving = moving.set;

// ---------------------------------------------------------------------------
// 一层画布按投影铺到屏幕上

/** 弯边投影时外轮廓外面铺什么颜色(null = 透明) */
export type PageFill = string | null;

export class ProjLayer {
  private src: HTMLCanvasElement | null = null;
  /** 原图是别人的(地形图的缓存):release 时不释放它 */
  private borrowed = false;
  private dbl: HTMLCanvasElement | null = null;
  private dirty = true;
  /** 最近一次铺到显示画布上的投影(同一个投影、原图没变就不重铺) */
  private shown = '';

  /**
   * 离屏的等距圆柱原图(w × h;按需创建,大小变了就换)。
   * keepShown:只是预先备好原图(拖动时再用),显示的画布上按投影重画的那一版照样有效
   */
  source(w: number, h: number, keepShown = false): HTMLCanvasElement {
    let c = this.borrowed ? null : this.src;
    if (!c) {
      c = this.src = document.createElement('canvas');
      this.borrowed = false;
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    if (keepShown) this.dirty = true;
    else this.touch();
    return c;
  }

  /** 用现成的画布当原图(地形图的缓存;换了一张才重新接两份) */
  use(src: HTMLCanvasElement): void {
    if (this.src === src) return;
    if (this.src && !this.borrowed) this.src.width = this.src.height = 0;
    this.src = src;
    this.borrowed = true;
    this.touch();
  }

  /** 原图有了新内容(下次铺时重新接两份) */
  touch(): void {
    this.dirty = true;
    this.shown = '';
  }

  /** 原图在不在(画过没有) */
  has(): boolean {
    return !!this.src && this.src.width > 0;
  }

  /**
   * 按投影铺到显示画布(和原图一样大)上;返回用了多少毫秒。
   * force = false 时,同一个投影、原图没变就不重铺
   */
  present(dst: HTMLCanvasElement, mp: MapProj, fill: PageFill = null, force = false): number {
    const src = this.src;
    if (!src || !src.width) return 0;
    const key = `${mp.key}|${fill}`;
    if (!force && !this.dirty && key === this.shown && dst.width === src.width) return 0;
    const t0 = performance.now();
    if (this.dirty || !this.dbl) {
      this.dbl = doubleCanvas(src, this.dbl ?? document.createElement('canvas'));
      this.dirty = false;
    }
    if (dst.width !== src.width || dst.height !== src.height) {
      dst.width = src.width;
      dst.height = src.height;
    }
    const ctx = dst.getContext('2d');
    if (!ctx) return 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, dst.width, dst.height);
    } else ctx.clearRect(0, 0, dst.width, dst.height);
    drawProjected(ctx, this.dbl, src.width, src.height, mp, dst.width, dst.height);
    this.shown = key;
    return performance.now() - t0;
  }

  /**
   * 按投影重画(不是整图重投影):画布设成 w × h、铺底色,调 draw 画。
   * key 相同、原图没变(没 touch 过)就不重画;之后再 present(整图重投影)会重铺
   */
  redraw(dst: HTMLCanvasElement, w: number, h: number, key: string, fill: PageFill, draw: (ctx: CanvasRenderingContext2D) => void, force = false): number {
    const k = `redraw|${key}|${fill}`;
    if (!force && k === this.shown && dst.width === w && dst.height === h) return 0;
    const t0 = performance.now();
    if (dst.width !== w || dst.height !== h) {
      dst.width = w;
      dst.height = h;
    }
    const ctx = dst.getContext('2d');
    if (!ctx) return 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
    } else ctx.clearRect(0, 0, w, h);
    draw(ctx);
    this.shown = k;
    return performance.now() - t0;
  }

  /** release 时顺带要做的事(地形图那一层:释放按投影重画的缓存,见 presentTerrain) */
  onRelease: (() => void) | null = null;

  /** 释放离屏画布的显存(回到等距圆柱时) */
  release(): void {
    this.onRelease?.();
    if (this.src && !this.borrowed) this.src.width = this.src.height = 0;
    if (this.dbl) this.dbl.width = this.dbl.height = 0;
    this.src = this.dbl = null;
    this.dirty = true;
    this.shown = '';
  }
}

// ---------------------------------------------------------------------------
// 地形图在弯边投影下怎么画

/**
 * 弯边投影下的地形图(canvas,和世界一样大 = 地图平面):
 * - 手绘 / 写实、没在拖动中心:按投影重画(render/detail.ts 的 drawTerrainProjected)—— 面按行重投影,
 *   海岸墨线、河逐点投影(线宽处处一致),山、树林符号在投影后的位置上正立、按屏幕大小画;
 * - 数据图层,或者正在左右拖动中心:把等距圆柱的整张地形图(src,符号、河都在里面)整图重投影 ——
 *   拖动时每帧只要几毫秒,停下来再按投影重画。
 * layer = 地形图的 ProjLayer(记着原图和画布上现在是哪一版)。返回用了多少毫秒
 */
export function presentTerrain(
  cv: HTMLCanvasElement,
  mp: MapProj,
  o: { world: World; raster: Raster; style: string; src: HTMLCanvasElement; layer: ProjLayer; moving: boolean },
): number {
  const { world, raster, style, layer } = o;
  layer.use(o.src);
  layer.onRelease = releaseCurvedCaches;
  if ((style !== 'fantasy' && style !== 'realistic') || o.moving) return layer.present(cv, mp, pageColor(style));
  return layer.redraw(cv, raster.w, raster.h, mp.key, pageColor(style), (ctx) =>
    drawTerrainProjected(ctx, world, raster, style as DetailStyle, mp, { s: raster.scale, ox: 0, oy: 0, k: 1 }),
  );
}

/** 回到等距圆柱:按投影重画用的缓存(投影后的符号层、文明层让位遮罩、合成用的草稿画布……)都扔掉 */
function releaseCurvedCaches(): void {
  releaseFantasyProjCaches();
  releaseWashScratch();
}
