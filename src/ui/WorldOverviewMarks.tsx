/**
 * 世界概览的「标记」页(在「人物」后面):作者在地图上放的标记(数据格式见 gen/edits.ts 文件头"作者标记")列成表,
 * 点一行打开标记卡片(收起概览,地图移过去)。
 *
 *   全部 / 这一年有的(时间轴当前那一年地图上有的)
 *   每个标记一行:年份(从–到 / 从…起)、颜色圆点和名字、"在哪。说明";按「从」排,新的在上(同一年的先加的在上)
 *   和编年史一样跟着时间轴:还没开始的淡显,"现在"线在第一个已经开始的上方(Chronicle.tsx 的 useNowLine)
 *   「加标记」= 收起概览、进入"点地图放标记";「复制全文」复制成纯文字
 */
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { markShownAt, type AuthorMark } from '../gen/edits';
import { MARK_HEX } from '../render/marks';
import { useEdits } from './editsStore';
import { getCivTime, setSelection, subscribeCivTime } from './civView';
import { closeOverview } from './overviewStore';
import { useNowLine } from './Chronicle';
import { markPlaceText, markYears } from './markInfo';
import { startPlacing } from './markStore';
import { copyText } from './panelParts';
import { useNarrow } from './device';
import './timeline.css';
import './marks.css';

/** 时间轴当前那一年(取整;一年只重新渲染一次;人物页的「我的」也用) */
export function useYear(civ: Civ | null): number {
  const end = civ?.endYear ?? 0;
  return useSyncExternalStore(
    (f) => subscribeCivTime(() => f()),
    () => Math.floor(Math.min(end, Math.max(0, getCivTime().year ?? end))),
  );
}

interface MRow {
  m: AuthorMark;
  /** "在哪。说明"(说明里的换行换成空格) */
  line: string;
}

export function MarksPage({ civ, data }: { civ: Civ | null; data: { world: World; raster: Raster } | null }) {
  const edits = useEdits();
  const year = useYear(civ);
  const narrow = useNarrow();
  const listRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const [only, setOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const marks = edits.marks;
  const all = useMemo((): MRow[] => {
    if (!civ || !data || !marks) return [];
    return [...marks]
      .sort((a, b) => b.from - a.from || a.id - b.id)
      .map((m) => {
        const place = markPlaceText(civ, data.world, data.raster, m, Math.min(civ.endYear, Math.max(0, m.from)));
        const note = (m.note ?? '').replace(/\s*\n\s*/g, ' ').trim();
        return { m, line: [place, note].filter(Boolean).join('。') };
      });
  }, [civ, data, marks]);
  const shownNow = useMemo(() => all.filter((r) => markShownAt(r.m, year)), [all, year]);
  const rows = only ? shownNow : all;
  useNowLine({ listRef, nowRef, civ, jumpKey: rows.length + (only ? 'n' : 'a'), deps: [rows] });

  if (!civ) return <section className="chronicle marks" />;

  const add = () => {
    closeOverview();
    startPlacing();
  };
  const copy = async () => {
    const lines = [`标记 · 种子 ${civ.seed}${only ? ` · 第 ${year} 年有的` : ''}`, ''];
    for (const r of rows) lines.push(`${markYears(r.m)} ${r.m.title}${r.line ? ` ${r.line}` : ''}`);
    const text = lines.join('\n').trim();
    (window as unknown as { __wfMarksText: string }).__wfMarksText = text;
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const open = (id: number) => {
    closeOverview();
    setSelection({ kind: 'mark', id });
  };

  return (
    <section className="chronicle marks">
      <div className="chron-filters">
        <div className="seg">
          <button className={only ? '' : 'on'} data-list="all" onClick={() => setOnly(false)}>
            全部 <span className="chron-n">{all.length}</span>
          </button>
          <button className={only ? 'on' : ''} data-list="now" title="时间轴当前这一年地图上有的" onClick={() => setOnly(true)}>
            这一年有的 <span className="chron-n">{shownNow.length}</span>
          </button>
        </div>
        <span className="chron-acts">
          <button className="ov-btn" data-act="marks-add" onClick={add} title="收起概览,在地图上点一下放标记">
            加标记
          </button>
          <button className="ov-btn chron-copy" data-act="marks-copy" onClick={() => void copy()} disabled={!rows.length} title="把列出的标记复制成纯文本">
            {copied ? '已复制' : '复制全文'}
          </button>
        </span>
      </div>
      <div className="chron-list" ref={listRef}>
        {rows.map((r) => (
          <div key={r.m.id} className="chron-item">
            <div className="chron-row pp-row mk-row" data-y={r.m.from} data-e={r.m.to === undefined ? 1e9 : r.m.to + 1} data-top="1" data-mark={r.m.id} title="看这个标记" onClick={() => open(r.m.id)}>
              <span className="chron-year">
                {r.m.from}
                <em>{r.m.to === undefined ? '起' : `–${r.m.to}`}</em>
              </span>
              <b className="mk-who">
                <i className="mk-dot" style={{ background: MARK_HEX[r.m.color] }} aria-hidden="true" />
                {r.m.title}
              </b>
              <span className="chron-text">{r.line}</span>
            </div>
          </div>
        ))}
        <div className="chron-now" ref={nowRef}>
          <span />
        </div>
        {!all.length && (
          <div className="ov-empty">{narrow ? '还没有标记，点地图右上角的图钉，或者在城、州卡片的「更多」里加。' : '还没有标记，点地图右下角的「标记」，或者在城、州卡片的「更多」里加。'}</div>
        )}
        {all.length > 0 && !rows.length && <div className="ov-empty">第 {year} 年地图上没有标记</div>}
      </div>
    </section>
  );
}
