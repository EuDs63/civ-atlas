/**
 * 文明细节层(canvas.civ-detail、civ-detail-sel、civ-detail-hl):放大到 DETAIL_K 倍以上时,把文明底图、选中层、高亮层
 * 看得见的那一块按屏幕像素重画(render/civ/detail.ts)—— 色块的边顺着界线和岸线、线条按屏幕粗细,放大多少倍都不糊、不起方块;
 * 同时把被 CSS 放大的那几张(canvas.civ、civ-sel、civ-hl 和右边接的那一份)藏起来。
 *
 * 和地形细节层一样放在不缩放的屏幕层里(App 传进来的 host:地形细节层、视窗装饰之上,文明底图那一层地图框之下;
 * 见 mapWrap.ts 的"屏幕层"),按地图框的位置摆(placeOnScreen),画布像素 = 屏幕像素。
 *
 * 画哪一块、什么时候重画,和地形细节层(TerrainDetail.tsx)同一套规则:视口附近一块(四周各留 1/4 视口);
 * 视口还在画好的那一块里、缩放倍数差不到 30% 就不重画只挪位置;停下来 0.15 秒后按准确的倍数补画;
 * 弯边投影拖动转中心时整块左右平移(放大不到 SLIDE_K 倍先藏起来)。两层同时重画、倍数一样 ——
 * 手绘风色块给符号"让位"的遮罩(按这个倍数画的符号层)和地形细节层的符号对得上。
 * 只换数据(回放 / 拖时间轴换年份、开关图层、选中、高亮)时在画好的那一块上重画,不挪位置、不换倍数。
 *
 * 逐格上色的粗细:停着的时候 1 个 CSS 像素一格;拖动、缩放中重画和回放 / 拖时间轴时 2 个 CSS 像素一格(快几倍),
 * 停下来、回放停了再按 1 个补画。线条一直按屏幕像素画。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { DETAIL_K } from '../render/detail';
import { centerShift, type MapProj } from '../render/projection';
import { detailCache, drawCivDetail, drawHighlightDetail, drawSelectionDetail, type CivDetailView, type DetailCache } from '../render/civ/detail';
import { washLayer } from '../render/civ/territory';
import type { CivDrawParams, CivStyle } from '../render/civ/overlay';
import type { CivHighlight, SelectionTarget } from '../render/civ/highlight';
import { mapBoxOf, placeOnScreen, visibleBox, type Visible } from './mapWrap';
import { useMapMoving } from './projection';

/** 画好的那一块(地图框 CSS 坐标,缩放前)、画的时候的缩放倍数、画布 → 地图平面的变换 */
interface Region {
  id: number;
  world: World;
  raster: Raster;
  /** 地图框(缩放 1 倍)的宽:窗口缩放后坐标就不对了,要重画 */
  bw: number;
  k: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 画布像素 / CSS 像素 */
  dpr: number;
  /** 按哪个投影 + 中心画的(等距圆柱 = '') */
  proj: string;
  mp: MapProj | null;
  view: CivDetailView;
  cache: DetailCache;
}

/** 每张画布画的是哪一块、哪份数据(哪个 civ)、多粗的格 */
interface Drawn {
  region: number;
  data: unknown;
  civ: Civ | null;
  step: number;
}

/** 画布最多多少像素(约 48 MB 显存);超了就降低像素密度(同地形细节层) */
const MAX_PIXELS = 12e6;
/** 四周多画的余量(占看得见那一块的比例) */
const MARGIN = 0.25;
/** 缩放倍数变了多少以内不重画 */
const K_SLACK = Math.log(1.3);
/** 弯边投影里转中心时:放大到几倍以上才让画好的那一块跟着左右平移(以下先藏起来) */
const SLIDE_K = 3;
/** 平移和真实投影在视口上下边最多差几个 CSS 像素(超了就按新中心重画) */
const SLIDE_ERR = 8;
/** 逐格上色:停着 / 拖动、回放时一格几个 CSS 像素;工作格最多多少个(超了就放粗) */
const STEP_FINE = 1;
const STEP_COARSE = 2;
const MAX_CELLS_FINE = 4.5e6;
const MAX_CELLS_COARSE = 1.2e6;

let regionSeq = 0;

/** 弯边投影:画好的那一块换到新中心时整体左右平移多少(地图框 CSS 像素);要重画 = null(同 TerrainDetail) */
function slideOf(d: Region, mp: MapProj, vis: Visible): number | null {
  const from = d.mp;
  if (!from || from.def !== mp.def || from.W !== mp.W || from.H !== mp.H) return null;
  const ux = mp.W / vis.bw;
  const uy = mp.H / vis.bh;
  const { dx, err } = centerShift(from, mp, vis.y0 * uy, vis.y1 * uy);
  return (err / ux) * vis.k <= SLIDE_ERR ? dx / ux : null;
}

/** 底图这一层有没有东西要画(只开着地名时没有) */
function baseHasContent(p: CivDrawParams | null): boolean {
  if (!p) return false;
  const s = p.show;
  return washLayer(p) !== null || (s.polities && p.civ.polities.length > 0) || (s.routes && p.civ.routes.length > 0) || s.regions || s.sites || s.habitat;
}

export interface CivDetailProps {
  world: World;
  raster: Raster;
  /** 底图的参数(和整张图同一份);没有文明 = null */
  params: CivDrawParams | null;
  /** 画选中 / 高亮用的 civ(原始的,改名不重画);没有 = null */
  civ: Civ | null;
  style: CivStyle;
  /** 选中的东西、选中国家按哪一年的国土画 */
  sel: SelectionTarget | null;
  selYear: number;
  hl: (CivHighlight & { stamp: number }) | null;
  view: { k: number; x: number; y: number };
  mp: MapProj | null;
  /** 放在哪(屏幕层);还没有 = 不画 */
  host: HTMLElement | null;
  /** 高亮那张画布(闪烁动画由 CivLayer 和整张图的高亮层一起放) */
  hlRef: RefObject<HTMLCanvasElement>;
  /** 细节层盖住时要藏起来的那几张(被 CSS 放大的文明底图、选中、高亮和右边接的那一份) */
  hide: RefObject<HTMLCanvasElement>[];
  /** 细节层开 / 关(开着时 CivLayer 不用再重画被藏起来的那几张) */
  onCover: (on: boolean) => void;
}

export function CivDetail({ world, raster, params, civ, style, sel, selYear, hl, view, mp, host, hlRef, hide, onCover }: CivDetailProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const selRef = useRef<HTMLCanvasElement>(null);
  const region = useRef<Region | null>(null);
  const drawn = useRef<{ base: Drawn | null; sel: Drawn | null; hl: Drawn | null }>({ base: null, sel: null, hl: null });
  const covered = useRef(false);
  const lastView = useRef<unknown>(null);
  const timer = useRef(0);
  const moving = useMapMoving();
  const coverRef = useRef(onCover);
  coverRef.current = onCover;

  // 地图框大小变了(窗口缩放)也要重画
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const box = mapBoxOf(baseRef.current);
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, [host]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      for (const r of hide) if (r.current) r.current.style.visibility = '';
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutEffect(() => {
    const cvs = { base: baseRef.current, sel: selRef.current, hl: hlRef.current };
    const box = mapBoxOf(cvs.base);
    if (!cvs.base || !cvs.sel || !cvs.hl || !box) return;
    window.clearTimeout(timer.current);
    const setCover = (on: boolean) => {
      if (covered.current === on) return;
      covered.current = on;
      for (const r of hide) if (r.current) r.current.style.visibility = on ? 'hidden' : '';
      coverRef.current(on);
    };
    /** release = false:只藏起来,画布留着(拖动中;停下来接着用,不重新分配) */
    const off = (release = true) => {
      for (const cv of [cvs.base!, cvs.sel!, cvs.hl!]) {
        if (cv.style.display !== 'none') cv.style.display = 'none';
        if (release && cv.width) cv.width = cv.height = 0;
      }
      region.current = null;
      drawn.current = { base: null, sel: null, hl: null };
      setCover(false);
      (window as unknown as { __wfCivDetail?: unknown }).__wfCivDetail = { on: false, k: view.k };
    };
    const wantBase = baseHasContent(params);
    const wantSel = !!civ && !!sel && sel.kind !== 'settlement';
    const wantHl = !!civ && !!hl;
    if (view.k <= DETAIL_K || (!wantBase && !wantSel && !wantHl)) return off();
    const projKey = mp ? mp.key : '';
    const fast = !!params?.fast;
    const viewNow = view;

    const draw = (exact: boolean) => {
      const vis = visibleBox(box);
      if (!vis) return off();
      const d0 = region.current;
      const d = d0 && d0.world === world && d0.raster === raster && d0.bw === vis.bw ? d0 : null;
      const precise = !!d && d.proj === projKey;
      // 弯边投影里正在转中心、放大得不够:平移对不齐,先藏起来(画布留着),停下来再画
      if (mp && moving && !precise && vis.k < SLIDE_K) return off(false);
      const dx = !d ? null : precise ? 0 : mp && moving && !exact ? slideOf(d, mp, vis) : null;
      let R: Region | null = null;
      if (d && dx !== null) {
        const covers = d.x0 + dx <= vis.x0 + 0.5 && d.y0 <= vis.y0 + 0.5 && d.x1 + dx >= vis.x1 - 0.5 && d.y1 >= vis.y1 - 0.5;
        const dk = Math.abs(Math.log(vis.k / d.k));
        if (covers && (exact ? dk < 0.02 : dk < K_SLACK)) R = d;
      }
      const slide = R ? dx! : 0;
      // 拖动、缩放中(视图和上一次不一样)或回放中:粗一点的格
      const interacting = !exact && (lastView.current !== viewNow || moving);
      lastView.current = viewNow;
      if (!R) R = newRegion(vis);
      region.current = R;
      const t0 = performance.now();
      const css = fast || interacting ? STEP_COARSE : STEP_FINE;
      const cells = (R.view.cw * R.view.ch) / (R.dpr * R.dpr * css * css);
      const maxCells = css === STEP_FINE ? MAX_CELLS_FINE : MAX_CELLS_COARSE;
      const step = Math.max(1, Math.round(css * R.dpr * Math.max(1, Math.sqrt(cells / maxCells))));
      const timing = { wash: 0, lines: 0, ink: 0, sel: 0, hl: 0 };
      let did = false;
      const need = (dw: Drawn | null, data: unknown, c: Civ | null = null) =>
        !dw || dw.region !== R!.id || dw.data !== data || dw.civ !== c || (dw.step > step && !interacting);
      const prep = (cv: HTMLCanvasElement) => {
        if (cv.width !== R!.view.cw || cv.height !== R!.view.ch) {
          cv.width = R!.view.cw;
          cv.height = R!.view.ch;
        }
        Object.assign(cv.style, { display: '', width: `${R!.view.cw / R!.dpr}px`, height: `${R!.view.ch / R!.dpr}px` });
        return cv.getContext('2d')!;
      };
      const hideCv = (cv: HTMLCanvasElement) => {
        if (cv.style.display !== 'none') cv.style.display = 'none';
        if (cv.width) cv.width = cv.height = 0;
      };
      // 底图
      const dr = drawn.current;
      if (wantBase && params) {
        if (need(dr.base, params)) {
          const t = drawCivDetail(prep(cvs.base!), params, R.view, step, R.cache);
          timing.wash = t.wash;
          timing.lines = t.lines;
          timing.ink = t.ink;
          dr.base = { region: R.id, data: params, civ: null, step };
          did = true;
        }
      } else if (dr.base || cvs.base!.width) {
        hideCv(cvs.base!);
        dr.base = null;
      }
      // 选中
      if (wantSel && civ) {
        const key = `${sel!.kind}|${sel!.id}|${selYear}|${style}`;
        if (need(dr.sel, key, civ)) {
          const t1 = performance.now();
          const lit = drawSelectionDetail(prep(cvs.sel!), world, raster, civ, sel!, selYear, style, R.view, step, R.cache);
          timing.sel = performance.now() - t1;
          dr.sel = { region: R.id, data: key, civ, step };
          did = true;
          (window as unknown as { __wfSelection: unknown }).__wfSelection = { kind: sel!.kind, id: sel!.id, lit, ms: timing.sel, detail: true };
        }
      } else if (dr.sel || cvs.sel!.width) {
        hideCv(cvs.sel!);
        dr.sel = null;
      }
      // 高亮(不透明度的闪烁动画在 CivLayer 里放)
      if (wantHl && civ) {
        const key = `${hl!.stamp}|${style}`;
        if (need(dr.hl, key, civ)) {
          const t1 = performance.now();
          drawHighlightDetail(prep(cvs.hl!), world, raster, civ, hl!, style, R.view, step, R.cache);
          timing.hl = performance.now() - t1;
          dr.hl = { region: R.id, data: key, civ, step };
          did = true;
        }
      } else if (dr.hl || cvs.hl!.width) {
        hideCv(cvs.hl!);
        dr.hl = null;
      }
      for (const cv of [cvs.base!, cvs.sel!, cvs.hl!]) if (cv.width) placeOnScreen(cv, vis, R.x0 + slide, R.y0, R.k);
      setCover(true);
      const w = window as unknown as { __wfCivDetail?: Record<string, unknown> };
      const ms = performance.now() - t0;
      const prev = w.__wfCivDetail;
      // 画着的那几张是按几个 CSS 像素一格上的色
      const cur = dr.base ?? dr.sel ?? dr.hl;
      w.__wfCivDetail = {
        on: true,
        k: R.k,
        w: R.view.cw,
        h: R.view.ch,
        cssW: R.view.cw / R.dpr,
        dpr: R.dpr,
        // 这一次重画了没有(没重画 = 只挪了位置;耗时留着上一次重画的)
        ms: did || !prev?.on ? ms : prev.ms,
        drew: did,
        step: (cur ? cur.step : step) / R.dpr,
        ...timing,
        exact,
        fast,
        slide,
        year: params?.year,
        proj: mp?.def.id ?? 'equirect',
        lon: R.mp?.lon0,
      };
    };

    /** 新的一块:看得见的那块四周各多 1/4,不超出地图;画布按屏幕像素(太大就降低像素密度) */
    function newRegion(vis: Visible): Region {
      const mw = (vis.x1 - vis.x0) * MARGIN;
      const mh = (vis.y1 - vis.y0) * MARGIN;
      const x0 = Math.max(0, vis.x0 - mw);
      const y0 = Math.max(0, vis.y0 - mh);
      const x1 = Math.min(mp ? vis.bw : 2 * vis.bw, vis.x1 + mw);
      const y1 = Math.min(vis.bh, vis.y1 + mh);
      let dpr = window.devicePixelRatio || 1;
      const px = (x1 - x0) * (y1 - y0) * vis.k * vis.k;
      if (px * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / px);
      const cw = Math.max(1, Math.round((x1 - x0) * vis.k * dpr));
      const ch = Math.max(1, Math.round((y1 - y0) * vis.k * dpr));
      // 画布像素 / 世界单位(地图平面和世界一样大);画布左上角 = 地图框坐标 (x0, y0)
      const s = (vis.bw / world.width) * vis.k * dpr;
      const old = region.current;
      if (old?.cache.scratch) old.cache.scratch.canvas.width = old.cache.scratch.canvas.height = 0;
      return {
        id: ++regionSeq,
        world,
        raster,
        bw: vis.bw,
        k: vis.k,
        x0,
        y0,
        x1,
        y1,
        dpr,
        proj: projKey,
        mp,
        view: { cw, ch, s, ox: -x0 * vis.k * dpr, oy: -y0 * vis.k * dpr, k: vis.k, mp, dpr },
        cache: detailCache(),
      };
    }

    draw(false);
    // 停下来以后按准确的缩放倍数、细一点的格补画一次
    timer.current = window.setTimeout(() => draw(true), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, raster, params, civ, style, sel, selYear, hl, view, tick, mp, moving, host]);

  if (!host) return null;
  return createPortal(
    <>
      <canvas ref={baseRef} className="civ-detail" style={{ pointerEvents: 'none', display: 'none' }} />
      <canvas ref={selRef} className="civ-detail-sel" style={{ pointerEvents: 'none', display: 'none' }} />
      <canvas ref={hlRef} className="civ-detail-hl" style={{ pointerEvents: 'none', display: 'none', opacity: 0 }} />
    </>,
    host,
  );
}
