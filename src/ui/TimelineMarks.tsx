/**
 * 时间轴的轨道:1px 基线、每 100 年一格刻度(500、1000 年加长)、0 / 1000 / 2000 / 3000 年的字、
 * 事件菱形(颜色按事件类型)、干预的红线加"令"字、进度和播放头(按父元素的 CSS 变量 --p 画)。
 * 怎么排、太密怎么合并见 timelineLayout.ts。
 *
 * - 拖动 / 点空处:时间轴跳到那一年(暂停)。点菱形或"令":和在编年史里点那一条一样(civView.ts 的 pickChronicleEntry:
 *   跳到那一年、地图上闪出事发地、必要时平移地图)。
 * - 悬停菱形出提示(类型、年份、纪事);挤在一起合并成的菱形,提示里列出每一件,点哪一行就跳到哪一件。
 *   手机上点一下同时弹出提示,约三秒后收起。
 * - 键盘:← → 前后 10 年(按住 Shift 100 年),Home / End 到头 / 到尾。
 * - 只在换世界 / 换筛选 / 轨道宽度变了时重排。
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ChronicleEntry } from '../gen/civ/chronicle';
import { pickChronicleEntry, setCivTime, stepYear } from './civView';
import { evLabel, evText, evType, evYears, hitDiamonds, layoutDiamonds, type Diamond } from './timelineLayout';

/** 提示最多列几件 */
const TIP_ROWS = 5;
/** 指针在这条线以上(像素,轨道里)按下才算点菱形 / "令";以下是拖动年份 */
const MARK_ROW = 22;
/** 按下后移动超过这么多(像素)算拖动 */
const DRAG_SLOP = 3;

export interface TimelineMarksProps {
  /** 要画的纪事(按年份排好;已经按"大事"和国家筛过) */
  entries: readonly ChronicleEntry[];
  end: number;
  /** 时间轴在地图底部(提示朝上弹)还是顶部(提示朝下弹) */
  dock: 'top' | 'bottom' | 'inline';
  /** 当前年份(取整;读屏用) */
  year: number;
}

type Tip = Diamond & { pinned?: boolean };

export const TimelineMarks = memo(function TimelineMarks({ entries, end, dock, year }: TimelineMarksProps) {
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const hideTimer = useRef(0);
  const press = useRef<{ x: number; id: number; hit: Diamond | null; drag: boolean; touch: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => layoutDiamonds(entries, end, width), [entries, end, width]);

  // 换世界 / 换筛选:收起提示
  useEffect(() => setTip(null), [layout]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // 提示放在时间轴外面(底部时朝上、顶部时朝下),左右不出地图
  useLayoutEffect(() => {
    const el = tipRef.current;
    const track = ref.current;
    if (!el || !track || !tip) return;
    const bar = (track.closest('.timebar') ?? track).getBoundingClientRect();
    const stage = (track.closest('.stage') ?? document.body).getBoundingClientRect();
    const L = track.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = Math.max(stage.left + 8, Math.min(stage.right - 8 - r.width, L.left + tip.x - r.width / 2));
    const top = dock === 'top' ? bar.bottom + 6 : bar.top - 6 - r.height;
    el.style.left = `${left - L.left}px`;
    el.style.top = `${top - L.top}px`;
    el.style.visibility = 'visible';
  }, [tip, dock]);

  const keep = () => clearTimeout(hideTimer.current);
  const hideSoon = (ms: number) => {
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setTip(null), ms);
  };
  const localX = (cx: number) => cx - ref.current!.getBoundingClientRect().left;
  const yearAt = (cx: number) => Math.round(Math.min(1, Math.max(0, localX(cx) / Math.max(1, width))) * end);
  const scrub = (cx: number) => setCivTime({ year: yearAt(cx), playing: false, story: false, scrubbing: true });
  const inTip = (e: React.SyntheticEvent) => !!tipRef.current?.contains(e.target as Node);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || inTip(e)) return;
    const r = ref.current!.getBoundingClientRect();
    const hit = e.clientY - r.top < MARK_ROW ? hitDiamonds(layout, e.clientX - r.left) : null;
    press.current = { x: e.clientX, id: e.pointerId, hit, drag: false, touch: e.pointerType === 'touch' };
    // 拖出轨道也接着认(合成的指针事件没有真的指针,捕获会报错,不要紧)
    try {
      ref.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 没有这个指针 */
    }
    if (!hit) scrub(e.clientX);
  };
  const onMove = (e: React.PointerEvent) => {
    const pr = press.current;
    if (pr && pr.id === e.pointerId) {
      if (!pr.drag && Math.abs(e.clientX - pr.x) > DRAG_SLOP) pr.drag = true;
      if (pr.drag || !pr.hit) {
        setTip(null);
        scrub(e.clientX);
      }
      return;
    }
    if (inTip(e)) return keep();
    if (e.pointerType === 'touch') return;
    const h = hitDiamonds(layout, localX(e.clientX));
    if (h) {
      keep();
      setTip((t) => (t && t.lead === h.lead && t.x === h.x ? t : h));
    } else if (tip && !tip.pinned) hideSoon(180);
  };
  const onUp = (e: React.PointerEvent) => {
    const pr = press.current;
    if (!pr || pr.id !== e.pointerId) return;
    press.current = null;
    setCivTime({ scrubbing: false });
    if (pr.hit && !pr.drag) {
      pickChronicleEntry(pr.hit.lead);
      // 手机上没有悬停:点一下同时弹出提示,三秒后收起
      setTip({ ...pr.hit, pinned: pr.touch });
      if (pr.touch) hideSoon(3000);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 100 : 10;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') stepYear(end, -step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') stepYear(end, step);
    else if (e.key === 'Home' || e.key === 'End') setCivTime({ year: e.key === 'Home' ? 0 : end, playing: false, story: false });
    else return;
    e.preventDefault();
  };

  // 刻度、字、菱形、"令":只在排版变了时重新生成(播放时每年重新渲染一次,只改读屏用的年份)
  const hot = tip?.lead;
  const static_ = useMemo(() => {
    const ticks: ReactElement[] = [];
    if (end > 0) {
      for (let y = 0; y <= end; y += 100) {
        const cls = y % 1000 === 0 ? ' k' : y % 500 === 0 ? ' h' : '';
        ticks.push(<i key={y} className={`tb-tick${cls}`} style={{ left: `${(y / end) * 100}%` }} />);
      }
    }
    const labels = [0, 1000, 2000, 3000].filter((y) => y <= end);
    if (end % 1000 !== 0) labels.push(end);
    return (
      <>
        <i className="tb-base" />
        {ticks}
        {labels.map((y, i) => (
          <span key={y} className={`tb-label${i === 0 ? ' first' : y === end ? ' last' : ''}`} style={{ left: `${(y / Math.max(1, end)) * 100}%` }}>
            {y}
          </span>
        ))}
      </>
    );
  }, [end]);
  const marks = useMemo(
    () => (
      <>
        {layout.marks.map((d) => (
          <i
            key={`m${d.lead.id}`}
            className={`tb-mark${d.items.length > 1 ? ' many' : ''}${hot === d.lead ? ' on' : ''}`}
            data-ev={evType(d.lead)}
            data-year={Math.floor(d.lead.year)}
            data-n={d.items.length}
            style={{ left: d.x }}
          />
        ))}
        {layout.orders.map((d) => (
          <i
            key={`o${d.lead.id}`}
            className={`tb-order${hot === d.lead ? ' on' : ''}${d.x > width - 18 ? ' end' : ''}`}
            data-year={Math.floor(d.lead.year)}
            data-n={d.items.length}
            style={{ left: d.x }}
          >
            <b>令</b>
          </i>
        ))}
      </>
    ),
    [layout, hot, width],
  );

  const more = tip ? tip.items.length - TIP_ROWS : 0;
  return (
    <div
      ref={ref}
      className={`tb-track${tip ? ' hot' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="年份"
      aria-valuemin={0}
      aria-valuemax={end}
      aria-valuenow={year}
      aria-valuetext={`第 ${year} 年`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => tip && !tip.pinned && hideSoon(220)}
      onKeyDown={onKey}
    >
      {static_}
      <i className="tb-prog" />
      {marks}
      <i className="tb-head" />
      {tip && (
        <div
          ref={tipRef}
          className="tb-tip"
          style={{ visibility: 'hidden' }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={keep}
          onPointerLeave={() => !tip.pinned && hideSoon(220)}
        >
          {tip.items.slice(0, TIP_ROWS).map((e) => (
            <div
              key={e.id}
              className={`tb-tip-row${e === tip.lead ? ' lead' : ''}`}
              data-ev={evType(e)}
              onClick={() => {
                pickChronicleEntry(e);
                setTip({ ...tip, lead: e });
              }}
            >
              <b className="tb-ev">{evLabel(e)}</b>
              <span className="tb-tip-year">{evYears(e)}</span>
              <span className="tb-tip-text">{evText(e)}</span>
            </div>
          ))}
          {more > 0 && <div className="tb-tip-more">这里还有 {more} 件,打开编年史看全部</div>}
        </div>
      )}
    </div>
  );
});
