/**
 * 世界概览(点世界名、侧栏里的"全部 N 国""编年史""世界参数"打开):全屏浮层。
 *
 *   头部  世界名;一行"种子 7，当前 2679 年，未干预";一行汇总(现存几国、历来几国、民族、城镇、州,跟着时间轴的当前年份);
 *         关闭。存档、导出、AI 设置、写成史书不放这里:宽屏在侧栏和地图右上,手机在底部世界卡片的按钮和「···」里
 *   页签  国家(WorldOverviewCountries.tsx)/ 编年史(Chronicle.tsx)/ 人物(WorldOverviewPeople.tsx:名人、君主、将领)/
 *         我的干预(WorldOverviewInterventions.tsx)/
 *         世界设定(WorldOverviewGenesis.tsx:创建时定下的种子、参数、地形,只能看;以它为底稿新建、回放世界形成)
 *   世界名旁边"改名"(点了就地变成输入框)
 *   底部  一行小字:源代码、隐私政策、用户协议(新标签页打开;网址在 links.ts)
 * 关闭:右上角的关闭 / Esc / 点浮层外面。窄屏铺满全屏。开没开、在哪一页见 overviewStore.ts(别处用 openOverview(tab, opts) 打开某一页)。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { World, WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { polityAlive, populationAt } from '../gen/civ/growth';
import { Chronicle } from './Chronicle';
import { PeoplePage } from './WorldOverviewPeople';
import { CountriesPage } from './WorldOverviewCountries';
import { InterventionsPage } from './WorldOverviewInterventions';
import { SettingsPage } from './WorldOverviewGenesis';
import { getCivTime, subscribeCivTime } from './civView';
import { useEdits } from './editsStore';
import { currentWorld, renameWorld, useSavesVersion } from './saveStore';
import { closeOverview, setOverviewTab, useOverview, type OverviewTab } from './overviewStore';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { Icon } from './icons';
import { APP_VERSION } from './version';
import { TitleInput } from './worldParts';
import './overview.css';

export interface WorldOverviewProps {
  data: { world: World; raster: Raster } | null;
  civ: Civ | null;
  params: WorldParams;
  /** 世界还在生成 */
  generating: boolean;
  /** 正在重推历史(干预页先不判"未生效") */
  resimBusy: boolean;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 以这个世界为底稿新建(世界设定页) */
  onDraftFrom: () => void;
}

const TABS: { id: OverviewTab; name: string }[] = [
  { id: 'countries', name: '国家' },
  { id: 'chronicle', name: '编年史' },
  { id: 'people', name: '人物' },
  { id: 'interventions', name: '我的干预' },
  { id: 'genesis', name: '世界设定' },
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
  return (
    <div className="ov-root" hidden={!open}>
      <div className="ov-scrim" onClick={closeOverview} />
      <div className="ov" role="dialog" aria-modal="true" aria-label="世界概览" onPointerDown={stop} onDoubleClick={stop} onWheel={stop}>
        <header className="ov-head">
          {open ? <OverviewSummary civ={p.civ} seed={p.data ? p.data.world.params.seed : null} /> : <span className="ov-summary" />}
          <div className="ov-actions">
            <button className="ov-x" data-act="ov-close" onClick={closeOverview} title="关闭(Esc)" aria-label="关闭">
              <Icon name="close" size={14} />
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

/** 底部一行小字:源代码、隐私政策、用户协议(新标签页打开),最右边是版本号 */
function AboutLinks() {
  return (
    <footer className="ov-about">
      {ABOUT.map((l) => (
        <a key={l.id} href={l.href} target="_blank" rel="noreferrer" data-link={l.id}>
          {l.name}
        </a>
      ))}
      <span className="ov-ver" data-version>
        版本 {APP_VERSION}
      </span>
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
    case 'people':
      return <PeoplePage civ={p.civ} />;
    case 'interventions':
      return <InterventionsPage civ={p.civ} busy={p.resimBusy} />;
    case 'genesis':
      return (
        <SettingsPage
          params={p.params}
          generating={p.generating || !p.data}
          replay={p.replay}
          onReplay={() => {
            closeOverview();
            p.onReplay();
          }}
          onDraftFrom={() => {
            closeOverview();
            p.onDraftFrom();
          }}
        />
      );
  }
}

/** 头部左边:世界名、种子 · 当前年份 · 干预数;汇总数字(跟着时间轴当前年份) */
function OverviewSummary({ civ, seed }: { civ: Civ | null; seed: number | null }) {
  useSavesVersion();
  const edits = useEdits();
  const year = useYear(civ);
  const cur = currentWorld();
  const title = cur?.title;
  const [naming, setNaming] = useState(false);
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
  const sub = [seed !== null ? `种子 ${seed}` : '正在生成', civ ? `当前 ${year} 年` : null, n ? `干预了 ${n} 处` : '未干预'].filter(Boolean).join('，');
  return (
    <div className="ov-summary">
      <div className="ov-title">
        {naming && cur ? (
          <TitleInput
            className="ov-name-input"
            initial={title ?? ''}
            onDone={(t) => {
              setNaming(false);
              if (t !== null) renameWorld(cur.id, t);
            }}
          />
        ) : (
          <span className="ov-name-row">
            <span className="ov-name">{title || '未命名世界'}</span>
            {cur && (
              <button className="ov-rename" data-act="ov-rename" onClick={() => setNaming(true)}>
                <Icon name="rename" size={14} />
                改名
              </button>
            )}
          </span>
        )}
        <span className="ov-subline">{sub}</span>
        {stats && (
          <span className="ov-subline ov-stats">
            现存 {stats.alive} 国（历来 {stats.founded} 国），{stats.cultures} 个民族，{stats.towns} 座城镇，{stats.regions} 州
          </span>
        )}
      </div>
    </div>
  );
}
