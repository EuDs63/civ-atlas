/**
 * 文明骨架的三种显示:宜居度热力图、州界细线、城址圆点。两种画风各有一套配色。
 * 由世界数据推出来的几何(平滑后的州界、热力场)按 civ 缓存,切画风 / 开关时不重算。
 */
import type { Raster } from '../../gen/raster';
import type { Civ } from '../../gen/civ/types';
import type { Mesh } from '../../gen/mesh';
import { boxBlurWrap, wrapShifts } from '../common';
import { relShifts, reprojectImage } from '../projection';
import { addToPath, chaikin, meshWrap, traceBoundaries, type Polyline } from './lines';
import type { CivDrawParams, CivStyle } from './overlay';

type RGB = [number, number, number];

/** 宜居分到多少算"满格"(热力图最深色);约等于最好的 5% 地块 */
export const HABITAT_FULL = 28;
/** 宜居分低于这个值的地块算"不可居",热力图不上色、不画城址 */
export const HABITABLE_MIN = 1;

/**
 * 热力图色带:由浅到深、越深越宜居(写实:黄 → 橙 → 赭红;手绘:淡赭 → 朱砂)。
 * 不透明度也随宜居度升高:贫瘠之地几乎不上色,地形、山峰树林符号照样看得清。
 */
export const HABITAT_RAMP: Record<'realistic' | 'fantasy', RGB[]> = {
  realistic: [
    [255, 233, 150],
    [253, 174, 75],
    [227, 90, 26],
    [160, 30, 12],
  ],
  fantasy: [
    [246, 222, 170],
    [232, 170, 105],
    [206, 96, 52],
    [150, 42, 24],
  ],
};

const rampKey = (style: CivStyle) => (style === 'fantasy' ? 'fantasy' : 'realistic');

function rampAt(stops: RGB[], t: number): RGB {
  const f = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const u = f - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// ---- 缓存 ----
interface Cache {
  field?: { raster: Raster; v: Float32Array };
  lines?: Polyline[];
  sites?: { cell: number; r: number }[];
}
const caches = new WeakMap<Civ, Cache>();
const cacheOf = (civ: Civ) => {
  let c = caches.get(civ);
  if (!c) caches.set(civ, (c = {}));
  return c;
};

/** 每个像素的宜居分:按地块取值再做一次"只在陆地上平均"的模糊,抹掉地块的多边形边 */
function habitatField(civ: Civ, r: Raster): Float32Array {
  const c = cacheOf(civ);
  if (c.field && c.field.raster === r) return c.field.v;
  const { w, h, cell } = r;
  const N = w * h;
  const num = new Float32Array(N);
  const den = new Float32Array(N);
  const suit = civ.habitat.suitability;
  const of = civ.regions.of;
  for (let k = 0; k < N; k++) {
    const i = cell[k];
    if (of[i] < 0) continue; // 水
    num[k] = suit[i];
    den[k] = 1;
  }
  const rad = Math.max(1, Math.round(3 * r.scale));
  // 主图东西相连:列下标取模,左右接缝处接得上
  boxBlurWrap(num, w, h, rad);
  boxBlurWrap(num, w, h, rad);
  boxBlurWrap(den, w, h, rad);
  boxBlurWrap(den, w, h, rad);
  for (let k = 0; k < N; k++) num[k] = den[k] > 0.02 ? num[k] / den[k] : 0;
  c.field = { raster: r, v: num };
  return num;
}

export function drawHabitat(ctx: CanvasRenderingContext2D, p: CivDrawParams) {
  const { raster: r, civ, style } = p;
  const v = habitatField(civ, r);
  const { w, h, water } = r;
  const stops = HABITAT_RAMP[rampKey(style)];
  const fantasy = style === 'fantasy';
  const img = ctx.createImageData(w, h);
  const d = img.data;
  // 预先算好 256 级色表
  const LUT = 256;
  const lut = new Uint8ClampedArray(LUT * 4);
  for (let i = 0; i < LUT; i++) {
    const t = i / (LUT - 1);
    const c = rampAt(stops, t);
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    // 越宜居越浓;手绘风稍淡一点,像纸上薄薄一层水彩
    lut[i * 4 + 3] = 255 * (fantasy ? 0.12 + 0.56 * Math.pow(t, 0.85) : 0.14 + 0.66 * Math.pow(t, 0.85));
  }
  for (let k = 0; k < w * h; k++) {
    if (water[k] !== 0) continue;
    const s = v[k];
    if (s <= 0.05) continue;
    const li = Math.min(LUT - 1, Math.round((s / HABITAT_FULL) * (LUT - 1)));
    // 宜居分 0 → 1 之间淡入:不可居的冰原、荒漠腹地保持原貌
    const fade = s >= HABITABLE_MIN ? 1 : (s - 0.05) / (HABITABLE_MIN - 0.05);
    const o = k * 4;
    d[o] = lut[li * 4];
    d[o + 1] = lut[li * 4 + 1];
    d[o + 2] = lut[li * 4 + 2];
    d[o + 3] = lut[li * 4 + 3] * fade;
  }
  if (p.proj) {
    // 弯边投影:先放进一张等距圆柱的离屏画布,再按投影一行一行铺过来
    const tmp =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    (tmp.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
    reprojectImage(ctx, tmp, w, h, p.proj.mp, { s: r.scale, ox: 0, oy: 0 });
    tmp.width = tmp.height = 0;
    return;
  }
  // putImageData 会覆盖而不是叠加:它是这一层最先画的,所以直接写
  ctx.putImageData(img, 0, 0);
}

/** 平滑后的州界折线(世界坐标) */
export function regionLines(mesh: Mesh, civ: Civ): Polyline[] {
  const c = cacheOf(civ);
  if (!c.lines) c.lines = traceBoundaries(mesh, civ.regions.of).map((l) => chaikin(l, 3));
  return c.lines;
}

export function drawRegionLines(ctx: CanvasRenderingContext2D, p: CivDrawParams) {
  const S = p.raster.scale;
  const path = new Path2D();
  addToPath(path, regionLines(p.world.mesh, p.civ), S, meshWrap(p.world.mesh), p.proj);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.style === 'fantasy') {
    // 墨色点划线,像旧地图上的州县界
    ctx.setLineDash([3.2 * S, 2.4 * S]);
    ctx.strokeStyle = 'rgba(70,50,36,0.5)';
    ctx.lineWidth = 0.9 * S;
    ctx.stroke(path);
  } else {
    // 写实:先描一道很淡的暗边,再描一道半透明的亮线 —— 雪地、沙漠上也看得清
    ctx.strokeStyle = p.style === 'data' ? 'rgba(20,20,20,0.35)' : 'rgba(20,16,10,0.22)';
    ctx.lineWidth = 2 * S;
    ctx.stroke(path);
    ctx.strokeStyle = p.style === 'data' ? 'rgba(255,255,255,0.7)' : 'rgba(255,250,240,0.62)';
    ctx.lineWidth = 0.8 * S;
    ctx.stroke(path);
  }
  ctx.restore();
}

/** 城址:每州治所,按州的人口上限定大小(不可居的州不画) */
function sites(civ: Civ): { cell: number; r: number }[] {
  const c = cacheOf(civ);
  if (c.sites) return c.sites;
  const { regions, habitat } = civ;
  const list: { cell: number; cap: number }[] = [];
  for (let r = 0; r < regions.count; r++) {
    const s = regions.seat[r];
    if (habitat.suitability[s] < HABITABLE_MIN) continue;
    list.push({ cell: s, cap: regions.capacity[r] });
  }
  list.sort((a, b) => b.cap - a.cap || a.cell - b.cell);
  const top = list.length ? list[Math.min(list.length - 1, Math.floor(list.length * 0.02))].cap : 1;
  c.sites = list.map((e) => ({ cell: e.cell, r: 1.1 + 1.9 * Math.sqrt(Math.min(1, e.cap / Math.max(1e-6, top))) }));
  return c.sites;
}

export function drawSites(ctx: CanvasRenderingContext2D, p: CivDrawParams) {
  const S = p.raster.scale;
  const { x, y } = p.world.mesh;
  const list = sites(p.civ);
  ctx.save();
  const halo = new Path2D();
  const dot = new Path2D();
  const wrap = meshWrap(p.world.mesh);
  const pj = p.proj;
  for (const e of list) {
    // 弯边投影:画在投影后的位置上(挨着 ±180° 的在另一边再画一份);等距圆柱:挨着左右边的城址(东西相连)在另一边再画一份
    const rel = pj ? pj.rel(x[e.cell]) : 0;
    const K = pj ? pj.K(y[e.cell]) : 0;
    for (const sh of pj ? relShifts(rel, 6 / Math.max(1e-6, K)) : wrapShifts(x[e.cell], x[e.cell], wrap, 4)) {
      const px = pj ? (pj.W / 2 + K * (rel + sh)) * S : (x[e.cell] + sh) * S;
      const py = pj ? pj.Y(y[e.cell]) * S : y[e.cell] * S;
      const rr = e.r * S;
      halo.moveTo(px + rr + 0.9 * S, py);
      halo.arc(px, py, rr + 0.9 * S, 0, Math.PI * 2);
      dot.moveTo(px + rr, py);
      dot.arc(px, py, rr, 0, Math.PI * 2);
    }
  }
  if (p.style === 'fantasy') {
    ctx.fillStyle = 'rgba(244,234,210,0.9)';
    ctx.fill(halo);
    ctx.fillStyle = 'rgba(62,40,28,0.92)';
    ctx.fill(dot);
  } else {
    ctx.fillStyle = 'rgba(25,18,12,0.72)';
    ctx.fill(halo);
    ctx.fillStyle = 'rgba(255,252,244,0.96)';
    ctx.fill(dot);
  }
  ctx.restore();
}
