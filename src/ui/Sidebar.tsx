/**
 * 左边的侧栏(宽屏):界面的主体都在这里,地图在它右边。样子照常见的地图应用。
 *
 *   顶上   世界名、"种子 7，现存 14 国";存档、新世界、更多(用一句话改写世界、写成史书、AI 设置、关于);下面一个搜索框
 *          "改写"的框(Rewrite.tsx)浮在侧栏右边、地图的左上角
 *   下面   三选一 ——
 *          搜索框里有字:搜索结果(点一条 = 选中它,地图飞过去)
 *          地图上选中了东西:它的详情(Inspector:国家 / 城 / 地理实体 / 州的面板)
 *          什么都没选:整个世界(WorldHome:国家按大小排、最近大事、我的干预、地形)
 *
 * 窄屏(手机)不用这个侧栏:同样的内容放进底部的世界卡片(PhoneSheet.tsx),这里的零件(搜索、世界名、"更多"菜单、整个世界)两边共用。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World, WorldParams } from '../gen/world';
import { capitalAt, polityAlive, polityName } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { buildChronicle, filterChronicle } from '../gen/civ/chronicle';
import { getCivTime, pickChronicleEntry, setSelection, subscribeCivTime, useSelection } from './civView';
import { useEdits } from './editsStore';
import { currentWorld, useSavesVersion } from './saveStore';
import { SaveMenu } from './SaveMenu';
import { openAiSettings } from './AiSettings';
import { openHistoryBook } from './bookStore';
import { openOverview } from './overviewStore';
import { setTerrainTool } from './TerrainTools';
import { searchCiv, type SearchHit } from './searchIndex';
import { countUpTo, evText } from './timelineLayout';
import { RewriteBox } from './Rewrite';
import { Icon } from './icons';
import { AiMenuItem, MenuItem, MenuSep, PopMenu } from './PopMenu';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import { rgb } from './panelParts';
import './sidebar.css';

export interface SidebarProps {
  data: { world: World; raster: Raster } | null;
  /** 套上改名的历史(界面上显示的那一份) */
  civ: Civ | null;
  /** 没套改名的历史 */
  raw: Civ | null;
  params: WorldParams;
  /** 随机一个种子,生成新世界 */
  onRandomSeed: () => void;
  /** 世界还在生成 */
  generating: boolean;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 改地形进不去(新世界还在生成、正在回放) */
  terrainDisabled: boolean;
  /** 读档:文件内容 / "我的世界"里的一个 */
  onOpenText: (text: string, fileName?: string) => void;
  onOpenStored: (id: string) => void;
  /** 正在重推 / 按新地形重新生成 / 生成新世界(改写框里这时不能发话、不能执行) */
  rewriteBusy: boolean;
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
  return (
    <aside className="sidebar" aria-label="侧栏" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      <header className="sb-head">
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
        placeholder="搜索国家、城市、民族、山河"
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
// 顶上:世界名、存档、新世界、更多

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

/** "更多"菜单:用一句话改写世界、写成史书、AI 设置、源代码和两份协议;最底下一行版本号 */
export function WorldMoreMenu({
  civ,
  data,
  onRewrite,
  onBook,
  className = 'sb-pill sb-more',
}: {
  civ: Civ | null;
  data: SidebarProps['data'];
  onRewrite: () => void;
  /** 点"写成史书"时先做的事(手机:世界卡片收起,写作进度在右上看得到) */
  onBook?: () => void;
  className?: string;
}) {
  // 改写不要求有文明:没长出文明的世界也能改地形
  const canRewrite = !!civ && !!data;
  return (
    <PopMenu className={className} icon={<Icon name="more" size={17} />} title="更多" act="world-more" align="right">
      <AiMenuItem icon={<Icon name="rename" size={16} />} act="rewrite" disabled={!canRewrite} onClick={onRewrite} note="AI">
        用一句话改写世界
      </AiMenuItem>
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
      <MenuItem icon={<Icon name="sparkle" size={16} />} act="ai-settings" onClick={() => openAiSettings()}>
        AI 设置
      </MenuItem>
      <MenuSep />
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
  const [rewriting, setRewriting] = useState(false);
  /** "更多"菜单:点它不关改写框 */
  const more = useRef<HTMLDivElement>(null);
  const closeRewrite = useCallback(() => setRewriting(false), []);
  const canRewrite = !!p.civ && !!p.data;
  return (
    <div className="sb-world">
      <button className="sb-title" data-act="overview" onClick={() => openOverview()} title="世界概览:国家、编年史、干预、世界参数">
        <b className="sb-name">{title}</b>
        <span className="sb-sub">{sub}</span>
      </button>
      <div className="sb-acts">
        <SaveMenu ready={!!p.data && !p.generating} onOpenText={p.onOpenText} onOpenStored={p.onOpenStored} icon={<Icon name="save" size={15} />} />
        <button className="sb-pill" data-act="new-world" disabled={p.generating} onClick={p.onRandomSeed} title="随机一个种子,生成一个新世界">
          <Icon name="plus" size={15} />
          新世界
        </button>
        <div className="sb-more-wrap" ref={more}>
          <WorldMoreMenu civ={p.civ} data={p.data} onRewrite={() => setRewriting(true)} />
        </div>
      </div>
      {rewriting && canRewrite && (
        <div className="sb-rewrite">
          <RewriteBox civ={p.civ!} world={p.data!.world} busy={p.rewriteBusy} onClose={closeRewrite} anchor={more} />
        </div>
      )}
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

/** 什么都没选时的整个世界:国家按大小排、最近大事、我的干预、地形(宽屏侧栏、手机的世界卡片拉到顶时共用) */
export function WorldHome(p: Pick<SidebarProps, 'civ' | 'data' | 'params' | 'generating' | 'replay' | 'onReplay' | 'terrainDisabled'>) {
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
  const entries = useMemo(() => (ok ? filterChronicle(buildChronicle(civ!), { major: true }) : []), [ok, civ]);
  const k = countUpTo(entries, year);
  const recent = entries.slice(Math.max(0, k - RECENT_N), k).reverse();
  const nIv = edits.interventions.length;
  const nTerrain = edits.terrain.length;
  const params = p.params;
  return (
    <div className="sb-home">
      {ok && (
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>国家</span>
            <button className="sb-link" data-act="all-countries" onClick={() => openOverview('countries')}>
              全部 {top.alive} 国
            </button>
          </div>
          <div className="sb-group">
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
                <span className="sb-ev-text">{evText(e)}</span>
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
          <span>地形</span>
        </div>
        <div className="sb-group">
          <button className="sb-row terrain-toggle" data-act="terrain" disabled={p.terrainDisabled} onClick={() => setTerrainTool({ on: true })} title="放火山、画山脉、挖湖……改完整个世界按新地形重新长一遍">
            <Icon name="terrain" size={17} className="sb-ico" />
            <span className="sb-row-main">改地形</span>
            {nTerrain > 0 && <span className="sb-row-side">改了 {nTerrain} 处</span>}
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
          <button className="sb-row" data-act="replay" disabled={!p.data || p.generating || p.replay.on} onClick={p.onReplay}>
            <Icon name="replay" size={17} className="sb-ico" />
            <span className="sb-row-main">{p.replay.on ? (p.replay.ready ? '正在回放' : '正在准备回放') : '回放世界形成'}</span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
          <button className="sb-row" data-act="genesis" onClick={() => openOverview('genesis')}>
            <Icon name="sliders" size={17} className="sb-ico" />
            <span className="sb-row-main">世界参数</span>
            <span className="sb-row-side">
              陆地 {Math.round(params.landFraction * 100)}%，{params.plates} 个板块
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
        </div>
      </section>
    </div>
  );
}
