/**
 * 地图上的事件标签:时间轴播放经过一条大事时,在事发地画一个圆环(直径 14,外带 6px 光晕),
 * 右侧一张小卡:第一行类型(彩色粗体)+ 年份,第二行纪事正文。停约 3.8 秒淡出。
 *
 * - 同时最多 3 个(timelineLayout.ts 的 PIN_MAX;再来新的,最早的那个提前淡出);卡片互不重叠:
 *   默认放在圆环右边,放不下(出屏、压着别的卡片)就换到左边、下边、上边(placeCards)。
 * - 在编年史、时间轴刻度、最近事件里点一条跳过去时,那一条的标签停约 5 秒。拖动时间轴 / 跳到别的年份时收起。
 * - 标签跟着地图走:每帧按 App 给的"世界坐标 → 屏幕坐标"重新摆(平移、缩放、左右无限拖动、弯边投影都对);
 *   事发地不在视窗里就不显示。地球仪视图下按球的投影摆(App 换成地球仪的换算),转到背面就不显示。
 * - 事发地:相关的城 / 事发各州的中心 / 相关国家那一年的国都(timelineLayout.ts 的 entryAnchor)。
 * - 用的纪事:编年史的"大事"(编年史只看某国时就只看这国的),和最近事件一致。
 * - 标签不接鼠标(点得到下面的地图)。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { filterChronicle } from '../gen/civ/chronicle';
import { fullChronicle } from '../gen/civ/religionText';
import { getCivTime, subscribeCivTime, useChronicle, useChroniclePick } from './civView';
import { useThemeCompat } from './CivTimeline';
import {
  PIN_JUMP_MS,
  addPins,
  cardOffset,
  crossed,
  entryAnchor,
  evLabel,
  evText,
  evType,
  evYears,
  pinOpacity,
  placeCards,
  type LivePin,
  type PinBox,
} from './timelineLayout';
import './timeline.css';

/** 世界坐标 → 屏幕坐标(clientX / clientY);算不出 = null */
export type WorldToClient = (wx: number, wy: number) => [number, number] | null;

export interface EventPinsProps {
  civ: Civ | null;
  world: World;
  /** App 的"世界坐标 → 屏幕坐标"(取视窗里的那一份;弯边投影按投影) */
  toClient: MutableRefObject<WorldToClient | null>;
  /** 地质回放时藏起来 */
  hidden?: boolean;
}

/** 一帧里年份往前跳得比这多(年)就不算"播放经过",是跳过去的(不补标签) */
const JUMP_YEARS = 60;
/** 卡片摆放时底下让出的高度(像素):时间轴那一行 */
const BOTTOM_RESERVE = 84;

const pinKey = (p: LivePin) => `${p.e.id}:${p.start}`;

export function EventPins({ civ, world, toClient, hidden }: EventPinsProps) {
  const chron = useChronicle();
  const pick = useChroniclePick();
  const [setRoot, compat] = useThemeCompat();
  const layerRef = useRef<HTMLDivElement | null>(null);
  // ref 回调要稳定:每次渲染换一个新函数,React 每次提交都会先传 null 再传元素,各触发一次同步的 setState;
  // 碰上还挂着一个普通优先级的 setPins(播放时每帧都可能有)时,同步渲染会一遍遍重算后面的 setPins、
  // 每遍都得到新数组 → 再渲染 → 再换 ref → ……直到 React 报 "Maximum update depth exceeded"
  const setLayer = useCallback(
    (el: HTMLDivElement | null) => {
      layerRef.current = el;
      setRoot(el);
    },
    [setRoot],
  );
  const has = !!civ && civ.viable && civ.cultures.length > 0;
  const end = civ?.endYear ?? 0;
  const entries = useMemo(() => (has ? filterChronicle(fullChronicle(civ), { major: true, polity: chron.polity }) : []), [civ, has, chron.polity]);
  const [pins, setPins] = useState<LivePin[]>([]);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  // 播放经过大事:加标签;拖动 / 跳到别的年份:收起
  useEffect(() => {
    setPins([]);
    if (!entries.length) return;
    const t0 = getCivTime();
    let prevYear = t0.year ?? end;
    let prevPlaying = t0.playing;
    const clear = () => setPins((ps) => (ps.length ? [] : ps));
    const add = (list: ReturnType<typeof crossed>) => list.length && setPins((ps) => addPins(ps, list, performance.now()));
    const off = subscribeCivTime((t) => {
      const y = t.year ?? end;
      if (t.playing && prevPlaying && y > prevYear && y - prevYear <= JUMP_YEARS) {
        add(crossed(entries, prevYear, y));
      } else if (!t.playing && prevPlaying && t.year === null) {
        // 放到了结束年份(最后一帧没有推进年份,把剩下那一小段补上)
        add(crossed(entries, prevYear, end));
      } else if (y !== prevYear) {
        // 拖动、跳到别的年份、从别的年份重新放起:标签说的已经不是眼前的事了
        clear();
      }
      prevYear = y;
      prevPlaying = t.playing;
    });
    return off;
  }, [entries, end]);

  // 在编年史 / 刻度 / 最近事件里点一条:只留这一条的标签,停约 5 秒
  const seenPick = useRef(pick.stamp);
  useEffect(() => {
    if (pick.stamp === seenPick.current) return;
    seenPick.current = pick.stamp;
    if (!pick.entry || !has) return;
    const now = performance.now();
    setPins([{ e: pick.entry, start: now, until: now + PIN_JUMP_MS }]);
  }, [pick.stamp, pick.entry, has]);

  // 每帧把标签摆到事发地(跟着地图的平移 / 缩放 / 投影),淡入淡出,摆卡片;过期的收掉
  const els = useRef(new Map<string, HTMLDivElement>());
  const sizes = useRef(new Map<string, [number, number]>());
  const sides = useRef(new Map<string, number>());
  const show = !hidden && has;
  useLayoutEffect(() => {
    if (!show || !pins.length || !civ) return;
    let raf = 0;
    const frame = () => {
      const layer = layerRef.current;
      if (!layer) return;
      const now = performance.now();
      const rect = layer.getBoundingClientRect();
      const live = pinsRef.current;
      const shown: { key: string; el: HTMLDivElement; card: HTMLElement; op: number; box: PinBox }[] = [];
      for (const p of live) {
        const key = pinKey(p);
        const el = els.current.get(key);
        if (!el) continue;
        const card = el.lastElementChild as HTMLElement;
        const a = entryAnchor(world, civ, p.e);
        const c = a ? (toClient.current?.(a[0], a[1]) ?? null) : null;
        const op = pinOpacity(p, now);
        const x = c ? c[0] - rect.left : NaN;
        const y = c ? c[1] - rect.top : NaN;
        if (!(op > 0) || !(x >= 0 && y >= 0 && x <= rect.width && y <= rect.height)) {
          el.style.visibility = 'hidden';
          continue;
        }
        let sz = sizes.current.get(key);
        if (!sz) sizes.current.set(key, (sz = [card.offsetWidth, card.offsetHeight]));
        shown.push({ key, el, card, op, box: { x, y, w: sz[0], h: sz[1], side: sides.current.get(key) ?? -1 } });
      }
      // 底下让出时间轴那一行;窄屏的两行时间轴、开着的底部抽屉更高,按它们的上边让
      const app = layer.closest('.app');
      const low = app?.querySelector('.inspector.sheet:not(.hidden)') ?? app?.querySelector('.bottom-row');
      const bottom = low ? Math.max(BOTTOM_RESERVE, rect.bottom - low.getBoundingClientRect().top + 4) : BOTTOM_RESERVE;
      const placed = placeCards(
        shown.map((s) => s.box),
        rect.width,
        rect.height,
        8,
        bottom,
      );
      shown.forEach((s, i) => {
        const side = placed[i];
        sides.current.set(s.key, side);
        const [dx, dy] = cardOffset(side, s.box.w, s.box.h);
        s.el.style.visibility = 'visible';
        s.el.style.opacity = String(s.op);
        s.el.style.transform = `translate(${s.box.x}px, ${s.box.y}px)`;
        s.card.style.left = `${dx}px`;
        s.card.style.top = `${dy}px`;
      });
      if (live.some((p) => p.until <= now)) {
        setPins((ps) => (ps.some((p) => p.until <= now) ? ps.filter((p) => p.until > now) : ps));
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [pins, show, civ, world, toClient]);

  // 收掉的标签:忘掉它的大小和摆放
  useEffect(() => {
    const keep = new Set(pins.map(pinKey));
    for (const m of [sizes.current, sides.current]) for (const k of m.keys()) if (!keep.has(k)) m.delete(k);
  }, [pins]);

  if (!show) return null;
  return (
    <div
      ref={setLayer}
      className={`ev-pins${compat ? ' tb-compat' : ''}`}
      aria-live="polite"
    >
      {pins.map((p) => {
        const key = pinKey(p);
        return (
          <div
            key={key}
            className="ev-pin"
            data-ev={evType(p.e)}
            data-year={Math.floor(p.e.year)}
            ref={(el) => {
              if (el) els.current.set(key, el);
              else els.current.delete(key);
            }}
            style={{ visibility: 'hidden' }}
          >
            <i className="ev-ring" />
            <div className="ev-card">
              <span className="ev-head">
                <b className="tb-ev">{evLabel(p.e)}</b>
                {evYears(p.e)}
              </span>
              <span className="ev-text">{evText(p.e)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
