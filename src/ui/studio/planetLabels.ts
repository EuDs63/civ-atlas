/**
 * 新建界面星球上的地名(海、山、河、湖、岛,和平常的地图同一套排版 render/labels):
 * 星球停住时排一次、画在盖着它的一张 2D 画布上;一动(变形、自转、拖动)就藏起来,停下来再排。
 *
 *   地球仪     正射投影(render/globeLabels.ts),球心、半径用星球自己的
 *   平面投影   按 mapProj 投到地图平面,再按星球的姿势放大挪到屏幕上
 *
 * 字号、出现的门槛按图在屏幕上有多大算(和平常的地图一样:图越小,只放越大的名字)。
 */
import type { World } from '../../gen/world';
import { drawPlacedLabels, placeMap, type LabelItem, type LabelView } from '../../render/labels/draw';
import { globeGlyphAlpha, globeLabelView, globeToCanvas, type GlobeLabelView } from '../../render/globeLabels';
import { labelProjection, mapProj } from '../../render/projection';
import type { StillPose } from './scene';

/** 球背面的、离画布太远的不交给排版(省得每条都去试摆法) */
function onFront(it: LabelItem, lv: GlobeLabelView): boolean {
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

/** 在 cv 上按 pose 排、画地名(画布铺满视口);返回放上去几条 */
export function drawPlanetLabels(cv: HTMLCanvasElement, items: readonly LabelItem[], pose: StillPose, world: World, surface: LabelView['surface'], dpr: number): number {
  const cw = Math.max(1, Math.round(pose.w * dpr));
  const ch = Math.max(1, Math.round(pose.h * dpr));
  if (cv.width !== cw || cv.height !== ch) {
    cv.width = cw;
    cv.height = ch;
  }
  const ctx = cv.getContext('2d');
  if (!ctx) return 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!items.length) return 0;
  const W = world.width;
  const H = world.height;
  if (pose.proj === 'globe') {
    const lv = globeLabelView({
      view: { lon: pose.lon, lat: pose.lat, k: 1 },
      w: pose.w,
      h: pose.h,
      dpr,
      worldW: W,
      worldH: H,
      surface,
      frame: { cx: pose.cx, cy: pose.cy, R: pose.k },
    });
    const placed = placeMap(
      items.filter((it) => onFront(it, lv)),
      [],
      lv,
    );
    drawPlacedLabels(ctx, placed.labels, lv, globeGlyphAlpha(lv));
    return placed.labels.length;
  }
  // 平面:地图平面(W × H,mapProj)→ 屏幕:投影平面 1 单位 = pose.k 像素 = mp.s 个地图平面单位
  const mp = mapProj(pose.proj, (pose.lon * 180) / Math.PI, W, H);
  const r = pose.k / mp.s;
  const lv: LabelView = {
    scale: r * dpr,
    ox: (pose.cx - (r * W) / 2) * dpr,
    oy: (pose.cy - (r * H) / 2) * dpr,
    dpr,
    k: 1,
    mapCss: W * r,
    worldW: W,
    worldH: H,
    surface,
    margin: 6,
    canvasW: cw,
    canvasH: ch,
    wrap: 0,
    frameLeft: 0,
    reserved: [],
    proj: labelProjection(mp),
  };
  const placed = placeMap(items.slice(), [], lv);
  drawPlacedLabels(ctx, placed.labels, lv);
  return placed.labels.length;
}
