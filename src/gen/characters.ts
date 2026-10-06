/**
 * 作者的人物(WorldEdits.characters):作者放进这个世界的自己的人物。和作者标记一样只是记下来 ——
 * 不改变世界、不参与推演、和生成器版本无关;跟着存档文件、分享链接、云同步走。纯计算,不碰 DOM。
 *
 * | 字段       | 意思                                                                                   |
 * |------------|----------------------------------------------------------------------------------------|
 * | id         | 编号:这个世界里不重复的正整数(新建的 = 现有最大的 + 1;选中、撤销按它认)                |
 * | name       | 名字(CHAR_NAME_MAX 个字以内;空 = CHAR_NAME_DEFAULT)                                   |
 * | color      | 头像的颜色:和作者标记同一套六种(edits.ts 的 MARK_COLORS)                              |
 * | born, died | 生年、卒年(整数,夹到 [0, INTERVENTION_YEAR_MAX];died 早于 born 的当作没给;没有 died = 一直活着) |
 * | birthplace | 出生地(Where,见下;没有 = 没填)                                                        |
 * | polity     | 国家:国家的稳定键 `polity:c4567#0`(没有 = 出生地在生年归属的国家)                     |
 * | role       | 身份("书记官、说书人";CHAR_ROLE_MAX 个字以内)                                         |
 * | note       | 简介(可以分行,CHAR_NOTE_MAX 个字以内)                                                 |
 * | life       | 一生的几段经历(LifeEntry,按写进来的先后存,显示时按年份排;最多 LIFE_MAX 段)            |
 * | kin        | 亲友(KinEntry;最多 KIN_MAX 个)                                                         |
 *
 * 地方(Where)有三种,和作者标记一样按稳定键 / 世界坐标记,改地形以后还指同一处:
 *   城 = 城键 `settlement:c4567#1`;州 = 州键 `region:c4567`;任意一点 = 世界坐标 [x, y](x 规整到 [0, 2048))。
 *
 * 一段经历(LifeEntry):year 年份、text 写了什么(LIFE_TEXT_MAX 个字以内)、where 在哪(可以不填)、
 * events 勾上的推演里的事(事的稳定键 `event:2506|battle|region:c4567|polity:c12#0,polity:c88#0#0`,界面上按它找回那件事)、
 * people 勾上的推演里的人(人物的稳定键,见 personKey)。各最多 LINKS_MAX 个。
 * 作者干预以后重推,找不到的那一件 / 那个人界面上照样列着,写明"重推以后这件事没有了";作者写的字不动。
 *
 * 亲友(KinEntry):rel 关系(随便写,KIN_REL_MAX 个字以内,可以空着)、char 自己的另一个人物(编号)或 person 推演里的人(人物的稳定键),
 * 两个有且只有一个。指到的人物删掉了,界面上不列(撤销删除又回来)。
 *
 * 读进来的列表先过 cleanCharacters(格式不对的丢掉,编号重复的换一个新编号,最多留 CHARACTERS_MAX 个)。
 */
import type { Civ } from './civ/types';
import { INTERVENTION_YEAR_MAX, MARK_COLORS, freeMarkId, isCityKey, isPolityKey, isRegionKey, polityKey, yearOf, type MarkColor } from './edits';
import { TERRAIN_H, TERRAIN_W } from './terrainEdits';

/** 一个世界最多几个作者的人物 */
export const CHARACTERS_MAX = 500;
/** 一个人物最多几段经历 */
export const LIFE_MAX = 200;
/** 一个人物最多几个亲友 */
export const KIN_MAX = 50;
/** 名字、身份最长几个字 */
export const CHAR_NAME_MAX = 40;
export const CHAR_ROLE_MAX = 40;
/** 简介最长几个字 */
export const CHAR_NOTE_MAX = 2000;
/** 一段经历最长几个字 */
export const LIFE_TEXT_MAX = 200;
/** 关系最长几个字 */
export const KIN_REL_MAX = 16;
/** 一段经历最多勾几件事、几个人 */
export const LINKS_MAX = 20;
/** 名字是空的就叫这个 */
export const CHAR_NAME_DEFAULT = '新人物';
/** 编号最大到几(和作者标记一样) */
const CHAR_ID_MAX = 1e9;

/** 地方:城键、州键,或世界坐标 [x, y] */
export type Where = string | [number, number];

/** 一段经历 */
export interface LifeEntry {
  year: number;
  text: string;
  where?: Where;
  /** 勾上的推演里的事(事的稳定键) */
  events?: string[];
  /** 勾上的推演里的人(人物的稳定键) */
  people?: string[];
}

/** 一个亲友:自己的另一个人物(char)或推演里的人(person) */
export interface KinEntry {
  rel: string;
  char?: number;
  person?: string;
}

/** 一个作者的人物(字段见文件头) */
export interface AuthorCharacter {
  id: number;
  name: string;
  color: MarkColor;
  born: number;
  died?: number;
  birthplace?: Where;
  polity?: string;
  role?: string;
  note?: string;
  life?: LifeEntry[];
  kin?: KinEntry[];
}

// ---------------------------------------------------------------------------
// 推演里的人的稳定键

/**
 * 人物的稳定键:国家的稳定键 + 身份 + 名字 + 生年(重推历史后同一国、同名、同年生的还是他;推演变了、指不到就算了)。
 * 同一国、同身份、同名、同年生的不止一个(西幻的君主会重名):第二个起后面加 #1、#2……(按人物编号的先后)
 */
export function personKey(civ: Civ, id: number): string {
  return personKeys(civ)[id] ?? '';
}

const personKeyCache = new WeakMap<object, { keys: string[]; byKey: Map<string, number> }>();

/** 每个人的稳定键(下标 = 人物编号;国家没了的 = '')。按人物列表存 */
function personIndex(civ: Civ): { keys: string[]; byKey: Map<string, number> } {
  const list = civ.people ?? [];
  let ix = personKeyCache.get(list);
  if (ix && ix.keys.length === list.length) return ix;
  const keys: string[] = [];
  const byKey = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const x of list) {
    if (!civ.polities[x.polity]) {
      keys[x.id] = '';
      continue;
    }
    const base = `person:${polityKey(civ, x.polity)}|${x.role}|${x.name}|${Math.round(x.born)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const k = n ? `${base}#${n}` : base;
    keys[x.id] = k;
    byKey.set(k, x.id);
  }
  ix = { keys, byKey };
  personKeyCache.set(list, ix);
  return ix;
}

const personKeys = (civ: Civ) => personIndex(civ).keys;

/** 按人物的稳定键在(重推过的)历史里找回这个人;找不到 = −1 */
export function resolvePersonKey(civ: Civ, key: string): number {
  if (!civ.people?.length) return -1;
  return personIndex(civ).byKey.get(key) ?? -1;
}

const PERSON_KEY = /^person:polity:(r-?\d{1,7}|c\d{1,7})#\d{1,5}\|(ruler|general)\|[^|\n]{1,32}\|-?\d{1,6}(#\d{1,4})?$/;
const EVENT_KEY = /^event:\d{1,5}\|[a-z]{1,16}\|[^|\n]{1,48}\|[^|\n]{1,100}#\d{1,4}$/;
export const isPersonKey = (k: unknown): k is string => typeof k === 'string' && PERSON_KEY.test(k);
export const isEventKey = (k: unknown): k is string => typeof k === 'string' && EVENT_KEY.test(k);

// ---------------------------------------------------------------------------
// 清理

/** 一行字:去掉控制字符、首尾空白、连着的空白并成一个,超长截断 */
function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const cs = [...s];
  return cs.length > max ? cs.slice(0, max).join('').trimEnd() : s;
}

/** 名字(空 = ''):去掉控制字符、首尾空白,超长截断 */
export const cleanCharName = (raw: unknown) => cleanLine(raw, CHAR_NAME_MAX);

/** 简介:去掉换行以外的控制字符、首尾空白,超长截断 */
export function cleanCharNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  const cs = [...s];
  return cs.length > CHAR_NOTE_MAX ? cs.slice(0, CHAR_NOTE_MAX).join('').trimEnd() : s;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 地方:城键、州键原样;世界坐标 x 规整到 [0, 2048)、y 夹到图里、留一位小数;别的 = null */
export function cleanWhere(x: unknown): Where | null {
  if (isCityKey(x) || isRegionKey(x)) return x;
  if (Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const [ax, ay] = x as number[];
    return [round1(ax - TERRAIN_W * Math.floor(ax / TERRAIN_W)) % TERRAIN_W, round1(Math.min(TERRAIN_H, Math.max(0, ay)))];
  }
  return null;
}

/** 两个地方是不是同一处(城键 / 州键一样;两个点离得不到一个像素) */
export function sameWhere(a: Where | null | undefined, b: Where | null | undefined): boolean {
  if (!a || !b) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const dx = Math.abs(a[0] - b[0]);
  return Math.min(dx, TERRAIN_W - dx) < 1 && Math.abs(a[1] - b[1]) < 1;
}

/** 一串键:合格的、不重复的留下,最多 LINKS_MAX 个 */
function cleanKeys(list: unknown, ok: (k: unknown) => k is string): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const k of list) if (ok(k) && !out.includes(k) && out.length < LINKS_MAX) out.push(k);
  return out;
}

/** 一段经历;不合格(年份不是数)= null */
export function cleanLife(x: unknown): LifeEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const year = yearOf(o.year);
  if (year === null) return null;
  const e: LifeEntry = { year, text: cleanLine(o.text, LIFE_TEXT_MAX) };
  const where = o.where === undefined ? null : cleanWhere(o.where);
  if (where) e.where = where;
  const events = cleanKeys(o.events, isEventKey);
  if (events.length) e.events = events;
  const people = cleanKeys(o.people, isPersonKey);
  if (people.length) e.people = people;
  return e;
}

/** 一个亲友;不合格(两个都没有、都不合格)= null。self = 人物自己的编号(亲友不能是自己) */
export function cleanKin(x: unknown, self = 0): KinEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const rel = cleanLine(o.rel, KIN_REL_MAX);
  const char = o.char;
  if (typeof char === 'number' && Number.isInteger(char) && char >= 1 && char <= CHAR_ID_MAX && char !== self) return { rel, char };
  if (isPersonKey(o.person)) return { rel, person: o.person };
  return null;
}

/**
 * 清理一个人物(规则见文件头);不合格 = null(编号不是正整数、生年不是数)。名字是空的叫 CHAR_NAME_DEFAULT。
 * 本来就合格的原样返回(同一个对象)
 */
export function cleanCharacter(x: unknown): AuthorCharacter | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const id = o.id;
  const born = yearOf(o.born);
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > CHAR_ID_MAX || born === null) return null;
  const c: AuthorCharacter = {
    id,
    name: cleanCharName(o.name) || CHAR_NAME_DEFAULT,
    color: MARK_COLORS.includes(o.color as MarkColor) ? (o.color as MarkColor) : MARK_COLORS[0],
    born,
  };
  const died = o.died === undefined ? null : yearOf(o.died);
  if (died !== null && died >= born) c.died = died;
  const birthplace = o.birthplace === undefined ? null : cleanWhere(o.birthplace);
  if (birthplace) c.birthplace = birthplace;
  if (isPolityKey(o.polity)) c.polity = o.polity;
  const role = cleanLine(o.role, CHAR_ROLE_MAX);
  if (role) c.role = role;
  const note = cleanCharNote(o.note);
  if (note) c.note = note;
  if (Array.isArray(o.life)) {
    const life: LifeEntry[] = [];
    for (const v of o.life) {
      const e = life.length < LIFE_MAX ? cleanLife(v) : null;
      if (e) life.push(e);
    }
    if (life.length) c.life = life;
  }
  if (Array.isArray(o.kin)) {
    const kin: KinEntry[] = [];
    for (const v of o.kin) {
      const k = kin.length < KIN_MAX ? cleanKin(v, id) : null;
      if (k) kin.push(k);
    }
    if (kin.length) c.kin = kin;
  }
  return JSON.stringify(c) === JSON.stringify(x) ? (x as AuthorCharacter) : c;
}

/** 两个人物是不是一模一样 */
export function sameCharacter(a: AuthorCharacter, b: AuthorCharacter): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 用过的编号:现有人物的,和亲友里还记着的(删掉的人物别人亲友里留着他的编号,不能给新人物,
 * 不然那条亲友就指到不相干的人身上了)。retired = 另外不能用的(这次打开以后删掉过的,放回去时还用原编号)
 */
function usedCharacterIds(list: readonly AuthorCharacter[] | undefined, retired?: Iterable<number>): Set<number> {
  const used = new Set<number>(retired);
  for (const c of list ?? []) {
    used.add(c.id);
    for (const k of c.kin ?? []) if (k.char !== undefined) used.add(k.char);
  }
  return used;
}

/** 新人物的编号:用过的最大的 + 1(见 usedCharacterIds) */
export function nextCharacterId(list: readonly AuthorCharacter[] | undefined, retired?: Iterable<number>): number {
  const used = usedCharacterIds(list, retired);
  let n = 0;
  for (const id of used) if (id > n) n = id;
  return freeMarkId(used, n);
}

/**
 * 清理一份人物列表(读档、撤销时用):不合格的丢掉;编号和前面重复的换成新编号(现有最大的 + 1);最多留 CHARACTERS_MAX 个。
 * 全都合格时返回原数组(同一个对象)。dropped / over = 丢掉了几个(格式不对 / 超出上限),读档时提示用
 */
export function cleanCharacters(list: readonly unknown[] | null | undefined, count?: { dropped: number; over: number }): AuthorCharacter[] {
  if (!Array.isArray(list)) return [];
  const out: AuthorCharacter[] = [];
  let same = true;
  const cleaned = (list as unknown[]).map((x) => cleanCharacter(x));
  const used = usedCharacterIds(cleaned.filter((c): c is AuthorCharacter => !!c));
  let max = 0;
  for (const id of used) if (id > max) max = id;
  const ids = new Set<number>();
  cleaned.forEach((c0, i) => {
    let c = c0;
    if (!c) {
      if (count) count.dropped++;
      same = false;
      return;
    }
    if (out.length >= CHARACTERS_MAX) {
      if (count) count.over++;
      same = false;
      return;
    }
    if (ids.has(c.id)) {
      c = { ...c, id: freeMarkId(used, max) };
      max = Math.max(max, c.id);
    }
    ids.add(c.id);
    if (c !== list[i]) same = false;
    out.push(c);
  });
  return same ? (list as AuthorCharacter[]) : out;
}

// ---------------------------------------------------------------------------
// 年龄、一生走过的地方

/** 时间轴停在 year 这一年时他:还没出生 / 活着(几岁)/ 已故(享年几岁)。年龄 = 那一年减生年(整年) */
export function characterAge(c: Pick<AuthorCharacter, 'born' | 'died'>, year: number): { state: 'unborn' | 'alive' | 'dead'; age: number } {
  const y = Math.floor(year);
  if (y < c.born) return { state: 'unborn', age: 0 };
  if (c.died !== undefined && y > c.died) return { state: 'dead', age: c.died - c.born };
  return { state: 'alive', age: y - c.born };
}

/** 一生按年份排好的经历(同一年按写进来的先后);i = 在 life 里的下标 */
export function lifeInOrder(c: Pick<AuthorCharacter, 'life'>): { e: LifeEntry; i: number }[] {
  return (c.life ?? []).map((e, i) => ({ e, i })).sort((a, b) => a.e.year - b.e.year || a.i - b.i);
}

/** 一生落脚的地方(按年份;出生地算生年那一站,排在同一年的经历前面;没写地方的经历跳过)。life = 经历的下标,出生地 = −1 */
export interface LifeStop {
  year: number;
  where: Where;
  life: number;
}

export function lifeStops(c: Pick<AuthorCharacter, 'born' | 'birthplace' | 'life'>): LifeStop[] {
  const out: LifeStop[] = [];
  if (c.birthplace) out.push({ year: c.born, where: c.birthplace, life: -1 });
  for (const { e, i } of lifeInOrder(c)) if (e.where) out.push({ year: e.year, where: e.where, life: i });
  return out.sort((a, b) => a.year - b.year || (a.life < 0 ? -1 : b.life < 0 ? 1 : 0));
}

/** 时间轴停在 year 这一年时他在哪一站(这一年以前最后一站;出生前、去世后、一站都没有 = −1) */
export function stopAt(c: Pick<AuthorCharacter, 'born' | 'died'>, stops: readonly LifeStop[], year: number): number {
  if (characterAge(c, year).state !== 'alive') return -1;
  const y = Math.floor(year);
  let k = -1;
  stops.forEach((s, i) => {
    if (s.year <= y) k = i;
  });
  return k;
}

/** 年份上限(和作者标记、干预一样) */
export const CHAR_YEAR_MAX = INTERVENTION_YEAR_MAX;
