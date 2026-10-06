/**
 * 作者的人物的界面状态(人物本身存在 editsStore 的 WorldEdits.characters 里,格式见 gen/characters.ts 文件头):
 *
 * - 新建 / 编辑:卡片上正在填的那一份(draft),点「完成」才存进修改(记一步撤销),「取消」扔掉。
 *   新建时选中的是 { kind: 'character', id: 0 }(还没有编号);选中别的东西 = 扔掉正在填的
 * - 加一段经历、加亲友:卡片换成一张小表(sub),「加上」写回 draft(还没存),「取消」回到大表
 * - 挑地方(picking):出生地 / 这段经历在哪。新建的人物没有出生地、新加的经历时自动开始挑;「换一处」也开始挑。
 *   挑的时候点地图:城镇符号、城名 = 那座城,陆地 = 那一州,海上 = 那一点(App 按 pickPlace 交过来);顶部提示条能取消(Esc)
 */
import { useSyncExternalStore } from 'react';
import { MARK_COLORS, type MarkColor } from '../gen/edits';
import {
  CHARACTERS_MAX,
  CHAR_NAME_DEFAULT,
  CHAR_YEAR_MAX,
  KIN_MAX,
  LIFE_MAX,
  LINKS_MAX,
  cleanCharacter,
  type AuthorCharacter,
  type KinEntry,
  type LifeEntry,
  type Where,
} from '../gen/characters';
import { addCharacter, getEdits, subscribeEdits, updateCharacter } from './editsStore';
import { clearSelection, getSelection, setSelection, subscribeSelection } from './civView';
import { clearToast, showToast } from './toastStore';

/** 一段经历(小表上正在填的) */
export interface LifeDraft {
  /** 改的是第几段(在 draft.life 里的下标;新加的 = −1) */
  index: number;
  yearText: string;
  text: string;
  where: Where | null;
  events: string[];
  people: string[];
}

/** 一个亲友(小表上正在填的) */
export interface KinDraft {
  /** 改的是第几个(在 draft.kin 里的下标;新加的 = −1) */
  index: number;
  rel: string;
  char?: number;
  person?: string;
  /** 搜索框里的字 */
  query: string;
}

/** 卡片上正在填的人物 */
export interface CharDraft {
  /** 编辑的是哪个人物;新建 = 0 */
  id: number;
  name: string;
  color: MarkColor;
  bornText: string;
  diedText: string;
  birthplace: Where | null;
  /** 国家(国家的稳定键);null = 跟着出生地 */
  polity: string | null;
  role: string;
  note: string;
  life: LifeEntry[];
  kin: KinEntry[];
  /** 正在填的小表:一段经历 / 一个亲友 */
  sub: { kind: 'life'; d: LifeDraft } | { kind: 'kin'; d: KinDraft } | null;
}

export interface CharUi {
  draft: CharDraft | null;
  /** 正在点地图挑地方:出生地 / 这段经历在哪 */
  picking: 'birth' | 'life' | null;
}

let state: CharUi = { draft: null, picking: null };
const subs = new Set<() => void>();
function set(patch: Partial<CharUi>) {
  state = { ...state, ...patch };
  for (const f of subs) f();
}

export function getCharUi(): CharUi {
  return state;
}

export function useCharUi(): CharUi {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getCharUi,
    getCharUi,
  );
}

export function subscribeCharUi(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** 年份 → 输入框里的字 */
const yearText = (y: number | undefined) => (y === undefined ? '' : String(Math.floor(y)));

/** 年份输入框里的字 → 年份(空 = null;不是数 = NaN) */
export function parseYear(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  return /^\d{1,5}$/.test(t) ? Number(t) : NaN;
}

// ---- 新建 / 编辑 ----

/**
 * 新建一个(还没存):生年先填时间轴当前那年;birthplace = 城、州卡片「在这里加人物」;kin = 推演人物卡片「加一个和他有关的人物」。
 * 没有出生地时直接开始挑出生地。选中它,卡片换成填写的样子
 */
export function newCharacterDraft(init: { birthplace?: Where; kin?: KinEntry[]; year: number }) {
  const used = new Set((getEdits().characters ?? []).map((c) => c.color));
  const color = MARK_COLORS.find((c) => !used.has(c)) ?? MARK_COLORS[(getEdits().characters?.length ?? 0) % MARK_COLORS.length];
  set({
    draft: {
      id: 0,
      name: '',
      color,
      bornText: yearText(init.year),
      diedText: '',
      birthplace: init.birthplace ?? null,
      polity: null,
      role: '',
      note: '',
      life: [],
      kin: init.kin ?? [],
      sub: null,
    },
    picking: init.birthplace ? null : 'birth',
  });
  setSelection({ kind: 'character', id: 0 });
}

/** 编辑一个已有的人物 */
export function editCharacterDraft(c: AuthorCharacter) {
  set({
    draft: {
      id: c.id,
      name: c.name,
      color: c.color,
      bornText: yearText(c.born),
      diedText: yearText(c.died),
      birthplace: c.birthplace ?? null,
      polity: c.polity ?? null,
      role: c.role ?? '',
      note: c.note ?? '',
      life: (c.life ?? []).map((e) => ({ ...e })),
      kin: (c.kin ?? []).map((k) => ({ ...k })),
      sub: null,
    },
    picking: null,
  });
  setSelection({ kind: 'character', id: c.id });
}

export function patchDraft(p: Partial<Omit<CharDraft, 'sub'>>) {
  if (state.draft) set({ draft: { ...state.draft, ...p } });
}

/** 填的东西能不能存;不能 = 原因(卡片上提示一句,「完成」点不了) */
export function draftProblem(d: CharDraft): string | null {
  const born = parseYear(d.bornText);
  const died = parseYear(d.diedText);
  if (born === null || Number.isNaN(born)) return '填一下生年';
  if (Number.isNaN(died)) return '卒年要填年份，或者空着';
  if (born > CHAR_YEAR_MAX || (died !== null && died > CHAR_YEAR_MAX)) return `年份最大填到 ${CHAR_YEAR_MAX}`;
  if (died !== null && died < born) return '卒年比生年早了';
  if (d.id === 0 && (getEdits().characters?.length ?? 0) >= CHARACTERS_MAX) return `作者的人物已经有 ${CHARACTERS_MAX} 个了，删掉一些才能再加`;
  return null;
}

/** 填好的 → 要存的人物(不含编号);不能存 = null */
export function draftCharacterData(d: CharDraft): Omit<AuthorCharacter, 'id'> | null {
  if (draftProblem(d)) return null;
  const c: Omit<AuthorCharacter, 'id'> = { name: d.name.trim() || CHAR_NAME_DEFAULT, color: d.color, born: parseYear(d.bornText)! };
  const died = parseYear(d.diedText);
  if (died !== null) c.died = died;
  if (d.birthplace) c.birthplace = d.birthplace;
  if (d.polity) c.polity = d.polity;
  if (d.role.trim()) c.role = d.role;
  if (d.note.trim()) c.note = d.note;
  if (d.life.length) c.life = d.life.map((e) => ({ ...e }));
  if (d.kin.length) c.kin = d.kin.map((k) => ({ ...k }));
  return c;
}

/** 正在填的画成的样子(地图上的足迹、卡片上的年龄用;年份没填好按 fallback 年算) */
export function draftAsCharacter(d: CharDraft, fallback: number): AuthorCharacter {
  const born = parseYear(d.bornText);
  const died = parseYear(d.diedText);
  const b = born === null || Number.isNaN(born) ? Math.floor(fallback) : born;
  const raw = {
    id: d.id || 1,
    name: d.name.trim() || CHAR_NAME_DEFAULT,
    color: d.color,
    born: b,
    died: died !== null && !Number.isNaN(died) && died >= b ? died : undefined,
    birthplace: d.birthplace ?? undefined,
    polity: d.polity ?? undefined,
    role: d.role,
    note: d.note,
    life: d.life,
    kin: d.kin,
  };
  return { ...(cleanCharacter(raw) ?? { id: raw.id, name: raw.name, color: d.color, born: b }), id: d.id };
}

/** 「完成」:存进修改(新建 = 加一个,编辑 = 换掉原来的),选中它、卡片换回看的样子。返回人物的编号;存不了 = −1 */
export function finishDraft(): number {
  const d = state.draft;
  const c = d && draftCharacterData(d);
  if (!d || !c) return -1;
  let id = d.id;
  if (id === 0) id = addCharacter(c);
  else if (getEdits().characters?.some((x) => x.id === id)) updateCharacter({ ...c, id });
  else id = addCharacter(c);
  set({ draft: null, picking: null });
  if (id > 0) setSelection({ kind: 'character', id });
  return id;
}

/** 「取消」:扔掉正在填的;新建的连卡片一起关掉,编辑的回到看的样子(那个人物已经没了 = 也关掉) */
export function cancelDraft() {
  const d = state.draft;
  if (!d) return;
  set({ draft: null, picking: null });
  if (d.id === 0 || !getEdits().characters?.some((c) => c.id === d.id)) clearSelection();
}

// ---- 挑地方 ----

/** 开始 / 停止点地图挑地方 */
export function startPicking(what: 'birth' | 'life') {
  if (state.draft) set({ picking: what });
}

export function stopPicking() {
  if (state.picking) set({ picking: null });
}

/** 挑好了一处(App 点地图时交过来):出生地 / 这段经历在哪 */
export function pickPlace(w: Where) {
  const d = state.draft;
  if (!d || !state.picking) return;
  if (state.picking === 'birth') set({ draft: { ...d, birthplace: w }, picking: null });
  else if (d.sub?.kind === 'life') set({ draft: { ...d, sub: { kind: 'life', d: { ...d.sub.d, where: w } } }, picking: null });
  else set({ picking: null });
}

// ---- 一段经历 ----

/** 加一段经历(index = −1)/ 改第 index 段;year = 时间轴当前那年(新加的先填它,夹到生卒之间) */
export function startLife(index: number, year: number) {
  const d = state.draft;
  if (!d) return;
  const e = index >= 0 ? d.life[index] : undefined;
  let y = Math.floor(year);
  const born = parseYear(d.bornText);
  const died = parseYear(d.diedText);
  if (born !== null && !Number.isNaN(born)) y = Math.max(y, born);
  if (died !== null && !Number.isNaN(died)) y = Math.min(y, died);
  const ld: LifeDraft = e
    ? { index, yearText: yearText(e.year), text: e.text, where: e.where ?? null, events: (e.events ?? []).slice(), people: (e.people ?? []).slice() }
    : { index: -1, yearText: yearText(y), text: '', where: null, events: [], people: [] };
  set({ draft: { ...d, sub: { kind: 'life', d: ld } }, picking: e ? null : 'life' });
}

export function patchLife(p: Partial<LifeDraft>) {
  const d = state.draft;
  if (d?.sub?.kind === 'life') set({ draft: { ...d, sub: { kind: 'life', d: { ...d.sub.d, ...p } } } });
}

/** 勾上 / 去掉一件事、一个人(各最多 LINKS_MAX 个,满了再勾提示一句,不勾上:存的时候多出来的会丢掉) */
export function toggleLifeLink(field: 'events' | 'people', key: string) {
  const d = state.draft;
  if (d?.sub?.kind !== 'life') return;
  const list = d.sub.d[field];
  if (list.includes(key)) return patchLife({ [field]: list.filter((k) => k !== key) });
  if (list.length >= LINKS_MAX) {
    showToast({ id: 'oc-links', kind: 'warn', text: `一段经历最多勾 ${LINKS_MAX} ${field === 'events' ? '件事' : '个人'}`, ttl: 3000 });
    return;
  }
  patchLife({ [field]: [...list, key] });
}

/** 这段经历能不能加上;不能 = 原因 */
export function lifeProblem(d: CharDraft, l: LifeDraft): string | null {
  const y = parseYear(l.yearText);
  if (y === null || Number.isNaN(y)) return '填一下年份';
  if (y > CHAR_YEAR_MAX) return `年份最大填到 ${CHAR_YEAR_MAX}`;
  if (!l.text.trim()) return '写一句经历';
  if (l.index < 0 && d.life.length >= LIFE_MAX) return `一个人最多写 ${LIFE_MAX} 段经历`;
  return null;
}

/** 「加上」:写回正在填的人物(还没存,点「完成」才存) */
export function finishLife() {
  const d = state.draft;
  if (d?.sub?.kind !== 'life' || lifeProblem(d, d.sub.d)) return;
  const l = d.sub.d;
  const e: LifeEntry = { year: parseYear(l.yearText)!, text: l.text.trim() };
  if (l.where) e.where = l.where;
  if (l.events.length) e.events = l.events.slice();
  if (l.people.length) e.people = l.people.slice();
  const life = d.life.slice();
  if (l.index >= 0 && l.index < life.length) life[l.index] = e;
  else life.push(e);
  set({ draft: { ...d, life, sub: null }, picking: null });
}

/** 删掉正在改的这段经历 */
export function removeLife() {
  const d = state.draft;
  if (d?.sub?.kind !== 'life') return;
  const i = d.sub.d.index;
  set({ draft: { ...d, life: i >= 0 ? d.life.filter((_, j) => j !== i) : d.life, sub: null }, picking: null });
}

/** 小表的「取消」:回到大表 */
export function cancelSub() {
  const d = state.draft;
  if (d?.sub) set({ draft: { ...d, sub: null }, picking: null });
}

// ---- 亲友 ----

export function startKin(index: number) {
  const d = state.draft;
  if (!d) return;
  const k = index >= 0 ? d.kin[index] : undefined;
  const kd: KinDraft = k ? { index, rel: k.rel, char: k.char, person: k.person, query: '' } : { index: -1, rel: '', query: '' };
  set({ draft: { ...d, sub: { kind: 'kin', d: kd } }, picking: null });
}

export function patchKin(p: Partial<KinDraft>) {
  const d = state.draft;
  if (d?.sub?.kind === 'kin') set({ draft: { ...d, sub: { kind: 'kin', d: { ...d.sub.d, ...p } } } });
}

/** 选中一个人(自己的人物 / 推演里的人;再点一下 = 不选) */
export function pickKin(who: { char: number } | { person: string }) {
  const d = state.draft;
  if (d?.sub?.kind !== 'kin') return;
  const k = d.sub.d;
  const same = 'char' in who ? k.char === who.char : k.person === who.person;
  patchKin(same ? { char: undefined, person: undefined } : 'char' in who ? { char: who.char, person: undefined } : { char: undefined, person: who.person });
}

export function kinProblem(d: CharDraft, k: KinDraft): string | null {
  if (k.char === undefined && !k.person) return '选一个人';
  if (k.index < 0 && d.kin.length >= KIN_MAX) return `一个人最多列 ${KIN_MAX} 个亲友`;
  return null;
}

export function finishKin() {
  const d = state.draft;
  if (d?.sub?.kind !== 'kin' || kinProblem(d, d.sub.d)) return;
  const k = d.sub.d;
  const e: KinEntry = k.char !== undefined ? { rel: k.rel.trim(), char: k.char } : { rel: k.rel.trim(), person: k.person! };
  const kin = d.kin.slice();
  if (k.index >= 0 && k.index < kin.length) kin[k.index] = e;
  else kin.push(e);
  set({ draft: { ...d, kin, sub: null } });
}

export function removeKin() {
  const d = state.draft;
  if (d?.sub?.kind !== 'kin') return;
  const i = d.sub.d.index;
  set({ draft: { ...d, kin: i >= 0 ? d.kin.filter((_, j) => j !== i) : d.kin, sub: null } });
}

/** Esc:先停下挑地方,再关小表,再取消正在填的 */
export function escapeCharacter(): boolean {
  if (state.picking) {
    stopPicking();
    return true;
  }
  if (state.draft?.sub) {
    cancelSub();
    return true;
  }
  if (state.draft) {
    cancelDraft();
    return true;
  }
  return false;
}

/** 换了世界、重新套上修改:正在填的一律作废,选中的人物、"已删除人物"的提示条也收起 */
export function resetCharacterUi() {
  if (state.draft || state.picking) set({ draft: null, picking: null });
  if (getSelection().sel?.kind === 'character') clearSelection();
  clearToast('oc');
}

// 选中了别的东西(点了地图上的城、面板里的链接、搜索……):正在填的扔掉,卡片关掉也一样
subscribeSelection(() => {
  const s = getSelection().sel;
  const d = state.draft;
  if (d && (!s || s.kind !== 'character' || s.id !== d.id)) set({ draft: null, picking: null });
});

// 选中的人物没了(撤销了新建、换了世界……):卡片关掉
subscribeEdits((e) => {
  const s = getSelection().sel;
  if (s?.kind === 'character' && s.id !== state.draft?.id && !e.characters?.some((c) => c.id === s.id)) clearSelection();
});
