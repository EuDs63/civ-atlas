/**
 * 国家面板:点国家从右侧出来(宽 340,上 72、下 84),两页 —— 信息页(这里)和干预页(CommandPage.tsx)。
 *
 * 信息页(按时间轴当前那一年;没立国 = 立国那年的样子,已亡 = 亡国前的样子):
 *   顶部  颜色块、"国家 · 第 N 年"、关闭;国名(宋体大字,可改,输入时预览国号变迁);"1045 年立国 · 国都 竹影城 · 设为中心"
 *   三格  州 / 人口(境内城镇)/ 主体民族
 *   朝代条 按时长分段,当前那一朝实色;点一段 = 时间轴跳到它开始的那年
 *   疆域小柱图(历年州数,和概览"国家"表同一份)、邻国(可点)、来历 / 结局 / 历任国都(有才写)
 *   相关事件 到当前年份为止最近 5 条(可点:跳到那一年,地图上闪出事发地);"全部 ›"打开概览的编年史页、只看这国
 *   名字由来(AI 释名,点底部按钮才出;先"生成中…"再出结果;没设置 AI 时一行提示 + "设置 AI")、AI 起名(改名时的入口)
 *   底部 2×2 干预历史(主色)/ 改名 / 名字由来 / 写国史(窄屏:点"干预历史"时底部抽屉展开)
 *
 * 顶部、三格、色条、小柱图、事件列表、底部按钮这些零件在 panelParts.tsx,城 / 地理实体 / 州的面板(CityPanel、PlacePanel、
 * RegionPanel)用的是同一套。
 */
import { useMemo, useState, type RefObject } from 'react';
import type { Civ, Polity } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { cultureLabel } from '../gen/civ/display';
import { capitalAt, dynastyIndexAt, polityAlive, polityName, polityTitleChain, populationAt, populationLabel } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { buildChronicle, filterChronicle } from '../gen/civ/chronicle';
import { dynastyKey, polityKey } from '../gen/edits';
import { setCivTime } from './civView';
import type { AiName } from './AiNamePanel';
import { openHistoryBook } from './HistoryBook';
import { NameEdit } from './NameEdit';
import { neighborsAt } from './Interventions';
import { CommandPage } from './CommandPage';
import { setPanelTab, setSheet, usePanel } from './panelStore';
import { shownYearOf } from './flyTo';
import { SPARK_N, polityHistory } from './WorldOverviewCountries';
import { openOverview } from './overviewStore';
import { AiBox, AiSuggestLink, CenterLink, EventList, Foot, Link, PanelHead, SegBar, Spark, Stats, rgb, rgba, useRevealAi } from './panelParts';
import './countryPanel.css';

// ---------------------------------------------------------------------------
// 国家

/** 国名词根换成 root 的国家(预览用;东方第一朝的国号跟着换) */
function withRoot(p: Polity, root: string): Polity {
  const d = p.dynasties;
  return { ...p, name: root, dynasties: p.eastern && d && d.length ? d.map((x, i) => (i === 0 ? { ...x, name: root } : x)) : d };
}

let owners: Owners | undefined;

/** 历朝(东方每一朝的国号 / 西幻的王室);没改朝换代过 = 一段 */
function dynastySegments(civ: Civ, p: Polity): { name: string; from: number; to: number }[] {
  const last = p.ended ?? civ.endYear;
  const d = p.dynasties;
  if (!d || d.length < 2) return [{ name: p.name, from: p.founded, to: last }];
  return d.map((x, i) => ({ name: x.name || p.name, from: Math.max(p.founded, x.year), to: d[i + 1]?.year ?? last }));
}

export interface CountryPanelProps {
  civ: Civ;
  raw: Civ;
  raster: Raster | null;
  world: World;
  id: number;
  /** 时间轴当前那一年(取整) */
  year: number;
  names: Record<string, string>;
}

export function CountryPanel(props: CountryPanelProps) {
  const { tab } = usePanel();
  const { civ, raw, raster, id, year } = props;
  const p = civ.polities[id];
  // 改名的开关、AI 释名 / 起名:标题(改名、AI 起名)和信息页(名字由来的框、底部按钮)共用一份
  const d = p.dynasties;
  const di = p.eastern && d && d.length >= 2 ? dynastyIndexAt(p, shownYearOf(p, year, civ.endYear)) : 0;
  const [renaming, setRenaming] = useState(false);
  // 点了"名字由来""AI 起名":内容在信息页最下面,滚过去让它露出来
  const { ai, aiRef } = useRevealAi({ civ, raw, raster, target: { kind: 'polity', id, dynasty: di }, lazy: true });
  const shared: Shared = { renaming, setRenaming, ai, aiRef };
  return (
    <div className="cp" data-polity={id} data-tab={tab}>
      <CountryHead {...props} shared={shared} />
      {tab === 'cmd' ? <CommandPage civ={civ} id={id} year={year} /> : <InfoPage {...props} p={p} shared={shared} />}
    </div>
  );
}

interface Shared {
  renaming: boolean;
  setRenaming: (on: boolean) => void;
  ai: AiName;
  aiRef: RefObject<HTMLDivElement>;
}

/** 顶部:颜色块、国家 · 第 N 年、关闭;国名(可改);立国 · 国都 · 设为中心 */
function CountryHead({ civ, raw, world, id, year, names, shared }: CountryPanelProps & { shared: Shared }) {
  const p = civ.polities[id];
  const alive = polityAlive(p, year);
  const shownYear = shownYearOf(p, year, civ.endYear);
  const cap = civ.settlements[capitalAt(p, shownYear)];
  const d = p.dynasties;
  // 东方改朝换代过的:标题上的国号是当朝的,改的是当朝的国号(第一朝 = 国名词根)
  const di = p.eastern && d && d.length >= 2 ? dynastyIndexAt(p, shownYear) : 0;
  const { renaming, setRenaming, ai } = shared;
  const withDynasty = (i: number, v: string): Polity => (i === 0 ? withRoot(p, v) : { ...p, dynasties: d!.map((y, j) => (j === i ? { ...y, name: v } : y)) });
  const extra = <AiSuggestLink ai={ai} />;
  return (
    <PanelHead color={rgb(p.color)} tag="国家" year={year}>
      {di > 0 ? (
        <NameEdit
          k={dynastyKey(civ, id, di)}
          kind="dynasty"
          eastern
          shown={polityName(p, shownYear)}
          current={d![di].name}
          fallback={raw.polities[id].dynasties?.[di]?.name ?? d![di].name}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
          extra={extra}
          hint={`改的是当朝(第 ${di + 1} 朝)的国号;别的朝:点朝代条跳到那一朝再改`}
          preview={(v) => polityName(withDynasty(di, v), shownYear)}
        />
      ) : (
        <NameEdit
          k={polityKey(civ, id)}
          kind="polity"
          eastern={p.eastern}
          shown={polityName(p, shownYear)}
          current={p.name}
          fallback={raw.polities[id].name}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
          extra={extra}
          hint={p.eastern ? '国号按国土大小自动加:秦部 → 秦国 → 大秦 → 大秦王朝' : '国号(国 / 王国 / 帝国……)按国土大小自动加'}
          preview={(v) => polityTitleChain(withRoot(p, v))}
        />
      )}
      <div className="cp-sub">
        {p.ended !== undefined && year >= p.ended
          ? `${Math.floor(p.founded)}–${Math.floor(p.ended)} 年`
          : `${Math.floor(p.founded)} 年${alive ? '' : '才'}立国`}
        {cap && (
          <>
            {' · 国都 '}
            <Link to={{ kind: 'settlement', id: cap.id }}>{cap.name}</Link>
          </>
        )}
        {' · '}
        <CenterLink world={world} civ={civ} sel={{ kind: 'polity', id }} year={shownYear} />
      </div>
    </PanelHead>
  );
}

function InfoPage({ civ, id, year, p, shared }: CountryPanelProps & { p: Polity; shared: Shared }) {
  const { ai } = shared;
  const shownYear = shownYearOf(p, year, civ.endYear);
  const alive = polityAlive(p, year);
  // 这一年的州数、人口(境内的城)、各民族的州数
  owners = ownersAt(civ, shownYear, owners);
  const own = owners;
  let n = 0;
  const folk = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) {
    if (own.polity[r] !== id) continue;
    n++;
    const c = own.culture[r];
    if (c >= 0) folk.set(c, (folk.get(c) ?? 0) + 1);
  }
  let pop = 0;
  for (const s of civ.settlements) if (own.polity[s.region] === id) pop += populationAt(s, shownYear);
  const folks = [...folk].sort((a, b) => b[1] - a[1]);
  const top = folks.length ? civ.cultures[folks[0][0]] : civ.cultures[p.culture];
  const share = folks.length && n > 1 ? Math.round((folks[0][1] / n) * 100) : null;
  const near = useMemo(() => [...neighborsAt(civ, id, shownYear).near], [civ, id, shownYear]);
  // 疆域小柱图:和概览"国家"表里的同一份(0 年到结束年份均匀取样的州数),按这国最多时的州数定高
  const hist = polityHistory(civ);
  const spark = hist.years.map((y, i) => ({ year: y, n: hist.spark[id * SPARK_N + i] }));
  const segs = useMemo(() => dynastySegments(civ, p), [civ, p]);
  const related = useMemo(() => filterChronicle(buildChronicle(civ), { polity: id }), [civ, id]);
  const upTo = related.filter((e) => e.year <= year + 1e-6);
  const maxN = Math.max(1, hist.peak[id] ?? 0);
  const span = Math.max(1, (p.ended ?? civ.endYear) - p.founded);
  const last = p.ended ?? civ.endYear;
  const di = segs.length > 1 ? dynastyIndexAt(p, Math.min(year, last - 1 / 512)) : 0;
  const cur = year >= p.founded && (year < last || (p.ended === undefined && year >= civ.endYear)) ? di : -1;
  // 来历 / 结局:按史事查是谁灭的
  const end = useMemo(() => {
    for (const a of civ.annals) {
      if (a.kind === 'fall' && a.a === id) return { how: 'fall' as const, by: a.b };
      if (a.kind === 'merge' && a.b === id) return { how: 'merge' as const, by: a.a };
    }
    return null;
  }, [civ, id]);
  const other = (q: number, y: number) => (civ.polities[q] ? <Link to={{ kind: 'polity', id: q }}>{polityName(civ.polities[q], y)}</Link> : null);
  const capitals = p.capitals?.length ? p.capitals : [{ year: p.founded, settlement: p.capital }];
  const popText = pop > 0 ? populationLabel(pop).replace(/万人$/, '万') : '—';
  return (
    <>
      <div className="cp-body">
        <Stats
          items={[
            { k: '州', v: n },
            { k: '人口', v: popText, size: 'small' },
            {
              k: '主体民族',
              v: (
                <>
                  {top ? cultureLabel(top) : '—'}
                  {share !== null && ` ${share}%`}
                </>
              ),
              size: 'text',
            },
          ]}
        />
        <SegBar
          label="朝代"
          segs={segs.map((s, i) => ({
            name: s.name,
            frac: Math.max(0, s.to - s.from) / span,
            background: i === cur ? rgb(p.color) : rgba(p.color, 0.25),
            on: i === cur,
            title: `${s.name} · ${Math.floor(s.from)}–${Math.floor(s.to)}`,
            onClick: () => setCivTime({ year: Math.ceil(s.from), playing: false, story: false }),
          }))}
          years={[p.founded, last]}
        />
        <div className="cp-grid">
          <span className="cp-k">疆域</span>
          <Spark
            title={`历年州数(最多时 ${maxN} 州)`}
            bars={spark.map((s) => ({
              h: Math.max(1, Math.round((s.n / maxN) * 26)),
              background: rgb(p.color),
              opacity: s.n ? (s.year <= year ? 1 : 0.35) : 0.2,
            }))}
          />
          <span className="cp-k">邻国</span>
          <span className="cp-links">
            {near.length ? (
              near
                .map((q) => civ.polities[q])
                .filter(Boolean)
                .map((q) => (
                  <Link key={q.id} to={{ kind: 'polity', id: q.id }}>
                    {polityName(q, shownYear)}
                  </Link>
                ))
            ) : (
              <span className="cp-none">无</span>
            )}
          </span>
          {(p.restores !== undefined && civ.polities[p.restores]) || (p.parent !== undefined && civ.polities[p.parent]) ? (
            <>
              <span className="cp-k">来历</span>
              <span>
                {p.restores !== undefined && civ.polities[p.restores] ? (
                  <>复{other(p.restores, civ.polities[p.restores].ended ?? p.founded)}之国</>
                ) : (
                  <>叛{other(p.parent!, p.founded)}自立</>
                )}
              </span>
            </>
          ) : null}
          {p.ended !== undefined && (
            <>
              <span className="cp-k">结局</span>
              <span>
                {Math.floor(p.ended)} 年{end?.how === 'fall' && end.by >= 0 ? <>亡于{other(end.by, p.ended)}</> : end?.how === 'merge' ? <>并入{other(end.by, p.ended)}</> : '亡'}
              </span>
            </>
          )}
          {capitals.length > 1 && (
            <>
              <span className="cp-k">历任国都</span>
              <span className="cp-links">
                {capitals.map((c, i) => {
                  const s = civ.settlements[c.settlement];
                  if (!s) return null;
                  const now = alive && capitalAt(p, year) === s.id;
                  return (
                    <span key={i} className={now ? 'cp-now' : ''}>
                      <Link to={{ kind: 'settlement', id: s.id }}>{s.name}</Link>
                      <em>{Math.floor(c.year)}</em>
                    </span>
                  );
                })}
              </span>
            </>
          )}
        </div>
        <EventList
          upTo={upTo}
          empty={year < p.founded ? '尚未立国' : '还没有'}
          more={
            related.length > 0 && (
              <button className="ins-link cp-more" data-act="chronicle" onClick={() => openOverview('chronicle', { polity: id })}>
                全部 ›
              </button>
            )
          }
        />
        <AiBox ai={ai} aiRef={shared.aiRef} />
      </div>
      <Foot>
        <button className="cp-btn primary" data-act="intervene" onClick={() => (setPanelTab('cmd'), setSheet('full'))}>
          干预历史
        </button>
        <button className="cp-btn" data-act="rename" onClick={() => shared.setRenaming(true)}>
          改名
        </button>
        <button className="cp-btn" data-ain="explain" disabled={ai.busy} onClick={ai.ask}>
          名字由来
        </button>
        <button className="cp-btn" data-act="book" onClick={() => openHistoryBook({ polity: id })}>
          写国史
        </button>
      </Foot>
    </>
  );
}
