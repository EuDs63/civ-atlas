/**
 * 文明叠加层(截图脚本能叠到):
 *
 * 1. 文明底图(canvas.civ):和地图同样大小,只在文明数据、画风、开关、年份变化时重画,地形图不动。
 *    国土色块、国界、道路画在这里。
 * 2. 文字层(canvas.civ-labels):只盖住视口里看得见的那一块地图,分辨率 = 屏幕像素 × devicePixelRatio,
 *    缩放、平移、换年份时重画。它不在被 CSS 放大的地图框里,而是在最上面的屏幕层里(App 传进来的 labelsHost,
 *    见 mapWrap.ts 的"屏幕层"),按地图框的位置摆,一个画布像素对一个屏幕像素 —— 放大到 12 倍字和城镇符号也是清晰的。
 *    画的东西:地理名、国名、城名和城镇符号,一起避让(render/labels/draw.ts 的 placeMap);
 *    底下先画战事的战线和双剑(render/civ/warfare.ts,不参与避让)。
 *    回放 / 拖时间轴时城名只排国都和大城的,每帧更快;停下来就补上城、镇、村的名字。
 *
 * 3. 高亮层(canvas.civ-hl,阶段 3 编年史):点编年史的一条,事发的州、相关国家的国土闪约两秒
 *    (render/civ/highlight.ts 画一次,闪烁是 Web Animations 改不透明度,不重画)。夹在底图和文字层之间,地名不被盖住。
 * 4. 选中层(canvas.civ-sel,阶段 4 点选):选中的国家(当年的国土)/ 州淡淡罩染 + 细描边,选中的大河、山脉一道淡光;常亮。
 *    选中的城画一圈细环、选中的东西的名字底下垫一层光晕 —— 这两样画在文字层上。
 *    文字层排完就把放上去的字和符号记下(ui/mapPick.ts),单击地图时按它查点到了什么。
 *
 * 5. 文明细节层(CivDetail.tsx,放大到 1.2 倍以上):底图、选中层、高亮层看得见的那一块按屏幕像素重画,放在不缩放的屏幕层里
 *    (App 传进来的 detailHost);这时上面 1、3、4 这几张被 CSS 放大的画布藏起来,底图、选中层也先不重画(回放时每帧省一次整图),
 *    缩回 1.2 倍以下再画。
 *
 * 弯边投影(罗宾森、摩尔威德……,mp 不为空):底图、选中层、高亮层按投影重画在地图平面上 —— 色块、罩染这样的"面"
 * 按等距圆柱算好再按行重投影,国界、州界、道路、描边逐点投影(线宽、虚线处处一致);拖动中心时底图先把等距圆柱原图
 * 整图重投影(ui/projection.ts 的 ProjLayer,快),停下来再按投影重画。文字层按投影排(LabelView.proj),
 * 国名按投影后的国土拟合 —— 拖动中心时先用世界坐标拟合的摆法投过去,停下来再重新拟合。
 *
 * 画字前先等字体加载好(ensureFonts),第一次画出来就是正确的字体,不会先闪一下默认字体。
 * 要等的字是这个文明所有可能出现的字(各国各档国号、所有城名),回放时国号升格、新城出现都不用再等字体。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ, Year } from '../gen/civ/types';
import { drawCivOverlay, type CivDrawParams, type CivStyle, type CivViewport } from '../render/civ/overlay';
import { civLabelChars, civLabelItems, civMapLayer, labelViewExtras, reserveCanvasBoxes, type CivMapLayer } from '../render/civ/labels';
import { drawSettlementMarks } from '../render/civ/settlements';
import { drawWarfare, warsShown } from '../render/civ/warfare';
import { drawPlacedLabels, placeMap, placedMarkBox, toCanvas, type LabelItem, type LabelView } from '../render/labels/draw';
import { ensureFonts, fontsReady, preloadFonts } from '../render/labels/fonts';
import { drawHighlight, drawSelection, drawSelectionLabels } from '../render/civ/highlight';
import { getCivHighlight, setCivHighlight, useCivHighlight, useCivShow, useCivTime, useSelection } from './civView';
import { setMapPlacement } from './mapPick';
import { mapBoxOf, mirrorCanvas, placeOnScreen, visibleBox } from './mapWrap';
import { nearX } from '../render/common';
import { labelProjection, projector, type MapProj } from '../render/projection';
import { ProjLayer, useMapMoving } from './projection';
import { useAvoidBoxes } from './uiAvoid';
import { CivDetail } from './CivDetail';

/** 高亮闪烁:约两秒,亮 → 暗 → 亮 → 暗 → 亮,最后淡出 */
const FLASH: Keyframe[] = [
  { opacity: 0 },
  { opacity: 1, offset: 0.08 },
  { opacity: 0.3, offset: 0.24 },
  { opacity: 1, offset: 0.4 },
  { opacity: 0.3, offset: 0.56 },
  { opacity: 1, offset: 0.72 },
  { opacity: 0 },
];
const FLASH_MS = 2200;

// 页面一打开就开始下载字体,和生成世界同时进行
preloadFonts();

// ---- 地球仪(Globe.tsx)借用这里画好的东西:文明底图、选中层、高亮层三张画布(和主图一样大的等距圆柱,
// 直接当贴图贴到球上),这一年的国名、城镇符号(排版在球上另做)。每画完一张就通知一次 ----

export interface CivFeed {
  base: HTMLCanvasElement | null;
  sel: HTMLCanvasElement | null;
  hl: HTMLCanvasElement | null;
  /** 各自画过几次(地球仪按它判断要不要重新上传贴图) */
  baseVer: number;
  selVer: number;
  hlVer: number;
  /** 高亮是哪一次点的(每点一次编年史都不同;没有高亮 = 0) */
  hlStamp: number;
  /** 这一年的国名、城名、城镇符号(和主图文字层同一份) */
  layer: CivMapLayer | null;
  /** 地理名(海、山、河……) */
  places: LabelItem[];
  /** 字体已加载好 */
  fontsOk: boolean;
}

let feed: CivFeed = { base: null, sel: null, hl: null, baseVer: 0, selVer: 0, hlVer: 0, hlStamp: 0, layer: null, places: [], fontsOk: false };
const feedSubs = new Set<() => void>();

function patchFeed(p: Partial<CivFeed>) {
  feed = { ...feed, ...p };
  for (const f of feedSubs) f();
}

export function getCivFeed(): CivFeed {
  return feed;
}

export function subscribeCivFeed(f: () => void): () => void {
  feedSubs.add(f);
  return () => feedSubs.delete(f);
}

export interface CivLayerProps {
  world: World;
  raster: Raster;
  /** 套上用户改名的 civ(阶段 4;地图文字用它) */
  civ: Civ | null;
  /**
   * 生成出来的原始 civ(阶段 4):底图、高亮、选中层只看地理和归属、不看名字,用它画 ——
   * 改名时只重排文字,不重画底图。不给 = civ
   */
  geo?: Civ | null;
  style: CivStyle;
  /** 画哪一年;不传 = 时间轴上的年份(civView.ts),时间轴也没定 = civ.endYear */
  year?: Year;
  view?: CivViewport;
  /** 弯边投影(当前投影 + 中心);等距圆柱 = null / 不给 */
  mp?: MapProj | null;
  /** 文字层放在哪(屏幕层,不随地图 CSS 缩放;还没有 = 先不画字) */
  labelsHost?: HTMLElement | null;
  /** 放大后的文明细节层放在哪(屏幕层:地形细节层之上、这一层地图框之下;没有 = 不画细节层) */
  detailHost?: HTMLElement | null;
}

const VIEW_1: CivViewport = { k: 1, x: 0, y: 0 };

interface LabelsDebug {
  ready: boolean;
  drawn: number;
  /** 画了几个城镇符号、几个国名 */
  marks: number;
  polities: number;
  year: number;
  fast: boolean;
  ms: number;
  fontOk: boolean;
  /** 第一次画字时字体是否已就绪(冒烟检查"不闪默认字体"用) */
  firstFontOk?: boolean;
  style: string;
  k: number;
  /** 画出来的文字(冒烟检查"改名后地图上的字变了"用) */
  texts: string[];
  /** 按哪种投影、哪条中央经线排的;国名是不是按投影后的国土拟合的 */
  proj?: string;
  lon?: number;
  fitted?: boolean;
  /** 画了几段战线、几个双剑(战事关着 / 没在打仗 = null 或 0) */
  wars?: { lines: number; marks: number } | null;
}

export function CivLayer({ world, raster, civ, geo, style, year, view, mp = null, labelsHost = null, detailHost = null }: CivLayerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLCanvasElement>(null);
  const hlRef = useRef<HTMLCanvasElement>(null);
  const selRef = useRef<HTMLCanvasElement>(null);
  // 底图、选中层、高亮层在右边接的那一份(左右无限拖动,见 mapWrap.ts)
  const refCopy = useRef<HTMLCanvasElement>(null);
  const selCopy = useRef<HTMLCanvasElement>(null);
  const hlCopy = useRef<HTMLCanvasElement>(null);
  // 文明细节层的高亮画布(闪烁动画和上面的高亮层一起放);细节层盖住时上面几张不用重画
  const detailHl = useRef<HTMLCanvasElement>(null);
  const [detailOn, setDetailOn] = useState(false);
  const hl = useCivHighlight();
  const { sel } = useSelection();
  const mpRef = useRef(mp);
  mpRef.current = mp;
  const show = useCivShow();
  // 时间轴:画哪一年;回放 / 拖动时色块用半分辨率
  const time = useCivTime();
  const fast = time.playing || time.scrubbing;
  const y = year ?? time.year;

  // 世界和文明必须是同一次生成的(地块数对得上)才画
  const base = geo ?? civ;
  const ok = !!civ && !!base && base.habitat.suitability.length === world.mesh.n && base.regions === civ.regions;
  // 底图(国土、国界、道路……)用原始 civ:改名不重画
  const params = useMemo<CivDrawParams | null>(
    () => (ok && base ? { world, raster, civ: base, style, year: y ?? base.endYear, show, fast } : null),
    [ok, world, raster, base, style, y, show, fast],
  );
  // 国名、城名、城镇符号:同一年、同样的开关,换成套了改名的 civ
  const mapParams = useMemo<CivDrawParams | null>(() => (params && civ ? { ...params, civ } : null), [params, civ]);
  // 文字层不随年份变:单独一份参数,回放时不用每帧重排地名
  const labelParams = useMemo<CivDrawParams | null>(
    () => (ok && civ ? { world, raster, civ, style, year: civ.endYear, show } : null),
    [ok, world, raster, civ, style, show],
  );

  // ---- 1. 文明底图 ----
  // 右边接的那一份只在视窗里看得见它的时候才复制(视窗没跨过主图右边 = 180° 经线时看不见):
  // 回放、拖时间轴时每帧省一次整张图的复制(没有显卡加速的机器上这一下很慢);看不见时记下"过期",平移到看得见时再补
  const copyStale = useRef(false);
  const copyVisible = () => {
    const box = ref.current?.parentElement;
    const vis = box ? visibleBox(box) : null;
    return !!vis && vis.x1 > vis.bw + 0.5;
  };
  // 弯边投影:停着的时候按投影重画(色块按行重投影,国界、道路逐点投影);拖动中心时把等距圆柱原图(离屏)整图重投影到 ref 上
  // (快)。baseDrawn = 原图是按哪份参数画的(只改中心时不重画原图);preciseDrawn = 按投影重画的是哪份参数
  const baseProj = useRef(new ProjLayer());
  const baseDrawn = useRef<unknown>(null);
  const preciseDrawn = useRef<unknown>(null);
  const moving = useMapMoving();
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    // 放大后细节层盖住了这一张(藏着):先不画,细节层关了再画
    if (detailOn) return;
    if (mp) {
      copyStale.current = false;
      mirrorCanvas(refCopy.current, null, false);
      const L = baseProj.current;
      if (!params) {
        baseDrawn.current = preciseDrawn.current = null;
        L.release();
        if (cv.width) cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height);
        return;
      }
      const t0 = performance.now();
      if (!moving) {
        const fresh = preciseDrawn.current !== params;
        const pj = projector(mp);
        L.redraw(cv, raster.w, raster.h, mp.key, null, (ctx) => drawCivOverlay(ctx, { ...params, proj: pj }), fresh);
        preciseDrawn.current = params;
        const w = window as unknown as { __wfCiv: unknown; __wfCivProj: unknown };
        const ms = performance.now() - t0;
        w.__wfCivProj = { ms, lon: mp.lon0, proj: mp.def.id, precise: true };
        if (fresh) w.__wfCiv = { ready: true, ms, show, year: params.year, fast, proj: mp.def.id };
        // 空闲时先把拖动用的等距圆柱原图备好:一开始拖就能整图重投影,不卡第一帧(回放、拖时间轴时不备)
        if (fast || baseDrawn.current === params) return;
        const p0 = params;
        const win = window as unknown as {
          requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number;
          cancelIdleCallback?: (h: number) => void;
        };
        const prep = () => {
          if (baseDrawn.current === p0) return;
          const src = L.source(raster.w, raster.h, true);
          const sctx = src.getContext('2d')!;
          sctx.clearRect(0, 0, src.width, src.height);
          drawCivOverlay(sctx, p0);
          baseDrawn.current = p0;
        };
        if (win.requestIdleCallback) {
          const h = win.requestIdleCallback(prep, { timeout: 3000 });
          return () => win.cancelIdleCallback?.(h);
        }
        const h = window.setTimeout(prep, 400);
        return () => window.clearTimeout(h);
      }
      const redraw = baseDrawn.current !== params || !L.has();
      if (redraw) {
        const src = L.source(raster.w, raster.h);
        const sctx = src.getContext('2d')!;
        sctx.clearRect(0, 0, src.width, src.height);
        drawCivOverlay(sctx, params);
        baseDrawn.current = params;
      }
      const t1 = performance.now();
      L.present(cv, mp, null, true);
      const w = window as unknown as { __wfCiv: unknown; __wfCivProj: unknown };
      w.__wfCivProj = { ms: performance.now() - t1, lon: mp.lon0, proj: mp.def.id };
      if (redraw) w.__wfCiv = { ready: true, ms: performance.now() - t0, show, year: params.year, fast, proj: mp.def.id };
      return;
    }
    baseDrawn.current = preciseDrawn.current = null;
    baseProj.current.release();
    if (cv.width !== raster.w || cv.height !== raster.h) {
      cv.width = raster.w;
      cv.height = raster.h;
    }
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    copyStale.current = false;
    if (!params) {
      patchFeed({ base: cv, baseVer: feed.baseVer + 1 });
      return mirrorCanvas(refCopy.current, cv, false);
    }
    const t0 = performance.now();
    drawCivOverlay(ctx, params);
    patchFeed({ base: cv, baseVer: feed.baseVer + 1 });
    if (copyVisible()) mirrorCanvas(refCopy.current, cv, true);
    else copyStale.current = true;
    (window as unknown as { __wfCiv: unknown }).__wfCiv = { ready: true, ms: performance.now() - t0, show, year: params.year, fast };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, raster, show, mp, moving, detailOn]);
  useLayoutEffect(() => {
    if (!copyStale.current || !copyVisible()) return;
    copyStale.current = false;
    mirrorCanvas(refCopy.current, ref.current, true);
  });

  // ---- 3. 高亮层(编年史点一条):只在点的那一下画一次 ----
  const curvedMode = !!mp;
  useEffect(() => {
    const cv = hlRef.current;
    if (!cv) return;
    if (cv.width !== raster.w || cv.height !== raster.h) {
      cv.width = raster.w;
      cv.height = raster.h;
    }
    const ctx = cv.getContext('2d')!;
    const copy = hlCopy.current;
    if (!hl || !ok || !base) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      mirrorCanvas(copy, cv, false);
      patchFeed({ hl: cv, hlVer: feed.hlVer + 1, hlStamp: 0 });
      return;
    }
    const t0 = performance.now();
    const m = mpRef.current;
    // 弯边投影:按投影直接画在地图平面上(罩染按行重投影,描边逐点投影;不接右边那一份)
    const marks = drawHighlight(ctx, world, raster, base, hl, style, view?.k ?? 1, m ? projector(m) : null);
    let lit = 0;
    for (const m of marks) if (m) lit++;
    for (const a of cv.getAnimations?.() ?? []) a.cancel();
    const anim = cv.animate?.(FLASH, { duration: FLASH_MS, easing: 'ease-in-out', fill: 'forwards' });
    // 细节层的高亮(放大后画的是它)一起闪
    const dh = detailHl.current;
    if (dh) {
      for (const a of dh.getAnimations?.() ?? []) a.cancel();
      dh.animate?.(FLASH, { duration: FLASH_MS, easing: 'ease-in-out', fill: 'forwards' });
    }
    mirrorCanvas(copy, cv, !m);
    // 地球仪借用的是等距圆柱那一张(弯边投影时这张是投影过的,地球仪也不在)
    if (!m) patchFeed({ hl: cv, hlVer: feed.hlVer + 1, hlStamp: hl.stamp });
    if (copy && !m) {
      for (const a of copy.getAnimations?.() ?? []) a.cancel();
      copy.animate?.(FLASH, { duration: FLASH_MS, easing: 'ease-in-out', fill: 'forwards' });
    }
    // 闪完就把高亮清掉(之后切画风、换年份不会再闪一次)
    const stamp = hl.stamp;
    if (anim) anim.onfinish = () => getCivHighlight()?.stamp === stamp && setCivHighlight(null);
    (window as unknown as { __wfHighlight: unknown }).__wfHighlight = { stamp, lit, year: hl.year, ms: performance.now() - t0 };
    // 画风切换时不重画(闪过就算了);只跟着新的高亮、新的世界走(换成 / 换回弯边投影时按新的办法重画)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl, ok, base, world, raster, curvedMode]);
  // 弯边投影里高亮闪着的时候转了中心:按新中心重画(不重新闪)
  const hlShown = useRef(false);
  useEffect(() => {
    const cv = hlRef.current;
    if (!hlShown.current) {
      hlShown.current = true;
      return;
    }
    if (!cv || !mp || !hl || !ok || !base) return;
    drawHighlight(cv.getContext('2d')!, world, raster, base, hl, style, view?.k ?? 1, projector(mp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp]);

  // ---- 4. 选中层:选中的国家 / 州 / 大河、山脉。国家的国土随年份变(回放时一年画一次);描边按缩放倍数变细 ----
  const selYear = params ? Math.floor(params.year) : 0;
  const selZoom = Math.round(Math.log2(Math.max(1, view?.k ?? 1)) * 2) / 2;
  // 回放 / 拖时间轴时每 5 年才重画一次(一次约 10 毫秒,不拖慢回放)
  const selPolityYear = sel?.kind === 'polity' ? (fast ? selYear - (selYear % 5) : selYear) : 0;
  useEffect(() => {
    const cv = selRef.current;
    if (!cv) return;
    // 放大后细节层盖住了这一张:先不画(选中的轮廓由细节层画)
    if (detailOn) return;
    if (!sel || !ok || !base || sel.kind === 'settlement') {
      if (cv.width) cv.width = cv.height = 0;
      mirrorCanvas(selCopy.current, cv, false);
      patchFeed({ sel: cv, selVer: feed.selVer + 1 });
      return;
    }
    if (cv.width !== raster.w || cv.height !== raster.h) {
      cv.width = raster.w;
      cv.height = raster.h;
    }
    const t0 = performance.now();
    const m = mp;
    if (m) {
      // 弯边投影:按投影直接画在地图平面上(罩染按行重投影,描边逐点投影;转中心时每次重画,约十毫秒)
      const lit = drawSelection(cv.getContext('2d')!, world, raster, base, sel, selPolityYear, style, 2 ** selZoom, projector(m));
      mirrorCanvas(selCopy.current, null, false);
      (window as unknown as { __wfSelection: unknown }).__wfSelection = { kind: sel.kind, id: sel.id, lit, ms: performance.now() - t0 };
      return;
    }
    const lit = drawSelection(cv.getContext('2d')!, world, raster, base, sel, selPolityYear, style, 2 ** selZoom);
    mirrorCanvas(selCopy.current, cv, true);
    patchFeed({ sel: cv, selVer: feed.selVer + 1 });
    (window as unknown as { __wfSelection: unknown }).__wfSelection = { kind: sel.kind, id: sel.id, lit, ms: performance.now() - t0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, ok, base, world, raster, style, selPolityYear, selZoom, mp, detailOn]);

  // ---- 2. 文字层 ----
  // 地理名不随年份变:回放时不用每帧重新生成;国名、城名、城镇符号随年份变
  const geoItems = useMemo(() => (labelParams ? civLabelItems(labelParams) : []), [labelParams]);
  // 弯边投影:国名按投影后的国土拟合;拖动中心时(moving)先用世界坐标拟合的那一份投过去,停下来再按新中心拟合
  const fitMp = mp && !moving ? mp : null;
  const mapLayer = useMemo(() => (mapParams ? civMapLayer(mapParams, { fast, proj: fitMp }) : null), [mapParams, fast, fitMp]);
  const extras = useMemo(() => (labelParams ? labelViewExtras(labelParams) : null), [labelParams]);
  const text = useMemo(() => (ok && civ ? civLabelChars(civ) : ''), [ok, civ]);
  const fontStyle = style;
  const want = `${fontStyle}|${text}`;
  const [loaded, setLoaded] = useState('');
  useEffect(() => {
    if (!text) return;
    let alive = true;
    void ensureFonts(fontStyle, text).then(() => alive && setLoaded(want));
    return () => {
      alive = false;
    };
  }, [fontStyle, text, want]);
  // 字体早已加载好(比如切换画风、开关地名)时不必等一帧,直接画
  const fontsOk = loaded === want || (text !== '' && fontsReady(fontStyle, text));
  useEffect(() => patchFeed({ layer: mapLayer, places: geoItems, fontsOk }), [mapLayer, geoItems, fontsOk]);

  // 地图框大小变了(窗口缩放)也要重画
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const box = mapBoxOf(textRef.current);
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, [labelsHost]);

  // 地图上盖着的界面(四角的字、时间轴、面板 / 抽屉、提示条……):它们下面不放字和符号(和地球仪同一份清单,见 uiAvoid.ts)
  const avoid = useAvoidBoxes(textRef);

  useLayoutEffect(() => {
    const cv = textRef.current;
    const box = mapBoxOf(cv);
    if (!cv || !box) return;
    const ctx = cv.getContext('2d')!;
    const clear = () => {
      setMapPlacement(null);
      ctx.clearRect(0, 0, cv.width, cv.height);
    };
    const items = mapLayer ? geoItems.concat(mapLayer.items) : geoItems;
    const marks = mapLayer?.marks ?? [];
    const wars = !!params && warsShown(params);
    if ((!items.length && !marks.length && !wars) || !extras || !fontsOk) return clear();
    const t0 = performance.now();
    // 看得见的那块:地图框(已被 CSS 放大)和舞台(视口)的交集,换回地图框自己的坐标
    // (舞台换成视窗,地图框往右多算一份 —— 见 mapWrap.ts 的 visibleBox)
    const vis = visibleBox(box);
    if (!vis) return clear();
    const { k, bw } = vis;
    const dpr = window.devicePixelRatio || 1;
    const lx0 = vis.x0;
    const ly0 = vis.y0;
    const W = Math.max(1, Math.round((vis.x1 - vis.x0) * k * dpr));
    const H = Math.max(1, Math.round((vis.y1 - vis.y0) * k * dpr));
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    } else clear();
    Object.assign(cv.style, { width: `${W / dpr}px`, height: `${H / dpr}px` });
    placeOnScreen(cv, vis, lx0, ly0, k);
    const scale = (bw / extras.worldW) * k * dpr;
    const lv: LabelView = { ...extras, scale, ox: -lx0 * k * dpr, oy: -ly0 * k * dpr, dpr, k, mapCss: bw, canvasW: W, canvasH: H };
    if (mp) {
      // 弯边投影:整张图就在画布上(不挪整圈);字不出外轮廓(罗盘在轮廓外面,不用另外让)
      lv.proj = labelProjection(mp);
      lv.wrap = 0;
      lv.frameLeft = 0;
      lv.reserved = [];
    } else {
      // 外框画在视窗上(不随平移),文字不出外框、不压左下角的罗盘
      const fl = (vis.frameX / bw) * extras.worldW;
      lv.frameLeft = fl;
      lv.reserved = extras.reserved?.map((r) => [r[0] + fl, r[1], r[2] + fl, r[3]] as [number, number, number, number]);
    }
    // 界面(屏幕坐标)→ 文字层画布像素(画布左上角 = 看得见的那一块的左上角,一个 CSS 像素 = dpr 个画布像素)
    const ui = avoid.map((b) => [(b[0] - vis.left) * dpr, (b[1] - vis.top) * dpr, (b[2] - vis.left) * dpr, (b[3] - vis.top) * dpr] as const);
    if (ui.length) lv.reserved = reserveCanvasBoxes(lv, ui);
    const placed = placeMap(items, marks, lv);
    // 国都的符号总要画(排版时不看重叠),但压在界面下面的也不画(和地球仪一样)
    if (ui.length) {
      placed.marks = placed.marks.filter((pm) => {
        const b = placedMarkBox(pm);
        return !ui.some((r) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]);
      });
    }
    // 选中的城(符号没画出来时按它的位置画圈)、选中的东西的名字底下的光晕
    let at: [number, number] | null = null;
    if (sel?.kind === 'settlement' && civ?.settlements[sel.id]) {
      const c = civ.settlements[sel.id].cell;
      const cx = (W / 2 - lv.ox) / lv.scale;
      at = mp ? toCanvas(lv, world.mesh.x[c], world.mesh.y[c]) : [nearX(world.mesh.x[c], cx, lv.wrap ?? 0) * lv.scale + lv.ox, world.mesh.y[c] * lv.scale + lv.oy];
    }
    // 战线、双剑压在国界上、城镇符号和字底下
    const war = wars && params ? drawWarfare(ctx, params, lv, mp ? projector(mp) : null) : null;
    drawSelectionLabels(ctx, placed, lv, sel, style, at);
    drawSettlementMarks(ctx, placed.marks, style);
    drawPlacedLabels(ctx, placed.labels, lv);
    setMapPlacement({ canvas: cv, placed, view: lv });
    const w = window as unknown as { __wfLabels?: LabelsDebug };
    const fontOk = fontsReady(fontStyle, text);
    w.__wfLabels = {
      ready: true,
      drawn: placed.labels.length,
      marks: placed.marks.length,
      polities: placed.labels.filter((l) => l.item.sizeWorld !== undefined).length,
      year: params?.year ?? 0,
      fast: !!fast,
      ms: performance.now() - t0,
      fontOk,
      firstFontOk: w.__wfLabels?.firstFontOk ?? fontOk,
      style: fontStyle,
      k,
      texts: placed.labels.map((l) => l.item.text),
      wars: war,
      proj: mp?.def.id ?? 'equirect',
      lon: mp?.lon0,
      fitted: !!fitMp,
    };
  }, [geoItems, mapLayer, extras, fontsOk, fontStyle, style, text, view, tick, params, fast, sel, civ, world, mp, fitMp, avoid, labelsHost]);

  return (
    <>
      <canvas ref={ref} className="civ" style={{ pointerEvents: 'none' }} />
      <canvas ref={refCopy} className="civ wrap-copy" style={{ pointerEvents: 'none' }} />
      <canvas ref={selRef} className="civ-sel" style={{ pointerEvents: 'none' }} />
      <canvas ref={selCopy} className="civ-sel wrap-copy" style={{ pointerEvents: 'none' }} />
      <canvas ref={hlRef} className="civ-hl" style={{ pointerEvents: 'none', opacity: 0 }} />
      <canvas ref={hlCopy} className="civ-hl wrap-copy" style={{ pointerEvents: 'none', opacity: 0 }} />
      {labelsHost && createPortal(<canvas ref={textRef} className="civ-labels" style={{ pointerEvents: 'none' }} />, labelsHost)}
      <CivDetail
        world={world}
        raster={raster}
        params={params}
        civ={ok ? base : null}
        style={style}
        sel={sel}
        selYear={selPolityYear}
        hl={hl}
        view={view ?? VIEW_1}
        mp={mp}
        host={detailHost}
        hlRef={detailHl}
        hide={[ref, refCopy, selRef, selCopy, hlRef, hlCopy]}
        onCover={setDetailOn}
      />
    </>
  );
}
