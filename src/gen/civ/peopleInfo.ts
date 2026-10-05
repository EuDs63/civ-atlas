/**
 * 人物页的整理(纯计算,不碰 DOM):人物卡片、世界概览的人物页、国家卡片的历代君主、搜索共用。
 *
 * - peopleIndex     每国的历代君主(按即位先后)、每国的将领(按第一次领兵先后)、每场战争的宣战史事
 * - personSpan      一个人"在台上"的年份:君主 = 在位;将领 = 第一次领兵到最后一次卸任
 * - commandFoes     领兵打的是哪国:攻方"伐"、守方"抗"
 * - riseText        君主怎么上台的一句:"继兄明宗即位""起兵代大衍，开国""叛萨兰提亚帝国自立"
 * - personFame      谁算名人、为什么(famousPeople = 全世界的名人,新的在前)。只看推演里真发生的事,打分够 FAME_MIN 算:
 *     君主:开创的朝代称过帝 +6(开国 / 起兵建立新朝);复国 +4;叛离自立、篡位 +3;在位时本国攻下 4 州以上 +州数;
 *           亲征 +1;称大帝、殉国 +3
 *     将领:攻下 3 州以上 +2×州数;击退来攻 3 次以上 +2×次数;战死 +3
 *   名人的"事迹"(卡片概况第一行)只写为什么出名;人物页的一行(fameLine)前面加国名和身份、伐谁抗谁。
 */
import type { Annal, Civ, Person, PersonCommand, Year } from './types';
import { polityName, polityShortTitle, polityTierAt } from './growth';
import { cnNumber } from './chronicle';
import { KIN_BACK, isConsul, kinOf, rulerRef, rulerShort } from './peopleText';

/** 够这么多分算名人 */
export const FAME_MIN = 6;

export interface PeopleIndex {
  /** 每国的历代君主(按即位先后) */
  rulers: Person[][];
  /** 每国的将领(按第一次领兵先后) */
  generals: Person[][];
  /** 战争编号 → 宣战那条史事 */
  wars: Map<number, Annal>;
  /** 每国在战争里攻下州的年份(按先后) */
  gains: number[][];
}

const indexCache = new WeakMap<object, PeopleIndex>();

/** 人物索引(按 civ.people、civ.annals 缓存:改名换了 civ 对象,索引还是这一份) */
export function peopleIndex(civ: Civ): PeopleIndex {
  const key = civ.people ?? civ.annals;
  const hit = indexCache.get(key);
  if (hit && hit.rulers.length === civ.polities.length) return hit;
  const n = civ.polities.length;
  const ix: PeopleIndex = { rulers: [], generals: [], wars: new Map(), gains: [] };
  for (let i = 0; i < n; i++) {
    ix.rulers.push([]);
    ix.generals.push([]);
    ix.gains.push([]);
  }
  for (const x of civ.people ?? []) {
    if (x.polity < 0 || x.polity >= n) continue;
    if (x.role === 'ruler') ix.rulers[x.polity].push(x);
    else if (x.commands?.length) ix.generals[x.polity].push(x);
  }
  for (const rs of ix.rulers) rs.sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || a.id - b.id);
  for (const gs of ix.generals) gs.sort((a, b) => a.commands![0].from - b.commands![0].from || a.id - b.id);
  for (const e of civ.annals) {
    if (e.kind === 'war' && e.war >= 0 && !ix.wars.has(e.war)) ix.wars.set(e.war, e);
    if (e.kind === 'conquer' && e.war >= 0 && e.a >= 0 && e.a < n) ix.gains[e.a].push(e.year);
  }
  indexCache.set(key, ix);
  return ix;
}

/** 一个人在台上的年份:君主 = 即位到失位(还在位 = null);将领 = 第一次领兵到最后一次卸任 */
export function personSpan(x: Person): { from: Year; until: Year | null } {
  if (x.role === 'ruler') return { from: x.from ?? x.born, until: x.until ?? null };
  const cs = x.commands ?? [];
  if (!cs.length) return { from: x.born, until: x.died ?? null };
  return { from: cs[0].from, until: cs[cs.length - 1].until };
}

/** 某国的某位君主前后各是谁(同一国、按即位先后;不分朝代) */
export function rulerNeighbors(civ: Civ, x: Person): { prev: Person | null; next: Person | null } {
  const rs = peopleIndex(civ).rulers[x.polity] ?? [];
  const k = rs.indexOf(x);
  return { prev: k > 0 ? rs[k - 1] : null, next: k >= 0 && k + 1 < rs.length ? rs[k + 1] : null };
}

/** 这一刻在位的君主(没有 = null;还没即位的、已经失位的不算) */
export function rulerAt(civ: Civ, polity: number, year: Year): Person | null {
  const rs = peopleIndex(civ).rulers[polity] ?? [];
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if ((r.from ?? Infinity) <= year) return r.until === undefined || year < r.until ? r : null;
  }
  return null;
}

export interface Foe {
  /** 伐 = 攻方;抗 = 守方 */
  verb: '伐' | '抗';
  polity: number;
  from: Year;
  until: Year;
}

/** 一次领兵打的是哪国(找不到宣战那条 = −1) */
export function commandFoe(civ: Civ, c: PersonCommand): number {
  const w = peopleIndex(civ).wars.get(c.war);
  if (!w) return -1;
  return c.side === 0 ? w.b : w.a;
}

/** 领兵打过的仗(同一场战争多次领兵并成一条) */
export function commandFoes(civ: Civ, x: Person): Foe[] {
  const out: Foe[] = [];
  const seen = new Map<number, Foe>();
  for (const c of x.commands ?? []) {
    const had = seen.get(c.war);
    if (had) {
      had.until = Math.max(had.until, c.until);
      continue;
    }
    const polity = commandFoe(civ, c);
    if (polity < 0 || !civ.polities[polity]) continue;
    const f: Foe = { verb: c.side === 0 ? '伐' : '抗', polity, from: c.from, until: c.until };
    seen.set(c.war, f);
    out.push(f);
  }
  return out;
}

/** "伐萨尔斯坦帝国""伐甲国、抗乙国"(国名按领兵那年) */
export function foesText(civ: Civ, foes: readonly Foe[]): string {
  return foes.map((f) => `${f.verb}${polityName(civ.polities[f.polity], f.from)}`).join('、');
}

/** 将领经手的仗:攻下几州、守住几次(战役没打下来的攻方是他的对手) */
export function generalTally(civ: Civ, x: Person): { took: number; held: number } {
  let took = 0;
  let held = 0;
  const A = civ.annals;
  for (const c of x.commands ?? []) {
    for (let i = Math.max(0, c.first); i <= c.last && i < A.length; i++) {
      const e = A[i];
      if (e.war !== c.war) continue;
      if (e.kind === 'conquer' && e.a === x.polity) took++;
      if (e.kind === 'battle' && e.b === x.polity) held++;
    }
  }
  return { took, held };
}

/** 君主在位时本国在战争里攻下几州 */
export function reignGains(civ: Civ, x: Person): number {
  const ys = peopleIndex(civ).gains[x.polity] ?? [];
  const from = x.from ?? Infinity;
  const until = x.until ?? Infinity;
  let n = 0;
  for (const y of ys) if (y >= from && y < until) n++;
  return n;
}

/** 某一朝的起止年份和最高档位(第 0 朝从立国算起;最后一朝到亡国或结束年份) */
function dynastyInfo(civ: Civ, polity: number, di: number): { from: Year; to: Year; ended: boolean; peak: number } {
  const p = civ.polities[polity];
  const ds = p.dynasties ?? [];
  const from = di === 0 ? p.founded : (ds[di]?.year ?? p.founded);
  const next = ds[di + 1]?.year;
  const to = next ?? p.ended ?? civ.endYear;
  let peak = polityTierAt(p, from);
  for (const t of p.titles ?? []) if (t.year >= from && t.year < to) peak = Math.max(peak, t.tier);
  return { from, to, ended: next !== undefined || p.ended !== undefined, peak };
}

/**
 * 君主怎么上台的一句(人物页「君主」一行的开头):
 * 继位 "继兄明宗即位";立国 "立国";起兵改朝 "起兵代大衍，开国";叛离 "叛某国自立";复国 "复某国";篡位 "篡位";
 * 共和国的执政官 "接某某继任"
 */
export function riseText(civ: Civ, x: Person): string {
  const p = civ.polities[x.polity];
  if (!p) return '';
  const { prev } = rulerNeighbors(civ, x);
  const y = x.from ?? p.founded;
  const consul = isConsul(civ, x);
  switch (x.rise) {
    case 'found':
      return '立国';
    case 'rise': {
      if (!p.eastern) return '起兵建立新朝';
      const before = y - 1 / 512;
      return `起兵代${polityShortTitle(p, Math.max(0, Math.min(3, polityTierAt(p, before))), before)}，开国`;
    }
    case 'rebel':
      return p.parent !== undefined && civ.polities[p.parent] ? `叛${polityName(civ.polities[p.parent], y)}自立` : '叛离自立';
    case 'restore':
      return p.restores !== undefined && civ.polities[p.restores] ? `复${polityName(civ.polities[p.restores], civ.polities[p.restores].ended ?? y)}之国` : '复国';
    case 'usurp':
      return '篡位';
    default:
      if (!prev) return consul ? '就任' : '即位';
      if (consul) return `接${rulerShort(civ, prev)}继任`;
      if ((prev.dynasty ?? 0) !== (x.dynasty ?? 0)) return '即位';
      return `继${KIN_BACK[kinOf(prev, x)]}${rulerShort(civ, prev)}即位`;
  }
}

export interface Fame {
  id: number;
  score: number;
  /** 事迹(卡片概况第一行):"在位时得五州""攻取三州""起兵建立新朝，传 27 位、416 年" */
  deeds: string;
}

const fameCache = new WeakMap<object, Map<number, Fame>>();

/** 全世界的名人(按人物编号查);按 civ.people 缓存(事迹里不写国名,改名不用重算) */
function fameMap(civ: Civ): Map<number, Fame> {
  const key = civ.people ?? civ.annals;
  const hit = fameCache.get(key);
  if (hit) return hit;
  const out = new Map<number, Fame>();
  const ix = peopleIndex(civ);
  for (const x of civ.people ?? []) {
    if (x.polity < 0 || !civ.polities[x.polity]) continue;
    const deeds: string[] = [];
    let score = 0;
    if (x.role === 'ruler') {
      if (x.rise === 'found' || x.rise === 'rise') {
        const di = x.dynasty ?? 0;
        const d = dynastyInfo(civ, x.polity, di);
        if (d.peak >= 3) {
          const n = ix.rulers[x.polity].filter((r) => (r.dynasty ?? 0) === di).length;
          const years = Math.floor(d.to - d.from);
          const how = x.rise === 'rise' ? '起兵建立新朝' : '立国';
          if (isConsul(civ, x)) deeds.push(`立国，${d.ended ? '' : '至今'}国祚 ${years} 年`);
          else deeds.push(d.ended ? `${how}，传 ${n} 位、${years} 年` : `${how}，传 ${n} 位，至今 ${years} 年`);
          score += 6;
        }
      }
      if (x.rise === 'restore') {
        deeds.push('复国');
        score += 4;
      }
      if (x.rise === 'rebel') {
        deeds.push('叛离自立');
        score += 3;
      }
      if (x.rise === 'usurp') {
        deeds.push('篡位');
        score += 3;
      }
      const gains = reignGains(civ, x);
      if (gains >= 4) {
        deeds.push(`在位时得${cnNumber(gains)}州`);
        score += gains;
      }
      if (x.commands?.length) score += 1;
      if (x.title === '大帝') {
        deeds.push('称大帝');
        score += 3;
      }
      if (x.fate === 'fell') {
        deeds.push('殉国');
        score += 3;
      }
    } else {
      const { took, held } = generalTally(civ, x);
      if (took >= 3) {
        deeds.push(`攻取${cnNumber(took)}州`);
        score += 2 * took;
      }
      if (held >= 3) {
        deeds.push(`击退来攻${cnNumber(held)}次`);
        score += 2 * held;
      }
      if (x.fate === 'battle') {
        deeds.push('战死');
        score += 3;
      }
    }
    if (score >= FAME_MIN) out.set(x.id, { id: x.id, score, deeds: deeds.join('，') });
  }
  fameCache.set(key, out);
  return out;
}

/** 这个人是不是名人(不是 = null) */
export function personFame(civ: Civ, x: Person): Fame | null {
  return fameMap(civ).get(x.id) ?? null;
}

/** 全世界的名人,按上台的年份新的在前(同年按编号) */
export function famousPeople(civ: Civ): Fame[] {
  const ps = civ.people ?? [];
  return [...fameMap(civ).values()].sort((a, b) => personSpan(ps[b.id]).from - personSpan(ps[a.id]).from || a.id - b.id);
}

/**
 * 人物页「名人」的一行:国名 + 身份,再写为什么出名 ——
 * "大景王朝君主，在位时得五州，亲征萨尔斯坦帝国""尼梅亚帝国将领，伐奈雷亚国，攻取八州"(国名按他在台上的中间那年)
 */
export function fameLine(civ: Civ, x: Person, f: Fame): string {
  const p = civ.polities[x.polity];
  const span = personSpan(x);
  const mid = (span.from + (span.until ?? civ.endYear)) / 2;
  const who = `${polityName(p, mid)}${x.role === 'ruler' ? (isConsul(civ, x) ? '执政' : '君主') : '将领'}`;
  const foes = commandFoes(civ, x);
  if (x.role === 'ruler') return [who, f.deeds, foes.length ? campaignText(civ, foes) : ''].filter(Boolean).join('，');
  return [who, foesText(civ, foes), f.deeds].filter(Boolean).join('，');
}

/** 君主亲自领兵:"亲征萨尔斯坦帝国";守方 "亲自领兵抗某国" */
export function campaignText(civ: Civ, foes: readonly Foe[]): string {
  const name = (f: Foe) => polityName(civ.polities[f.polity], f.from);
  const att = foes.filter((f) => f.verb === '伐').map(name);
  const def = foes.filter((f) => f.verb === '抗').map(name);
  return [att.length ? `亲征${att.join('、')}` : '', def.length ? `亲自领兵抗${def.join('、')}` : ''].filter(Boolean).join('，');
}

export interface Mention {
  text: string;
  /** 这一段是哪个人的名字(Person.id);不是名字 = 不给 */
  person?: number;
}

/**
 * 纪事正文里写到的人名切出来(界面上变成能点的蓝字):ids = 这一条写到的人物(ChronicleEntry.people),
 * skip = 不切的那个人(人物卡片里他自己),year = 这一条的年份(给了就连国名带称号一起切:"大景明宗")。
 * 每个人只切第一次出现;东方君主按名字、称号找("大景圣宗崩……其孙柳珩琅即位"),西幻按名字 + 序数找("阿尔德里克三世");
 * 先出现的先切,同一处长的先切
 */
export function personMentions(civ: Civ, text: string, ids: readonly number[] | undefined, skip = -1, year?: Year): Mention[] {
  const cands: { s: string; id: number }[] = [];
  for (const id of ids ?? []) {
    const x = civ.people?.[id];
    if (!x || id === skip) continue;
    const forms = new Set<string>([rulerShort(civ, x), x.name]);
    if (x.role === 'ruler' && x.title) {
      forms.add(x.title);
      if (year !== undefined && civ.polities[x.polity]?.eastern) forms.add(rulerRef(civ, x, year));
    }
    for (const s of forms) if ([...s].length >= 2) cands.push({ s, id });
  }
  if (!cands.length) return [{ text }];
  // 所有出现的地方,前面的先切;同一处长的先切;每人只切一次、不和已切的重叠
  const all: { at: number; end: number; id: number }[] = [];
  for (const c of cands) for (let at = text.indexOf(c.s); at >= 0; at = text.indexOf(c.s, at + 1)) all.push({ at, end: at + c.s.length, id: c.id });
  all.sort((a, b) => a.at - b.at || b.end - a.end);
  const hits: { at: number; end: number; id: number }[] = [];
  const done = new Set<number>();
  for (const h of all) {
    if (done.has(h.id) || hits.some((o) => h.at < o.end && h.end > o.at)) continue;
    hits.push(h);
    done.add(h.id);
  }
  if (!hits.length) return [{ text }];
  hits.sort((a, b) => a.at - b.at);
  const out: Mention[] = [];
  let k = 0;
  for (const h of hits) {
    if (h.at > k) out.push({ text: text.slice(k, h.at) });
    out.push({ text: text.slice(h.at, h.end), person: h.id });
    k = h.end;
  }
  if (k < text.length) out.push({ text: text.slice(k) });
  return out;
}
