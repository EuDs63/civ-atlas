/**
 * 放大后的地形细节层(canvas.detail,在地形图之上、文明层之下的屏幕层里,见 mapWrap.ts 的"屏幕层"):
 * 放大到 DETAIL_K 倍以上时,把视口附近那一块按屏幕像素重画(render/detail.ts)——
 * 手绘风的符号逐级变大、细节变多,写实风的河流按缩放分级;放大多少倍都不糊。
 *
 * 和文字层一样,画布只盖住看得见的那一块(外加四周各留 1/4 视口的余量),画布像素 = 屏幕像素;地图平移、缩放时按地图框的位置
 * 挪过去(placeOnScreen)。重画一次要几十毫秒,所以不是每一帧都画:
 *   - 视口还在画好的那一块里、缩放倍数和画的时候差不到 30%:不重画,只挪位置(缩放倍数变了就按比例放大一点点,看不出)
 *   - 否则马上重画;停下来约 0.15 秒后,再按准确的缩放倍数补画一次
 * 没盖到的地方(拖得太快)露出底下的地形图(缩放 1 倍的那一份),不会出现空白。
 *
 * 弯边投影(mp,罗宾森、摩尔威德……):按投影直接在画布上重画(render/detail.ts 的 drawTerrainProjected)——
 * 面按行重投影,海岸、河逐点投影,符号在投影后的位置上正立、按屏幕大小画,放大多少倍都不糊。
 *
 * 转中心(左右拖动、选中后地图飞过去)时整张图都在变,但放大以后视口里纬度跨得不大,转中心约等于整块左右平移:
 *   - 放大到 SLIDE_K 倍以上:画好的那一块按视口中间那条纬线的比例整体左右挪过去(只改 CSS 位置,不重画);
 *     挪出了画好的那一块、或视口上下边和真实投影差出 SLIDE_ERR 像素以上,就按新中心马上重画;停下来再按准确的中心补画
 *   - 放大不到 SLIDE_K 倍:视口里纬度跨得大,平移对不齐 —— 先藏起来(露出底下的地形图,这时它本来就不太糊),停下来再画
 * 拖动时画布一直是同一张(不释放、不重建),只在缩小到 DETAIL_K 以下、换成数据图层时才释放显存。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import { DETAIL_K, drawTerrainDetail, drawTerrainProjected, type DetailStyle } from '../render/detail';
import { centerShift, type MapProj } from '../render/projection';
import { mapBoxOf, placeOnScreen, visibleBox, type Visible } from './mapWrap';
import { useMapMoving } from './projection';

/** 画好的那一块(地图框 CSS 坐标,缩放前)和画的时候的缩放倍数 */
interface Drawn {
  world: World;
  raster: Raster;
  style: string;
  k: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dpr: number;
  /** 弯边投影:按哪个投影 + 中心画的(等距圆柱 = '') */
  proj: string;
  mp: MapProj | null;
}

/** 画布最多多少像素(约 48 MB 显存);超了就降低像素密度 */
const MAX_PIXELS = 12e6;
/** 四周多画的余量(占看得见那一块的比例) */
const MARGIN = 0.25;
/** 缩放倍数变了多少以内不重画 */
const K_SLACK = Math.log(1.3);
/** 弯边投影里转中心时:放大到几倍以上才让画好的那一块跟着左右平移(以下先藏起来) */
const SLIDE_K = 3;
/** 平移和真实投影在视口上下边最多差几个 CSS 像素(超了就按新中心重画) */
const SLIDE_ERR = 8;

/**
 * 弯边投影:按 d.mp 画好的那一块换到新中心 mp 时,整体左右平移多少(地图框 CSS 像素,缩放前);
 * 不是同一种投影、或视口上下边和真实投影差太多 = null(要重画)
 */
function slideOf(d: Drawn, mp: MapProj, vis: Visible): number | null {
  const from = d.mp;
  if (!from || from.def !== mp.def || from.W !== mp.W || from.H !== mp.H) return null;
  // 地图平面单位 / 地图框 CSS 像素
  const ux = mp.W / vis.bw;
  const uy = mp.H / vis.bh;
  const { dx, err } = centerShift(from, mp, vis.y0 * uy, vis.y1 * uy);
  return (err / ux) * vis.k <= SLIDE_ERR ? dx / ux : null;
}

export function TerrainDetail({
  world,
  raster,
  style,
  view,
  mp = null,
}: {
  world: World;
  raster: Raster;
  style: string;
  view: { k: number; x: number; y: number };
  /** 弯边投影(当前投影 + 中心);等距圆柱 = null */
  mp?: MapProj | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<Drawn | null>(null);
  const timer = useRef(0);
  const moving = useMapMoving();

  // 地图框大小变了(窗口缩放)也要重画
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const box = mapBoxOf(ref.current);
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const cv = ref.current;
    const box = mapBoxOf(cv);
    if (!cv || !box) return;
    window.clearTimeout(timer.current);
    /** release = false:只藏起来,画布留着(拖动中;停下来接着用这一张,不重新分配) */
    const hide = (release = true) => {
      if (cv.style.display !== 'none') cv.style.display = 'none';
      if (release && cv.width) cv.width = cv.height = 0; // 释放显存(几十 MB)
      drawn.current = null;
      (window as unknown as { __wfDetail?: unknown }).__wfDetail = { on: false, k: view.k };
    };
    if ((style !== 'fantasy' && style !== 'realistic') || view.k <= DETAIL_K) return hide();
    const projKey = mp ? mp.key : '';

    /**
     * 看得见的那一块(地图框 CSS 坐标)和当前缩放倍数;看不见返回 null。
     * 可以伸到地图框右边接的那一份里(x 到 2 × 地图框宽,见 mapWrap.ts)
     */
    const visible = () => visibleBox(box);

    const draw = (exact: boolean) => {
      const vis = visible();
      if (!vis) return hide();
      const d0 = drawn.current;
      const d = d0 && d0.world === world && d0.raster === raster && d0.style === style ? d0 : null;
      const precise = !!d && d.proj === projKey;
      // 弯边投影里正在转中心、放大得不够:平移对不齐,先藏起来(画布留着),停下来再画
      if (mp && moving && !precise && vis.k < SLIDE_K) return hide(false);
      // 画好的那一块要左右挪多少才对得上(地图框 CSS 像素):中心没变 = 0;正在转中心 = 按投影整体平移;null = 要重画
      const dx = !d ? null : precise ? 0 : mp && moving && !exact ? slideOf(d, mp, vis) : null;
      if (d && dx !== null) {
        const covers = d.x0 + dx <= vis.x0 + 0.5 && d.y0 <= vis.y0 + 0.5 && d.x1 + dx >= vis.x1 - 0.5 && d.y1 >= vis.y1 - 0.5;
        const dk = Math.abs(Math.log(vis.k / d.k));
        if (covers && (exact ? dk < 0.02 : dk < K_SLACK)) {
          placeOnScreen(cv, vis, d.x0 + dx, d.y0, d.k);
          if (dx) (window as unknown as { __wfDetail?: unknown }).__wfDetail = { on: true, k: d.k, slide: dx, proj: mp?.def.id ?? 'equirect', lon: mp?.lon0 };
          return;
        }
      }
      const t0 = performance.now();
      // 多画的余量:四周各 1/4 视口,不超出地图
      const mw = (vis.x1 - vis.x0) * MARGIN;
      const mh = (vis.y1 - vis.y0) * MARGIN;
      const x0 = Math.max(0, vis.x0 - mw);
      const y0 = Math.max(0, vis.y0 - mh);
      const x1 = Math.min(mp ? vis.bw : 2 * vis.bw, vis.x1 + mw);
      const y1 = Math.min(vis.bh, vis.y1 + mh);
      let dpr = window.devicePixelRatio || 1;
      const px = (x1 - x0) * (y1 - y0) * vis.k * vis.k;
      if (px * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / px);
      const W = Math.max(1, Math.round((x1 - x0) * vis.k * dpr));
      const H = Math.max(1, Math.round((y1 - y0) * vis.k * dpr));
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      Object.assign(cv.style, { display: '', width: `${W / dpr}px`, height: `${H / dpr}px` });
      placeOnScreen(cv, vis, x0, y0, vis.k);
      const ctx = cv.getContext('2d')!;
      const s = (vis.bw / world.width) * vis.k * dpr; // 画布像素 / 世界单位
      const v = { s, ox: -x0 * vis.k * dpr, oy: -y0 * vis.k * dpr, k: vis.k };
      if (mp) {
        // 弯边投影:按投影直接在画布上重画(面按行重投影,线逐点投影、符号正立按屏幕大小画),不是把像素拉大
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        // 地图平面和世界一样大:画布像素 / 地图平面单位 = s,偏移同等距圆柱
        drawTerrainProjected(ctx, world, raster, style as DetailStyle, mp, v);
      } else if (x0 < vis.bw && x1 > vis.bw) {
        // 这一块跨过主图的右边(180° 经线):左右两段各画一遍(右段 = 挪一整圈),各自裁在自己那一段里,
        // 接缝处的符号、河不会画两遍叠深
        const seam = (vis.bw - x0) * vis.k * dpr;
        ctx.clearRect(0, 0, W, H);
        for (const [c0, c1, shift] of [
          [0, seam, 0],
          [seam, W, world.width * s],
        ]) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(c0, 0, c1 - c0, H);
          ctx.clip();
          drawTerrainDetail(ctx, world, raster, style as DetailStyle, { ...v, ox: v.ox + shift });
          ctx.restore();
        }
      } else {
        // 整块都在右边接的那一份里:挪回一整圈画
        const shift = x0 >= vis.bw ? world.width * s : 0;
        drawTerrainDetail(ctx, world, raster, style as DetailStyle, { ...v, ox: v.ox + shift });
      }
      drawn.current = { world, raster, style, k: vis.k, x0, y0, x1, y1, dpr, proj: projKey, mp };
      (window as unknown as { __wfDetail?: unknown }).__wfDetail = { on: true, k: vis.k, ms: performance.now() - t0, w: W, h: H, exact, proj: mp?.def.id ?? 'equirect', lon: mp?.lon0 };
    };
    draw(false);
    // 停下来以后按准确的缩放倍数补画一次
    timer.current = window.setTimeout(() => draw(true), 150);
  }, [world, raster, style, view, tick, mp, moving]);

  return <canvas ref={ref} className="detail" style={{ pointerEvents: 'none', display: 'none' }} />;
}
