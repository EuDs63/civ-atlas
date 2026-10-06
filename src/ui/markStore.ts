/**
 * 作者标记的界面状态(标记本身存在 editsStore 的 WorldEdits.marks 里,格式见 gen/edits.ts 文件头"作者标记"):
 *
 * - 放标记:地图右下角(手机是右上那列按钮)的「标记」→ placing;顶部提示条"点地图放标记"(取消 · Esc),点地图 = 在那里新建一个
 * - 新建 / 编辑:卡片上正在填的那一份(draft),点「完成」才存进修改(记一步撤销),「取消」扔掉。
 *   新建时选中的是 { kind: 'mark', id: 0 }(还没有编号);选中别的东西 = 扔掉正在填的
 * - 几个州的标记:编辑时点地图上的州 = 加进来 / 再点一下去掉;一个点的标记:编辑时拖图钉挪位置
 */
import { useSyncExternalStore } from 'react';
import { INTERVENTION_YEAR_MAX, MARKS_MAX, MARK_COLORS, MARK_REGIONS_MAX, MARK_REGIONS_TOTAL, markRegionTotal, type AuthorMark, type MarkColor } from '../gen/edits';
import { addMark, getEdits, subscribeEdits, updateMark } from './editsStore';
import { clearSelection, getSelection, setSelection, subscribeSelection } from './civView';
import { clearToast, showToast } from './toastStore';

/** 卡片上正在填的标记 */
export interface MarkDraft {
  /** 编辑的是哪个标记;新建 = 0 */
  id: number;
  title: string;
  note: string;
  color: MarkColor;
  /** 年份输入框里的字("到"空着 = 一直都在) */
  fromText: string;
  toText: string;
  /** 一个点 / 几个州 */
  scope: 'point' | 'regions';
  /** 一个点的位置(世界坐标);换成"几个州"时留着,换回来还在 */
  at: [number, number] | null;
  /** 几个州(州键) */
  regions: string[];
}

export interface MarkUi {
  /** 正在"点地图放标记" */
  placing: boolean;
  draft: MarkDraft | null;
  /** 正在拖图钉 */
  dragging: boolean;
}

let state: MarkUi = { placing: false, draft: null, dragging: false };
const subs = new Set<() => void>();
function set(patch: Partial<MarkUi>) {
  state = { ...state, ...patch };
  for (const f of subs) f();
}

export function getMarkUi(): MarkUi {
  return state;
}

export function useMarkUi(): MarkUi {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getMarkUi,
    getMarkUi,
  );
}

export function subscribeMarkUi(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

// ---- 放标记 ----

/** 「标记」按钮:进入 / 退出"点地图放标记"(进入时收起打开着的卡片) */
export function togglePlacing() {
  if (state.placing) return stopPlacing();
  startPlacing();
}

/** 进入"点地图放标记"(已经在放了就不动) */
export function startPlacing() {
  clearSelection();
  if (!state.placing) set({ placing: true, draft: null });
}

export function stopPlacing() {
  if (state.placing) set({ placing: false });
}

// ---- 新建 / 编辑 ----

/** 年份 → 输入框里的字 */
const yearText = (y: number | undefined) => (y === undefined ? '' : String(Math.floor(y)));

/** 新建一个(还没存):一个点(at)或几个州(regions);「从」= year(时间轴当前那年)。选中它,卡片换成填写的样子 */
export function newMarkDraft(init: { at?: [number, number]; regions?: string[]; year: number }) {
  const regions = init.regions ?? [];
  set({
    placing: false,
    draft: {
      id: 0,
      title: '',
      note: '',
      color: MARK_COLORS[0],
      fromText: yearText(init.year),
      toText: '',
      scope: regions.length ? 'regions' : 'point',
      at: init.at ?? null,
      regions,
    },
  });
  setSelection({ kind: 'mark', id: 0 });
}

/** 编辑一个已有的标记 */
export function editMarkDraft(m: AuthorMark) {
  set({
    placing: false,
    draft: {
      id: m.id,
      title: m.title,
      note: m.note ?? '',
      color: m.color,
      fromText: yearText(m.from),
      toText: yearText(m.to),
      scope: m.regions ? 'regions' : 'point',
      at: m.at ? [m.at[0], m.at[1]] : null,
      regions: m.regions ? m.regions.slice() : [],
    },
  });
  setSelection({ kind: 'mark', id: m.id });
}

export function patchDraft(p: Partial<MarkDraft>) {
  if (state.draft) set({ draft: { ...state.draft, ...p } });
}

/** 编辑几个州时点了一个州:没选的加进来(满了 MARK_REGIONS_MAX 个就提示一句),选了的去掉 */
export function toggleDraftRegion(key: string) {
  const d = state.draft;
  if (!d || d.scope !== 'regions') return;
  if (!d.regions.includes(key) && d.regions.length >= MARK_REGIONS_MAX) {
    showToast({ id: 'mk-regions', kind: 'warn', text: `一个标记最多圈 ${MARK_REGIONS_MAX} 个州`, ttl: 3000 });
    return;
  }
  const regions = d.regions.includes(key) ? d.regions.filter((k) => k !== key) : [...d.regions, key];
  set({ draft: { ...d, regions } });
}

/** 年份输入框里的字 → 年份(空 = null;不是数 = NaN) */
export function parseYear(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  return /^\d{1,5}$/.test(t) ? Number(t) : NaN;
}

/** 填的东西能不能存;不能 = 原因(卡片上提示一句,「完成」点不了) */
export function draftProblem(d: MarkDraft): string | null {
  const from = parseYear(d.fromText);
  const to = parseYear(d.toText);
  if (from === null || Number.isNaN(from)) return '填一下从哪年开始';
  if (Number.isNaN(to)) return '"到"要填年份,或者空着';
  if (from > INTERVENTION_YEAR_MAX || (to !== null && to > INTERVENTION_YEAR_MAX)) return `年份最大填到 ${INTERVENTION_YEAR_MAX}`;
  if (to !== null && to < from) return '"到"比"从"早了';
  if (d.scope === 'regions' && !d.regions.length) return '在地图上点几个州加进来';
  if (d.scope === 'point' && !d.at) return '在地图上点一下放图钉';
  if (d.id === 0 && (getEdits().marks?.length ?? 0) >= MARKS_MAX) return `标记已经有 ${MARKS_MAX} 个了,删掉一些才能再加`;
  if (d.scope === 'regions' && markRegionTotal(getEdits().marks, d.id) + d.regions.length > MARK_REGIONS_TOTAL) return `所有标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州`;
  return null;
}

/** 填好的 → 要存的标记(不含编号);不能存 = null */
export function draftMark(d: MarkDraft): Omit<AuthorMark, 'id'> | null {
  if (draftProblem(d)) return null;
  const from = parseYear(d.fromText)!;
  const to = parseYear(d.toText);
  const m: Omit<AuthorMark, 'id'> = { title: d.title, color: d.color, from };
  if (d.note.trim()) m.note = d.note;
  if (to !== null) m.to = to;
  if (d.scope === 'regions') m.regions = d.regions.slice();
  else m.at = [d.at![0], d.at![1]];
  return m;
}

/** 「完成」:存进修改(新建 = 加一个,编辑 = 换掉原来的),选中它、卡片换回看的样子。返回标记的编号;存不了 = −1 */
export function finishDraft(): number {
  const d = state.draft;
  const m = d && draftMark(d);
  if (!d || !m) return -1;
  let id = d.id;
  if (id === 0) id = addMark(m);
  else if (getEdits().marks?.some((x) => x.id === id)) updateMark({ ...m, id });
  else id = addMark(m);
  set({ draft: null });
  if (id > 0) setSelection({ kind: 'mark', id });
  return id;
}

/** 「取消」:扔掉正在填的;新建的连卡片一起关掉,编辑的回到看的样子(那个标记已经没了 = 也关掉) */
export function cancelDraft() {
  const d = state.draft;
  if (!d) return;
  set({ draft: null });
  if (d.id === 0 || !getEdits().marks?.some((m) => m.id === d.id)) clearSelection();
}

export function setMarkDragging(on: boolean) {
  if (state.dragging !== on) set({ dragging: on });
}

/** 换了世界、重新套上修改:放标记、正在填的一律作废,选中的标记、"已删除标记"的提示条也收起 */
export function resetMarkUi() {
  if (state.placing || state.draft || state.dragging) set({ placing: false, draft: null, dragging: false });
  if (getSelection().sel?.kind === 'mark') clearSelection();
  clearToast('mk');
}

// 选中了别的东西(点了地图上的城、面板里的链接、搜索……):正在填的扔掉,卡片关掉也一样;放标记时选了别的 = 不放了
subscribeSelection(() => {
  const s = getSelection().sel;
  if (state.placing && s) set({ placing: false });
  const d = state.draft;
  if (d && (!s || s.kind !== 'mark' || s.id !== d.id)) set({ draft: null });
});

// 选中的标记没了(撤销了新建、换了世界……):卡片关掉
subscribeEdits((e) => {
  const s = getSelection().sel;
  if (s?.kind === 'mark' && s.id !== state.draft?.id && !e.marks?.some((m) => m.id === s.id)) clearSelection();
});
