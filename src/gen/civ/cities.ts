/**
 * 城市兴衰(阶段 3):城会在战火里被洗劫、被毁;毁掉的地方过些年可能重建;国都迁走 / 国家亡了以后旧都慢慢衰落。
 * 挂在同一个推演引擎(sim.ts)上;不改归属,只改城镇表(Settlement 的 sacks / ended / capitalSpans,新城 rebuilds)、记史事。
 * 人口怎么随这些变,见 growth.ts 的 populationAt(按年份段现算,不存每年的人口)。
 *
 * 流程(index.ts 在 installDynasty 之后调用 installCities):
 *
 *   攻城(wars.ts 的 WarModel.onAssault):战役里攻下一州(攻方打下来、守方反攻夺回;议和割让、亡国残部不算),州里有城:
 *     先掷"毁城":机会 = RUIN_P × 破坏系数 × 城的大小(RUIN_RANK:村镇好毁、大城难毁)× 国都 CAPITAL_RUIN × RUIN_AGAIN^(这场战争里已经毁了几座);
 *     没毁再掷"洗劫":机会 = SACK_P × 破坏系数 × 国都 CAPITAL_SACK(国都被攻破更容易被洗劫)× 刚被洗劫过的 SACK_AGAIN。
 *     破坏系数 = 攻方是游牧国家 NOMAD × 攻异族 FOREIGN / 同族 KIN × 久攻不下(攻方在这场战争里多年没拿下一州)× 破坏更重的战争 BRUTAL
 *     (每场战争有 BRUTAL_P 的机会是破坏更重的一场,按攻守双方 + 宣战时刻取随机)。
 *     洗劫:人口折损 LOSS 里随机的几成(破坏更重的战争、攻方是游牧国家时再多 LOSS_HARSH),之后慢慢恢复(Settlement.sacks)。
 *     毁城:Settlement.ended = 这一年,州里没有城了(PolityModel.cityOf = −1:建城、立国、分裂、迁都挑城时都跳过它);
 *     被毁的是国都 —— 攻下来的本来就是守方的国都,wars.ts 接着照常迁都(或亡国)。
 *     洗劫、毁城记在那条攻占的前面(同一刻;编年史里排回攻占后面)。
 *   看重建(Ev.CityRebuild)城被毁后 REBUILD_FIRST 年起,每 REBUILD_EVERY 年看一次(一共看的次数按城随机,REBUILD_TRIES):
 *     州里有人住、REBUILD_SETTLE 年没换过国家(战火已息),就有机会在故址上重建(城址越好机会越大);看完都没建 = 就此荒废。
 *     重建的是一座新城(新编号、同一地块,Settlement.rebuilds = 旧城),从村子长起、长得比一般的城快(REBUILD_GROWTH);
 *     同族重建沿用旧名,换了民族另起新名(naming.ts)。
 *   看旧都(Ev.CityDecline)国都失去国都之位(迁都、亡国、被并)后约 DECLINE_NOTE 年:国都加成在 CAPITAL_DECLINE 年里渐渐退掉
 *     (growth.ts),这时人口比失去国都之位时少了 DECLINE_RATIO 以上、当年又是"城"以上的,记一条"旧都渐衰"。
 *     其间又做了国都、或者被毁了的不记。
 *
 * **不存内存状态**:这场战争毁了几座城 = 史事里带战争编号的 ruin;哪些城毁了还没重建 = 城镇表(ended、rebuilds);
 *   哪些旧都还没到"看旧都"的时候 = Settlement.capitalSpans;看重建、看旧都的时刻都由"城 + 第几次"算出来(resumeCities)。
 *
 * 随机数:keyed(subSeed(seed, 'civ-city'), 城…, 时刻 / 第几次, 用途),和处理顺序无关。
 * 城、国家用位置锚(PolityModel.stag / ptag,见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { Layer, type Civ, type Settlement, type Year } from './types';
import { fexp, fpow, keyed, keyed4, subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { foundCity, onCapitalLost, polityModelOf, type PolityModel } from './polities';
import { warModelOf, type War, type WarModel } from './wars';
import { SETTLEMENT_RANKS, populationAt, ruinRank, ruinSites, settlementRank } from './growth';

// ---- 调参(以统计数和截图为准,见 scripts/gen-stats.ts) ----
/** 攻下一州时城被洗劫、被毁的基础机会 */
const SACK_P = 0.1;
const RUIN_P = 0.055;
/** 机会的上限 */
const P_MAX = 0.75;
/** 破坏系数:攻方是游牧国家;攻异族的城 / 同族的城 */
const NOMAD = 2.2;
const FOREIGN = 1.4;
const KIN = 0.55;
/** 久攻不下:攻方在这场战争里连着 SIEGE_FROM 年以上没拿下一州,之后每多 SIEGE_YEARS 年 × e(最多 SIEGE_MAX 倍) */
const SIEGE_FROM = 6;
const SIEGE_YEARS = 10;
const SIEGE_MAX = 2.5;
/** 破坏更重的战争:每场战争有 BRUTAL_P 的机会是;洗劫、毁城的机会 × BRUTAL */
const BRUTAL_P = 0.15;
const BRUTAL = 2.5;
/** 国都被攻破:洗劫 × CAPITAL_SACK;毁 × CAPITAL_RUIN */
const CAPITAL_SACK = 3;
const CAPITAL_RUIN = 1.5;
/** 城越大越难毁(按被攻下时的级别:村、镇、城、大城) */
const RUIN_RANK = [1.3, 1, 0.7, 0.5];
/** 同一场战争里每毁一座城,再毁的机会 × RUIN_AGAIN(不要打一次仗毁一片) */
const RUIN_AGAIN = 0.2;
/** 刚被洗劫过(SACK_REST 年内)的城没什么可抢的:洗劫的机会 × SACK_AGAIN */
const SACK_REST = 40;
const SACK_AGAIN = 0.3;
/** 洗劫的人口折损(随机,含两头);破坏更重的战争、攻方是游牧国家时再多几成 */
const LOSS: [number, number] = [0.3, 0.6];
const LOSS_HARSH = 0.15;

/** 重建:毁后多少年开始看、每隔多少年看一次(每段里随机一个时刻)、一共看几次(按城随机,含两头) */
const REBUILD_FIRST = 25;
const REBUILD_EVERY = 45;
const REBUILD_TRIES: [number, number] = [1, 7];
/** 每次看的机会 = REBUILD_P × 城址好坏(√(人口上限 ÷ SITE_REF),夹在 0.5–1.5) */
const REBUILD_P = 0.18;
const SITE_REF = 30;
/** 这么多年里换过国家的州(战火未息)先不重建 */
const REBUILD_SETTLE = 15;
/** 重建的城长得比一般的城快这么多倍(故址上重建,人口回流) */
export const REBUILD_GROWTH = 2.5;

/** 看旧都:失去国都之位后这么多年(再加 0–DECLINE_JITTER 年随机)看一次 */
const DECLINE_NOTE = 110;
const DECLINE_JITTER = 20;
/** 人口不到失去国都之位时的这么多、当时至少是"城"(千人),记"旧都渐衰" */
const DECLINE_RATIO = 0.85;
const DECLINE_MIN_POP = SETTLEMENT_RANKS[2].min;

// 随机数用途编号
const U_RUIN = 1;
const U_SACK = 2;
const U_LOSS = 3;
const U_BRUTAL = 4;
const U_REBUILD_T = 5;
const U_REBUILD = 6;
const U_TRIES = 7;
const U_DECLINE_T = 8;

// ---------------------------------------------------------------------------
// 模型

export interface CityModel {
  pm: PolityModel;
  wm: WarModel;
  base: number;
  /** 战争编号 → 这场战争里毁了几座城 */
  razed: Map<number, number>;
}

const models = new WeakMap<CivSim, CityModel>();

/** 推演引擎上挂着的城市兴衰模型(测试、统计用) */
export function cityModelOf(sim: CivSim): CityModel | undefined {
  return models.get(sim);
}

/** 破坏更重的战争(按攻守双方 + 宣战时刻取随机,和战争编号无关) */
function brutalWar(cm: CityModel, w: War): boolean {
  return keyed4(cm.base, cm.pm.ptag[w.a], cm.pm.ptag[w.b], Math.round(w.start * 256), U_BRUTAL) < BRUTAL_P;
}

/** 被毁的城一共看几次重建 */
function rebuildTries(cm: CityModel, s: Settlement): number {
  return REBUILD_TRIES[0] + Math.floor((REBUILD_TRIES[1] - REBUILD_TRIES[0] + 1) * keyed(cm.base, cm.pm.stag[s.id], 0, U_TRIES));
}

/** 被毁的城 s 第 k 次看重建的时刻 */
function rebuildTime(cm: CityModel, s: Settlement, k: number): number {
  return s.ended! + REBUILD_FIRST + REBUILD_EVERY * (k + 0.2 + 0.6 * keyed(cm.base, cm.pm.stag[s.id], k, U_REBUILD_T));
}

/** 城 s 的第 k 段国都结束(until)后看旧都的时刻 */
function declineTime(cm: CityModel, s: Settlement, k: number, until: Year): number {
  return until + DECLINE_NOTE + DECLINE_JITTER * keyed(cm.base, cm.pm.stag[s.id], k, U_DECLINE_T);
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记城市兴衰的事件处理(installDynasty 之后调用) */
export function installCities(sim: CivSim, pm: PolityModel, wm: WarModel, cm: CityModel = newModel(pm, wm)): CityModel {
  models.set(sim, cm);
  const culture = sim.owners[Layer.Culture];
  const owner = sim.owners[Layer.Polity];
  const base = cm.base;

  // ---- 攻城:洗劫 / 毁城 ----
  wm.onAssault = (w, x, y, r, sid, t, capital) => {
    const s = pm.settlements[sid];
    if (!s || s.ended !== undefined) return;
    const X = pm.polities[x];
    const nomad = X.kind === 'nomad';
    const brutal = brutalWar(cm, w);
    let harsh = (nomad ? NOMAD : 1) * (culture[r] === X.culture ? KIN : FOREIGN) * (brutal ? BRUTAL : 1);
    // 久攻不下:攻方在这场战争里上一次拿下一州(或宣战)以来的年数
    let last = w.start;
    for (const e of w.takes) if (e.by === x && e.year > last) last = e.year;
    if (t - last > SIEGE_FROM) harsh *= Math.min(SIEGE_MAX, fexp((t - last - SIEGE_FROM) / SIEGE_YEARS));
    const tick = Math.round(t * 256);
    const rank = settlementRank(populationAt(s, t));
    const razed = cm.razed.get(w.id) ?? 0;
    const pRuin = Math.min(P_MAX, RUIN_P * harsh * RUIN_RANK[rank] * (capital ? CAPITAL_RUIN : 1) * fpow(RUIN_AGAIN, razed));
    const tag = pm.stag[sid];
    if (keyed(base, tag, tick, U_RUIN) < pRuin) {
      s.ended = t;
      pm.cityOf[r] = -1;
      cm.razed.set(w.id, razed + 1);
      sim.record('ruin', { a: x, b: y, region: r, settlement: sid, war: w.id });
      if (rebuildTries(cm, s) > 0) sim.schedule(rebuildTime(cm, s, 0), Ev.CityRebuild, 0, sid);
      return;
    }
    const sk = s.sacks;
    const recent = !!sk && sk.length > 0 && t - sk[sk.length - 1].year < SACK_REST;
    const pSack = Math.min(P_MAX, SACK_P * harsh * (capital ? CAPITAL_SACK : 1) * (recent ? SACK_AGAIN : 1));
    if (keyed(base, tag, tick, U_SACK) < pSack) {
      const loss = LOSS[0] + (LOSS[1] - LOSS[0]) * keyed(base, tag, tick, U_LOSS) + (brutal || nomad ? LOSS_HARSH : 0);
      (s.sacks ??= []).push({ year: t, loss: Math.round(loss * 1000) / 1000 });
      sim.record('sack', { a: x, b: y, region: r, settlement: sid, war: w.id });
    }
  };

  // ---- 看重建 ----
  sim.on(Ev.CityRebuild, (k, sid, t) => {
    const s = pm.settlements[sid];
    if (!s || s.ended === undefined) return;
    const r = s.region;
    if (pm.cityOf[r] >= 0) return; // 州里已经另有城了
    const next = () => {
      if (k + 1 < rebuildTries(cm, s)) sim.schedule(rebuildTime(cm, s, k + 1), Ev.CityRebuild, k + 1, sid);
    };
    const site = Math.min(1.5, Math.max(0.5, Math.sqrt(s.capacity / SITE_REF)));
    if (culture[r] < 0 || t - wm.since[r] < REBUILD_SETTLE || keyed(base, pm.stag[sid], k, U_REBUILD) >= REBUILD_P * site) {
      next();
      return;
    }
    const n = foundCity(sim, pm, r, t, { of: sid, growth: REBUILD_GROWTH });
    sim.record('rebuild', { a: owner[r], region: r, settlement: n.id });
  });

  // ---- 看旧都 ----
  onCapitalLost(pm, (sid, pid, t) => {
    const spans = pm.settlements[sid].capitalSpans;
    const k = spans ? spans.length - 1 : -1;
    if (k < 0 || spans![k].until !== t || spans![k].polity !== pid) return;
    sim.schedule(declineTime(cm, pm.settlements[sid], k, t), Ev.CityDecline, k, sid);
  });
  sim.on(Ev.CityDecline, (k, sid, t) => {
    const s = pm.settlements[sid];
    const spans = s?.capitalSpans;
    if (!s || !spans || k !== spans.length - 1 || s.ended !== undefined) return;
    const sp = spans[k];
    if (sp.until === undefined) return;
    const before = populationAt(s, sp.until);
    if (!(before >= DECLINE_MIN_POP) || !(populationAt(s, t) <= DECLINE_RATIO * before)) return;
    sim.record('decline', { a: sp.polity, region: s.region, settlement: sid });
  });

  return cm;
}

function newModel(pm: PolityModel, wm: WarModel): CityModel {
  return { pm, wm, base: subSeed(pm.seed, 'civ-city'), razed: new Map() };
}

/**
 * 由 Civ 重建城市兴衰的推演状态(CivSim.fromCiv 调用,在 resumeDynasty 之后):
 * 每场战争毁了几座城从史事里读;毁了还没重建的城、没到"看旧都"的旧都从城镇表里读;
 * 再按"城 + 第几次"算出还没到的看重建、看旧都,补进引擎。
 */
export function resumeCities(sim: CivSim, _world: World, civ: Civ): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  if (!pm || !wm) return;
  const cm = newModel(pm, wm);
  for (const e of civ.annals) if (e.kind === 'ruin' && e.war >= 0) cm.razed.set(e.war, (cm.razed.get(e.war) ?? 0) + 1);
  installCities(sim, pm, wm, cm);

  const now = sim.now;
  const rebuilt = new Set<number>();
  for (const s of pm.settlements) if (s.rebuilds !== undefined) rebuilt.add(s.rebuilds);
  for (const s of pm.settlements) {
    // 毁了、还没重建(州里也没有别的城):下一次看重建
    if (s.ended !== undefined && !rebuilt.has(s.id) && pm.cityOf[s.region] < 0) {
      const n = rebuildTries(cm, s);
      let k = 0;
      while (k < n && quantize(rebuildTime(cm, s, k)) <= now) k++;
      if (k < n) sim.schedule(rebuildTime(cm, s, k), Ev.CityRebuild, k, s.id);
    }
    // 失去国都之位、还没到看旧都的时候
    const spans = s.capitalSpans;
    if (spans) {
      spans.forEach((sp, k) => {
        if (sp.until === undefined) return;
        const tt = declineTime(cm, s, k, sp.until);
        if (quantize(tt) > now) sim.schedule(tt, Ev.CityDecline, k, s.id);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、stress.ts、单测用)

export interface CityStats {
  /** 洗劫、毁城、重建、旧都衰落的次数 */
  sacks: number;
  ruins: number;
  rebuilds: number;
  declines: number;
  /** 毁城按被毁前的级别(村、镇、城、大城) */
  ruinsByRank: [number, number, number, number];
  /** 结束时的遗址数(毁了、没重建的城址) */
  ruinsAtEnd: number;
  /** 一场战争最多毁了几座城 */
  maxRuinsPerWar: number;
  /** 旧都衰落的例子(按失去国都之位时的人口从大到小):城、哪年失去国都之位、当时人口、记"渐衰"那年的人口(千人) */
  declineExamples: { settlement: number; year: Year; before: number; after: number; at: Year }[];
}

export function cityStats(civ: Civ): CityStats {
  const A = civ.annals;
  const S = civ.settlements;
  const out: CityStats = {
    sacks: 0,
    ruins: 0,
    rebuilds: 0,
    declines: 0,
    ruinsByRank: [0, 0, 0, 0],
    ruinsAtEnd: 0,
    maxRuinsPerWar: 0,
    declineExamples: [],
  };
  const perWar = new Map<number, number>();
  for (const e of A) {
    if (e.kind === 'sack') out.sacks++;
    else if (e.kind === 'ruin') {
      out.ruins++;
      const s = S[e.settlement];
      if (s) out.ruinsByRank[Math.max(0, ruinRank(s))]++;
      if (e.war >= 0) {
        const n = (perWar.get(e.war) ?? 0) + 1;
        perWar.set(e.war, n);
        out.maxRuinsPerWar = Math.max(out.maxRuinsPerWar, n);
      }
    } else if (e.kind === 'rebuild') out.rebuilds++;
    else if (e.kind === 'decline') {
      out.declines++;
      const s = S[e.settlement];
      const sp = s?.capitalSpans?.filter((x) => x.until !== undefined && x.until <= e.year).pop();
      if (s && sp) out.declineExamples.push({ settlement: s.id, year: sp.until!, before: populationAt(s, sp.until!), after: populationAt(s, e.year), at: e.year });
    }
  }
  out.declineExamples.sort((a, b) => b.before - a.before || a.settlement - b.settlement);
  out.ruinsAtEnd = ruinSites(civ, civ.endYear).length;
  return out;
}
