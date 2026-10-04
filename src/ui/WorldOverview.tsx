/**
 * 世界概览(点左上角的世界名打开):全屏浮层。
 *
 *   头部  世界名、"种子 7 · 当前 2679 年 · 未干预";汇总数字(国家 现存 / 共、民族、城镇、州,跟着时间轴的当前年份);
 *         AI 设置入口(AiMenu)、存档(SaveMenu)、导出(ExportMenu)、成书(收起概览 + 打开写史书窗口)、关闭
 *   页签  国家(WorldOverviewCountries.tsx)/ 编年史(Chronicle.tsx)/ 我的干预(WorldOverviewInterventions.tsx)/
 *         创世(WorldOverviewGenesis.tsx:种子、新世界、世界参数、回放世界形成、改地形)
 *   底部  一行小字:源代码 · 隐私政策 · 用户协议(新标签页打开;网址在 links.ts)
 * 关闭:✕ / Esc / 点浮层外面。窄屏铺满全屏。开没开、在哪一页见 overviewStore.ts(别处用 openOverview(tab, opts) 打开某一页)。
 *
 * 存档、导出、AI 这三个菜单一直挂着(浮层关着时只是藏起来):导出做到一半收起概览,做完照样在顶部提示;
 * 别处(成书窗口、AI 功能)照样能打开 AI 设置。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { World, WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import type { LayerId } from '../render/layers';
import { polityAlive, populationAt } from '../gen/civ/growth';
import { SaveMenu } from './SaveMenu';
import { ExportMenu } from './ExportMenu';
import { AiMenu } from './AiSettings';
import { openHistoryBook } from './HistoryBook';
import { Chronicle } from './Chronicle';
import { CountriesPage } from './WorldOverviewCountries';
import { InterventionsPage } from './WorldOverviewInterventions';
import { GenesisPage } from './WorldOverviewGenesis';
import { getCivTime, subscribeCivTime } from './civView';
import { useEdits } from './editsStore';
import { currentWorld, useSavesVersion } from './saveStore';
import { closeOverview, setOverviewTab, useOverview, type OverviewTab } from './overviewStore';
import type { Style } from './mapLayers';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import './overview.css';

export interface WorldOverviewProps {
  data: { world: World; raster: Raster } | null;
  civ: Civ | null;
  params: WorldParams;
  /** 用这组参数重新生成 */
  onCommit: (p: WorldParams) => void;
  /** 随机一个种子,生成新世界 */
  onRandomSeed: () => void;
  /** 导出用:当前画风、数据图层 */
  style: Style;
  dataLayer: LayerId;
  /** 世界还在生成 */
  generating: boolean;
  /** 正在重推历史(干预页先不判"未生效") */
  resimBusy: boolean;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 改地形进不去(新世界还在生成、正在回放) */
  terrainDisabled: boolean;
  /** 读档:文件内容 / "我的世界"里的一个 */
  onOpenText: (text: string, fileName?: string) => void;
  onOpenStored: (id: string) => void;
}

const TABS: { id: OverviewTab; name: string }[] = [
  { id: 'countries', name: '国家' },
  { id: 'chronicle', name: '编年史' },
  { id: 'interventions', name: '我的干预' },
  { id: 'genesis', name: '创世' },
];

const subscribeYear = (f: () => void) => subscribeCivTime(() => f());

/** 时间轴当前年份(取整;回放时一年只重新渲染一次) */
function useYear(civ: Civ | null): number {
  const end = civ?.endYear ?? 0;
  return useSyncExternalStore(subscribeYear, () => Math.floor(Math.min(end, Math.max(0, getCivTime().year ?? end))));
}

export function WorldOverview(p: WorldOverviewProps) {
  const { open, tab } = useOverview();
  const edits = useEdits();

  // Esc 收起(先于页面上别的 Esc:不顺手取消地图上的选中)。输入框里打字时不管;
  // 存档 / 导出菜单、AI 设置开着时先让它们收
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.ov .save-menu, .ov .export-menu, .ai-dialog-bg')) return;
      e.stopPropagation();
      closeOverview();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const nIv = edits.interventions.length;
  const ready = !!p.data && !p.generating;
  return (
    <div className="ov-root" hidden={!open}>
      <div className="ov-scrim" onClick={closeOverview} />
      <div className="ov" role="dialog" aria-modal="true" aria-label="世界概览" onPointerDown={stop} onDoubleClick={stop} onWheel={stop}>
        <header className="ov-head">
          {open ? <OverviewSummary civ={p.civ} seed={p.data ? p.data.world.params.seed : null} /> : <span className="ov-summary" />}
          <div className="ov-actions">
            <AiMenu />
            <SaveMenu ready={ready} onOpenText={p.onOpenText} onOpenStored={p.onOpenStored} />
            <ExportMenu data={p.data} civ={p.civ} style={p.style} layer={p.dataLayer} />
            <button
              className="ov-btn ov-primary ov-book"
              data-act="ov-book"
              disabled={!p.civ || !p.civ.viable}
              onClick={() => {
                closeOverview();
                openHistoryBook();
              }}
            >
              成书
            </button>
            <button className="ov-x" data-act="ov-close" onClick={closeOverview} title="关闭" aria-label="关闭">
              ✕
            </button>
          </div>
        </header>
        <nav className="ov-tabs" role="tablist" aria-label="概览">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`ov-tab${tab === t.id ? ' on' : ''}`} data-tab={t.id} onClick={() => setOverviewTab(t.id)}>
              {t.name}
              {t.id === 'interventions' && ` ${nIv}`}
            </button>
          ))}
        </nav>
        <div className={`ov-body tab-${tab}`}>{open && <OverviewPage {...p} tab={tab} />}</div>
        <AboutLinks />
      </div>
    </div>
  );
}

const ABOUT = [
  { id: 'source', name: '源代码', href: SOURCE_URL },
  { id: 'privacy', name: '隐私政策', href: PRIVACY_URL },
  { id: 'terms', name: '用户协议', href: TERMS_URL },
];

/** 底部一行小字:源代码 · 隐私政策 · 用户协议(新标签页打开) */
function AboutLinks() {
  return (
    <footer className="ov-about">
      {ABOUT.map((l, i) => (
        <span key={l.id}>
          {i > 0 && <i aria-hidden="true">·</i>}
          <a href={l.href} target="_blank" rel="noreferrer" data-link={l.id}>
            {l.name}
          </a>
        </span>
      ))}
    </footer>
  );
}

/** 国家页跟着时间轴的当前年份(一年重新渲染一次);其余几页不用 */
function Countries({ civ }: { civ: Civ | null }) {
  const year = useYear(civ);
  return <CountriesPage civ={civ} year={year} />;
}

function OverviewPage(p: WorldOverviewProps & { tab: OverviewTab }) {
  switch (p.tab) {
    case 'countries':
      return <Countries civ={p.civ} />;
    case 'chronicle':
      return <Chronicle civ={p.civ} />;
    case 'interventions':
      return <InterventionsPage civ={p.civ} busy={p.resimBusy} />;
    case 'genesis':
      return (
        <GenesisPage
          params={p.params}
          world={p.data?.world ?? null}
          onCommit={p.onCommit}
          onRandomSeed={p.onRandomSeed}
          generating={p.generating}
          replay={p.replay}
          onReplay={p.onReplay}
          terrainDisabled={p.terrainDisabled}
        />
      );
  }
}

/** 头部左边:世界名、种子 · 当前年份 · 干预数;汇总数字(跟着时间轴当前年份) */
function OverviewSummary({ civ, seed }: { civ: Civ | null; seed: number | null }) {
  useSavesVersion();
  const edits = useEdits();
  const year = useYear(civ);
  const title = currentWorld()?.title;
  const n = edits.interventions.length;
  const stats = useMemo(() => {
    if (!civ || !civ.viable) return null;
    let alive = 0;
    let founded = 0;
    for (const p of civ.polities) {
      if (p.founded > year) continue;
      founded++;
      if (polityAlive(p, year)) alive++;
    }
    let cultures = 0;
    for (const cu of civ.cultures) if (cu.born <= year && (cu.ended === undefined || cu.ended > year)) cultures++;
    let towns = 0;
    for (const s of civ.settlements) if (populationAt(s, year) > 0) towns++;
    return { alive, founded, cultures, towns, regions: civ.regions.count };
  }, [civ, year]);
  const sub = [seed !== null ? `种子 ${seed}` : '正在生成', civ ? `当前 ${year} 年` : null, n ? `已干预 ${n} 处` : '未干预'].filter(Boolean).join(' · ');
  return (
    <div className="ov-summary">
      <div className="ov-title">
        <span className="ov-name">{title || '未命名世界'}</span>
        <span className="ov-subline">{sub}</span>
      </div>
      {stats && (
        <div className="ov-stats">
          <div>
            <b>
              {stats.alive} / {stats.founded}
            </b>
            <span>国家 现存 / 共</span>
          </div>
          <div>
            <b>{stats.cultures}</b>
            <span>民族</span>
          </div>
          <div>
            <b>{stats.towns}</b>
            <span>城镇</span>
          </div>
          <div>
            <b>{stats.regions}</b>
            <span>州</span>
          </div>
        </div>
      )}
    </div>
  );
}
