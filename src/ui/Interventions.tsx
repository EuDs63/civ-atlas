/**
 * 干预(阶段 4)的数据与界面零件:"在地图上选目标"的状态、干预的说法、州的干预区。
 *
 * - 国家的命令(保护、禁止分裂、禁止扩张、结盟、宣战、迁都)在国家面板的干预页(CommandPage.tsx),这里只给它用的小工具
 *   (某年的邻国、城还在不在、默认生效年份……)。
 * - 在地图上选目标(PolityPick):干预页 / 州的"划给…"发起;地图压暗、可选的对象浮出名牌(TargetPlates.tsx),
 *   单击地图或名牌 = accept(编号);悬停卡片写"点击选择 / 不可选 / 本国"(hoverInfo.ts)。
 * - 州的干预(州面板 RegionPanel.tsx 的"在这里立国""划给…")用这里的 regionOrders / MineList 列出这一州的干预(可撤销)。
 * - 所有干预的列表在概览的"我的干预"页(WorldOverviewInterventions.tsx,用这里的 interventionText)。
 * - 下了 / 删了干预,editsStore 里的干预列表一变,App 就在后台从第 0 年重推文明(见 App.tsx)。
 *
 * 国家、州、城一律按稳定键记(gen/edits.ts);显示的名字按当前这份历史解析。
 */
import { useSyncExternalStore } from 'react';
import { AdjKind, type Civ, type Polity } from '../gen/civ/types';
import { polityAlive, polityName } from '../gen/civ/growth';
import { regionLabel } from '../gen/civ/display';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { cleanIntervention, polityKey, regionKey, regionOfKey, resolveKey, type Intervention } from '../gen/edits';
import { removeIntervention } from './editsStore';

// ---------------------------------------------------------------------------
// 在地图上选目标

export interface PolityPick {
  /** 顶部提示条上的话:"选择与大昌结盟的国家" */
  prompt: string;
  /** 提示条上的小字:"2649 年起生效" */
  sub?: string;
  /** 从哪里发起(`polity:3` / `region:12`;面板换了对象时据此收起) */
  source: string;
  /** 要点的是国家(默认)还是城 */
  target?: 'polity' | 'settlement';
  /** 点到了国家 / 城 id:合格 = 下令、返回 null;不合格 = 返回原因(如"两国不接壤,无法宣战") */
  accept: (id: number) => string | null;
  /** 上一次点的不合格的原因 */
  msg?: string;
  /** 本国(名牌、悬停写"本国") */
  self?: number;
  /** 可选的对象(国家 / 城的编号):地图上浮出它们的名牌,悬停写"点击选择" */
  eligible?: ReadonlySet<number>;
  /** 相邻的国家(名牌上写"相邻") */
  near?: ReadonlySet<number>;
  /** 按哪一年的国土摆名牌 */
  year?: number;
}

let pick: PolityPick | null = null;
const pickSubs = new Set<() => void>();

export function getPolityPick(): PolityPick | null {
  return pick;
}

export function setPolityPick(p: PolityPick | null) {
  if (p === pick) return;
  pick = p;
  if (!p) setPickHover(-1);
  for (const f of pickSubs) f();
}

export function usePolityPick(): PolityPick | null {
  return useSyncExternalStore(
    (f) => {
      pickSubs.add(f);
      return () => pickSubs.delete(f);
    },
    getPolityPick,
    getPolityPick,
  );
}

/** 选目标时鼠标下的对象对不对:'ok' 可选 / 'self' 本国 / 'no' 不可选 */
export function pickVerdict(p: PolityPick, id: number): 'ok' | 'self' | 'no' {
  if (id >= 0 && p.self === id && (p.target ?? 'polity') === 'polity') return 'self';
  if (id >= 0 && p.eligible?.has(id)) return 'ok';
  return 'no';
}

/** 选目标时"悬停卡片"的小字 */
export const VERDICT_TEXT = { ok: '点击选择', self: '本国', no: '不可选' } as const;

// 选目标时鼠标停在哪个对象上(名牌反色);−1 = 没有
let hovered = -1;
const hoverSubs = new Set<() => void>();

export function setPickHover(id: number) {
  if (id === hovered) return;
  hovered = id;
  for (const f of hoverSubs) f();
}

export function usePickHover(): number {
  return useSyncExternalStore(
    (f) => {
      hoverSubs.add(f);
      return () => hoverSubs.delete(f);
    },
    () => hovered,
    () => hovered,
  );
}

// ---------------------------------------------------------------------------
// 小工具

/** 稳定键 → 这份历史里的国家编号(−1 = 没有) */
export function polityIdOf(civ: Civ, key: string): number {
  const r = resolveKey(civ, key);
  return r && r.kind === 'polity' ? r.id : -1;
}

/** 城的稳定键 → 这份历史里的城编号(−1 = 没有) */
function cityIdOf(civ: Civ, key: string): number {
  const r = resolveKey(civ, key);
  return r && r.kind === 'settlement' ? r.id : -1;
}

/** 某年的国名(那一年还没立国 / 已亡:立国时 / 亡国前的国号) */
export function nameAt(p: Polity, year: number): string {
  const y = year < p.founded ? p.founded : p.ended !== undefined && year >= p.ended ? p.ended - 1 / 512 : year;
  return polityName(p, y) || p.name || '某国';
}

const keyName = (civ: Civ, key: string, year: number): string => {
  const id = polityIdOf(civ, key);
  return id >= 0 ? nameAt(civ.polities[id], year) : '(新历史里没有的国家)';
};

const regionKeyName = (civ: Civ, key: string): string => {
  const r = regionOfKey(key, civ.regions.of);
  return r >= 0 && r < civ.regions.count ? regionLabel(civ, r) : '(没有的州)';
};

const cityKeyName = (civ: Civ, key: string): string => {
  const id = cityIdOf(civ, key);
  return id >= 0 ? civ.settlements[id].name || '某城' : '(新历史里没有的城)';
};

/** 第 i 条干预(Civ.interventions 的下标)是"立国"、在这份历史里立成了:立出来的国家(没有 = −1) */
function foundedBy(civ: Civ, i: number): number {
  if (i < 0 || civ.interventions?.[i]?.kind !== 'found') return -1;
  const e = civ.annals.find((x) => x.kind === 'intervene' && x.war === i);
  return e && e.a >= 0 ? e.a : -1;
}

/**
 * editsStore 里的干预列表(可能夹着认不出的)→ 每一条在这份历史的 Civ.interventions 里是第几条(−1 = 认不出 / 对不上:
 * 这份历史还不是按现在的列表推出来的,比如正在重推)
 */
export function civIndexes(civ: Civ, list: readonly unknown[]): number[] {
  const done = civ.interventions ?? [];
  let c = 0;
  return list.map((x) => {
    const v = cleanIntervention(x);
    if (!v) return -1;
    if (c < done.length && JSON.stringify(done[c]) === JSON.stringify(v)) return c++;
    return -1;
  });
}

/**
 * 一条干预的说法:"大昌:保护""大昌与索拉特结盟(至第 2000 年)""大昌向索拉特宣战""大昌:禁止分裂"
 * "瑞州划给大昌(永久)""在瑞州立国(号饕餮)""大昌迁都瑞城""大昌:禁止扩张(至第 1800 年)"。
 * i = 它在这份历史的 Civ.interventions 里是第几条(给了、立国立成了,就写出立出来的国名)
 */
export function interventionText(civ: Civ, v: Intervention, i = -1): string {
  if (v.kind === 'found') {
    const made = i >= 0 ? foundedBy(civ, i) : -1;
    const shown = made >= 0 ? `,即${nameAt(civ.polities[made], v.from)}` : v.name ? `(号${v.name})` : '';
    return `在${regionKeyName(civ, v.region)}立国${shown}`;
  }
  const A = keyName(civ, v.a, v.from);
  switch (v.kind) {
    case 'protect':
      return `${A}:保护`;
    case 'unity':
      return `${A}:禁止分裂`;
    case 'ally':
      return `${A}与${keyName(civ, v.b, v.from)}结盟${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'declare':
      return `${A}向${keyName(civ, v.b, v.from)}宣战`;
    case 'cede':
      return `${regionKeyName(civ, v.region)}划给${A}${v.permanent ? '(永久)' : ''}`;
    case 'move':
      return `${A}迁都${cityKeyName(civ, v.city)}`;
    case 'halt':
      return `${A}:禁止扩张${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
  }
}

let owners: Owners | undefined;

/** y 年各国的州数、和 id 接壤的国家(id 能走过去的边) */
export function neighborsAt(civ: Civ, id: number, y: number): { size: Map<number, number>; near: Set<number> } {
  owners = ownersAt(civ, y, owners);
  const own = owners.polity;
  const reg = civ.regions;
  const size = new Map<number, number>();
  const near = new Set<number>();
  const sea = civ.polities[id]?.kind === 'sea';
  for (let r = 0; r < reg.count; r++) {
    const o = own[r];
    if (o < 0) continue;
    size.set(o, (size.get(o) ?? 0) + 1);
    if (o !== id) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own[reg.adj[k]];
      const kind = reg.adjKind[k];
      if (q >= 0 && q !== id && (sea || (kind !== AdjKind.Strait && kind !== AdjKind.SeaRoute))) near.add(q);
    }
  }
  return { size, near };
}

/** 城 s 在 y 年还在(建了、没毁) */
export const cityStands = (civ: Civ, sid: number, y: number) => {
  const s = civ.settlements[sid];
  return !!s && s.founded <= y && (s.ended === undefined || s.ended > y);
};

/** 国家 p 在时间轴停在 year 时,生效年份的默认值:活着 = 这一年;还没立国 = 立国那年;已亡 = 亡国前 30 年 */
export function defaultYear(p: Polity, year: number): number {
  if (polityAlive(p, year)) return Math.floor(year);
  if (year < p.founded) return Math.ceil(p.founded);
  return Math.max(Math.ceil(p.founded), Math.floor(p.ended!) - 30);
}

/**
 * 牵涉国家 id 的干预(它下的令、以它为对象的结盟 / 宣战、立国立出来的就是它):
 * v = 清理过的干预,i = editsStore 里的下标,c = 这份历史里的下标
 */
export function polityOrders(civ: Civ, id: number, list: readonly unknown[]): { v: Intervention; i: number; c: number }[] {
  const key = polityKey(civ, id);
  const ci = civIndexes(civ, list);
  return list
    .map((x, i) => ({ v: cleanIntervention(x), i, c: ci[i] }))
    .filter(
      (e): e is { v: Intervention; i: number; c: number } =>
        !!e.v &&
        (e.v.kind === 'found' ? foundedBy(civ, e.c) === id : e.v.a === key || ((e.v.kind === 'ally' || e.v.kind === 'declare') && e.v.b === key)),
    );
}

/** 这一州的干预(立国、划州):v = 清理过的干预,i = editsStore 里的下标,c = 这份历史里的下标 */
export function regionOrders(civ: Civ, region: number, list: readonly unknown[]): { v: Intervention; i: number; c: number }[] {
  const key = regionKey(civ, region);
  const ci = civIndexes(civ, list);
  return list
    .map((x, i) => ({ v: cleanIntervention(x), i, c: ci[i] }))
    .filter((e): e is { v: Intervention; i: number; c: number } => !!e.v && (e.v.kind === 'found' || e.v.kind === 'cede') && e.v.region === key);
}

/** 已经下了的几条(可撤销;i = editsStore 里的下标,c = 这份历史里的下标) */
export function MineList({ civ, mine }: { civ: Civ; mine: { v: Intervention; i: number; c: number }[] }) {
  if (!mine.length) return null;
  return (
    <div className="iv-mine">
      {mine.map(({ v, i, c }) => (
        <div key={i} className="iv-item">
          <span className="ins-years">{v.from}</span>
          <span className="iv-item-text">{interventionText(civ, v, c)}</span>
          <button className="iv-del" data-act="iv-del" onClick={() => removeIntervention(i)} title="撤销这条干预(之后的历史重新推演)">
            撤销
          </button>
        </div>
      ))}
    </div>
  );
}
