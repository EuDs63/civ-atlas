/**
 * 信仰的文字(纯计算,不碰 DOM):类型的说明、侧栏 / 图例里按信仰列的几行、编年史里的宗教大事。
 *
 * 宗教大事(faithEntries):创教、立国教、传入一国、教派分立、圣城易主,和现有纪事一样用半角逗号。
 *   创教、教派分立是大事(重要度 3);当年州数前五的国家立国教是 2;小国立国教、传入是 1。
 *   不放进 buildChronicle(那里只有史事,AI 的材料用它);编年史、时间轴、卡片里的大事用 fullChronicle(史事 + 继位以外的宗教大事)。
 */
import type { Civ, Faith, FaithEvent, FaithEventKind, FaithForm, Year } from './types';
import { polityName } from './growth';
import { ownersAt, type Owners } from './timeline';
import { rulerRef } from './peopleText';
import { buildChronicle, mergeChronicle, type ChronicleEntry, type Importance } from './chronicle';
import { faithCounts, faithRoot, FOLK_COLOR } from './religion';

/** 类型的说明(宗教卡片「类型」一行的小字) */
export const FORM_NOTE: Record<FaithForm, string> = {
  一神: '只拜一位神',
  多神: '拜很多神',
  二元: '善神恶神相争',
  哲理: '讲修身处世，不拜神',
  修行: '出家修行',
};

/** 宗教大事的一字标签(界面上的类型名见 timelineLayout.ts 的 TAG_LABEL:创教、国教、传入、教派、圣城) */
const TAG: Record<FaithEventKind, string> = { found: '创', state: '皈', enter: '传', schism: '派', holy: '圣' };

/** 立国教算"大国"的:当年州数前几名 */
const BIG_STATES = 5;

const polName = (civ: Civ, p: number, y: Year) => (p >= 0 && civ.polities[p] ? polityName(civ.polities[p], y) : '');
const cityName = (civ: Civ, s: number) => (s >= 0 && civ.settlements[s] ? civ.settlements[s].name : '');

/** 一件宗教大事写成一句 */
export function faithEventText(civ: Civ, e: FaithEvent): string {
  const rel = civ.religion!;
  const f = rel.faiths[e.faith];
  const pol = polName(civ, e.polity, e.year);
  const ruler = e.ruler !== undefined ? civ.people?.[e.ruler] : undefined;
  const who = ruler ? rulerRef(civ, ruler, e.year) : pol;
  const city = cityName(civ, e.settlement);
  switch (e.kind) {
    case 'found':
      return `${f.founder?.name ?? ''}于${city}创立${f.name}`;
    case 'state':
      return `${who}皈依${f.name},立为国教`;
    case 'enter':
      return city ? `${f.name}传入${pol},始于${city}` : `${f.name}传入${pol}`;
    case 'schism':
      return `${who}另立${f.name},自${rel.faiths[f.parent ?? e.faith].name}分出`;
    case 'holy':
      return `${pol}夺得${city},${f.name}圣城易主`;
  }
}

/** 某一年州数前 BIG_STATES 名的国家 */
function bigStates(civ: Civ, own: Owners): Set<number> {
  const n = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) {
    const p = own.polity[r];
    if (p >= 0) n.set(p, (n.get(p) ?? 0) + 1);
  }
  return new Set([...n].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, BIG_STATES).map(([p]) => p));
}

const entryCache = new WeakMap<Civ, ChronicleEntry[]>();

/**
 * 宗教大事 → 编年史条目(按年份排好)。kind = 'faith',faith = 哪种信仰;
 * id = 史事条数 + 人物数 + 第几件(不和史事、继位的 id 撞)。没有信仰 = 空数组。按 civ 缓存
 */
export function faithEntries(civ: Civ): ChronicleEntry[] {
  const hit = entryCache.get(civ);
  if (hit) return hit;
  const out: ChronicleEntry[] = [];
  const rel = civ.religion;
  if (rel) {
    const n0 = (civ.annals?.length ?? 0) + (civ.people?.length ?? 0);
    let own: Owners | undefined;
    let ownYear = NaN;
    rel.events.forEach((e, i) => {
      let importance: Importance = 1;
      if (e.kind === 'found' || e.kind === 'schism') importance = 3;
      else if (e.kind === 'state') {
        if (ownYear !== e.year) own = ownersAt(civ, (ownYear = e.year), own);
        if (bigStates(civ, own!).has(e.polity)) importance = 2;
      }
      const polities = [e.polity];
      if (e.kind === 'holy' && e.from !== undefined) polities.push(e.from);
      out.push({
        id: n0 + i,
        kind: 'faith',
        year: e.year,
        end: e.year,
        text: faithEventText(civ, e),
        tag: TAG[e.kind],
        importance,
        polities: polities.filter((p) => p >= 0),
        regions: e.region >= 0 ? [e.region] : [],
        settlement: e.settlement,
        people: e.ruler !== undefined ? [e.ruler] : undefined,
        faith: e.faith,
      });
    });
    out.sort((a, b) => a.year - b.year || a.id - b.id);
  }
  entryCache.set(civ, out);
  return out;
}

const fullCache = new WeakMap<Civ, ChronicleEntry[]>();

/** 史事 + 宗教大事(编年史、时间轴、最近大事、卡片里的大事用这一份;不含君主继位)。按 civ 缓存;地图在更早一段时按整段历史(Civ.history)算 */
export function fullChronicle(civ: Civ): ChronicleEntry[] {
  if (civ.history) return fullChronicle(civ.history);
  const hit = fullCache.get(civ);
  if (hit) return hit;
  const out = mergeChronicle(buildChronicle(civ), faithEntries(civ));
  fullCache.set(civ, out);
  return out;
}

/** 侧栏、图例里的一行:大教 / 教派(id = 信仰编号)或合成一行的民间信仰(id = −1) */
export interface FaithRow {
  id: number;
  name: string;
  color: readonly [number, number, number];
  /** 第二行小字(大教:类型、创立;民间信仰:说明;教派:从哪分出) */
  sub: string;
  /** 这一年几个州 */
  n: number;
  sect: boolean;
}

/** 民间信仰合成的那一行 */
export const FOLK_ROW_NAME = '民间信仰';
export const FOLK_ROW_SUB = '各族自己的祖灵、旧神';

/**
 * 某一年的信仰列表:大教按(自己 + 教派)的州数排,教派(按州数)跟在本教后面,最后一行民间信仰;
 * 一个州都没有的不列(大教自己没有、教派还有的照列)
 */
export function faithRows(civ: Civ, year: Year): FaithRow[] {
  const rel = civ.religion;
  if (!rel) return [];
  const { n, folk } = faithCounts(civ, year);
  const born = (f: Faith) => f.kind !== 'folk' && (f.founded ?? 0) <= year;
  const sectsOf = (g: number) => rel.faiths.filter((f) => f.kind === 'sect' && f.parent === g && born(f) && n[f.id] > 0).sort((a, b) => n[b.id] - n[a.id] || a.id - b.id);
  const total = (g: number) => sectsOf(g).reduce((a, f) => a + n[f.id], n[g]);
  const greats = rel.faiths.filter((f) => f.kind === 'great' && born(f) && total(f.id) > 0).sort((a, b) => total(b.id) - total(a.id) || a.id - b.id);
  const rows: FaithRow[] = [];
  for (const g of greats) {
    rows.push({ id: g.id, name: g.name, color: g.color, sub: greatSub(civ, g), n: n[g.id], sect: false });
    for (const s of sectsOf(g.id)) rows.push({ id: s.id, name: s.name, color: s.color, sub: `${Math.floor(s.founded ?? 0)} 年从${g.name}分出`, n: n[s.id], sect: true });
  }
  if (folk > 0) rows.push({ id: -1, name: FOLK_ROW_NAME, color: FOLK_COLOR, sub: FOLK_ROW_SUB, n: folk, sect: false });
  return rows;
}

/** 大教的一行小字:"哲理，1140 年创于揽霞城" */
export function greatSub(civ: Civ, g: Faith): string {
  const city = g.holy !== undefined ? cityName(civ, g.holy) : '';
  return `${g.form ?? ''}，${Math.floor(g.founded ?? 0)} 年${city ? `创于${city}` : '创立'}`;
}

/** 这件宗教大事属于哪个大教(卡片按本教列大事:大教连同它的教派) */
export function eventRoot(civ: Civ, e: ChronicleEntry): number {
  return e.faith === undefined || !civ.religion ? -1 : faithRoot(civ.religion, e.faith);
}

/** 信众小柱图:每隔这么多年一根 */
export const FAITH_SPARK_STEP = 250;

const sparkCache = new WeakMap<object, { years: number[]; n: Int32Array[] }>();

/**
 * 各信仰的历年州数(0 年起每 FAITH_SPARK_STEP 年一份,最后一份是结束那年):宗教卡片「信众」的小柱图。
 * 按信仰日志缓存(改名不重算)
 */
export function faithHistory(civ: Civ): { years: number[]; n: Int32Array[] } {
  const rel = civ.religion;
  if (!rel) return { years: [], n: [] };
  const hit = sparkCache.get(rel.log);
  if (hit) return hit;
  const years: number[] = [];
  for (let y = 0; y < civ.endYear; y += FAITH_SPARK_STEP) years.push(y);
  years.push(civ.endYear);
  const n = years.map((y) => faithCounts(civ, y).n);
  const out = { years, n };
  sparkCache.set(rel.log, out);
  return out;
}
