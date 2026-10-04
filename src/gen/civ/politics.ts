/**
 * 分与合:国家会分裂、会合并、会复国、会主动迁都;部落地带里当年没能立国的城,后来还能再试。
 * 挂在同一个推演引擎(sim.ts)上,改归属一律走 setOwner(原因 = Ev.Split / Ev.Merge),发生了什么记进史事(sim.record)。
 *
 * 流程(index.ts 在 installWars 之后调用 installPolitics):
 *
 *   看内政(Ev.PoliticsCheck)每个国家立国 POL_FIRST 年后,每 POL_EVERY 年看一眼自己(每段里随机一个时刻),
 *   一次最多出一件事,依次看:
 *
 *   ① 分裂 / 独立:国土 ≥ SPLIT_MIN_SIZE 州的大国,各州有"离心力"(借 Worlds 历史模拟器的思路:离国家核心越远,管理成本越高):
 *        离心力 = 离国都的路程 ÷ SPLIT_REACH + 异族 FOREIGN_D + 刚被征服不久 RECENT_D(随年数淡去)
 *      国家整体的"动荡"= 刚丢了国都 / 迁了都、刚改朝换代(dynasty.ts)、正在打仗、这些年接连丢州、国土太大(管理不过来),加在每一州上。
 *      离心力最大的那一州起兵的机会 = 赔率 SPLIT_ODDS × e^(SPLIT_K × (离心力 + 动荡 − SPLIT_D0)),换成概率。
 *      起兵的州连同周围离心力差不多大的州一起自立(从起事的州往外长,同族的、离得近的先并进来,国土成团;
 *      最多占原国的 SPLIT_FRAC),
 *      原国因此被切断、和国都不再连着的碎块也一并归新国(不留飞地)。新国都 = 这些州里人口最多的城;
 *      新国都要是某个同族亡国的故都,这次起兵就算复国(见下)。
 *      同一国分裂后 SPLIT_REST 年内不再分裂:大国不会一夜碎成十几块。
 *   ② 合并:不超过 MERGE_SMALL 州、立国满 MERGE_AGE 年的小国,接壤的同族大国(州数是它 MERGE_RATIO 倍以上)
 *      有一定机会和平并入;双方都不在打仗。被并掉的国家 ended = 那一年(不另记灭亡)。
 *   ③ 主动迁都:国都离国土重心太远(各州离国都的平均距离是离"国土中部人口多的那座城"的 ECC_RATIO 倍以上),
 *      或国都已经成了前线(挨着正在交战的敌国),就迁到国土中部人口多的城。迁都后 CAPMOVE_REST 年内不再主动迁。
 *
 *   看复国(Ev.RestoreCheck)国家亡于战争以后,每 RESTORE_EVERY 年看一次(看 RESTORE_TRIES 次,约五百年):
 *      故国的国都(历任国都)一带仍是同族人住、现在的宗主又弱(在打仗、刚分裂、刚迁都)、而且是异族统治时机会更大,
 *      遗民就以故都为中心、连同周围的同族州起兵复国(记 split,b = 从哪国手里起兵;新国家写 restores = 亡国)。
 *      一个亡国只复一次;复国出来的国家再亡就不再复(不一复再复)。
 *
 *   看部落地带(Ev.TribalCheck)每 TRIBAL_EVERY 年看一次:当年因为离别国国都太近(国都间距)没能立国的城,
 *      那个国都灭亡 / 迁走以后,在这里补立国(走 polities.ts 同一个"立国"事件)。
 *
 *   分裂 / 复国出来的国家:founded = 起事那年、立国从第 0 档起算(按当时州数升格,同一刻记进 titles)、
 *   有自己的看邻国 / 看内政;立国 NEWBORN 年内别国不会对它宣战(站稳期,见 wars.ts)。
 *   起兵、合并的州都要 SETTLE 年没换过国家(和战争的 HOLD 一起,保证 50 年内没有州易手 3 次)。
 *
 * 阶段 4 干预(interventions.ts,挂在 WarModel.iv 上;没有干预时只多一次判空):不许灭的国家不会被合并掉;
 *   禁止分裂的国家不会分裂,它的国土里也不会有遗民起兵复国;
 *   永久划给某国的州(还在那国手里时)不会跟着起兵自立 / 复国(被切断时这次就不分),手里有这种州的小国不会被合并掉;
 *   不许扩张的国家不去合并别的小国。
 *
 * **不存内存状态**:最近一次分裂 = 史事里 split 的 b;复过国的亡国 = 国家表的 restores;被并掉的 = 史事里 merge 的 b;
 *   最近一次迁都 = 国家的 capitals;看内政、看复国、看部落地带的时刻都由"国家 + 第几次"算出来(resumePolitics)。
 *
 * 随机数:keyed(subSeed(seed, 'civ-politics'), 国家…, 第几次, 用途),和处理顺序无关。
 * 国家、州一律用位置锚(PolityModel.ptag、治所地块;见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { MinHeap } from '../util';
import { geometryOf, type Geometry } from '../geometry';
import { AdjKind, Layer, type Civ, type Polity, type Year } from './types';
import { fexp, flog, keyed, keyed4, subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { addPolity, canCross, coreOf, endPolity, foundingYear, moveCapital, polityModelOf, type PolityModel } from './polities';
import { warModelOf, type WarModel } from './wars';
import { capitalAt, populationAt } from './growth';

// ---- 调参(以截图和统计数为准,见 scripts/gen-stats.ts) ----
/** 立国后多少年开始看内政;之后每隔多少年看一次(每段里 20%–80% 处随机一个时刻) */
const POL_FIRST = 60;
const POL_EVERY = 40;
/** 起兵、合并、复国的州要这么多年没换过国家(战争的 HOLD 是 25 年:两者加起来,50 年内一州最多易手两次) */
const SETTLE = 30;

/** 分裂:国土至少这么多州、立国满这么多年;同一国分裂后这么多年内不再分裂 */
const SPLIT_MIN_SIZE = 16;
const SPLIT_AGE = 120;
const SPLIT_REST = 120;
/** 离心力:离国都的路程(标准路程)÷ SPLIT_REACH;异族;刚被征服(RECENT 年内,随年数淡去) */
const SPLIT_REACH = 12;
const FOREIGN_D = 0.7;
const RECENT = 150;
const RECENT_D = 0.6;
/** 动荡:CRISIS_YEARS 年内迁过都(多半是丢了国都)、正在打仗、接连丢州(最多加满 CRISIS_LOSS);国土大(每大 e 倍加 SIZE_D) */
const CRISIS_YEARS = 50;
const CRISIS_CAPITAL = 0.5;
const CRISIS_WAR = 0.25;
const CRISIS_LOSS = 0.5;
const SIZE_D = 0.4;
/** 动荡:DYNASTY_YEARS 年内改朝换代过(阶段 3 王朝更替,dynasty.ts):新朝初立,边远之地更容易割据自立 */
const DYNASTY_YEARS = 60;
const CRISIS_DYNASTY = 0.25;
/** 起兵的赔率:SPLIT_ODDS × e^(SPLIT_K × (离心力 + 动荡 − SPLIT_D0)) */
const SPLIT_ODDS = 0.08;
const SPLIT_K = 2;
const SPLIT_D0 = 1.8;
/** 挑起事的州时,离心力加一点随机(不总是同一州) */
const RISE_JITTER = 0.3;
/** 一起自立的州:离心力不低于起事那州 − GROUP_DROP,也不低于 GROUP_MIN_D */
const GROUP_DROP = 0.9;
const GROUP_MIN_D = 1.0;
/** 一起自立的州先挑谁:离心力 + 和起事的州同族 GROUP_KIN − 离起事的州每隔一州 GROUP_COMPACT */
const GROUP_KIN = 0.3;
const GROUP_COMPACT = 0.25;
/** 自立的国土:至少几州、最多几州、最多占原国的几成 */
const SPLIT_MIN_GROUP = 5;
const SPLIT_MAX_GROUP = 25;
const SPLIT_FRAC = 0.35;

/** 合并:小国不超过几州、立国满几年;大国的州数至少是小国的几倍;赔率 */
const MERGE_SMALL = 10;
const MERGE_AGE = 60;
const MERGE_RATIO = 2.5;
const MERGE_ODDS = 0.25;

/** 主动迁都:国土至少几州、立国满几年;上次迁都(含国都失守)后多少年内不再主动迁 */
const CAPMOVE_MIN = 10;
const CAPMOVE_AGE = 150;
const CAPMOVE_REST = 400;
/**
 * 国都偏在一隅:各州离国都的平均距离 ≥ 离新国都的 ECC_RATIO 倍;
 * 国都是前线(离正在交战的敌国不到两州)时,新国都不比现在偏太多(FRONT_RATIO)就迁
 */
const ECC_RATIO = 1.2;
/** 粗筛(省时间):各州离国都的平均距离不到离国土重心的 ECC_PRE 倍、国都也不是前线,就不挑新国都了 */
const ECC_PRE = 1.1;
const FRONT_RATIO = 1.15;
/**
 * 新国都的人口至少是现国都的几成;挑新国都:按"人口 × e^(−离国土重心的距离 ÷ CENTER_L 个州的间距)"挑前 CAPMOVE_TOP 座,
 * 其中各州离它平均最近的那座
 */
const CAPMOVE_POP = 0.35;
const CENTER_L = 3;
const CAPMOVE_TOP = 5;
/** 看到该迁了,这一次真迁的机会 */
const CAPMOVE_P = 0.35;

/** 复国:亡国后多少年开始看,每隔多少年看一次,一共看几次 */
const RESTORE_FIRST = 30;
const RESTORE_EVERY = 40;
const RESTORE_TRIES = 12;
/** 复国的赔率 = RESTORE_ODDS × 宗主的虚弱 × 异族统治 × 离宗主国都远近 */
const RESTORE_ODDS = 0.025;
const RESTORE_FOREIGN = 2;
/** 宗主的虚弱 = 1 + 在打仗 W_WAR + RECENT_SPLIT 年内分裂过 W_SPLIT + CRISIS_YEARS 年内迁过都 W_CAP + 接连丢州 W_LOSS */
const W_WAR = 1.5;
const W_SPLIT = 1.5;
const W_CAP = 1;
const W_LOSS = 1;
const RECENT_SPLIT = 80;
/** 宗主至少几州才能从它手里分出去;复国的国土最少几州、最多几州、最多占宗主的几成 */
const RESTORE_MIN_OWNER = 8;
const RESTORE_MIN_GROUP = 2;
const RESTORE_MAX_GROUP = 16;
const RESTORE_FRAC = 0.3;

/** 看部落地带:第一次在哪一年,之后每隔多少年 */
const TRIBAL_FIRST = 0;
const TRIBAL_EVERY = 50;

// 随机数用途编号
const U_CHECK_T = 1;
const U_SPLIT = 2;
const U_RISE = 3;
const U_MERGE = 4;
const U_MOVE = 5;
const U_RESTORE_T = 6;
const U_RESTORE = 7;
const U_TRIBAL_T = 8;

// ---------------------------------------------------------------------------
// 模型

export interface PoliticsModel {
  pm: PolityModel;
  wm: WarModel;
  base: number;
  /** 世界的几何(算国土重心、各州治所离重心远近) */
  geo: Geometry;
  /** 州的典型间距(世界单位) */
  unit: number;
  /** 国家 → 最近一次从它分出去(分裂 / 复国,它是 split 的 b)的年份 */
  lastSplit: Map<number, Year>;
  /** 已经复过国的亡国 */
  restored: Set<number>;
  /** 被并掉的国家(不复国) */
  merged: Set<number>;
}

function newModel(pm: PolityModel, wm: WarModel, world: World): PoliticsModel {
  const reg = pm.terrain.regions;
  const R = reg.count;
  let area = 0;
  for (let r = 0; r < R; r++) area += reg.area[r];
  return {
    pm,
    wm,
    base: subSeed(pm.seed, 'civ-politics'),
    geo: geometryOf(world.mesh),
    unit: Math.max(1e-6, Math.sqrt(area / Math.max(1, R))),
    lastSplit: new Map(),
    restored: new Set(),
    merged: new Set(),
  };
}

/** 国家 p 第 k 次看内政的时刻 */
function checkTime(pol: PoliticsModel, p: number, k: number): number {
  return pol.pm.polities[p].founded + POL_FIRST + POL_EVERY * (k + 0.2 + 0.6 * keyed(pol.base, pol.pm.ptag[p], k, U_CHECK_T));
}

/** 亡国 f(亡于 ended 年)第 k 次看复国的时刻 */
function restoreTime(pol: PoliticsModel, f: number, ended: Year, k: number): number {
  return ended + RESTORE_FIRST + RESTORE_EVERY * (k + 0.2 + 0.6 * keyed(pol.base, pol.pm.ptag[f], k, U_RESTORE_T));
}

/** 第 k 次看部落地带的时刻 */
function tribalTime(pol: PoliticsModel, k: number): number {
  return TRIBAL_FIRST + TRIBAL_EVERY * (k + 0.2 + 0.6 * keyed(pol.base, k, 0, U_TRIBAL_T));
}

/** 亡国 f 还能不能复国:没被并掉(并掉的不算亡国)、没复过国、自己不是复国出来的(不一复再复) */
function restorable(pol: PoliticsModel, f: Polity): boolean {
  return f.restores === undefined && !pol.merged.has(f.id) && !pol.restored.has(f.id);
}

const models = new WeakMap<CivSim, PoliticsModel>();

/** 推演引擎上挂着的分合模型(测试、统计用) */
export function politicsModelOf(sim: CivSim): PoliticsModel | undefined {
  return models.get(sim);
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记分合的事件处理和监听(installWars 之后调用),预约第一次看部落地带 */
export function installPolitics(sim: CivSim, pm: PolityModel, world: World): PoliticsModel {
  const wm = warModelOf(sim);
  if (!wm) throw new Error('installPolitics:先 installWars');
  const pol = newModel(pm, wm, world);
  hook(sim, pol);
  sim.schedule(tribalTime(pol, 0), Ev.TribalCheck, 0, 0);
  return pol;
}

function hook(sim: CivSim, pol: PoliticsModel): void {
  models.set(sim, pol);
  const { pm, wm } = pol;
  const T = pm.terrain;
  const reg = T.regions;
  const R = T.R;
  const culture = sim.owners[Layer.Culture];
  const owner = sim.owners[Layer.Polity];

  // 新国家(立国、分裂、复国)拿到第一州时预约第一次看内政;国家亡了(最后一州被攻占,或者阶段 4 干预把它最后的州划走 /
  // 在那里另立新国;被并掉的不算)时预约第一次看复国
  sim.onChange(Layer.Polity, (_r, v, prev, cause) => {
    if (v >= 0 && (cause === Ev.PolityFound || cause === Ev.Split) && pm.size[v] === 1) {
      sim.schedule(checkTime(pol, v, 0), Ev.PoliticsCheck, 0, v);
    }
    if (prev >= 0 && cause !== Ev.Merge && pm.size[prev] === 0 && restorable(pol, pm.polities[prev])) {
      sim.schedule(restoreTime(pol, prev, sim.now, 0), Ev.RestoreCheck, 0, prev);
    }
  });

  // ---- 小工具 ----
  const atWar = (p: number) => wm.active.some((w) => w.a === p || w.b === p);
  const capRegion = (p: number, t: number) => pm.settlements[capitalAt(pm.polities[p], t)].region;
  /** 最近一次换国都的年份(没换过 = −Infinity) */
  const lastMove = (p: Polity) => {
    const c = p.capitals!;
    return c.length > 1 ? c[c.length - 1].year : -Infinity;
  };
  /** 最近一次改朝换代的年份(没有 = −Infinity) */
  const lastDynasty = (p: Polity) => {
    const d = p.dynasties;
    return d && d.length > 1 ? d[d.length - 1].year : -Infinity;
  };
  /** CRISIS_YEARS 年内在战争里丢了几州 */
  const lostRecently = (p: number, t: number) => {
    let n = 0;
    for (const w of wm.wars) {
      if (!w || (w.a !== p && w.b !== p) || (w.end !== undefined && t - w.end >= CRISIS_YEARS)) continue;
      for (const e of w.takes) if (e.by !== p && t - e.year < CRISIS_YEARS) n++;
    }
    return n;
  };
  const settled = (r: number, t: number) => t - wm.since[r] >= SETTLE;
  /** 国家 p 现在的国土(州号升序;复制一份,分出去、并掉时原表会变) */
  const regionsOf = (p: number): number[] => pm.lands[p].slice();

  // 草稿数组(每个引擎一份)
  const dis = new Float64Array(R);
  const inG = new Int32Array(R);
  let gStamp = 0;
  const core0 = new Uint8Array(R);
  const reach = new Int32Array(R);
  let rStamp = 0;
  const queue = new Int32Array(R);
  const hops = new Int32Array(R);

  /**
   * 州组 group(已按 inG[州] === gStamp 标好)从 pid 分出去以后,pid 剩下的国土里和国都断开的碎块(分之前连着)也并进来。
   * 返回并进来之后的州组(升序);碎块太大(超过 cap)、或者碎块里有 SETTLE 年内换过国家的州 = null
   */
  const withCutOff = (pid: number, group: number[], t: number, cap: number): number[] | null => {
    const P = pm.polities[pid];
    const { seen, stamp } = coreOf(pm, owner, pid, t);
    for (let r = 0; r < R; r++) core0[r] = owner[r] === pid && seen[r] === stamp ? 1 : 0;
    const capR = capRegion(pid, t);
    rStamp++;
    let qt = 0;
    queue[qt++] = capR;
    reach[capR] = rStamp;
    for (let h = 0; h < qt; h++) {
      const r = queue[h];
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (reach[j] === rStamp || owner[j] !== pid || inG[j] === gStamp || !canCross(P, reg.adjKind[k])) continue;
        reach[j] = rStamp;
        queue[qt++] = j;
      }
    }
    const out = group.slice();
    for (let r = 0; r < R; r++) {
      if (core0[r] && reach[r] !== rStamp && inG[r] !== gStamp) {
        // 碎块里有刚换过国家的州:这次不分(不让一州 50 年内易手 3 次);有永久划给它的州(阶段 4 干预)也不分
        if (!settled(r, t) || wm.iv?.locked(r, t)) return null;
        inG[r] = gStamp;
        out.push(r);
      }
    }
    if (out.length > cap) return null;
    return out.sort((a, b) => a - b);
  };

  /** 州组里人口最多的城(没有城 = −1) */
  const biggestCity = (group: number[], t: number): number => {
    let sid = -1;
    let best = -1;
    for (const r of group) {
      const c = pm.cityOf[r];
      if (c < 0) continue;
      const pop = populationAt(pm.settlements[c], t);
      if (pop > best) {
        best = pop;
        sid = c;
      }
    }
    return sid;
  };

  /** 州组从 parent 分出去,立新国(国都 sid),记一条 split(起事的州 = rising)。返回新国家 */
  const secede = (parent: number, group: number[], sid: number, rising: number, t: number, extra: Partial<Polity>): Polity => {
    const capR = pm.settlements[sid].region;
    const p = addPolity(pm, sid, culture[capR], t, { parent, ...extra });
    sim.setOwner(Layer.Polity, capR, p.id, Ev.Split);
    for (const r of group) if (r !== capR) sim.setOwner(Layer.Polity, r, p.id, Ev.Split);
    sim.record('split', { a: p.id, b: parent, region: rising, settlement: sid });
    pol.lastSplit.set(parent, t);
    return p;
  };

  // ---- ① 分裂 ----
  const canSplit = (P: Polity, t: number) =>
    pm.size[P.id] >= SPLIT_MIN_SIZE &&
    t - P.founded >= SPLIT_AGE &&
    t - (pol.lastSplit.get(P.id) ?? -Infinity) >= SPLIT_REST &&
    !wm.iv?.unites(P.id, t); // 阶段 4 干预"禁止分裂"
  const trySplit = (P: Polity, k: number, t: number, mine: readonly number[]): boolean => {
    const pid = P.id;
    const N = pm.size[pid];
    const capR = capRegion(pid, t);
    const dist = pm.capDist[pid];
    // 动荡(整个国家)
    let g = SIZE_D * Math.max(0, flog(N / SPLIT_MIN_SIZE));
    if (t - lastMove(P) < CRISIS_YEARS) g += CRISIS_CAPITAL;
    if (t - lastDynasty(P) < DYNASTY_YEARS) g += CRISIS_DYNASTY;
    if (atWar(pid)) g += CRISIS_WAR;
    g += CRISIS_LOSS * Math.min(1, lostRecently(pid, t) / 6);
    // 各州的离心力;挑起事的州
    let r0 = -1;
    let s0 = -Infinity;
    for (const r of mine) {
      if (r === capR) continue;
      let d = Math.min(4, dist[r] / SPLIT_REACH); // 走不到国都(Infinity)的州按 4 算
      if (culture[r] !== P.culture) d += FOREIGN_D;
      const age = t - wm.since[r];
      if (wm.prev[r] >= 0 && wm.prev[r] !== pid && age < RECENT) d += RECENT_D * (1 - age / RECENT);
      dis[r] = d;
      if (!settled(r, t) || wm.iv?.locked(r, t)) continue; // 阶段 4 干预:永久划给它的州不起兵
      const s = d + RISE_JITTER * keyed4(pol.base, pm.ptag[pid], reg.seat[r], k, U_RISE);
      if (s > s0) {
        s0 = s;
        r0 = r;
      }
    }
    if (r0 < 0) return false;
    const d0 = dis[r0];
    const odds = SPLIT_ODDS * fexp(SPLIT_K * (d0 + g - SPLIT_D0));
    if (keyed(pol.base, pm.ptag[pid], k, U_SPLIT) >= odds / (1 + odds)) return false;
    // 从起事的州往外长:离心力大的先并进来,只走陆路(国土成片)
    const limit = Math.min(SPLIT_MAX_GROUP, Math.max(SPLIT_MIN_GROUP, Math.floor(N * SPLIT_FRAC)));
    const thr = Math.max(GROUP_MIN_D, d0 - GROUP_DROP);
    // 先挑:离心力大的、和起事的州同族的、离起事的州近的(每隔一州扣 GROUP_COMPACT:国土成团,不沿着边远一圈拉成长条)
    const stamp = ++gStamp;
    const heap = new MinHeap(32);
    const group: number[] = [];
    const cu0 = culture[r0];
    inG[r0] = stamp;
    hops[r0] = 0;
    heap.push(r0, -d0);
    while (heap.size && group.length < limit) {
      const r = heap.pop();
      group.push(r);
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const j = reg.adj[e];
        const kind = reg.adjKind[e];
        if (kind === AdjKind.Strait || kind === AdjKind.SeaRoute) continue;
        if (inG[j] === stamp || owner[j] !== pid || j === capR || !settled(j, t) || dis[j] < thr || wm.iv?.locked(j, t)) continue;
        inG[j] = stamp;
        hops[j] = hops[r] + 1;
        heap.push(j, -(dis[j] + (culture[j] === cu0 ? GROUP_KIN : 0) - GROUP_COMPACT * hops[j]));
      }
    }
    // 没挑上的候选撤掉标记
    while (heap.size) inG[heap.pop()] = 0;
    if (group.length < SPLIT_MIN_GROUP) return false;
    // 新国都 = 起兵的这些州里人口最多的城(不挑后来并进来的碎块)
    const sid = biggestCity(group, t);
    if (sid < 0) return false;
    const full = withCutOff(pid, group, t, Math.ceil(limit * 1.5) + 2);
    if (!full) return false;
    // 新国都是某个同族亡国的故都:这一次起兵就是复国
    const f = heirOf(sid, t);
    secede(pid, full, sid, r0, t, f ? { restores: f.id, lineage: f.lineage } : {});
    if (f) pol.restored.add(f.id);
    return true;
  };

  /** 城 sid 当过哪个(还能复国的)同族亡国的国都:有几个取最近亡的;没有 = null */
  const heirOf = (sid: number, t: number): Polity | null => {
    const cu = culture[pm.settlements[sid].region];
    let best: Polity | null = null;
    for (const F of pm.polities) {
      if (F.ended === undefined || F.ended > t || F.culture !== cu || !restorable(pol, F)) continue;
      if (!F.capitals!.some((c) => c.settlement === sid)) continue;
      if (!best || F.ended! > best.ended! || (F.ended === best.ended && F.id > best.id)) best = F;
    }
    return best;
  };

  // ---- ② 合并 ----
  const canMerge = (B: Polity, t: number) =>
    pm.size[B.id] <= MERGE_SMALL &&
    pm.size[B.id] > 0 &&
    t - B.founded >= MERGE_AGE &&
    !atWar(B.id) &&
    !wm.iv?.protects(B.id, t) && // 阶段 4 干预"不许灭"
    !wm.iv?.holdsLock(B.id, t); // 阶段 4 干预:手里有永久划给它的州
  const tryMerge = (B: Polity, k: number, t: number, mine: readonly number[]): boolean => {
    const bid = B.id;
    const nB = pm.size[bid];
    // 接壤的同族大国(陆上相邻;海洋国家隔着海峡、航线也算:它的国土本来就能跨海)
    let A = -1;
    for (const r of mine) {
      if (!settled(r, t)) return false;
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const o = owner[reg.adj[e]];
        if (o < 0 || o === bid || o === A) continue;
        const O = pm.polities[o];
        if (O.culture !== B.culture || O.ended !== undefined || pm.size[o] < MERGE_RATIO * nB) continue;
        if (wm.iv?.halted(o, t)) continue; // 阶段 4 干预"不许扩张":不并别国
        if (!canCross(O, reg.adjKind[e])) continue;
        if (A < 0 || pm.size[o] > pm.size[A] || (pm.size[o] === pm.size[A] && o < A)) A = o;
      }
    }
    if (A < 0 || atWar(A)) return false;
    const odds = MERGE_ODDS * Math.sqrt(pm.size[A] / (MERGE_RATIO * nB));
    if (keyed(pol.base, pm.ptag[bid], k, U_MERGE) >= odds / (1 + odds)) return false;
    for (const r of mine) sim.setOwner(Layer.Polity, r, A, Ev.Merge);
    endPolity(pm, bid, t);
    pol.merged.add(bid);
    sim.record('merge', { a: A, b: bid });
    return true;
  };

  // ---- ③ 主动迁都 ----
  /** 主动迁都隔一次看一次(第偶数次看内政时):不用那么勤 */
  const canMove = (P: Polity, k: number, t: number) =>
    k % 2 === 0 && pm.size[P.id] >= CAPMOVE_MIN && t - P.founded >= CAPMOVE_AGE && t - lastMove(P) >= CAPMOVE_REST;
  const tryMove = (P: Polity, k: number, t: number, mine: readonly number[]): boolean => {
    const pid = P.id;
    const capR = capRegion(pid, t);
    const { geo } = pol;
    const seat = reg.seat;
    // 前线:离正在交战的敌国不到两州(本州或邻州挨着敌国)
    const enemies = new Set<number>();
    for (const w of wm.active) {
      if (w.a === pid) enemies.add(w.b);
      else if (w.b === pid) enemies.add(w.a);
    }
    const touchesEnemy = (r: number) => {
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) if (enemies.has(owner[reg.adj[e]])) return true;
      return false;
    };
    const frontline = (r: number) => {
      if (!enemies.size) return false;
      if (touchesEnemy(r)) return true;
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) if (owner[reg.adj[e]] === pid && touchesEnemy(reg.adj[e])) return true;
      return false;
    };
    // 国土重心、各州离某处的平均距离(按人口上限加权;只算和国都连成一片的国土)
    let core: readonly number[] = mine;
    let W = 0;
    let cx = 0;
    let cy = 0;
    const cpt = [0, 0];
    const seatOf = (r: number) => seat[r];
    const weightOf = (r: number) => Math.max(1e-3, reg.capacity[r]);
    const centroid = () => {
      W = geo.centroid(core, seatOf, weightOf, cpt);
      cx = cpt[0];
      cy = cpt[1];
    };
    /** 各州治所离某处(世界坐标点 / 某州治所)的平均距离 */
    const meanDistTo = (x: number, y: number) => {
      let sum = 0;
      for (const r of core) sum += Math.max(1e-3, reg.capacity[r]) * geo.distTo(seat[r], x, y);
      return sum / W;
    };
    const meanDistFrom = (c: number) => {
      let sum = 0;
      for (const r of core) sum += Math.max(1e-3, reg.capacity[r]) * geo.dist(seat[r], c);
      return sum / W;
    };
    // 粗筛(先按全部国土算):国都不是前线、离国土各处也不比国土重心远多少,就不用往下挑了
    centroid();
    const front = frontline(capR);
    if (!front && meanDistFrom(seat[capR]) < ECC_PRE * meanDistTo(cx, cy)) return false;
    const { seen, stamp } = coreOf(pm, owner, pid, t);
    core = mine.filter((r) => seen[r] === stamp);
    centroid();
    if (!(W > 0)) return false;
    const gCur = meanDistFrom(seat[capR]);
    // 候选:国土中部人口多的城(按"人口 × 离国土重心远近"挑前 CAPMOVE_TOP 座,再挑其中各州离它平均最近的)
    const L = CENTER_L * pol.unit;
    const capPop = populationAt(pm.settlements[capitalAt(P, t)], t);
    const top: [number, number][] = [];
    for (const r of core) {
      if (r === capR || pm.cityOf[r] < 0 || !settled(r, t) || frontline(r)) continue;
      const pop = populationAt(pm.settlements[pm.cityOf[r]], t);
      if (pop < CAPMOVE_POP * capPop) continue;
      top.push([r, pop * fexp(-geo.distTo(seat[r], cx, cy) / L)]);
    }
    if (!top.length) return false;
    top.sort((u, v) => v[1] - u[1] || reg.seat[u[0]] - reg.seat[v[0]]);
    top.length = Math.min(top.length, CAPMOVE_TOP);
    let best = -1;
    let gNew = Infinity;
    for (const [r] of top) {
      const g2 = meanDistFrom(seat[r]);
      if (g2 < gNew) {
        gNew = g2;
        best = r;
      }
    }
    const sid = pm.cityOf[best];
    const eccentric = gCur >= ECC_RATIO * gNew;
    if (!eccentric && !(front && gNew <= FRONT_RATIO * gCur)) return false;
    if (keyed(pol.base, pm.ptag[pid], k, U_MOVE) >= CAPMOVE_P) return false;
    moveCapital(pm, pid, sid, t);
    sim.record('capital', { a: pid, region: best, settlement: sid });
    return true;
  };

  sim.on(Ev.PoliticsCheck, (k, p, t) => {
    const P = pm.polities[p];
    if (!P || P.ended !== undefined) return;
    sim.schedule(checkTime(pol, p, k + 1), Ev.PoliticsCheck, k + 1, p);
    const split = canSplit(P, t);
    const merge = canMerge(P, t);
    const move = canMove(P, k, t);
    if (!split && !merge && !move) return;
    const mine = regionsOf(p);
    if (split && trySplit(P, k, t, mine)) return;
    if (merge && tryMerge(P, k, t, mine)) return;
    if (move) tryMove(P, k, t, mine);
  });

  // ---- 复国 ----
  const tryRestore = (F: Polity, k: number, t: number): boolean => {
    const fid = F.id;
    // 故国的历任国都(新的在前),挑复国机会最大的那一处
    let c = -1;
    let bestOdds = 0;
    const seenR = new Set<number>();
    const caps = F.capitals!;
    for (let i = caps.length - 1; i >= 0; i--) {
      const r = pm.settlements[caps[i].settlement].region;
      if (seenR.has(r)) continue;
      seenR.add(r);
      const o = owner[r];
      if (culture[r] !== F.culture || o < 0 || o === fid || !settled(r, t) || wm.iv?.locked(r, t)) continue;
      const O = pm.polities[o];
      if (O.ended !== undefined || pm.size[o] < RESTORE_MIN_OWNER || capRegion(o, t) === r) continue;
      if (wm.iv?.unites(o, t)) continue; // 阶段 4 干预"禁止分裂":遗民不会从它的国土里起兵
      let weak = 1;
      if (atWar(o)) weak += W_WAR;
      if (t - (pol.lastSplit.get(o) ?? -Infinity) < RECENT_SPLIT) weak += W_SPLIT;
      if (t - lastMove(O) < CRISIS_YEARS) weak += W_CAP;
      weak += W_LOSS * Math.min(1, lostRecently(o, t) / 4);
      const foreign = O.culture !== F.culture ? RESTORE_FOREIGN : 1;
      const far = fexp(Math.min(3, pm.capDist[o][r] / SPLIT_REACH) - 1);
      const odds = RESTORE_ODDS * weak * foreign * far;
      if (odds > bestOdds) {
        bestOdds = odds;
        c = r;
      }
    }
    if (c < 0 || keyed(pol.base, pm.ptag[fid], k, U_RESTORE) >= bestOdds / (1 + bestOdds)) return false;
    const o = owner[c];
    // 以故都为中心,连同周围的同族州(由近及远,只走陆路)
    const limit = Math.min(RESTORE_MAX_GROUP, Math.max(RESTORE_MIN_GROUP, Math.floor(pm.size[o] * RESTORE_FRAC)));
    const oCap = capRegion(o, t);
    const stamp = ++gStamp;
    const heap = new MinHeap(32);
    const d = dis; // 借用:到故都的路程(inG[州] === stamp 的才有效)
    const touched: number[] = [c];
    const chosen = new Set<number>();
    const group: number[] = [];
    inG[c] = stamp;
    d[c] = 0;
    heap.push(c, 0);
    while (heap.size && group.length < limit) {
      const r = heap.pop();
      if (chosen.has(r) || heap.lastPri > d[r]) continue;
      chosen.add(r);
      group.push(r);
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const j = reg.adj[e];
        const kind = reg.adjKind[e];
        if (kind === AdjKind.Strait || kind === AdjKind.SeaRoute || chosen.has(j)) continue;
        if (owner[j] !== o || j === oCap || culture[j] !== F.culture || !settled(j, t) || wm.iv?.locked(j, t)) continue;
        const nd = d[r] + reg.adjLen[e] / T.refLen;
        if (inG[j] === stamp && nd >= d[j]) continue;
        if (inG[j] !== stamp) touched.push(j);
        inG[j] = stamp;
        d[j] = nd;
        heap.push(j, nd);
      }
    }
    // 没挑上的撤掉标记(withCutOff 按 inG 认州组)
    for (const r of touched) if (!chosen.has(r)) inG[r] = 0;
    if (group.length < RESTORE_MIN_GROUP) return false;
    const sid = biggestCity(group, t);
    if (sid < 0) return false;
    const full = withCutOff(o, group, t, Math.ceil(limit * 1.5) + 2);
    if (!full) return false;
    secede(o, full, sid, c, t, { restores: fid, lineage: F.lineage });
    pol.restored.add(fid);
    return true;
  };

  sim.on(Ev.RestoreCheck, (k, f, t) => {
    const F = pm.polities[f];
    if (!F || F.ended === undefined || !restorable(pol, F)) return;
    if (tryRestore(F, k, t)) return;
    if (k + 1 < RESTORE_TRIES) sim.schedule(restoreTime(pol, f, F.ended, k + 1), Ev.RestoreCheck, k + 1, f);
  });

  // ---- 部落地带补立国 ----
  sim.on(Ev.TribalCheck, (k, _b, t) => {
    sim.schedule(tribalTime(pol, k + 1), Ev.TribalCheck, k + 1, 0);
    for (const s of pm.settlements) {
      const r = s.region;
      if (s.capitalFrom !== undefined || s.ended !== undefined || owner[r] >= 0 || culture[r] < 0 || pm.near[r] > 0) continue;
      // 自己的"立国"事件已经处理过(当时没立成);同一刻的还在排队,不重复预约
      if (!(quantize(foundingYear(s)) < t)) continue;
      sim.schedule(t, Ev.PolityFound, r, s.id);
    }
  });
}

/**
 * 由 Civ 重建分合的推演状态(CivSim.fromCiv 调用,在 resumeWars 之后):
 * 最近一次分裂、被并掉的国家从史事里读,复过国的亡国从国家表里读;
 * 再按"国家 + 第几次"算出还没到的看内政、看复国、看部落地带,补进引擎。
 */
export function resumePolitics(sim: CivSim, world: World, civ: Civ): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  if (!pm || !wm) return;
  const pol = newModel(pm, wm, world);
  for (const e of civ.annals) {
    if (e.kind === 'split') pol.lastSplit.set(e.b, e.year);
    else if (e.kind === 'merge') pol.merged.add(e.b);
  }
  for (const p of pm.polities) if (p.restores !== undefined) pol.restored.add(p.restores);
  hook(sim, pol);

  const now = sim.now;
  for (const p of pm.polities) {
    if (p.ended === undefined) {
      let k = 0;
      while (quantize(checkTime(pol, p.id, k)) <= now) k++;
      sim.schedule(checkTime(pol, p.id, k), Ev.PoliticsCheck, k, p.id);
    } else if (restorable(pol, p)) {
      let k = 0;
      while (k < RESTORE_TRIES && quantize(restoreTime(pol, p.id, p.ended, k)) <= now) k++;
      if (k < RESTORE_TRIES) sim.schedule(restoreTime(pol, p.id, p.ended, k), Ev.RestoreCheck, k, p.id);
    }
  }
  let k = 0;
  while (quantize(tribalTime(pol, k)) <= now) k++;
  sim.schedule(tribalTime(pol, k), Ev.TribalCheck, k, 0);
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、stress.ts、单测用)

export interface PoliticsStats {
  /** 先后立过的国家(含分裂 / 复国出来的) */
  polities: number;
  /** 分裂 / 独立(不含复国)、复国、合并、主动迁都(国都失守的迁都不算)的次数 */
  splits: number;
  restorations: number;
  merges: number;
  capitalMoves: number;
  /** 分裂 / 复国出来、不到 100 年就亡了(或被并掉)的国家 */
  shortLived: number;
}

export function politicsStats(civ: Civ): PoliticsStats {
  const A = civ.annals;
  let splits = 0;
  let restorations = 0;
  let merges = 0;
  let capitalMoves = 0;
  A.forEach((e, i) => {
    if (e.kind === 'split') {
      if (civ.polities[e.a]?.restores !== undefined) restorations++;
      else splits++;
    } else if (e.kind === 'merge') merges++;
    else if (e.kind === 'capital') {
      // 国都失守的迁都紧跟在那条攻占后面(同一刻、丢国都的是这一国)
      const prev = A[i - 1];
      if (!(prev && prev.kind === 'conquer' && prev.b === e.a && prev.year === e.year)) capitalMoves++;
    }
  });
  const shortLived = civ.polities.filter((p) => p.parent !== undefined && p.ended !== undefined && p.ended - p.founded < 100).length;
  return { polities: civ.polities.length, splits, restorations, merges, capitalMoves, shortLived };
}
