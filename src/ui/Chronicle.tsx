/**
 * 世界概览的"编年史"页:按年份列出推演里的大事(条目由 gen/civ/chronicle.ts 写好),新的在上。
 * 一行:年份(宋体)· 类型(彩色粗体:战争 / 改朝 / 立国 / 称帝 / 同化 / 宗教 / 干预……)· 纪事正文。
 * 宗教的事(创教、立国教、传入、教派分立、圣城易主)不是史事,按年份并进来(religionText.ts 的 fullChronicle)。
 *
 * - 点一条:收起概览,时间轴跳到那一年并暂停,打开"国家"图层,地图上事发的州 / 相关国家闪约两秒
 *   (高亮在 CivLayer 画;事发地不在视野里时 App 把地图平移过去)。
 * - 战争折叠成一条(起止年份、交战双方、结果),点右边的数字展开看开战、每一次攻占、没打下来的战役、被迫迁都;
 *   "大事 / 全部"(按钮上写各自的条数;按国家看时是这一国的条数);国家下拉框:只看这一国的事
 *   (别处打开:openOverview('chronicle', { polity }),见 overviewStore.ts)。
 *   只看一国时,"全部"里按年份插进这一国的历代君主继位(全世界的继位太多,看全部国家、看"大事"时不列)。
 * - 回放 / 拖时间轴时:还没发生的事(在上面)淡显,"现在"线跟着走、列表跟着滚。这一步不经过 React
 *   (订阅时间轴,直接改行的 data-st 属性和 scrollTop),几千条也不会每帧重排。
 * - "复制全文":当前列出的纪事(含战争里的每一件事)复制成纯文本,给 OC 作者写设定用。
 * - "写成史书"(阶段 5):打开 HistoryBook 窗口;按国家看时默认写这一国的国史。「使用 AI 功能」关着时没有这个按钮。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import { chronicleText, filterChronicle, polityChronicle, yearText, type ChronicleEntry } from '../gen/civ/chronicle';
import { fullChronicle } from '../gen/civ/religionText';
import { polityName } from '../gen/civ/growth';
import { getCivTime, pickChronicleEntry, setChronicle, subscribeCivTime, useChronicle, useChroniclePick, type CivTime } from './civView';
import { evLabel, evType } from './timelineLayout';
import { openHistoryBook } from './HistoryBook';
import { useAiOn } from '../ai/client';
import { closeOverview } from './overviewStore';
import { EntryText } from './panelParts';
import { polityHistory } from './WorldOverviewCountries';
import { PolityFlag } from './Flag';
import './timeline.css';

/** 同一条纪事(改名后编年史重写了一遍,条目是新对象:按史事下标、种类、是不是折叠的认) */
function sameEntry(a: ChronicleEntry | null, b: ChronicleEntry): boolean {
  return a === b || (!!a && a.id === b.id && a.kind === b.kind && !!a.children === !!b.children);
}

/** 回放时"现在"那条线保持在列表可视范围的这个高度(比例) */
const FOLLOW_AT = 0.4;
/** "现在"线占的缝(像素,和 overview.css 的 .chron-item[data-next] 一致) */
const NOW_GAP = 20;
/** 行的状态(data-st):已发生 / 进行中(战争打到一半)/ 还没发生 */
const ST = ['past', 'live', 'future'] as const;

export function Chronicle({ civ }: { civ: Civ | null }) {
  const view = useChronicle();
  const aiOn = useAiOn();
  const all = useMemo(() => (civ ? fullChronicle(civ) : []), [civ]);
  // 按国家筛过的"全部"和"大事"(两个按钮上各写条数),当前列出的是其中之一;只看一国时"全部"里并进这一国的君主继位
  const mine = useMemo(() => {
    if (!civ || view.polity === null) return filterChronicle(all, { polity: view.polity });
    return polityChronicle(civ, all, view.polity);
  }, [civ, all, view.polity]);
  const majors = useMemo(() => filterChronicle(mine, { major: true }), [mine]);
  const list = view.major ? majors : mine;
  /** 列出来的顺序:新的在上(战争里的每一件事仍按先后) */
  const shown = useMemo(() => [...list].reverse(), [list]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  // 选中的那一条(点这里的一行或时间轴上的刻度,都经过 civView.ts 的 pickChronicleEntry)
  const picked = useChroniclePick();
  const active = picked.entry;
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  /** 国家下拉框:在编年史里出现过的国家,鼎盛时大的在前 */
  const choices = useMemo(() => {
    if (!civ || !civ.viable || !civ.polities.length) return [];
    const seen = new Set<number>();
    for (const e of all) for (const p of e.polities) seen.add(p);
    const peak = polityHistory(civ).peak;
    return [...seen]
      .filter((id) => civ.polities[id])
      .sort((a, b) => peak[b] - peak[a] || a - b)
      .map((id) => {
        const p = civ.polities[id];
        return { id, name: polityName(p, Math.min(civ.endYear, p.ended ?? civ.endYear)) };
      });
  }, [civ, all]);

  // 换世界时收起所有战争(改名只换 civ 对象、州还是同一份,不收)
  const world = civ?.regions;
  useEffect(() => {
    setExpanded(new Set());
  }, [world]);

  // 点了一条(时间轴上的刻度):战争自动展开;这一条不在列表的可视范围里就滚过去
  const seenStamp = useRef(picked.stamp);
  useEffect(() => {
    if (picked.stamp === seenStamp.current) return;
    seenStamp.current = picked.stamp;
    const e = picked.entry;
    if (!e) return;
    if (e.children) setExpanded((s) => (s.has(e.id) ? s : new Set(s).add(e.id)));
    const raf = requestAnimationFrame(() => {
      const box = listRef.current;
      const row = box?.querySelector<HTMLElement>(`[data-top='1'][data-id='${e.id}']`);
      if (!box || !row) return;
      const b = box.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= b.top && r.bottom <= b.bottom) return;
      box.scrollTop += r.top - b.top - b.height * 0.3;
    });
    return () => cancelAnimationFrame(raf);
  }, [picked]);

  // ---- 跟着时间轴:淡显还没发生的、标出进行中的战争、"现在"线,回放 / 拖动时滚动 ----
  // 人物卡片的"编年史"带着 at:打开后滚到那一年(滚过去就清掉)
  useNowLine({ listRef, nowRef, civ, jumpKey: shown, deps: [expanded], at: view.at ?? null, onAt: () => setChronicle({ at: null }) });

  if (!civ) return <section className="chronicle" />;

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const focus = view.polity !== null ? civ.polities[view.polity] : undefined;
  const focusName = focus ? polityName(focus, Math.min(civ.endYear, focus.ended ?? civ.endYear)) : '';

  const copy = async () => {
    const title = `编年史 · 种子 ${civ.seed}${focus ? ` · 只看${focusName}` : ''}${view.major ? ' · 大事' : ''}`;
    const text = chronicleText(list, title);
    (window as unknown as { __wfChronicleText: string }).__wfChronicleText = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 没有剪贴板权限(非安全来源等):退回老办法
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  /** 点一条:收起概览,时间轴跳过去、地图上闪出事发地 */
  const pick = (e: ChronicleEntry) => {
    closeOverview();
    pickChronicleEntry(e);
  };

  const row = (e: ChronicleEntry, top: boolean) => {
    const a = Math.floor(e.year);
    const b = Math.floor(e.end);
    const kids = top ? e.children : undefined;
    const isOpen = !!kids && expanded.has(e.id);
    return (
      <div
        className={`chron-row imp${e.importance}${sameEntry(active, e) ? ' on' : ''}${top ? '' : ' kid'}`}
        data-y={e.year}
        data-e={e.end}
        data-top={top ? '1' : '0'}
        data-id={e.id}
        data-ev={evType(e)}
        onClick={() => pick(e)}
        title="时间轴跳到这一年,地图上闪出事发地"
      >
        <span className="chron-year">
          {a}
          {top && b > a && <em>–{b}</em>}
        </span>
        <b className="tb-ev chron-type">{evLabel(e)}</b>
        <span className="chron-text">
          <EntryText civ={civ} e={e} />
        </span>
        {kids && (
          <button
            className={`chron-fold${isOpen ? ' open' : ''}`}
            title={isOpen ? '收起' : '展开这场战争里的每一件事'}
            onClick={(ev) => {
              ev.stopPropagation();
              toggle(e.id);
            }}
          >
            {kids.length}
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="chronicle">
      <div className="chron-filters">
        <div className="seg">
          <button className={view.major ? 'on' : ''} onClick={() => setChronicle({ major: true })} title={`大国立国、称王称帝、改变格局的战争、分裂、复国、合并……`}>
            大事 <span className="chron-n">{majors.length}</span>
          </button>
          <button className={view.major ? '' : 'on'} onClick={() => setChronicle({ major: false })} title="所有纪事(含小国、小仗、部落)">
            全部 <span className="chron-n">{mine.length}</span>
          </button>
        </div>
        {choices.length > 0 && (
          <label className={`chron-pick${focus ? ' on' : ''}`}>
            {focus && <PolityFlag id={focus.id} year={civ.endYear} w={21} className="chron-flag" fallback={<i style={{ background: `rgb(${focus.color.join(',')})` }} aria-hidden="true" />} />}
            <select
              aria-label="只看某一国"
              data-act="chron-polity"
              value={view.polity ?? ''}
              onChange={(ev) => setChronicle({ polity: ev.target.value === '' ? null : Number(ev.target.value) })}
            >
              <option value="">全部国家</option>
              {focus && !choices.some((c) => c.id === view.polity) && <option value={view.polity!}>{focusName}</option>}
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="chron-acts">
          <button className="ov-btn chron-copy" onClick={copy} disabled={!list.length} title="把列出的纪事(含战争里的每一件事)复制成纯文本">
            {copied ? '已复制' : '复制全文'}
          </button>
          {aiOn && (
            <button
              className="ov-btn chron-ai"
              onClick={() => {
                closeOverview();
                openHistoryBook({ polity: view.polity });
              }}
              disabled={!all.length}
              title={focus ? `用 AI 把${focusName}的历史写成国史` : '用 AI 把推演出来的历史写成史书'}
            >
              {focus ? '写成国史' : '写成史书'}
            </button>
          )}
        </span>
      </div>
      <div className="chron-list" ref={listRef}>
        {shown.map((e) => (
          <div key={e.id} className="chron-item">
            {row(e, true)}
            {e.children && expanded.has(e.id) && <div className="chron-kids">{e.children.map((c) => <div key={c.id}>{row(c, false)}</div>)}</div>}
          </div>
        ))}
        <div className="chron-now" ref={nowRef}>
          <span />
        </div>
        {!list.length && (
          <div className="ov-empty">
            {!all.length
              ? civ.polities.length
                ? '还没有史事'
                : '这颗星球上还没有国家,也就还没有史事'
              : focus && view.major
                ? `${focusName}没有大事可记,切到"全部"看看`
                : '没有符合的纪事'}
          </div>
        )}
      </div>
    </section>
  );
}

export interface NowLineOpts {
  listRef: RefObject<HTMLDivElement>;
  nowRef: RefObject<HTMLDivElement>;
  civ: Civ | null;
  /** 列表换了(换世界 / 换筛选)之后第一次同步滚到当前年份:换了它就算换了 */
  jumpKey: unknown;
  /** 别的会让行重新排的东西(展开的战争……) */
  deps?: readonly unknown[];
  /** 打开后滚到这一年(不给 = 滚到"现在"线);滚过去以后调 onAt */
  at?: number | null;
  onAt?: () => void;
  /** 画"现在"线(不给 = 画;行不是一条时间线时不画,只淡显还没发生的) */
  line?: boolean;
}

/**
 * 列表跟着时间轴(编年史、人物页共用):行上带 data-y(开始年份)、data-e(结束年份)、data-top="1"(顶层的一行,
 * 它的上一层是一项);还没发生的(在上面)淡显,"现在"线放在第一项已经发生的上方,回放 / 拖动时滚动。
 * 这一步不经过 React(订阅时间轴,直接改行的 data-st 属性和 scrollTop),几千条也不会每帧重排
 */
export function useNowLine({ listRef, nowRef, civ, jumpKey, deps = [], at = null, onAt, line: withLine = true }: NowLineOpts) {
  /** 列表换了之后第一次同步:滚到当前年份 */
  const scrolledFor = useRef<unknown>(null);
  useLayoutEffect(() => {
    const box = listRef.current;
    if (!box || !civ) return;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-y]')];
    const ys = rows.map((r) => Number(r.dataset.y));
    const es = rows.map((r) => Number(r.dataset.e));
    const items = rows.map((r) => (r.dataset.top === '1' ? (r.parentElement as HTMLElement) : null));
    // 状态记在 data-st / data-next 上(React 不管这两个属性,重新渲染时不会被冲掉)
    const state = new Int8Array(rows.length).fill(-1);
    const end = civ.endYear;
    let shownYear = -1;
    /** "现在"线下面的第一条:还没发生的(在上面)之后,第一条已经发生的(它上面空出一道缝放线) */
    let next: HTMLElement | null = null;
    for (const el of box.querySelectorAll<HTMLElement>('[data-next]')) delete el.dataset.next;
    const sync = (t: CivTime, jump: boolean) => {
      const y = Math.min(end, Math.max(0, t.year ?? end));
      let first: HTMLElement | null = null;
      let future = false;
      for (let i = 0; i < rows.length; i++) {
        const s = ys[i] > y ? 2 : es[i] > y ? 1 : 0;
        if (s !== state[i]) {
          rows[i].dataset.st = ST[s];
          state[i] = s;
        }
        if (items[i]) {
          if (s === 2) future = true;
          else if (!first && future) first = items[i];
        }
      }
      // 都已发生、或者不画线(行不是一条时间线):不空出放线的缝
      if (y >= end || !withLine) first = null;
      if (first !== next) {
        if (next) delete next.dataset.next;
        if (first) first.dataset.next = '1';
        next = first;
      }
      const line = nowRef.current;
      if (!line) return;
      if (!withLine) {
        line.style.display = 'none';
        return;
      }
      line.style.display = next ? '' : 'none';
      if (!next) {
        // 都已发生:停在最上面(最新的);都还没发生:停在最下面
        if (jump) box.scrollTop = future ? box.scrollHeight : 0;
        return;
      }
      const pos = next.offsetTop - NOW_GAP / 2;
      line.style.top = `${pos}px`;
      if (Math.floor(y) !== shownYear) {
        shownYear = Math.floor(y);
        line.firstElementChild!.textContent = yearText(y);
      }
      const h = box.clientHeight;
      const follow = t.playing || t.scrubbing;
      if (jump || (follow && (pos < box.scrollTop + h * 0.12 || pos > box.scrollTop + h * 0.8))) {
        box.scrollTop = Math.max(0, pos - h * FOLLOW_AT);
      }
    };
    const jump = scrolledFor.current !== jumpKey;
    scrolledFor.current = jumpKey;
    sync(getCivTime(), jump);
    if (at !== null) {
      // 新的在上:滚到 at 那年或更早的第一条
      const k = ys.findIndex((y, i) => items[i] && y <= at + 1e-6);
      const row = k >= 0 ? rows[k] : null;
      if (row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight * 0.3);
      onAt?.();
    }
    return subscribeCivTime((t) => sync(t, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [civ, jumpKey, at, withLine, ...deps]);
}
