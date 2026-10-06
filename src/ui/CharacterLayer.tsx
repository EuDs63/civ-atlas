/**
 * 地图上作者的人物一生的足迹(样子见 render/trail.ts,算法见 characterInfo.ts 的 characterTrail):铺满舞台的一张画布,不接鼠标。
 *
 * - 只在选中一个人物(或正在填一个人物)时画,不选就不画:地图上不会一直挂着一堆头像
 * - 看的时候:按时间轴那一年分走过的(实线)和还没走的(虚线),头像停在那一年他在的地方;出生前、去世后不画头像
 * - 填的时候:整条都算走过,头像在出生地;加一段经历时那一段是虚的,半透明头像在挑好的那一处
 * - 挑地方时(characterStore 的 picking):鼠标在地图上时跟着一个半透明头像 + 十字
 * - 每帧问 App 要"世界坐标 → 舞台坐标"的换算(和作者标记共用 MarkApi),有变化才重画;年份尽量不压地图上的字、按钮面板
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import type { AuthorCharacter } from '../gen/characters';
import { MARK_HEX, canvasMeasure, type Measure } from '../render/marks';
import { avatarCenter, drawGhostAvatar, drawTrail, hitTrailPin, layoutTrail, type PlacedTrail } from '../render/trail';
import { useEdits } from './editsStore';
import { getCivTime, subscribeCivTime, useSelection } from './civView';
import { draftAsCharacter, parseYear, useCharUi, type CharDraft } from './characterStore';
import { characterTrail, type TrailMode } from './characterInfo';
import type { MarkApi, MarkView } from './MarkLayer';
import { useAvoidBoxes } from './uiAvoid';
import './characters.css';

/** 最近画的那一帧(App 点地图、悬停时按它认头像) */
let shown: { trail: PlacedTrail; view: MarkView; id: number } | null = null;

/** 屏幕上这一点是不是点在头像上;是 = 人物的编号 */
export function characterPinAt(cx: number, cy: number): number | null {
  if (!shown || !hitTrailPin(shown.trail, cx - shown.view.left, cy - shown.view.top)) return null;
  return shown.id;
}

/** 头像尖角在屏幕上的位置(悬停小卡片放在它上方);没画头像 = null */
export function characterPinTip(): [number, number] | null {
  const p = shown?.trail.pins[0];
  if (!p || !shown) return null;
  const [, cy] = avatarCenter(p.x, p.y);
  return [p.x + shown.view.left, cy - 18 + shown.view.top];
}

/** 冒烟检查用:window.__wfTrail = 最近画的那一帧(屏幕坐标);什么都没画 = 空 */
function debug(t: PlacedTrail | null, v: MarkView | null, id: number) {
  const L = v?.left ?? 0;
  const T = v?.top ?? 0;
  (window as unknown as { __wfTrail?: unknown }).__wfTrail = t
    ? {
        id,
        segs: t.segs.map((s) => ({ x0: s.x0 + L, y0: s.y0 + T, x1: s.x1 + L, y1: s.y1 + T, future: s.future })),
        dots: t.dots.map((d) => ({ x: d.x + L, y: d.y + T, future: d.future })),
        labels: t.labels.map((l) => ({ text: l.text, side: l.side, future: l.future, box: [l.box[0] + L, l.box[1] + T, l.box[2] + L, l.box[3] + T] })),
        pins: t.pins.map((p) => ({ x: p.x + L, y: p.y + T })),
        ghosts: t.ghosts.map((p) => ({ x: p.x + L, y: p.y + T })),
      }
    : { id: 0, segs: [], dots: [], labels: [], pins: [], ghosts: [] };
}

/** 正在填的那一份按哪种样子画 */
function draftMode(d: CharDraft): TrailMode {
  if (d.sub?.kind === 'life') {
    const y = parseYear(d.sub.d.yearText);
    return { kind: 'life', entry: { year: y === null || Number.isNaN(y) ? 0 : y, where: d.sub.d.where }, index: d.sub.d.index };
  }
  return { kind: 'edit' };
}

export function CharacterLayer({ civ, world, raster, api, hidden }: { civ: Civ | null; world: World; raster: Raster | null; api: MutableRefObject<MarkApi | null>; hidden?: boolean }) {
  const edits = useEdits();
  const ui = useCharUi();
  const { sel } = useSelection();
  const cvRef = useRef<HTMLCanvasElement>(null);
  const selId = sel?.kind === 'character' ? sel.id : null;
  const draft = ui.draft && selId === ui.draft.id ? ui.draft : null;
  const char: AuthorCharacter | null = draft ? null : (edits.characters?.find((c) => c.id === selId) ?? null);
  const active = !hidden && !!civ && (!!draft || !!char);

  const state = useRef({ ver: 0, sig: '', mouse: null as { x: number; y: number; map: boolean } | null });
  const panels = useAvoidBoxes(cvRef);
  const deps = { char, draft, picking: ui.picking, civ, panels, raster };
  const depsRef = useRef(deps);
  const was = depsRef.current;
  if (was.char !== char || was.draft !== draft || was.picking !== ui.picking || was.civ !== civ || was.panels !== panels || was.raster !== raster) state.current.ver++;
  depsRef.current = deps;

  useEffect(() => subscribeCivTime(() => void state.current.ver++), []);

  // 挑地方时跟着鼠标
  const followMouse = active && !!ui.picking;
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
      debug(null, null, 0);
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
        debug(null, null, 0);
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
      const { char, draft, picking, civ, panels, raster } = depsRef.current;
      if (!civ) return;
      const year = Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear)));
      const c = draft ? draftAsCharacter(draft, year) : char;
      if (!c) return;
      const input = characterTrail(civ, world, raster, c, year, draft ? draftMode(draft) : { kind: 'view' });
      ctx.save();
      if (v.period) {
        ctx.beginPath();
        ctx.rect(v.win[0], 0, v.win[1] - v.win[0], v.h);
        ctx.clip();
      }
      const avoid = [...text, ...panels].map((b) => [b[0] - v.left, b[1] - v.top, b[2] - v.left, b[3] - v.top]);
      const trail = layoutTrail(input, v, { measure, avoid });
      drawTrail(ctx, trail);
      const mouse = state.current.mouse;
      if (picking && mouse?.map) drawGhostAvatar(ctx, mouse.x - v.left, mouse.y - v.top, MARK_HEX[c.color], input.avatar);
      ctx.restore();
      shown = { trail, view: v, id: c.id };
      debug(trail, v, c.id);
    };
    state.current.sig = '';
    frame();
    return () => {
      cancelAnimationFrame(raf);
      shown = null;
    };
  }, [active, api, world]);

  if (!active) return null;
  return <canvas ref={cvRef} className="character-layer" aria-hidden="true" />;
}
