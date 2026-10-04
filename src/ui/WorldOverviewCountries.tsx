/**
 * 世界概览的"国家"页:到时间轴当前这一年为止出现过的国家,一国一行 ——
 * 颜色、名称(当年的国号)、存续年份、州数、疆域小图(0 年到结束年份,均匀取 13 个年份的州数)、国都、主体民族(占几成)。
 * 现存的按州数排在前面;已亡的变淡排在后面(先列最大的几个,其余点"显示全部")。
 * 点一行 = 收起概览、选中这个国家(地图飞过去由选中逻辑负责);已亡的国家先把时间轴拨到它亡国前一年,地图上看得到它。
 */
import { useMemo, useState } from 'react';
import type { Civ, Polity } from '../gen/civ/types';
import { capitalAt, polityName } from '../gen/civ/growth';
import { cultureLabel } from '../gen/civ/display';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { setCivTime, setSelection } from './civView';
import { closeOverview } from './overviewStore';

/** 疆域小图取几个年份 */
export const SPARK_N = 13;
/** 已亡国家先列几个 */
const DEAD_SHOWN = 5;

export interface PolityHistory {
  /** 每国 SPARK_N 个年份的州数(第 i 国在 [i * SPARK_N, (i + 1) * SPARK_N)) */
  spark: Int32Array;
  /** 取样的年份 */
  years: number[];
  /** 每国最多时的州数 */
  peak: Int32Array;
  /** 所有国家里最多时的州数(小图的纵轴) */
  max: number;
}

const historyCache = new WeakMap<object, PolityHistory>();

/** 各国历年的州数(疆域小图、已亡国家按鼎盛时的大小排);同一份历史只算一次(改名不重算) */
export function polityHistory(civ: Civ): PolityHistory {
  const hit = historyCache.get(civ.log);
  if (hit && hit.peak.length === civ.polities.length) return hit;
  const P = civ.polities.length;
  const spark = new Int32Array(P * SPARK_N);
  const years: number[] = [];
  let own: Owners | undefined;
  for (let i = 0; i < SPARK_N; i++) {
    const y = Math.round((civ.endYear * i) / (SPARK_N - 1));
    years.push(y);
    own = ownersAt(civ, y, own);
    for (let r = 0; r < civ.regions.count; r++) {
      const p = own.polity[r];
      if (p >= 0) spark[p * SPARK_N + i]++;
    }
  }
  const peak = new Int32Array(P);
  let max = 1;
  for (let p = 0; p < P; p++) {
    let m = 0;
    for (let i = 0; i < SPARK_N; i++) m = Math.max(m, spark[p * SPARK_N + i]);
    peak[p] = m;
    max = Math.max(max, m);
  }
  const h = { spark, years, peak, max };
  historyCache.set(civ.log, h);
  return h;
}

/** 国家在 y 年之前最后还在的那一年(已亡的 = 亡国前一年;还在的 = y) */
export function lastAliveYear(p: Polity, y: number): number {
  if (p.ended === undefined || p.ended > y) return y;
  return Math.max(Math.ceil(p.founded), Math.ceil(p.ended) - 1);
}

export interface CountryRow {
  p: Polity;
  alive: boolean;
  name: string;
  /** 当年的州数(已亡 = 0) */
  regions: number;
  capital: string;
  culture: string;
  /** 主体民族占这国州数的几成(0–1) */
  share: number;
}

let rowOwners: Owners | undefined;

/** y 年(取整)的国家表:到这一年为止立过国的;现存的按州数排,已亡的按鼎盛时的大小排 */
export function countryRows(civ: Civ, y: number): { alive: CountryRow[]; dead: CountryRow[] } {
  if (!civ.viable || !civ.polities.length) return { alive: [], dead: [] };
  rowOwners = ownersAt(civ, y, rowOwners);
  const own = rowOwners;
  const P = civ.polities.length;
  const size = new Int32Array(P);
  // 每国各民族占几个州(只数现存国家的)
  const mix = new Map<number, Map<number, number>>();
  for (let r = 0; r < civ.regions.count; r++) {
    const p = own.polity[r];
    if (p < 0) continue;
    size[p]++;
    const c = own.culture[r];
    if (c < 0) continue;
    let m = mix.get(p);
    if (!m) mix.set(p, (m = new Map()));
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  const hist = polityHistory(civ);
  const alive: CountryRow[] = [];
  const dead: CountryRow[] = [];
  for (const p of civ.polities) {
    if (p.founded > y) continue;
    const isAlive = p.ended === undefined || p.ended > y;
    if (isAlive) {
      let best = p.culture;
      let bestN = 0;
      let total = 0;
      for (const [c, n] of mix.get(p.id) ?? []) {
        total += n;
        if (n > bestN || (n === bestN && c < best)) {
          best = c;
          bestN = n;
        }
      }
      const cu = civ.cultures[best];
      const cap = civ.settlements[capitalAt(p, y)];
      alive.push({
        p,
        alive: true,
        name: polityName(p, y),
        regions: size[p.id],
        capital: cap?.name || '—',
        culture: cu ? cultureLabel(cu) : '—',
        share: total ? bestN / total : 1,
      });
    } else {
      const cu = civ.cultures[p.culture];
      dead.push({ p, alive: false, name: polityName(p, lastAliveYear(p, y)), regions: 0, capital: '—', culture: cu ? cultureLabel(cu) : '—', share: 1 });
    }
  }
  alive.sort((a, b) => b.regions - a.regions || a.p.id - b.p.id);
  dead.sort((a, b) => hist.peak[b.p.id] - hist.peak[a.p.id] || a.p.id - b.p.id);
  return { alive, dead };
}

/** 点一行:收起概览、选中这国(已亡的先把时间轴拨到它还在的最后一年) */
function locate(p: Polity, y: number) {
  closeOverview();
  const last = lastAliveYear(p, y);
  if (last !== y) setCivTime({ year: last, playing: false, scrubbing: false, story: false });
  setSelection({ kind: 'polity', id: p.id });
}

export function CountriesPage({ civ, year }: { civ: Civ | null; year: number }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => (civ ? countryRows(civ, year) : null), [civ, year]);
  const hist = useMemo(() => (civ && civ.viable && civ.polities.length ? polityHistory(civ) : null), [civ]);
  if (!civ) return <div className="ov-empty">正在生成世界</div>;
  if (!rows || !hist || (!rows.alive.length && !rows.dead.length))
    return <div className="ov-empty">{civ.viable ? `第 ${year} 年还没有国家` : '这颗星球上还没有文明'}</div>;
  const dead = all ? rows.dead : rows.dead.slice(0, DEAD_SHOWN);
  const more = rows.dead.length - dead.length;
  const end = Math.floor(civ.endYear);
  return (
    <div className="ov-table ov-countries">
      <div className="ov-tr ov-th">
        <span />
        <span>名称</span>
        <span>存续</span>
        <span className="num">州</span>
        <span className="ov-c-spark">疆域 0–{end} 年</span>
        <span className="ov-c-cap">国都</span>
        <span className="ov-c-cu">主体民族</span>
      </div>
      {[...rows.alive, ...dead].map((r) => {
        const { p } = r;
        const color = `rgb(${p.color.join(',')})`;
        const b = p.id * SPARK_N;
        return (
          <button key={p.id} className={`ov-tr ov-row${r.alive ? '' : ' dead'}`} data-polity={p.id} onClick={() => locate(p, year)}>
            <i className="ov-sw" style={{ background: color }} />
            <span className="ov-name">{r.name}</span>
            <span className="ov-years">
              {Math.floor(p.founded)}–{r.alive ? '' : Math.ceil(p.ended!)}
            </span>
            <span className="num ov-regions">{r.alive ? r.regions : '已亡'}</span>
            <span className="ov-c-spark ov-spark" title={hist.years.map((yy, i) => `${yy} 年 ${hist.spark[b + i]} 州`).join('\n')}>
              {hist.years.map((yy, i) => {
                const n = hist.spark[b + i];
                return <i key={yy} style={{ height: Math.max(1, Math.round((n / hist.max) * 20)), background: color, opacity: n ? 1 : 0.2 }} />;
              })}
            </span>
            <span className="ov-c-cap">{r.capital}</span>
            <span className="ov-c-cu ov-sub">
              {r.culture}
              {r.alive && r.share < 0.995 && <em> {Math.round(r.share * 100)}%</em>}
            </span>
          </button>
        );
      })}
      <div className="ov-foot">
        {more > 0 && (
          <>
            另有 {more} 个已亡国家 ·{' '}
            <button className="ov-link" data-act="all-dead" onClick={() => setAll(true)}>
              显示全部
            </button>{' '}
            ·{' '}
          </>
        )}
        点击一行在地图上定位
      </div>
    </div>
  );
}
