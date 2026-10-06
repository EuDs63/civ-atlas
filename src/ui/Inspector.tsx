/**
 * 右侧面板:地图上单击选中的国家 / 城 / 地理实体 / 州,在右侧(宽 340,上 72、下 84)显示它在时间轴当前那一年的状态。
 * 同一时间只有一个面板;右上角 ✕ 或 Esc 关闭。深色图层(实景、高程、降水)下跟着换深色(theme.css 的变量)。
 *
 * - 国家:CountryPanel.tsx(信息页 + 干预页)
 * - 城:CityPanel.tsx(级别 / 人口 / 做过国都、兴衰、历任归属、相关事件;迁都到这里、看所属国家)
 * - 地理实体:PlacePanel.tsx(按种类的几个数、当年在哪些国家境内;AI 起名)
 * - 州(没点到别的东西时):RegionPanel.tsx(主体民族 / 宜居度 / 人口、历任归属、州里的城、相关事件;在这里立国、划给…)
 * - 人物(点人名):PersonPanel.tsx(生卒、在位 / 领兵、前任继任、结局、他在台上那几年的事)
 * - 信仰(信仰图层上点陆地、侧栏的信仰组、国家卡片的「国教」):FaithPanel.tsx(类型、创立、圣城、信众、国教、教派、大事)
 * - 作者标记(地图上点标记、世界概览的「标记」页、搜索;新建、编辑也在这里填):MarkPanel.tsx
 *
 * 四种面板用同一套零件(panelParts.tsx):顶部、三格数字、色条、小柱图、事件列表、底部按钮。
 * 面板里的名字可以点,点了就选中那个国家 / 城 / 州。在地图上选干预目标、下了令正在推演时,面板先藏起来(状态留着)。
 *
 * 窄屏(手机,≤ 760px):面板是从屏幕底升起的卡片(盖住没选东西时的世界卡片),时间轴胶囊浮在它上面。
 * 默认半高(约屏高一半:露出头部、一排按钮和概况的开头),顶上有拖动条:往上拖或点拖动条 → 展开(上边到屏高 8%,胶囊藏起来);
 * 往下拖到底或点 ✕ → 关掉;从展开往下拖 → 回到半高。头部也能拖。内容在卡片里滚动,底部按钮固定在卡片底部。
 * 换了选中的东西回到半高;进干预页时展开。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { populationAt } from '../gen/civ/growth';
import { useEdits } from './editsStore';
import { clearSelection, setSelection, useCivTime, useSelection, type MapSelection } from './civView';
import { usePolityPick } from './Interventions';
import { CountryPanel } from './CountryPanel';
import { CityPanel } from './CityPanel';
import { PlacePanel } from './PlacePanel';
import { RegionPanel } from './RegionPanel';
import { PersonPanel } from './PersonPanel';
import { FaithPanel } from './FaithPanel';
import { MarkPanel } from './MarkPanel';
import { useMarkUi } from './markStore';
import { setPanelTab, setSheet, setSheetDrag, usePanel } from './panelStore';
import { ownersOf } from './panelData';
import { phoneSheet, selectionKey } from './flyTo';
import { useNarrow } from './device';
import { VELOCITY_MS, releaseVelocity, sheetSnap, type SheetSnap } from './gestures';
import './countryPanel.css';

/** 最近一次画面板时的历史(冒烟检查、截图挑例子用) */
let lastCiv: Civ | null = null;
/** 上次显示的是哪个选中的东西(稳定键;见 useSelectionReset) */
let lastShown = '';

/**
 * 换了选中的东西(按稳定键:重推历史后编号变了还算同一个):面板回到信息页;窄屏的抽屉回到半高。
 * 和上次显示的比(记在模块里,和面板页签一样是全局的):面板哪天重新挂上,也不会停在上一个东西的干预页
 */
export function useSelectionReset(raw: Civ | null, onReset?: () => void) {
  const { sel } = useSelection();
  const stable = raw && sel ? selectionKey(raw, sel) : '';
  useLayoutEffect(() => {
    if (lastShown === stable) return;
    lastShown = stable;
    setPanelTab('info');
    setSheet('half');
    onReset?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stable]);
}

export function Inspector({ civ, raw, raster, world }: { civ: Civ | null; raw: Civ | null; raster: Raster | null; world: World }) {
  const { sel } = useSelection();
  const t = useCivTime();
  const edits = useEdits();
  const pick = usePolityPick();
  const markDraft = useMarkUi().draft;
  const { run, sheet } = usePanel();
  const narrow = useNarrow();
  const sheetDrag = useSheetDrag(narrow, sheet);
  lastCiv = civ;
  useSelectionReset(raw, sheetDrag.reset);
  if (!civ || !raw || !sel) return null;
  const stable = selectionKey(raw, sel);
  const year = Math.floor(Math.min(civ.endYear, Math.max(0, t.year ?? civ.endYear)));
  const common = { civ, raw, raster, world, year, names: edits.names };
  let body: ReactNode = null;
  if (sel.kind === 'polity' && civ.polities[sel.id]) body = <CountryPanel {...common} id={sel.id} />;
  else if (sel.kind === 'settlement' && civ.settlements[sel.id]) body = <CityPanel key={stable} {...common} id={sel.id} />;
  else if (sel.kind === 'place' && civ.places[sel.id]) body = <PlacePanel key={stable} {...common} id={sel.id} />;
  else if (sel.kind === 'region' && sel.id >= 0 && sel.id < civ.regions.count) body = <RegionPanel key={stable} {...common} id={sel.id} />;
  else if (sel.kind === 'person' && civ.people?.[sel.id]) body = <PersonPanel key={stable} {...common} id={sel.id} />;
  else if (sel.kind === 'faith' && civ.religion?.faiths[sel.id]) body = <FaithPanel key={stable} {...common} id={sel.id} />;
  else if (sel.kind === 'mark' && (markDraft?.id === sel.id || edits.marks?.some((m) => m.id === sel.id))) body = <MarkPanel key={stable} civ={civ} raster={raster} world={world} year={year} id={sel.id} />;
  if (!body) return null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  // 在地图上选目标、下了令正在推演:先藏起来(面板里的状态留着,取消后回到干预页)
  const hidden = !!pick || !!run;
  const sheetCls = narrow ? ` sheet sheet-${sheet}${sheetDrag.top !== null ? ' dragging' : ''}${sheetDrag.closing ? ' closing' : ''}` : '';
  return (
    <section
      ref={sheetDrag.ref}
      className={`inspector cpanel k-${sel.kind}${hidden ? ' hidden' : ''}${sheetCls}`}
      style={narrow && sheetDrag.top !== null ? { top: sheetDrag.top } : undefined}
      onPointerDown={(e) => {
        stop(e);
        sheetDrag.down(e);
      }}
      onPointerMove={(e) => {
        stop(e);
        sheetDrag.move(e);
      }}
      onPointerUp={sheetDrag.up}
      onPointerCancel={sheetDrag.up}
      onClick={stop}
      onDoubleClick={stop}
      aria-label="详情"
      aria-hidden={hidden || undefined}
    >
      {narrow && (
        <button
          className="sheet-grip"
          data-act="sheet"
          aria-label={sheet === 'full' ? '收起' : '展开'}
          aria-expanded={sheet === 'full'}
          onClick={() => setSheet(sheet === 'full' ? 'half' : 'full')}
        >
          <i aria-hidden="true" />
        </button>
      )}
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 窄屏的底部抽屉:拖动条(和头部)上下拖

/** 卡片现在的几何(和 phone.css 的 --sheet-half / --sheet-full 同一个算法) */
function sheetNow(el: HTMLElement) {
  const app = el.offsetParent as HTMLElement | null;
  return phoneSheet(app?.clientHeight ?? window.innerHeight);
}

function useSheetDrag(narrow: boolean, sheet: SheetSnap) {
  const ref = useRef<HTMLElement>(null);
  /** 拖动中抽屉上边的 y(相对界面;不在拖 = null,按 CSS 停在半高 / 展开) */
  const [top, setTop] = useState<number | null>(null);
  /** 往下拖到底关掉:先滑下去,再取消选中 */
  const [closing, setClosing] = useState(false);
  const press = useRef<{ id: number; y0: number; top0: number; from: SheetSnap; moved: boolean; samples: { y: number; t: number }[] } | null>(null);
  const closeTimer = useRef(0);
  const reset = () => {
    if (press.current?.moved) setSheetDrag(false);
    press.current = null;
    window.clearTimeout(closeTimer.current);
    setTop(null);
    setClosing(false);
  };
  const down = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!narrow || !el || closing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target as HTMLElement;
    // 拖动条和头部能拖(输入框里不算:改名时要能选字)
    if (!t.closest('.sheet-grip, .cp-head') || t.closest('input, textarea, [contenteditable]')) return;
    press.current = { id: e.pointerId, y0: e.clientY, top0: el.offsetTop, from: sheet, moved: false, samples: [{ y: e.clientY, t: performance.now() }] };
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    const el = ref.current;
    if (!p || p.id !== e.pointerId || !el) return;
    const dy = e.clientY - p.y0;
    if (!p.moved) {
      if (Math.abs(dy) < 6) return;
      p.moved = true;
      setSheetDrag(true);
      // 拖起来以后抽屉接着收这根手指 / 鼠标(拖出抽屉也认);松手时头部的按钮不再算点到
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 合成的指针事件没有真的指针 */
      }
    }
    const now = performance.now();
    p.samples.push({ y: e.clientY, t: now });
    while (p.samples.length > 2 && now - p.samples[0].t > VELOCITY_MS) p.samples.shift();
    const g = sheetNow(el);
    setTop(Math.max(g.fullTop - 24, Math.min(g.bottom - 48, p.top0 + dy)));
  };
  const up = (e: React.PointerEvent) => {
    const p = press.current;
    const el = ref.current;
    if (!p || p.id !== e.pointerId || !el) return;
    press.current = null;
    if (!p.moved) return;
    setSheetDrag(false);
    const vy = releaseVelocity(p.samples, e.clientY, performance.now());
    const g = sheetNow(el);
    const snap = sheetSnap(p.from, Math.max(g.fullTop - 24, Math.min(g.bottom - 48, p.top0 + e.clientY - p.y0)), vy, g);
    if (snap === 'close') {
      setClosing(true);
      setTop(null);
      closeTimer.current = window.setTimeout(() => {
        clearSelection();
        setClosing(false);
      }, 200);
      return;
    }
    setSheet(snap);
    setTop(null);
  };
  return { ref, top, closing, down, move, up, reset };
}

// ---------------------------------------------------------------------------
// 冒烟检查、截图用:挑几个有代表性的例子、直接选中

/** 当年的几个例子(编号;没有 = −1):最大的城、一座故城、最长的河、最大的山脉、一片海、一个有主的州、一个无主(有人住)的州 */
export function panelSamples(year?: number): Record<string, number> {
  const civ = lastCiv;
  if (!civ) return {};
  const y = Math.min(civ.endYear, Math.max(0, year ?? civ.endYear));
  const own = ownersOf(civ, y);
  const best = <T,>(list: T[], score: (x: T) => number): T | undefined => {
    let b: T | undefined;
    let bs = -Infinity;
    for (const x of list) {
      const s = score(x);
      if (s > bs) {
        bs = s;
        b = x;
      }
    }
    return b;
  };
  const standing = civ.settlements.filter((s) => s.founded <= y && (s.ended === undefined || s.ended > y));
  const big = best(standing, (s) => populationAt(s, y));
  const ruin = best(
    civ.settlements.filter((s) => s.ended !== undefined && s.ended <= y),
    (s) => (s.sacks?.length ?? 0) + (s.capitalSpans?.length ?? 0) * 2 + s.capacity / 100,
  );
  const placeOf = (kind: string, score: (i: number) => number) =>
    best(
      civ.places.map((p, i) => ({ p, i })).filter((x) => x.p.kind === kind),
      (x) => score(x.i),
    )?.i ?? -1;
  const river = placeOf('river', (i) => civ.places[i].path.length);
  const mountains = placeOf('mountains', (i) => civ.places[i].size ?? 0);
  const sea = placeOf('sea', (i) => (civ.places[i].name.endsWith('海') ? 1000 : 0) - civ.places[i].rank * 10 + (civ.places[i].size ?? 0) / 100);
  const regions = [...Array(civ.regions.count).keys()];
  const owned = best(
    regions.filter((r) => own.polity[r] >= 0),
    (r) => (civ.settlements.some((s) => s.region === r && s.ended !== undefined) ? 10 : 0) + (civ.regions.name?.[r] ? 1 : 0),
  );
  const unowned = best(
    regions.filter((r) => own.polity[r] < 0 && own.culture[r] >= 0),
    (r) => civ.regions.area[r],
  );
  return {
    city: big?.id ?? -1,
    ruin: ruin?.id ?? -1,
    river,
    mountains,
    sea,
    region: owned ?? -1,
    wild: unowned ?? -1,
    polity: big ? own.polity[big.region] : -1,
  };
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { __wfPanelSamples: typeof panelSamples; __wfSelect: (kind: MapSelection['kind'], id: number) => void };
  w.__wfPanelSamples = panelSamples;
  w.__wfSelect = (kind, id) => setSelection({ kind, id } as MapSelection);
}
