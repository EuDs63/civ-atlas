/**
 * 右上"搜索"的查找(纯计算,不碰 DOM;单测直接调):按名字找国家(含已亡)、城、民族、信仰、山河湖海岛。
 *
 * - 用改过名的那份历史(editsStore 套过的 civ):改过的名字能搜到
 * - 国家按它实际用过的国号找(改朝换代前的"大景"也算),显示时间轴这一年的国号(已亡的写最后的国号)
 * - 排序:名字完全相同 > 开头就对上 > 名字里有;同样对得上时 国家 > 城 > 民族 > 信仰 > 山河;同类里大的在前
 * - 什么都没输:列出这一年最大的几个国家
 */
import type { Civ, Place, Polity } from '../gen/civ/types';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { cultureLabel } from '../gen/civ/display';
import { capitalAt, polityAlive, polityName, populationAt } from '../gen/civ/growth';
import { faithCounts } from '../gen/civ/religion';
import type { MapSelection } from './civView';

export interface SearchHit {
  kind: 'polity' | 'settlement' | 'culture' | 'faith' | 'place';
  id: number;
  /** 显示的名字 */
  name: string;
  /** 右侧小字:"12 州" / "国都 竹影城" / "城，属大澜王朝" / "民族" / "宗教" / "山脉" */
  sub: string;
  /** 颜色块 */
  color: string;
  /** 点了选中什么(民族 = 它人口最多的那个州) */
  select: MapSelection;
}

export const SEARCH_LIMIT = 8;

const PLACE_KIND: Record<Place['kind'], string> = {
  sea: '海',
  mountains: '山脉',
  river: '河流',
  lake: '湖泊',
  island: '岛屿',
  desert: '荒漠',
};
/** 山河湖海没有国家颜色:按类别给一个素净的颜色 */
const PLACE_COLOR: Record<Place['kind'], string> = {
  sea: '#7d9bb3',
  lake: '#7d9bb3',
  river: '#7d9bb3',
  mountains: '#8c7b63',
  island: '#9a9270',
  desert: '#c2a878',
};

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** 各国在某一年的国号:活着 = 这一年的;还没立国 = 立国时的;已亡 = 最后的 */
export function polityNameAt(p: Polity, year: number): string {
  if (year < p.founded) return polityName(p, p.founded);
  if (p.ended !== undefined && year >= p.ended) return polityName(p, p.ended - 1 / 512);
  return polityName(p, year);
}

/** 这个国家实际用过的国号(立国、每次升格、每次改朝换代时的全称),先后排好、去重 */
export function polityUsedNames(p: Polity): string[] {
  const end = p.ended ?? Infinity;
  const years = [p.founded, ...(p.titles ?? []).map((t) => t.year), ...(p.dynasties ?? []).map((d) => d.year)]
    .filter((y) => y >= p.founded && y < end)
    .sort((a, b) => a - b);
  const out: string[] = [];
  for (const y of years) {
    const n = polityName(p, y);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// 同一个 civ、同一年只算一次(搜索框开着时每敲一个字都要用)
let cache: { civ: Civ; year: number; owners: Owners; regions: Int32Array; names: string[][] } | null = null;
function prepared(civ: Civ, year: number) {
  if (cache && cache.civ === civ && cache.year === year) return cache;
  const owners = ownersAt(civ, year);
  const regions = new Int32Array(civ.polities.length);
  for (let r = 0; r < civ.regions.count; r++) {
    const p = owners.polity[r];
    if (p >= 0) regions[p]++;
  }
  const names = cache && cache.civ === civ ? cache.names : civ.polities.map((p) => polityUsedNames(p));
  cache = { civ, year, owners: { culture: owners.culture.slice(), polity: owners.polity.slice() }, regions, names };
  return cache;
}

/** 名字对上的程度:0 完全相同、1 开头对上、2 名字里有;对不上 = −1 */
function matchScore(name: string, q: string): number {
  if (!name) return -1;
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  return n.includes(q) ? 2 : -1;
}
function best(names: readonly string[], q: string): number {
  let s = -1;
  for (const n of names) {
    const m = matchScore(n, q);
    if (m >= 0 && (s < 0 || m < s)) s = m;
  }
  return s;
}

/** 民族在这一年人口最多的州(城镇人口加起来,没有城镇的按承载力);这一年一州都没有 = 发源地 */
export function cultureRegion(civ: Civ, culture: number, year: number, owners: Owners): number {
  const pop = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) if (owners.culture[r] === culture) pop.set(r, civ.regions.capacity[r] * 1e-6);
  if (!pop.size) return civ.cultures[culture]?.hearth ?? 0;
  for (const s of civ.settlements) {
    if (!pop.has(s.region) || s.founded > year || (s.ended !== undefined && s.ended <= year)) continue;
    pop.set(s.region, pop.get(s.region)! + populationAt(s, year));
  }
  let bestR = -1;
  let bestP = -Infinity;
  for (const [r, p] of pop) if (p > bestP || (p === bestP && r < bestR)) [bestR, bestP] = [r, p];
  return bestR;
}

interface Scored extends SearchHit {
  score: number;
  /** 同样对得上时谁在前:越大越前 */
  weight: number;
}

const KIND_ORDER: Record<SearchHit['kind'], number> = { polity: 0, settlement: 1, culture: 2, faith: 3, place: 4 };

/** 按名字找;q 为空 = 这一年最大的几个国家 */
export function searchCiv(civ: Civ, query: string, yearIn: number, limit = SEARCH_LIMIT): SearchHit[] {
  const year = Math.floor(Math.min(civ.endYear, Math.max(0, yearIn)));
  const { owners, regions, names } = prepared(civ, year);
  const q = query.trim().toLowerCase();
  const polityHit = (p: Polity, score: number, sub?: string): Scored => {
    const alive = polityAlive(p, year);
    return {
      kind: 'polity',
      id: p.id,
      name: polityNameAt(p, year),
      sub: sub ?? (alive ? `${regions[p.id]} 州` : year < p.founded ? `${Math.floor(p.founded)} 年立国` : '已亡'),
      color: rgb(p.color),
      select: { kind: 'polity', id: p.id },
      score,
      weight: (alive ? 1e6 : 0) + regions[p.id],
    };
  };

  if (!q) {
    return civ.polities
      .filter((p) => polityAlive(p, year))
      .map((p) => polityHit(p, 0))
      .sort((a, b) => b.weight - a.weight || a.id - b.id)
      .slice(0, limit)
      .map(strip);
  }

  const out: Scored[] = [];
  // 国家:这一年的国号,或者用过的国号(右边写"曾称某某");国都对上了也算(右边写"国都 某城")
  for (const p of civ.polities) {
    const now = matchScore(polityNameAt(p, year), q);
    const old = now < 0 ? [...names[p.id]].reverse().find((n) => matchScore(n, q) >= 0) : undefined;
    const s = now >= 0 ? now : old ? best([old], q) : -1;
    const cap = civ.settlements[capitalAt(p, Math.max(year, p.founded))];
    const cs = cap ? matchScore(cap.name, q) : -1;
    if (s >= 0 && (cs < 0 || s <= cs)) out.push(polityHit(p, s, old ? `曾称${old}` : undefined));
    else if (cs >= 0) out.push(polityHit(p, cs + 0.5, `国都 ${cap!.name}`));
  }
  // 城
  for (const s of civ.settlements) {
    const m = matchScore(s.name, q);
    if (m < 0) continue;
    const owner = owners.polity[s.region];
    const op = owner >= 0 ? civ.polities[owner] : undefined;
    const built = s.founded <= year;
    const ruined = s.ended !== undefined && s.ended <= year;
    const isCap = !!op && built && !ruined && capitalAt(op, year) === s.id;
    const sub = !built
      ? `城，${Math.floor(s.founded)} 年建`
      : ruined
        ? '城，已成废墟'
        : isCap
          ? `国都，${polityNameAt(op!, year)}`
          : op
            ? `城，属${polityNameAt(op, year)}`
            : '城';
    const cu = civ.cultures[s.culture];
    out.push({
      kind: 'settlement',
      id: s.id,
      name: s.name,
      sub,
      color: op ? rgb(op.color) : cu ? rgb(cu.color) : '#999',
      select: { kind: 'settlement', id: s.id },
      score: m,
      weight: built && !ruined ? populationAt(s, year) : 0,
    });
  }
  // 民族:"某某" 和 "某某族" 都算
  for (const cu of civ.cultures) {
    const label = cultureLabel(cu);
    const m = best([cu.name, label], q);
    if (m < 0) continue;
    let n = 0;
    for (let r = 0; r < civ.regions.count; r++) if (owners.culture[r] === cu.id) n++;
    out.push({
      kind: 'culture',
      id: cu.id,
      name: label,
      sub: '民族',
      color: rgb(cu.color),
      select: { kind: 'region', id: cultureRegion(civ, cu.id, year, owners) },
      score: m,
      weight: n,
    });
  }
  // 信仰:大教、教派、各族的民间信仰
  let fn: Int32Array | null = null;
  for (const f of civ.religion?.faiths ?? []) {
    const m = matchScore(f.name, q);
    if (m < 0) continue;
    fn ??= faithCounts(civ, year, undefined, owners).n;
    const later = f.kind !== 'folk' && (f.founded ?? 0) > year;
    out.push({
      kind: 'faith',
      id: f.id,
      name: f.name,
      sub: f.kind === 'folk' ? '民间信仰' : `${f.kind === 'sect' ? '教派' : '宗教'}${later ? `，${Math.floor(f.founded ?? 0)} 年${f.kind === 'sect' ? '分出' : '创立'}` : ''}`,
      color: rgb(f.color),
      select: { kind: 'faith', id: f.id },
      score: m,
      weight: fn[f.id] ?? 0,
    });
  }
  // 山河湖海岛、荒漠
  civ.places.forEach((pl, i) => {
    const m = matchScore(pl.name, q);
    if (m < 0) return;
    out.push({
      kind: 'place',
      id: i,
      name: pl.name,
      sub: PLACE_KIND[pl.kind],
      color: PLACE_COLOR[pl.kind],
      select: { kind: 'place', id: i },
      score: m,
      weight: -pl.rank * 1e6 + (pl.size ?? 0),
    });
  });
  return out
    .sort((a, b) => a.score - b.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.weight - a.weight || a.id - b.id)
    .slice(0, limit)
    .map(strip);
}

function strip(h: Scored): SearchHit {
  const { score: _s, weight: _w, ...rest } = h;
  return rest;
}
