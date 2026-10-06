/**
 * 地图上的作者标记(样子见 render/marks.ts,数据见 gen/edits.ts 文件头"作者标记"):铺满舞台的一张画布,不接鼠标(点得到下面的地图)。
 *
 * - 按时间轴当前那一年挑标记(markShownAt);选中的标记不在这一年里也画,变淡
 * - 每帧问 App 要"世界坐标 → 舞台坐标"的换算(平面主图、弯边投影、地球仪),视图、年份、标记、选中、鼠标(放标记、圈州时)、
 *   地图文字的排版有变化才重画;一千个标记以内一帧几毫秒
 * - 名字尽量不压地图上的城名、地名(平面主图、弯边投影时按文字层排好的位置躲),也尽量不写到按钮、面板下面
 * - 放标记(markStore 的 placing):鼠标在地图上时跟着一枚半透明图钉 + 十字
 * - 编辑几个州的标记:鼠标停着的州(还没选上的)描一圈虚线
 * - App 点地图、悬停时问 markHitAt:点到图钉、名字、名字牌 = 选中那个标记,点到合并的圆 = 在那里放大
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { markShownAt, regionKey, type AuthorMark } from '../gen/edits';
import {
  MARK_HEX,
  canvasMeasure,
  drawGhostPin,
  drawHoverOutline,
  drawMarks,
  hitMark,
  layoutMarks,
  projectLoops,
  type AreaShape,
  type MarkFrame,
  type MarkHit,
  type MarkItem,
  type MarkLayout,
  type Measure,
} from '../render/marks';
import { useEdits } from './editsStore';
import { getCivTime, subscribeCivTime, useSelection } from './civView';
import { useMarkUi, type MarkDraft } from './markStore';
import { markRegionIds, markShapeOf } from './markInfo';
import { useAvoidBoxes } from './uiAvoid';
import './marks.css';

/** 这一帧的换算(舞台坐标)+ 舞台在屏幕上的位置 + 指纹(视图没变 = 指纹不变) */
export interface MarkView extends MarkFrame {
  left: number;
  top: number;
  sig: string;
}

/** App 给标记层的几样东西 */
export interface MarkApi {
  frame(): MarkView | null;
  /** 屏幕坐标 → 州号(海上、地图外 = −1) */
  regionAt(cx: number, cy: number): number;
  /** 屏幕坐标在不在地图上 */
  onMap(cx: number, cy: number): boolean;
  /** 地图上城名、地名占的地方(屏幕坐标;ver 变了 = 重新排过):标记的名字尽量躲开 */
  textBoxes(): { ver: number; list: number[][] };
}

/** 最近画的那一帧(App 点地图、悬停时按它找点到的标记) */
let shown: { layout: MarkLayout; view: MarkView } | null = null;

/** 屏幕上这一点点到了哪个标记;没点到 = null */
export function markHitAt(cx: number, cy: number): MarkHit | null {
  if (!shown) return null;
  return hitMark(shown.layout, cx - shown.view.left, cy - shown.view.top);
}

/** 屏幕上这一点是不是一枚图钉(拖图钉用) */
export function markPinAt(cx: number, cy: number, id: number): boolean {
  if (!shown) return false;
  const x = cx - shown.view.left;
  const y = cy - shown.view.top;
  return shown.layout.pins.some((p) => p.id === id && Math.abs(x - p.x) <= p.w / 2 + 4 && y >= p.y - (p.w * 4) / 3 - 4 && y <= p.y + 4);
}

/** 这个标记的图钉尖在屏幕上的位置(悬停小卡片放在它左上方);没画图钉 = null */
export function markPinTip(id: number): [number, number] | null {
  const p = shown?.layout.pins.find((q) => q.id === id);
  return p && shown ? [p.x + shown.view.left, p.y + shown.view.top] : null;
}

/** 冒烟检查用:window.__wfMarks = 最近画的那一帧(屏幕坐标);什么都没画 = 空 */
function debugNone() {
  (window as unknown as { __wfMarks?: unknown }).__wfMarks = { pins: [], areas: [], clusters: [], k: 0 };
}

/** 编辑中的标记画成的样子(还没存的那一份) */
function draftAsMark(d: MarkDraft): AuthorMark | null {
  const from = Number(d.fromText);
  const to = d.toText.trim() ? Number(d.toText) : undefined;
  const base = { id: d.id, title: d.title.trim() || '新标记', color: d.color, from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : undefined };
  if (d.scope === 'regions') return { ...base, regions: d.regions };
  return d.at ? { ...base, at: d.at } : null;
}

export function MarkLayer({ civ, world, api, hidden }: { civ: Civ | null; world: World; api: MutableRefObject<MarkApi | null>; hidden?: boolean }) {
  const edits = useEdits();
  const ui = useMarkUi();
  const { sel } = useSelection();
  const cvRef = useRef<HTMLCanvasElement>(null);
  const marks = edits.marks;
  // 几个州的形状(同一份州划分、同一串州只算一次)
  const shapeOf = (ids: number[], draft = false): AreaShape | null => (civ ? markShapeOf(world, civ, ids, draft) : null);
  const selId = sel?.kind === 'mark' ? sel.id : null;
  const draft = ui.draft;
  const areaEdit = !!draft && draft.scope === 'regions';
  const active = !hidden && !!civ && (!!marks?.length || ui.placing || !!draft);

  // 每帧看一眼,有变化才重画
  const state = useRef({ ver: 0, sig: '', mouse: null as { x: number; y: number; map: boolean } | null });
  // 按钮、面板(名字尽量不写到它们下面)
  const panels = useAvoidBoxes(cvRef);
  const deps = { marks, draft, selId, placing: ui.placing, civ, panels };
  const depsRef = useRef(deps);
  const was = depsRef.current;
  if (was.marks !== marks || was.draft !== draft || was.selId !== selId || was.placing !== ui.placing || was.civ !== civ || was.panels !== panels) state.current.ver++;
  depsRef.current = deps;
  const shapeRef = useRef(shapeOf);
  shapeRef.current = shapeOf;

  useEffect(() => subscribeCivTime(() => void state.current.ver++), []);

  // 放标记、圈州时跟着鼠标
  const followMouse = active && (ui.placing || areaEdit);
  useEffect(() => {
    if (!followMouse) {
      state.current.mouse = null;
      return;
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = e.target as HTMLElement | null;
      const map = !!t?.closest?.('.canvas-wrap, .globe, .screen-layer') && !!api.current?.onMap(e.clientX, e.clientY);
      state.current.mouse = { x: e.clientX, y: e.clientY, map };
    };
    const onLeave = () => (state.current.mouse = null);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, [followMouse, api]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!active || !cv) {
      shown = null;
      debugNone();
      if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    const ctx = cv.getContext('2d')!;
    let measure: Measure | null = null;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const v = api.current?.frame();
      const tb = api.current?.textBoxes();
      const s = state.current;
      const m = s.mouse;
      const sig = v ? `${v.sig}|${s.ver}|${tb?.ver}|${m ? `${m.x},${m.y},${m.map}` : ''}` : '';
      if (sig === s.sig) return;
      s.sig = sig;
      draw(v, tb?.list ?? []);
    };
    const draw = (v: MarkView | null | undefined, text: number[][]) => {
      const dpr = window.devicePixelRatio || 1;
      if (!v) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        shown = null;
        debugNone();
        return;
      }
      const W = Math.max(1, Math.round(v.w * dpr));
      const H = Math.max(1, Math.round(v.h * dpr));
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
        cv.style.width = `${v.w}px`;
        cv.style.height = `${v.h}px`;
        measure = null;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measure ??= canvasMeasure(ctx);
      const { marks, draft, selId, placing, civ, panels } = depsRef.current;
      if (!civ) return;
      const year = Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear)));
      const items: MarkItem[] = [];
      const toItem = (mk: AuthorMark, selected: boolean, dim: boolean, draft = false): MarkItem => ({
        id: mk.id,
        title: mk.title,
        color: mk.color,
        at: mk.at,
        shape: mk.regions ? shapeRef.current(markRegionIds(civ, mk), draft) : undefined,
        selected,
        dim,
      });
      const editing = draft ? draftAsMark(draft) : null;
      const focus = editing ? editing.id : selId;
      for (const mk of marks ?? []) {
        if (editing && mk.id === editing.id) continue;
        const on = mk.id === focus;
        const live = markShownAt(mk, year);
        if (!live && !on) continue;
        items.push(toItem(mk, on, focus !== null ? !on || !live : false));
      }
      if (editing) items.push(toItem(editing, true, false, true));
      ctx.save();
      // 平面主图:只画在视窗里(和地图一样按视窗裁)
      if (v.period) {
        ctx.beginPath();
        ctx.rect(v.win[0], 0, v.win[1] - v.win[0], v.h);
        ctx.clip();
      }
      const avoid = [...text, ...panels].map((b) => [b[0] - v.left, b[1] - v.top, b[2] - v.left, b[3] - v.top]);
      const layout = layoutMarks(items, v, { measure, avoid });
      drawMarks(ctx, layout, dpr);
      const mouse = state.current.mouse;
      if (mouse?.map) {
        const x = mouse.x - v.left;
        const y = mouse.y - v.top;
        if (placing) drawGhostPin(ctx, x, y, MARK_HEX.red, dpr);
        else if (draft?.scope === 'regions') {
          const r = api.current?.regionAt(mouse.x, mouse.y) ?? -1;
          if (r >= 0 && !draft.regions.includes(regionKey(civ, r))) {
            const sh = shapeRef.current([r]);
            if (sh) drawHoverOutline(ctx, projectLoops(v, sh));
          }
        }
      }
      ctx.restore();
      shown = { layout, view: v };
      (window as unknown as { __wfMarks?: unknown }).__wfMarks = {
        pins: layout.pins.map((p) => ({ id: p.id, x: p.x + v.left, y: p.y + v.top, w: p.w, label: p.label?.text ?? null })),
        areas: layout.areas.map((a) => ({ id: a.id, polys: a.polys.length, pill: a.pill ? { x: a.pill.x + v.left, y: a.pill.y + v.top, text: a.pill.text } : null })),
        clusters: layout.clusters.map((c) => ({ x: c.x + v.left, y: c.y + v.top, ids: c.ids })),
        k: v.k,
      };
    };
    state.current.sig = '';
    frame();
    return () => {
      cancelAnimationFrame(raf);
      shown = null;
    };
  }, [active, api]);

  if (!active) return null;
  return <canvas ref={cvRef} className="mark-layer" aria-hidden="true" />;
}
