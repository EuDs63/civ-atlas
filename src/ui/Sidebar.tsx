/**
 * 左边的侧栏(宽屏):界面的主体都在这里,地图在它右边。样子照常见的地图应用。
 *
 *   顶上   "‹ 我的世界";世界名、"种子 7，现存 14 国";存档、更多(写成史书、AI 设置、关于);下面一个搜索框
 *          (用一句话改世界、问问题在右上「助手」打开的助手面板里,见 Assistant.tsx)
 *   下面   三选一 ——
 *          搜索框里有字:搜索结果(点一条 = 选中它,地图飞过去)
 *          地图上选中了东西:它的详情(Inspector:国家 / 城 / 地理实体 / 州的面板)
 *          什么都没选:整个世界(WorldHome:信仰(只在信仰图层)、国家按大小排、最近大事、我的干预、这颗星球)
 * 收起:卡片右上角的侧栏图标 → 卡片往左滑走,左上角留一个小按钮(侧栏图标 + 世界名),点它滑回来;记在浏览器里(sideStore.ts)。
 *       收起时选中了东西,卡片弹出来显示它,取消选中又收回去;收起时搜索框跟着卡片一起收起。
 * 新建世界这一步左边是另一张卡片(NewWorld.tsx),不收起。
 *
 * 窄屏(手机)不用这个侧栏:同样的内容放进底部的世界卡片(PhoneSheet.tsx),这里的零件(搜索、世界名、"更多"菜单、整个世界)两边共用。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World, WorldParams } from '../gen/world';
import { capitalAt, polityAlive, polityName } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { filterChronicle } from '../gen/civ/chronicle';
import { faithRows, fullChronicle } from '../gen/civ/religionText';
import { getCivTime, pickChronicleEntry, setSelection, subscribeCivTime, useCivShow, useSelection } from './civView';
import { useEdits } from './editsStore';
import { currentWorld, useSavesVersion } from './saveStore';
import { SaveMenu } from './SaveMenu';
import { openAiSettings } from './AiSettings';
import { openHistoryBook } from './bookStore';
import { openOverview } from './overviewStore';
import { searchCiv, type SearchHit } from './searchIndex';
import { countUpTo } from './timelineLayout';
import { Icon } from './icons';
import { AiMenuItem, AiSettingsItem, MenuItem, MenuSep, PopMenu } from './PopMenu';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import { useCoarse } from './device';
import { keyLabel } from './shortcuts';
import { openShortcuts } from './ShortcutsDialog';
import { EntryText, jumpTo, rgb } from './panelParts';
import { collapseSide, expandSide, useSide } from './sideStore';
import './sidebar.css';

export interface SidebarProps {
  data: { world: World; raster: Raster } | null;
  /** 套上改名的历史(界面上显示的那一份) */
  civ: Civ | null;
  /** 没套改名的历史 */
  raw: Civ | null;
  params: WorldParams;
  /** 世界还在生成 */
  generating: boolean;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 回到"我的世界" */
  onHome: () => void;
  /** 详情面板放进来的空位(面板只挂一份,由 App 挪到这里;见 App 的 inspectorHost) */
  inspectorSlot: (el: HTMLElement | null) => void;
}

const subscribeYear = (f: () => void) => subscribeCivTime(() => f());

/** 时间轴当前年份(取整;播放时一年只重新渲染一次) */
function useYear(civ: Civ | null): number {
  const end = civ?.endYear ?? 0;
  return useSyncExternalStore(subscribeYear, () => Math.floor(Math.min(end, Math.max(0, getCivTime().year ?? end))));
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function Sidebar(p: SidebarProps) {
  const { sel } = useSelection();
  const s = useSearch(p.civ);
  const side = useSide();
  /** 收起了(弹出来显示选中的东西时不算):卡片滑到左边外面,换成左上角的小按钮 */
  const hidden = side.collapsed && !side.peek;
  return (
    <>
      <aside
        className={`sidebar${hidden ? ' side-hidden' : ''}`}
        aria-label="侧栏"
        aria-hidden={hidden || undefined}
        ref={(el) => el?.toggleAttribute('inert', hidden)}
        onPointerDown={stop}
        onDoubleClick={stop}
        onClick={stop}
      >
        <header className="sb-head">
          <BackHome onClick={p.onHome} />
          <button className="sb-collapse" data-act="side-collapse" aria-label="收起侧栏" data-tip="收起侧栏" data-tip-key="side" data-tip-side="left" onClick={collapseSide}>
            <Icon name="sidebar" size={19} />
          </button>
          <WorldHead {...p} />
          <SearchField s={s} civ={p.civ} />
        </header>
        <div className="sb-body">
          {s.searching ? (
            <SearchResults q={s.q} hits={s.hits} active={s.active} onActive={s.setActive} onPick={s.pick} />
          ) : sel && p.civ && p.raw && p.data ? (
            <div className="inspector-slot" ref={p.inspectorSlot} />
          ) : (
            <WorldHome {...p} />
          )}
        </div>
      </aside>
      {hidden && <SideOpen civ={p.civ} data={p.data} />}
    </>
  );
}

/** 卡片收起后左上角的小按钮:侧栏图标 + 世界名,点它卡片滑回来 */
function SideOpen({ civ, data }: Pick<SidebarProps, 'civ' | 'data'>) {
  const { title } = useWorldInfo(civ, data);
  return (
    <button className="side-open glass" data-act="side-expand" aria-label={`展开侧栏:${title}`} onPointerDown={stop} onDoubleClick={stop} onClick={expandSide}>
      <Icon name="sidebar" size={19} />
      <span className="side-open-name">{title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 搜索框(宽屏侧栏、手机的世界卡片共用)

export interface SearchState {
  q: string;
  setQ: (q: string) => void;
  hits: SearchHit[];
  active: number;
  setActive: (i: number) => void;
  /** 点一条 / 回车:清空搜索框,选中它(地图飞过去) */
  pick: (h: SearchHit) => void;
  searching: boolean;
}

export function useSearch(civ: Civ | null): SearchState {
  const { sel } = useSelection();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const civOk = !!civ && civ.viable;
  // 年份取开始搜索那一刻的(播放时不跟着每一年重算)
  const searchYear = useMemo(() => (civ ? (getCivTime().year ?? civ.endYear) : 0), [civ, q === '']); // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo(() => (civOk && q.trim() ? searchCiv(civ!, q, searchYear) : []), [civOk, civ, q, searchYear]);
  useEffect(() => setActive(0), [q]);
  // 选中了别的东西(地图上点的):搜索框清空,下面换成它的详情
  useEffect(() => {
    if (sel) setQ('');
  }, [sel]);
  const pick = useCallback((h: SearchHit) => {
    setQ('');
    setSelection(h.select);
  }, []);
  return { q, setQ, hits, active, setActive, pick, searching: q.trim() !== '' };
}

export function SearchField({ s, civ, onFocus }: { s: SearchState; civ: Civ | null; onFocus?: () => void }) {
  const { q, setQ, hits, active, setActive, pick } = s;
  return (
    <div className="sb-search">
      <Icon name="search" size={17} />
      <input
        className="search-input"
        data-act="search"
        value={q}
        placeholder="搜索国家、城市、人物、山河"
        spellCheck={false}
        autoComplete="off"
        disabled={!civ || !civ.viable}
        aria-label="搜索"
        onFocus={onFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setQ('');
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = hits.length;
            if (n) setActive((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault();
            pick(hits[active]);
          }
        }}
      />
      {s.searching && (
        <button className="sb-clear" onClick={() => setQ('')} aria-label="清空" title="清空">
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 顶上:回到我的世界、世界名、存档、更多

/** 卡片左上"‹ 我的世界" */
export function BackHome({ onClick }: { onClick: () => void }) {
  return (
    <button className="nw-back" data-act="home" onClick={onClick}>
      <Icon name="back" size={18} />
      我的世界
    </button>
  );
}

/** 世界名、副标("种子 7,现存 14 国,干预了 2 处") */
export function useWorldInfo(civ: Civ | null, data: SidebarProps['data']): { title: string; sub: string } {
  useSavesVersion();
  const edits = useEdits();
  const year = useYear(civ);
  const alive = civ && civ.viable ? civ.polities.filter((x) => polityAlive(x, year)).length : 0;
  const n = edits.interventions.length;
  const seed = data ? data.world.params.seed : null;
  const sub = seed === null ? '正在生成' : `种子 ${seed}，${civ ? (civ.viable ? `现存 ${alive} 国` : '没有文明') : '正在推演历史'}${n ? `，干预了 ${n} 处` : ''}`;
  return { title: currentWorld()?.title || '未命名世界', sub };
}

/** "更多"菜单:写成史书(「使用 AI 功能」关着时没有)、AI 设置、键盘快捷键(有鼠标时)、源代码和两份协议;最底下一行版本号 */
export function WorldMoreMenu({
  civ,
  onBook,
  className = 'sb-pill sb-more',
}: {
  civ: Civ | null;
  /** 点"写成史书"时先做的事(手机:世界卡片收起,写作进度在右上看得到) */
  onBook?: () => void;
  className?: string;
}) {
  // 键盘快捷键只在有鼠标的设备上列出(手机、平板没有键盘)
  const coarse = useCoarse();
  return (
    <PopMenu className={className} icon={<Icon name="more" size={17} />} title="更多" act="world-more" align="right">
      <AiMenuItem
        icon={<Icon name="book" size={16} />}
        act="book"
        disabled={!civ || !civ.viable}
        onClick={() => {
          onBook?.();
          openHistoryBook();
        }}
        note="AI"
      >
        把历史写成史书
      </AiMenuItem>
      <AiSettingsItem onClick={() => openAiSettings()} />
      <MenuSep />
      {!coarse && (
        <MenuItem icon={<Icon name="keyboard" size={16} />} act="shortcuts" kbd={keyLabel('help')} onClick={openShortcuts}>
          键盘快捷键
        </MenuItem>
      )}
      <MenuItem icon={<Icon name="info" size={16} />} href={SOURCE_URL} act="source">
        源代码
      </MenuItem>
      <MenuItem href={PRIVACY_URL} act="privacy">
        隐私政策
      </MenuItem>
      <MenuItem href={TERMS_URL} act="terms">
        用户协议
      </MenuItem>
      <div className="pm-foot" data-version>
        版本 {APP_VERSION}
      </div>
    </PopMenu>
  );
}

function WorldHead(p: SidebarProps) {
  const { title, sub } = useWorldInfo(p.civ, p.data);
  return (
    <div className="sb-world">
      <button className="sb-title" data-act="overview" onClick={() => openOverview()} title="世界概览:国家、编年史、干预、世界参数">
        <b className="sb-name">{title}</b>
        <span className="sb-sub">{sub}</span>
      </button>
      <div className="sb-acts">
        <SaveMenu ready={!!p.data && !p.generating} icon={<Icon name="save" size={15} />} />
        <WorldMoreMenu civ={p.civ} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 搜索结果

export function SearchResults({ q, hits, active, onActive, onPick }: { q: string; hits: SearchHit[]; active: number; onActive: (i: number) => void; onPick: (h: SearchHit) => void }) {
  if (!hits.length) return <div className="sb-empty search-empty">没有找到「{q.trim()}」</div>;
  return (
    <div className="sb-sec">
      <div className="sb-group search-list" role="listbox">
        {hits.map((h, i) => (
          <button
            key={`${h.kind}:${h.id}`}
            className={`sb-row search-row${i === active ? ' on' : ''}`}
            role="option"
            aria-selected={i === active}
            data-kind={h.kind}
            onPointerEnter={() => onActive(i)}
            onClick={() => onPick(h)}
          >
            <i className="sb-sw" style={{ background: h.color }} />
            <span className="sb-row-main">
              <b className="search-name">{h.name}</b>
            </span>
            <span className="sb-row-side">{h.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 什么都没选时:整个世界

/** 国家一栏列几个 */
const TOP_N = 5;
/** 最近大事列几条 */
const RECENT_N = 3;

let owners: Owners | undefined;

/** 什么都没选时的整个世界:信仰(信仰图层)、国家按大小排、最近大事、我的干预、这颗星球(宽屏侧栏、手机的世界卡片拉到顶时共用) */
export function WorldHome(p: Pick<SidebarProps, 'civ' | 'data' | 'params' | 'generating' | 'replay' | 'onReplay'>) {
  const { civ } = p;
  const year = useYear(civ);
  const edits = useEdits();
  const ok = !!civ && civ.viable;
  // 现存的国家按当年的州数排
  const top = useMemo(() => {
    if (!ok) return { list: [], alive: 0 };
    owners = ownersAt(civ!, year, owners);
    const n = new Map<number, number>();
    for (let r = 0; r < civ!.regions.count; r++) {
      const q = owners.polity[r];
      if (q >= 0) n.set(q, (n.get(q) ?? 0) + 1);
    }
    const alive = civ!.polities.filter((x) => polityAlive(x, year));
    alive.sort((a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0));
    return { list: alive.slice(0, TOP_N).map((x) => ({ p: x, n: n.get(x.id) ?? 0 })), alive: alive.length };
  }, [ok, civ, year]);
  // 一个国家都没有的年份(多半是早年各族还是部落):说一句,给出之后第一个立国的
  const next = useMemo(() => {
    if (!ok || top.alive) return null;
    let first: Civ['polities'][number] | null = null;
    for (const x of civ!.polities) if (x.founded > year && (!first || x.founded < first.founded)) first = x;
    return first;
  }, [ok, civ, year, top.alive]);
  const entries = useMemo(() => (ok ? filterChronicle(fullChronicle(civ!), { major: true }) : []), [ok, civ]);
  // 信仰图层:「国家」上面一组「信仰」(大教按信众多少,教派缩进跟在后面,最后一行民间信仰;数字是这一年的州数)
  const faithOn = useCivShow().faiths && ok && !!civ!.religion;
  const faiths = useMemo(() => (faithOn ? faithRows(civ!, year) : []), [faithOn, civ, year]);
  const k = countUpTo(entries, year);
  const recent = entries.slice(Math.max(0, k - RECENT_N), k).reverse();
  const nIv = edits.interventions.length;
  const nTerrain = edits.terrain.length;
  return (
    <div className="sb-home">
      {faiths.length > 0 && (
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>信仰</span>
          </div>
          <div className="sb-group" data-testid="faiths">
            {faiths.map((f) =>
              f.id < 0 ? (
                <div key="folk" className="sb-row two static">
                  <i className="sb-sw" style={{ background: rgb(f.color) }} />
                  <span className="sb-row-main">
                    <b>{f.name}</b>
                    <small>{f.sub}</small>
                  </span>
                  <span className="sb-row-side">{f.n} 州</span>
                </div>
              ) : (
                <button key={f.id} className={`sb-row${f.sect ? ' sect' : ' two'}`} data-faith={f.id} onClick={() => setSelection({ kind: 'faith', id: f.id })}>
                  <i className="sb-sw" style={{ background: rgb(f.color) }} />
                  <span className="sb-row-main">
                    <b>{f.name}</b>
                    {!f.sect && <small>{f.sub}</small>}
                  </span>
                  <span className="sb-row-side">{f.n} 州</span>
                </button>
              ),
            )}
          </div>
        </section>
      )}
      {ok && (
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>国家</span>
            {top.alive > 0 && (
              <button className="sb-link" data-act="all-countries" onClick={() => openOverview('countries')}>
                全部 {top.alive} 国
              </button>
            )}
          </div>
          <div className="sb-group">
            {!top.alive && (
              <div className="sb-empty sb-no-polity">
                {next ? (
                  <>
                    这一年还没有国家，各族还是部落。
                    <br />
                    第一个国家{polityName(next, next.founded)}在 {Math.floor(next.founded)} 年立国。
                    <div className="sb-no-polity-act">
                      {/* 立国在年中:往后取整到下一年,那一年列表里才有它(和别处"跳到 N 年"一样) */}
                      <button className="sb-link" data-act="first-polity" onClick={() => jumpTo(Math.ceil(next.founded))}>
                        跳到 {Math.ceil(next.founded)} 年
                      </button>
                    </div>
                  </>
                ) : (
                  '这一年没有国家。'
                )}
              </div>
            )}
            {top.list.map(({ p: x, n }) => {
              const cap = civ!.settlements[capitalAt(x, year)];
              return (
                <button key={x.id} className="sb-row two" data-polity={x.id} onClick={() => setSelection({ kind: 'polity', id: x.id })}>
                  <i className="sb-sw" style={{ background: rgb(x.color) }} />
                  <span className="sb-row-main">
                    <b>{polityName(x, year)}</b>
                    <small>
                      {Math.floor(x.founded)} 年立国{cap ? `，都${cap.name}` : ''}
                    </small>
                  </span>
                  <span className="sb-row-side">{n} 州</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {ok && recent.length > 0 && (
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>最近大事</span>
            <button className="sb-link" data-act="chronicle" onClick={() => openOverview('chronicle', { polity: null })}>
              编年史
            </button>
          </div>
          <div className="sb-group">
            {recent.map((e) => (
              <button key={e.id} className="sb-row ev" onClick={() => pickChronicleEntry(e)}>
                <span className="sb-year">{Math.floor(e.year)}</span>
                <span className="sb-ev-text">
                  <EntryText civ={civ!} e={e} />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {nIv > 0 && (
        <section className="sb-sec">
          <div className="sb-group">
            <button className="sb-row" data-act="interventions" onClick={() => openOverview('interventions')}>
              <Icon name="intervene" size={17} className="sb-ico" />
              <span className="sb-row-main">我的干预</span>
              <span className="sb-row-side">{nIv} 处</span>
              <Icon name="chevron" size={14} className="sb-chev" />
            </button>
          </div>
        </section>
      )}
      <section className="sb-sec">
        <div className="sb-sec-head">
          <span>这颗星球</span>
        </div>
        <div className="sb-group">
          <button className="sb-row" data-act="replay" disabled={!p.data || p.generating || p.replay.on} onClick={p.onReplay}>
            <Icon name="replay" size={17} className="sb-ico" />
            <span className="sb-row-main">
              <b>{p.replay.on ? (p.replay.ready ? '正在回放' : '正在准备回放') : '回放世界形成'}</b>
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
          <button className="sb-row" data-act="genesis" onClick={() => openOverview('genesis')} title="创建时定下的种子、参数、地形">
            <Icon name="lock" size={17} className="sb-ico" />
            <span className="sb-row-main">
              <b>世界设定</b>
            </span>
            <span className="sb-row-side">
              种子 {p.params.seed}
              {nTerrain ? `，地形改过 ${nTerrain} 处` : ''}
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
        </div>
      </section>
    </div>
  );
}
