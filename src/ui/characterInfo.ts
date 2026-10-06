/**
 * 作者的人物的文字和位置(卡片、世界概览、搜索、复制、悬停小卡片、地图上的足迹共用;数据格式见 gen/characters.ts 文件头)。
 *
 * - 地方:城键 → 那座城(地图上画在城的位置),州键 → 那一州(画在州的中间),一个点 → 世界坐标(写成"落烟渡，紫月洲"这样的一句)
 * - 国家:写了就是那一国;没写 = 出生地在生年归属的国家
 * - 推演里的事:编年史里折叠的战争拆成一件一件,加上历代换君主;每件事一个稳定键(年份 + 种类 + 事发的州 / 城 / 国 + 牵涉的国家),重推以后按它找回
 * - 反过来:推演人物、城、州的卡片上列出和它有关的作者人物
 */
import type { Civ, Person } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { reignEntries, type ChronicleEntry } from '../gen/civ/chronicle';
import { fullChronicle } from '../gen/civ/religionText';
import { regionLabel } from '../gen/civ/display';
import { polityName } from '../gen/civ/growth';
import { rulerAt } from '../gen/civ/peopleInfo';
import { personName, personRoleShort } from '../gen/civ/peopleText';
import { ownersAt } from '../gen/civ/timeline';
import { polityKey, regionKey, regionOfKey, resolveKey, settlementKey } from '../gen/edits';
import { characterAge, lifeInOrder, lifeStops, personKey, resolvePersonKey, sameWhere, stopAt, type AuthorCharacter, type Where } from '../gen/characters';
import { MARK_HEX } from '../render/marks';
import type { TrailInput } from '../render/trail';
import { evText } from './timelineLayout';
import { markSpot, spotText } from './markInfo';
import type { HoverInfo } from './hoverInfo';

const F = Math.floor;

/** 时间轴的年份夹到这个世界的历史里(还没开始 / 结束以后按两头算) */
const clampYear = (civ: Civ, y: number) => Math.min(civ.endYear, Math.max(0, y));

/** 这一州 year 年归哪国(无主、海上 = −1) */
export function regionOwner(civ: Civ, r: number, year: number): number {
  if (!(r >= 0 && r < civ.regions.count)) return -1;
  return ownersAt(civ, clampYear(civ, year)).polity[r] ?? -1;
}

// ---------------------------------------------------------------------------
// 地方

/** 一个地方在这个世界里:画在哪、叫什么 */
export interface CharPlace {
  kind: 'city' | 'region' | 'point';
  /** 世界坐标(地图上画在哪);城、州找不到了 = null */
  at: [number, number] | null;
  /** 城(城键找到的那座;一个点挨着的那座) */
  city?: number;
  /** 州(城所在的州;州键找到的;一个点落在的州;海上没有) */
  region?: number;
  /** 名字:城名、州名;一个点 = "落烟渡，紫月洲" / "风暴海";找不到 = "这个地方找不到了" */
  name: string;
  /** 城、州按键找不到了(作者干预后重推、城没建起来) */
  missing?: boolean;
}

const MISSING = '这个地方找不到了';

/** 各州的中间(画足迹用;州只由地形定,按州划分存一份):各地块的平均位置,不在这一州里就挪到离它最近的地块 */
const centerCache = new WeakMap<object, Float32Array>();
function regionCenter(world: World, civ: Civ, r: number): [number, number] {
  const R = civ.regions;
  let cs = centerCache.get(R);
  if (!cs) {
    cs = new Float32Array(R.count * 2).fill(NaN);
    centerCache.set(R, cs);
  }
  if (Number.isNaN(cs[2 * r])) {
    const { x, y, spacing } = world.mesh;
    const W = world.width;
    const a = R.cellStart[r];
    const b = R.cellStart[r + 1];
    const ref = x[R.cells[a]];
    const near = (v: number) => v - W * Math.round((v - ref) / W);
    let sx = 0;
    let sy = 0;
    for (let k = a; k < b; k++) {
      sx += near(x[R.cells[k]]);
      sy += y[R.cells[k]];
    }
    let cx = sx / Math.max(1, b - a);
    let cy = sy / Math.max(1, b - a);
    let best = -1;
    let bd = Infinity;
    for (let k = a; k < b; k++) {
      const c = R.cells[k];
      const d = (near(x[c]) - cx) ** 2 + (y[c] - cy) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best >= 0 && bd > (spacing * 1.5) ** 2) {
      cx = near(x[best]);
      cy = y[best];
    }
    cs[2 * r] = cx - W * Math.floor(cx / W);
    cs[2 * r + 1] = cy;
  }
  return [cs[2 * r], cs[2 * r + 1]];
}

/** 一个地方(Where)在这个世界里是哪;year = 那一年(一个点挨着的城按那一年还在的算) */
export function placeOf(civ: Civ, world: World, raster: Raster | null, w: Where, year: number): CharPlace {
  if (typeof w !== 'string') {
    const spot = markSpot(civ, world, raster, w, year);
    return { kind: 'point', at: [w[0], w[1]], city: spot.city, region: spot.region, name: spotText(civ, spot) };
  }
  if (w.startsWith('region:')) {
    const r = regionOfKey(w, civ.regions.of);
    if (!(r >= 0 && r < civ.regions.count)) return { kind: 'region', at: null, name: MISSING, missing: true };
    return { kind: 'region', at: regionCenter(world, civ, r), region: r, name: regionLabel(civ, r) };
  }
  const k = resolveKey(civ, w);
  const s = k?.kind === 'settlement' ? civ.settlements[k.id] : undefined;
  if (!s) return { kind: 'city', at: null, name: MISSING, missing: true };
  return { kind: 'city', at: [world.mesh.x[s.cell], world.mesh.y[s.cell]], city: s.id, region: s.region, name: s.name };
}

/** 世界坐标、州号 → 存进人物里的地方:点到城(城镇符号、城名)= 城键,点到州里 = 那一点 */
export function whereOfCity(civ: Civ, id: number): Where {
  return settlementKey(civ, id);
}

/** 州 → 存进人物里的地方(州键) */
export function whereOfRegion(civ: Civ, r: number): Where {
  return regionKey(civ, r);
}

// ---------------------------------------------------------------------------
// 国家、年龄

/** 他的国家:写了 = 那一国(找不到了 = −1);没写 = 出生地在生年归属的国家(没有出生地、无主 = −1) */
export function characterPolity(civ: Civ, world: World, raster: Raster | null, c: Pick<AuthorCharacter, 'polity' | 'birthplace' | 'born'>): number {
  if (c.polity) {
    const k = resolveKey(civ, c.polity);
    return k?.kind === 'polity' ? k.id : -1;
  }
  return birthPolity(civ, world, raster, c);
}

/** 出生地在生年归属的国家(没有出生地、无主 = −1) */
export function birthPolity(civ: Civ, world: World, raster: Raster | null, c: Pick<AuthorCharacter, 'birthplace' | 'born'>): number {
  if (!c.birthplace) return -1;
  const pl = placeOf(civ, world, raster, c.birthplace, c.born);
  return pl.region !== undefined ? regionOwner(civ, pl.region, c.born) : -1;
}

/** "2490–2561 年" / "2490 年生" */
export function lifeYears(c: Pick<AuthorCharacter, 'born' | 'died'>): string {
  return c.died === undefined ? `${c.born} 年生` : `${c.born}–${c.died} 年`;
}

/** 那一年的样子:"22 岁" / "还没出生" / "已故" */
export function ageText(c: Pick<AuthorCharacter, 'born' | 'died'>, year: number): string {
  const a = characterAge(c, year);
  return a.state === 'unborn' ? '还没出生' : a.state === 'dead' ? '已故' : `${a.age} 岁`;
}

/** 简介的头一句(到第一个标点),太长就不用 */
function noteHead(note: string | undefined): string {
  const t = (note ?? '').trim().split(/[。，,.;；！!？?\n]/)[0].trim();
  return t.length <= NOTE_HEAD_MAX ? t : '';
}
const NOTE_HEAD_MAX = 16;

/**
 * 人物页一行:"大景王朝书记官、说书人，22 岁" / "…，2520 年出生" / "…，2506 年卒，享年 44 岁"。
 * 没写身份时,别的人物把他列成亲友的,写"林小满的女儿";也没有就用简介的头一句(短的才用)
 */
export function characterLine(civ: Civ, world: World, raster: Raster | null, c: AuthorCharacter, year: number, chars: readonly AuthorCharacter[]): string {
  const p = characterPolity(civ, world, raster, c);
  const pn = p >= 0 ? polityName(civ.polities[p], clampYear(civ, Math.max(c.born, Math.min(year, c.died ?? year)))) : '';
  let role = c.role ?? '';
  let who = `${pn}${role}`;
  if (!role) {
    for (const o of chars) {
      const k = o.id !== c.id ? o.kin?.find((q) => q.char === c.id && q.rel) : undefined;
      if (k) {
        role = `${o.name}的${k.rel}`;
        break;
      }
    }
    if (!role) role = noteHead(c.note);
    who = [pn, role].filter(Boolean).join('，');
  }
  const a = characterAge(c, year);
  const tail = a.state === 'unborn' ? `${c.born} 年出生` : a.state === 'dead' ? `${c.died} 年卒，享年 ${a.age} 岁` : `${a.age} 岁`;
  return who ? `${who}，${tail}` : tail;
}

// ---------------------------------------------------------------------------
// 推演里的事

/** 编年史里的每一件事(折叠的战争拆开)+ 历代换君主,和它们的稳定键。按 civ 存 */
interface EventIndex {
  list: ChronicleEntry[];
  keys: string[];
  byKey: Map<string, ChronicleEntry>;
  keyOf: Map<ChronicleEntry, string>;
}
const eventCache = new WeakMap<Civ, EventIndex>();

/** 一件事落在哪:事发的州 > 相关的城 > 第一个相关的国家 */
function anchorOf(civ: Civ, e: ChronicleEntry): string {
  const r = e.regions[0];
  if (r !== undefined && r >= 0 && r < civ.regions.count) return regionKey(civ, r);
  if (e.settlement >= 0 && civ.settlements[e.settlement]) return settlementKey(civ, e.settlement);
  const p = e.polities[0];
  return p !== undefined && civ.polities[p] ? polityKey(civ, p) : '-';
}

export function eventIndex(civ: Civ): EventIndex {
  let ix = eventCache.get(civ);
  if (ix) return ix;
  const list: ChronicleEntry[] = [];
  if (civ.viable) {
    for (const e of fullChronicle(civ)) for (const x of e.children?.length ? e.children : [e]) list.push(x);
    list.push(...reignEntries(civ));
  }
  const keys: string[] = [];
  const byKey = new Map<string, ChronicleEntry>();
  const keyOf = new Map<ChronicleEntry, string>();
  const seen = new Map<string, number>();
  for (const e of list) {
    // 年份 + 种类 + 落在哪 + 牵涉的国家(最多 4 个):同一年同一处同一类的事也分得开,别的事多了少了不会让它换号
    const who = e.polities.slice(0, 4).map((p) => (civ.polities[p] ? polityKey(civ, p) : '?')).join(',') || '-';
    const base = `event:${F(e.year)}|${e.kind}|${anchorOf(civ, e)}|${who}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const k = `${base}#${n}`;
    keys.push(k);
    byKey.set(k, e);
    keyOf.set(e, k);
  }
  ix = { list, keys, byKey, keyOf };
  eventCache.set(civ, ix);
  return ix;
}

/** 一件事的稳定键(不在索引里 = '') */
export function eventKey(civ: Civ, e: ChronicleEntry): string {
  return eventIndex(civ).keyOf.get(e) ?? '';
}

/** 按稳定键找回那件事(重推以后没有了 = null) */
export function eventOfKey(civ: Civ, key: string): ChronicleEntry | null {
  return eventIndex(civ).byKey.get(key) ?? null;
}

/** 一件事的简称(逗号前那一截):"赤云泽之战" */
export function eventShort(e: Pick<ChronicleEntry, 'text'>): string {
  return evText(e).split(/[,，;；]/)[0];
}

/** 勾选推演里的事:那一年前后几年 */
export const EVENT_SPAN = 5;
/** 最多列几件(勾过的另算) */
export const EVENT_CHOICES = 6;
/** 推演里的人最多列几个(勾过的另算) */
export const PEOPLE_CHOICES = 8;

export interface EventChoice {
  key: string;
  /** 重推以后找不到了 = null */
  entry: ChronicleEntry | null;
}

/**
 * 一段经历能勾的推演里的事:写了地方(落在某一州)= 那几年(前后 EVENT_SPAN 年)那一州的事;没写地方、海上、那几年那里没事 =
 * 他的国家那几年的事(含换君主)。离那一年近的优先,最多 EVENT_CHOICES 件,按先后列;勾过的(找不到了也列)接在后面。
 * scope = 列的是哪一种
 */
export function lifeEventChoices(
  civ: Civ,
  world: World,
  raster: Raster | null,
  c: Pick<AuthorCharacter, 'polity' | 'birthplace' | 'born'>,
  e: { year: number; where?: Where | null; events?: readonly string[] },
): { list: EventChoice[]; scope: 'place' | 'polity' } {
  const ix = eventIndex(civ);
  const y = e.year;
  const near = (x: ChronicleEntry) => Math.abs(F(x.year) - y) <= EVENT_SPAN;
  const pick = (ok: (x: ChronicleEntry) => boolean) =>
    ix.list
      .filter((x) => near(x) && ok(x))
      .map((x) => ({ x, d: Math.abs(F(x.year) - y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, EVENT_CHOICES)
      .map((a) => a.x);
  const r = e.where ? placeOf(civ, world, raster, e.where, y).region : undefined;
  let scope: 'place' | 'polity' = 'place';
  let found = r !== undefined ? pick((x) => x.regions.includes(r)) : [];
  if (!found.length) {
    scope = 'polity';
    const p = characterPolity(civ, world, raster, c);
    found = p >= 0 ? pick((x) => x.polities.includes(p)) : [];
  }
  const order = new Map(ix.list.map((x, i) => [x, i]));
  found.sort((a, b) => a.year - b.year || order.get(a)! - order.get(b)!);
  const list: EventChoice[] = found.map((x) => ({ key: ix.keyOf.get(x)!, entry: x }));
  for (const k of e.events ?? []) if (!list.some((q) => q.key === k)) list.push({ key: k, entry: ix.byKey.get(k) ?? null });
  return { list, scope };
}

export interface PersonChoice {
  key: string;
  /** 重推以后找不到了 = null */
  person: Person | null;
}

/**
 * 一段经历能勾的推演里的人:列出来的那几件事里写到的人,加上那一年他的国家在位的君主;最多 PEOPLE_CHOICES 个;
 * 勾过的(找不到了也列)接在后面
 */
export function lifePeopleChoices(
  civ: Civ,
  world: World,
  raster: Raster | null,
  c: Pick<AuthorCharacter, 'polity' | 'birthplace' | 'born'>,
  e: { year: number; where?: Where | null; people?: readonly string[] },
  events: readonly EventChoice[],
): PersonChoice[] {
  const ids: number[] = [];
  const add = (id: number | undefined) => {
    if (id !== undefined && id >= 0 && civ.people?.[id] && !ids.includes(id) && ids.length < PEOPLE_CHOICES) ids.push(id);
  };
  for (const ev of events) for (const id of ev.entry?.people ?? []) add(id);
  const y = clampYear(civ, e.year);
  const p = characterPolity(civ, world, raster, c);
  if (p >= 0) add(rulerAt(civ, p, y)?.id);
  const out: PersonChoice[] = ids.map((id) => ({ key: personKey(civ, id), person: civ.people![id] })).filter((q) => q.key);
  for (const k of e.people ?? []) {
    if (out.some((q) => q.key === k)) continue;
    const id = resolvePersonKey(civ, k);
    out.push({ key: k, person: id >= 0 ? civ.people![id] : null });
  }
  return out;
}

/** 推演里的人的名字和简短身份:"楚尧" + "大景将领" */
export function personChip(civ: Civ, x: Person): { name: string; role: string } {
  return { name: personName(civ, x), role: personRoleShort(civ, x) };
}

/**
 * 这些年身边的事:他在世那些年(出生到去世;还活着 = 到结束年份)他的国家的事和换君主、他去过的州发生的事,按先后
 */
export function aroundEvents(civ: Civ, world: World, raster: Raster | null, c: AuthorCharacter): ChronicleEntry[] {
  if (!civ.viable) return [];
  const p = characterPolity(civ, world, raster, c);
  const regs = new Set<number>();
  for (const s of lifeStops(c)) {
    const r = placeOf(civ, world, raster, s.where, s.year).region;
    if (r !== undefined) regs.add(r);
  }
  const from = c.born;
  const to = c.died ?? civ.endYear;
  const ix = eventIndex(civ);
  const out: ChronicleEntry[] = [];
  ix.list.forEach((x) => {
    const y = F(x.year);
    if (y < from || y > to) return;
    if ((p >= 0 && x.polities.includes(p)) || x.regions.some((r) => regs.has(r))) out.push(x);
  });
  const order = new Map(ix.list.map((x, i) => [x, i]));
  return out.sort((a, b) => a.year - b.year || order.get(a)! - order.get(b)!);
}

/** 列表里挑 n 条:当前那一年前后各一半(以前的多一点),按先后 */
export function windowAround<T>(list: readonly T[], yearOf: (x: T) => number, year: number, n: number): T[] {
  if (list.length <= n) return list.slice();
  let k = list.findIndex((x) => yearOf(x) > year);
  if (k < 0) k = list.length;
  const start = Math.min(Math.max(0, k - Math.ceil(n / 2)), list.length - n);
  return list.slice(start, start + n);
}

// ---------------------------------------------------------------------------
// 反过来:谁的卡片上列出作者的人物

/** 卡片上「作者的人物」一行:那个人物、一句小字 */
export interface CharRef {
  c: AuthorCharacter;
  text: string;
}

/** 按生年排,晚生的在上(和人物页「我的」一样) */
const byBorn = (list: CharRef[]) => list.sort((a, b) => b.c.born - a.c.born || a.c.id - b.c.id);

/** 几句连起来,最多写 max 句,多出来的写"等 N 件" */
function joinParts(parts: string[], lifeCount: number, max = 2): string {
  if (parts.length <= max) return parts.join('，');
  return `${parts.slice(0, max).join('，')}等 ${lifeCount} 件`;
}

/** 经历写成一句:"2506 年随楚尧西征" */
const lifeLine = (e: { year: number; text: string }) => `${e.year} 年${e.text || '（没写经历）'}`;

/** 推演里的人(人物编号)的卡片:亲友里有他、经历里勾了他的作者人物("上司是他，2506 年随他西征") */
export function charactersOfPerson(civ: Civ, chars: readonly AuthorCharacter[] | undefined, id: number): CharRef[] {
  const key = personKey(civ, id);
  const x = civ.people?.[id];
  if (!key || !x || !chars?.length) return [];
  // 经历里写到他的名字换成"他"(这一行就在他的卡片上)
  const name = personName(civ, x);
  const him = (t: string) => (name ? t.split(name).join('他') : t);
  const out: CharRef[] = [];
  for (const c of chars) {
    const kin = c.kin?.find((k) => k.person === key);
    const lives = lifeInOrder(c).filter(({ e }) => e.people?.includes(key));
    if (!kin && !lives.length) continue;
    const shown = lives.map(({ e }) => him(lifeLine(e)));
    const text = kin ? [kin.rel ? `${kin.rel}是他` : '亲友里有他', joinParts(shown, shown.length, 1)].filter(Boolean).join('，') : joinParts(shown, shown.length);
    out.push({ c, text });
  }
  return byBorn(out);
}

/** 经历写的是去世 */
const DIED_WORDS = /去世|逝世|病逝|卒|死/;

/** 一处地方在不在 test 说的地方(按那一年认一个点挨着的城) */
function placeHits(civ: Civ, world: World, raster: Raster | null, w: Where | undefined, year: number, test: (p: CharPlace) => boolean): boolean {
  return !!w && test(placeOf(civ, world, raster, w, year));
}

/** 城 / 州的卡片:生在这里、在这里有经历的作者人物("2490 年生在这里，2561 年在落烟渡去世") */
export function charactersAt(
  civ: Civ,
  world: World,
  raster: Raster | null,
  chars: readonly AuthorCharacter[] | undefined,
  at: { city: number } | { region: number },
): CharRef[] {
  if (!chars?.length) return [];
  const test = 'city' in at ? (p: CharPlace) => p.city === at.city : (p: CharPlace) => p.region === at.region;
  const out: CharRef[] = [];
  for (const c of chars) {
    const born = placeHits(civ, world, raster, c.birthplace, c.born, test);
    const lives = lifeInOrder(c).filter(({ e }) => !(born && e.year === c.born && sameWhere(e.where, c.birthplace)) && placeHits(civ, world, raster, e.where, e.year, test));
    if (!born && !lives.length) continue;
    // 卒年那一段写的是去世,就写"在这里去世";别的照经历原话
    const parts = lives.map(({ e }) => (e.year === c.died && DIED_WORDS.test(e.text) ? `${c.died} 年在这里去世` : lifeLine(e)));
    if (born) parts.unshift(`${c.born} 年生在这里`);
    out.push({ c, text: joinParts(parts, lives.length) });
  }
  return byBorn(out);
}

// ---------------------------------------------------------------------------
// 复制、悬停

/** 复制生平:名字、生卒、简介、概况、一生 */
export function characterCopyText(civ: Civ, world: World, raster: Raster | null, c: AuthorCharacter, chars: readonly AuthorCharacter[]): string {
  const out = [c.name, `作者的人物，${lifeYears(c)}`];
  if (c.note) out.push('', c.note, '');
  if (c.role) out.push(`身份：${c.role}`);
  const p = characterPolity(civ, world, raster, c);
  if (p >= 0) out.push(`国家：${polityName(civ.polities[p], clampYear(civ, c.born))}`);
  if (c.birthplace) {
    const pl = placeOf(civ, world, raster, c.birthplace, c.born);
    const reg = pl.kind === 'city' && pl.region !== undefined ? `（${regionLabel(civ, pl.region)}）` : '';
    out.push(`出生地：${pl.name}${reg}`);
  }
  const kin = kinList(civ, c, chars);
  if (kin.length) out.push(`亲友：${kin.map((k) => (k.rel ? `${k.name}（${k.rel}）` : k.name)).join('、')}`);
  const life = lifeInOrder(c);
  if (life.length) {
    out.push('', '一生：');
    for (const { e } of life) {
      const where = e.where ? placeOf(civ, world, raster, e.where, e.year).name : '';
      const age = e.year - c.born;
      const note = [age > 0 ? `${age} 岁` : '', where].filter(Boolean).join('，');
      out.push(`${e.year} ${e.text || '（没写经历）'}${note ? `（${note}）` : ''}`);
    }
  }
  return out.join('\n');
}

/** 亲友(列得出来的:自己的人物删掉了不列;推演里的人重推以后找不到了写名字 + "找不到了") */
export interface KinShown {
  rel: string;
  name: string;
  char?: number;
  person?: number;
  /** 推演里的人重推以后找不到了 */
  missing?: boolean;
}

export function kinList(civ: Civ, c: AuthorCharacter, chars: readonly AuthorCharacter[]): KinShown[] {
  const out: KinShown[] = [];
  for (const k of c.kin ?? []) {
    if (k.char !== undefined) {
      const o = chars.find((x) => x.id === k.char);
      if (o) out.push({ rel: k.rel, name: o.name, char: o.id });
    } else if (k.person) {
      const id = resolvePersonKey(civ, k.person);
      if (id >= 0) out.push({ rel: k.rel, name: personName(civ, civ.people![id]), person: id });
      else out.push({ rel: k.rel, name: k.person.split('|')[2] ?? '', missing: true });
    }
  }
  return out;
}

/** 悬停在地图上的头像:名字、那年多大、在哪 */
export function characterHover(civ: Civ, world: World, raster: Raster | null, c: AuthorCharacter, year: number): HoverInfo {
  const stops = lifeStops(c);
  const k = stopAt(c, stops, year);
  const where = k >= 0 ? placeOf(civ, world, raster, stops[k].where, stops[k].year).name : '';
  return { color: MARK_HEX[c.color], name: c.name, sub: ageText(c, year), extra: where ? `在${where}，点开看生平` : '点开看生平' };
}

// ---------------------------------------------------------------------------
// 地图上的足迹

/** 画足迹的几种时候:看(按时间轴那一年分走过、没走过)/ 填卡片(都算走过,头像在出生地)/ 加一段经历(那一段是虚的,半透明头像在那一处) */
export type TrailMode = { kind: 'view' } | { kind: 'edit' } | { kind: 'life'; entry: { year: number; where: Where | null }; index: number };

/**
 * 一生的足迹:去过的地方按经历的先后连起来;同一处只画一个点,年份写在一起(州的话后面写上州名);没写地方、找不到的地方跳过。
 * mode 见 TrailMode;index = 正在改的那一段经历(新加的 = −1),画的时候用 entry 代替它
 */
export function characterTrail(civ: Civ, world: World, raster: Raster | null, c: AuthorCharacter, year: number, mode: TrailMode): TrailInput {
  const life = (c.life ?? []).slice();
  let pending = -1;
  if (mode.kind === 'life') {
    const e = { year: mode.entry.year, text: '', ...(mode.entry.where ? { where: mode.entry.where } : {}) };
    if (mode.index >= 0 && mode.index < life.length) life[mode.index] = e;
    else life.push(e);
    pending = mode.index >= 0 && mode.index < (c.life?.length ?? 0) ? mode.index : life.length - 1;
  }
  const stops = lifeStops({ ...c, life });
  const Y = F(year);
  // 地方合并:同一处(同一个城键、州键,或离得不到一个像素的两个点)一个点
  const places: { where: Where; pl: CharPlace; years: number[]; first: number; pending: boolean; done: boolean }[] = [];
  const path: { place: number; year: number; pending: boolean }[] = [];
  for (const s of stops) {
    const pl = placeOf(civ, world, raster, s.where, s.year);
    if (!pl.at) continue;
    const isPending = s.life === pending && pending >= 0;
    let k = places.findIndex((p) => sameWhere(p.where, s.where));
    if (k < 0) {
      k = places.length;
      places.push({ where: s.where, pl, years: [], first: s.year, pending: false, done: false });
    }
    const p = places[k];
    if (!p.years.includes(s.year)) p.years.push(s.year);
    if (isPending) p.pending = true;
    else p.done = true;
    if (!path.length || path[path.length - 1].place !== k) path.push({ place: k, year: s.year, pending: isPending });
    else if (isPending) path[path.length - 1].pending = true;
  }
  const view = mode.kind === 'view';
  const segs = path.slice(1).map((s, i) => {
    const a = path[i];
    const future = view ? s.year > Y : mode.kind === 'life' && (s.pending || a.pending);
    return { a: a.place, b: s.place, future };
  });
  const out: TrailInput = {
    color: MARK_HEX[c.color],
    avatar: [...c.name][0] ?? '',
    stops: places.map((p) => ({
      at: p.pl.at!,
      label: `${p.years.join('、')}${p.pl.kind === 'region' ? ` ${p.pl.name}` : ''}`,
      future: view ? p.first > Y : !p.done && p.pending,
    })),
    segs,
    pin: -1,
    ghost: null,
  };
  if (view) {
    const k = stopAt(c, stops, Y);
    if (k >= 0) out.pin = places.findIndex((p) => sameWhere(p.where, stops[k].where));
  } else if (mode.kind === 'edit') {
    if (c.birthplace) out.pin = places.findIndex((p) => sameWhere(p.where, c.birthplace));
  } else if (mode.entry.where) {
    out.ghost = placeOf(civ, world, raster, mode.entry.where, mode.entry.year).at;
  }
  return out;
}
