/**
 * 世界概览浮层(WorldOverview.tsx)开没开、在哪一页。别处要打开某一页直接调:
 *
 *   openOverview()                               打开(停在上次那一页)
 *   openOverview('chronicle', { polity: 3 })     打开编年史,只看 3 号国家的事
 *   openOverview('interventions')                打开"我的干预"
 *   openPeople({ list: 'rulers', polity: 3 })    打开人物页,看 3 号国家的历代君主(usePeople() 读人物页的筛选)
 *   closeOverview()                              收起(编年史的"只看这一国"一起清掉)
 *   useOverview() / getOverview()                { open, tab }
 *
 * 编年史以前是单独的窗口(civView.ts 的 setChronicle({ open })),现在是概览里的一页:
 * 两边保持一致 —— setChronicle({ open: true }) 等于打开概览的编年史页,setChronicle({ open: false }) 在编年史页时收起概览;
 * 网址 chron=1 / chron=all 打开网页时就停在编年史页。
 */
import { useSyncExternalStore } from 'react';
import { getChronicle, setChronicle, subscribeChronicle, type ChronicleView } from './civView';

export type OverviewTab = 'countries' | 'chronicle' | 'people' | 'marks' | 'interventions' | 'genesis';

export const OVERVIEW_TABS: readonly OverviewTab[] = ['countries', 'chronicle', 'people', 'marks', 'interventions', 'genesis'];

export interface OverviewState {
  open: boolean;
  tab: OverviewTab;
}

export interface OverviewOpts {
  /** 编年史只看这一国(null = 全部国家;不给 = 不变) */
  polity?: number | null;
  /** 编年史只看大事(不给 = 不变) */
  major?: boolean;
  /** 编年史打开后滚到这一年(不给 = 滚到时间轴当前那年) */
  at?: number;
}

const chron0 = getChronicle();
let state: OverviewState = { open: chron0.open, tab: chron0.open ? 'chronicle' : 'countries' };
const subs = new Set<() => void>();

function set(next: OverviewState) {
  if (next.open === state.open && next.tab === state.tab) return;
  const closing = state.open && !next.open;
  state = next;
  subs.forEach((f) => f());
  // 编年史"开着" = 概览开在编年史页(同步到 civView 的编年史状态:App 根元素的 chron-open 读它);
  // 收起概览时"只看这一国"一起清掉:时间轴上的事件点跟着编年史的筛选,收起后回到全部国家。两样一次改(分两次改,下面的订阅会在中间把概览又打开)
  const shown = state.open && state.tab === 'chronicle';
  const c = getChronicle();
  const patch: Partial<ChronicleView> = {};
  if (c.open !== shown) patch.open = shown;
  if (closing && c.polity !== null) patch.polity = null;
  if (patch.open !== undefined || patch.polity !== undefined) setChronicle(patch);
}

// 别处还按老办法开关编年史(setChronicle({ open })):换成开关概览的编年史页
subscribeChronicle(() => {
  const c = getChronicle();
  const shown = state.open && state.tab === 'chronicle';
  if (c.open && !shown) set({ open: true, tab: 'chronicle' });
  else if (!c.open && shown) set({ ...state, open: false });
});

export function getOverview(): OverviewState {
  return state;
}

export function useOverview(): OverviewState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    getOverview,
    getOverview,
  );
}

/** 打开概览(不给 tab = 停在上次那一页);opts 给编年史页设筛选 */
export function openOverview(tab?: OverviewTab, opts: OverviewOpts = {}) {
  const patch: Partial<ChronicleView> = {};
  if (opts.polity !== undefined) patch.polity = opts.polity;
  if (opts.major !== undefined) patch.major = opts.major;
  if (opts.at !== undefined) patch.at = opts.at;
  if (Object.keys(patch).length) setChronicle(patch);
  set({ open: true, tab: tab ?? state.tab });
}

export function closeOverview() {
  set({ ...state, open: false });
}

/** 换页(开着时) */
export function setOverviewTab(tab: OverviewTab) {
  set({ ...state, tab });
}

// ---- 人物页的筛选:我的(作者的人物)/ 名人 / 君主 / 将领,只看哪一国 ----

export type PeopleList = 'mine' | 'famous' | 'rulers' | 'generals';

export interface PeopleView {
  /** 看哪一档;null = 还没挑过:有作者自己的人物先看「我的」,没有先看「名人」 */
  list: PeopleList | null;
  /** 只看这一国(null = 全部国家) */
  polity: number | null;
}

let people: PeopleView = { list: null, polity: null };
const peopleSubs = new Set<() => void>();

export function getPeople(): PeopleView {
  return people;
}

export function setPeople(patch: Partial<PeopleView>) {
  people = { ...people, ...patch };
  peopleSubs.forEach((f) => f());
}

export function usePeople(): PeopleView {
  return useSyncExternalStore(
    (f) => (peopleSubs.add(f), () => peopleSubs.delete(f)),
    getPeople,
    getPeople,
  );
}

/** 打开概览的人物页(国家卡片的"全部 N 位" = 这国的历代君主) */
export function openPeople(patch: Partial<PeopleView> = {}) {
  setPeople(patch);
  set({ open: true, tab: 'people' });
}
