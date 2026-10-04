/**
 * 地图四角的小字和按钮(界面骨架):地图铺满全屏,常驻界面只有这些。
 *
 *   左上 WorldTitle   世界名(宋体)+ 一行副标"种子 7 · 现存 12 国 · 未干预 · 查看概览 ›",点一下打开概览
 *                     (窄屏:世界名 20px,副标缩成"种子 7 · 12 国 · 概览 ›")
 *   右上 TopActions   "搜索""改写""成书";写史书时前面是"正在撰写《某某通史》"+ 细进度条,写完变成"《某某通史》已完成 · 打开"
 *                     (窄屏:进度缩成按钮下面的一条小进度条;搜索框、改写框全宽展开在顶栏下方)。
 *                     改写 = 用一句话让 AI 改世界(Rewrite.tsx;没长出文明的世界也能用,只能改地形),和搜索框同一时间只开一个
 *   右下 MapControls  "地球仪 / 平面地图"切换、放大、缩小;右侧详情面板打开时整体左移(触屏不放 + −,窄屏整个不放)
 *   底部 FirstHint    第一次打开时的一行操作提示,第一次拖动 / 缩放 / 点击之后不再出现(触屏换成"双指缩放"的说法)
 *   跟随鼠标 HoverCard 悬停小卡片(内容见 hoverInfo.ts)
 * 地图上的文字按钮不加底、只带描边(--halo),悬停出现浅灰底。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { polityAlive } from '../gen/civ/growth';
import { useCivTime } from './civView';
import { useEdits } from './editsStore';
import { currentWorld, useSavesVersion } from './saveStore';
import { openHistoryBook } from './HistoryBook';
import { bookProgress, bookTitleText, openBookReader, useBook } from './bookStore';
import { SearchBox } from './Search';
import { RewriteBox } from './Rewrite';
import type { HoverInfo } from './hoverInfo';
import { useNarrow } from './device';
import './book.css';

export function WorldTitle({ seed, civ, onOpen }: { seed: number | null; civ: Civ | null; onOpen: () => void }) {
  useSavesVersion();
  const edits = useEdits();
  const t = useCivTime();
  const title = currentWorld()?.title;
  const year = civ ? Math.floor(Math.min(civ.endYear, Math.max(0, t.year ?? civ.endYear))) : 0;
  const alive = civ && civ.viable ? civ.polities.filter((p) => polityAlive(p, year)).length : 0;
  const n = edits.interventions.length;
  const narrow = useNarrow();
  // 窄屏放不下一整行:只留种子、国家数(干预数在概览里)
  const parts = narrow
    ? [seed !== null ? `种子 ${seed}` : '正在生成', civ ? (civ.viable ? `${alive} 国` : '没有文明') : null].filter(Boolean)
    : [seed !== null ? `种子 ${seed}` : '正在生成', civ ? (civ.viable ? `现存 ${alive} 国` : '没有文明') : null, n ? `已干预 ${n} 处` : '未干预'].filter(Boolean);
  return (
    <button className="world-title" data-act="overview" onClick={onOpen} onPointerDown={(e) => e.stopPropagation()}>
      <span className="wt-name">{title || '未命名世界'}</span>
      <span className="wt-sub">
        {parts.join(' · ')} · <span className="wt-more">{narrow ? '概览 ›' : '查看概览 ›'}</span>
      </span>
    </button>
  );
}

export function TopActions({ canWrite, civ, world, busy = false }: { canWrite: boolean; civ?: Civ | null; world?: World | null; busy?: boolean }) {
  const [open, setOpen] = useState<'search' | 'rewrite' | null>(null);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const rewriteBtn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(null), []);
  const canSearch = !!civ && civ.viable;
  // 改写不要求有文明:没长出文明的世界也能改地形
  const canRewrite = !!civ && !!world;
  const toggle = (k: 'search' | 'rewrite') => setOpen((o) => (o === k ? null : k));
  return (
    <div
      className={`top-actions${open === 'search' ? ' search-on' : open === 'rewrite' ? ' rewrite-on' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <BookChip />
      <button
        ref={searchBtn}
        className={`map-btn${open === 'search' ? ' on' : ''}`}
        data-act="search"
        disabled={!canSearch}
        onClick={() => toggle('search')}
        title="按名字找国家、城市、民族、山河"
      >
        搜索
      </button>
      <button
        ref={rewriteBtn}
        className={`map-btn${open === 'rewrite' ? ' on' : ''}`}
        data-act="rewrite"
        disabled={!canRewrite}
        onClick={() => toggle('rewrite')}
        title="用一句话告诉 AI 想怎么改这个世界"
      >
        改写
      </button>
      <button className="map-btn" data-act="book" disabled={!canWrite} onClick={() => openHistoryBook()} title="用 AI 把推演出来的历史写成史书">
        成书
      </button>
      {open === 'search' && canSearch && <SearchBox civ={civ!} onClose={close} anchor={searchBtn} />}
      {open === 'rewrite' && canRewrite && <RewriteBox civ={civ!} world={world!} busy={busy} onClose={close} anchor={rewriteBtn} />}
    </div>
  );
}

/** 右上的写作进度:"正在撰写《某某通史》"+ 80px 细进度条;写完"《某某通史》已完成 · 打开",点开读过就收起 */
function BookChip() {
  const { job } = useBook();
  useSavesVersion();
  if (!job || !(job.status === 'writing' || (job.status === 'done' && !job.seen))) return null;
  const name = bookTitleText(job.title, job.opts.scope, currentWorld()?.title);
  const writing = job.status === 'writing';
  const pct = Math.round(bookProgress(job) * 100);
  return (
    <button
      className={`book-chip${writing ? '' : ' done'}`}
      data-act="book-progress"
      onClick={() => openBookReader(writing ? null : job.key)}
      title={writing ? '看看写到哪了' : '打开阅读'}
    >
      <span className="book-chip-text">{writing ? `正在撰写${name}` : `${name}已完成 · 打开`}</span>
      <span className="book-chip-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </span>
    </button>
  );
}

export function MapControls({
  globeOn,
  onToggleGlobe,
  onZoom,
  shifted,
  hidden,
  zoom = true,
}: {
  globeOn: boolean;
  onToggleGlobe: () => void;
  onZoom: (factor: number) => void;
  shifted: boolean;
  hidden?: boolean;
  /** 放不放 + −(触屏用双指捏合,不放) */
  zoom?: boolean;
}) {
  if (hidden) return null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className={`map-controls${shifted ? ' shifted' : ''}`} onPointerDown={stop} onDoubleClick={stop}>
      <button className="mc-btn mc-globe globe-toggle" data-act="globe" onClick={onToggleGlobe} title={globeOn ? '回到平面地图' : '显示成可以转动的地球仪'}>
        {globeOn ? '平面地图' : '地球仪'}
      </button>
      {zoom && (
        <>
          <button className="mc-btn mc-zoom" data-act="zoom-in" onClick={() => onZoom(1.5)} title="放大" aria-label="放大">
            +
          </button>
          <button className="mc-btn mc-zoom" data-act="zoom-out" onClick={() => onZoom(1 / 1.5)} title="缩小" aria-label="缩小">
            −
          </button>
        </>
      )}
    </div>
  );
}

/** 第一次打开的操作提示是否已经看过(拖过、缩放过、点过);存在浏览器里,存不了就只管这一次 */
const HINT_KEY = 'wenming-ditu:hint-seen';
export function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}
export function markHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* 隐私模式:只管这一次 */
  }
}

export function FirstHint({ show, touch }: { show: boolean; touch?: boolean }) {
  if (!show) return null;
  return <div className="first-hint">{touch ? '拖动地图 · 双指缩放 · 点国家看详情' : '拖动地图 · 滚轮缩放 · 点击国家查看详情'}</div>;
}

/** 悬停小卡片:跟着鼠标,靠右 / 靠下时翻到另一边 */
export function HoverCard({ info, x, y }: { info: HoverInfo; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== size.w || h !== size.h) setSize({ w, h });
  });
  const vw = typeof window === 'undefined' ? 1e4 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 1e4 : window.innerHeight;
  const left = x + 16 + size.w > vw - 8 ? x - 12 - size.w : x + 16;
  const top = y + 14 + size.h > vh - 8 ? y - 10 - size.h : y + 14;
  return (
    <div ref={ref} className="hover hover-card" style={{ left, top }} role="tooltip">
      <div className="hc-line">
        {info.color && <i className="hc-sw" style={{ background: info.color }} />}
        <span className="hc-name">{info.name}</span>
        {info.sub && <span className="hc-sub">{info.sub}</span>}
      </div>
      {info.extra && <div className="hc-extra">{info.extra}</div>}
    </div>
  );
}
