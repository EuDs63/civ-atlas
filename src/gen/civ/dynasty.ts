/**
 * 王朝更替(阶段 3):国家延续(同一个国家编号、国土、配色都不变),但统治者换了一家。
 * 东方语感的国家改朝换代、换国号("大昌 → 大景",地图上的国名跟着年份变);西幻语感的国家王室更迭,国名不变(换一个"某某王朝")。
 * 挂在同一个推演引擎(sim.ts)上;改朝换代不改归属,只记史事(sim.record('dynasty'))、往 Polity.dynasties 加一条,
 * 新朝定都自己的根据地时迁都(polities.ts 的 moveCapital,不另记 capital)。
 *
 * 流程(index.ts 在 installPolitics 之后调用 installDynasty):
 *
 *   看王朝(Ev.DynastyCheck)每个国家立国 DYN_FIRST 年后,每 DYN_EVERY 年看一眼(每段里随机一个时刻):
 *     只有大国会改朝换代(国号到过第 BIG_TIER 档、眼下国土 ≥ MIN_SIZE 州;当朝已经几百年的中等国家也会换,见 eligible;
 *     海洋城邦共和一系没有王室,不换);当朝至少立了 MIN_AGE 年。
 *     这一次改朝换代的赔率 = ODDS × e^((当朝年数 − AGE_REF) ÷ AGE_SCALE) × 动荡
 *       —— 王朝越老越容易亡(中国史上的"王朝周期",一朝多在一两百年到三四百年之间);
 *       动荡 = 1 + 正在打仗 C_WAR + 这些年战败失地 C_LOSS(按丢的州数,最多加满)+ 国都失守 / 迁都不久 C_CAPITAL
 *              + 刚有边远之地分裂出去 C_SPLIT + 国势衰微(国土缩到国号那一档门槛的 DECLINE 以下)C_DECLINE。
 *   新朝从哪兴起(王室的根据地):本国本族、SETTLE 年没换过国家的有城之州里挑 ——
 *     按"城的人口 ^ POP_EXP × (1 + 离国都越远越大 FAR_W)"随机挑一处(边远的大城多出割据一方的豪强);
 *     国都本身也在候选里(权臣篡位,COURT 倍权重)。
 *   新朝定都:根据地不是国都、根据地的城人口至少是国都的 MOVE_POP、不紧挨着别国的国都(CAP_GAP)、再掷一次 MOVE_P,
 *     就迁都根据地("定都青阳");否则入主旧都。新朝的国号档位照旧(国号只升不降)。
 *   动荡:迁都会让分合(politics.ts)的"动荡"加上迁都那一项,改朝换代本身再加一项(见 politics.ts 的 CRISIS_DYNASTY):
 *     改朝换代之后几十年里,边远之地更容易割据自立。
 *
 * 东方 / 西幻(Polity.eastern)要等推演结束、按民族最终的语感起名时才定(naming.ts),推演里分不出来:
 * 两边的赔率一样(欧洲的王室也是两三百年一换),起名后东方写"改朝换代"(换国号、地图上的国名跟着变),
 * 西幻写"王室更迭"(国名不变;编年史里不算大事)。
 *
 * **不存内存状态**:当朝从哪年起 = Polity.dynasties 的最后一条(没有 = 立国那年);国都 = Polity.capitals;
 *   动荡由战争模型(史事重建)、分合模型(最近一次分裂)现算;看王朝的时刻由"国家 + 第几次"算出来(resumeDynasty)。
 *
 * 随机数:keyed(subSeed(seed, 'civ-dynasty'), 国家…, 第几次, 用途),和处理顺序无关。
 * 国家用位置锚(PolityModel.ptag,见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { Layer, type Civ, type Polity, type Year } from './types';
import { fexp, fpow, keyed, subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { moveCapital, polityModelOf, type PolityModel } from './polities';
import { CAPITAL_GRACE, warModelOf, type WarModel } from './wars';
import { politicsModelOf } from './politics';
import { TIER_REGIONS, capitalAt, populationAt } from './growth';

// ---- 调参(以统计数为准,见 scripts/gen-stats.ts) ----
/** 立国后多少年开始看王朝;之后每隔多少年看一次(每段里 20%–80% 处随机一个时刻) */
const DYN_FIRST = 80;
const DYN_EVERY = 30;
/**
 * 只有大国会改朝换代(不要每个小国都在换):国号到过第 BIG_TIER 档(王国 / 二十五州),眼下国土还有 MIN_SIZE 州。
 * 王朝的"岁数"从当朝开始算(开国的那一朝从立国算:立国几百年才长成大国的,长成之后不久就可能易代)
 */
const BIG_TIER = 2;
const MIN_SIZE = 25;
/**
 * 当朝立了 OLD_AGE 年以上的,国土还有 OLD_SIZE 州也会易代(曾经的大国如今国土缩了、或者几百年一直是十几二十州的中等国家):
 * 不会一朝上千年
 */
export const OLD_AGE = 450;
const OLD_SIZE = 15;
/** 当朝至少立了这么多年(乱世里短命的王朝也有,但不会几年一换) */
export const MIN_AGE = 50;
/** 赔率 = 王朝岁数为 AGE_REF 年时为 ODDS,每多 AGE_SCALE 年 × e */
const ODDS = 0.12;
const AGE_REF = 310;
const AGE_SCALE = 70;
/** 动荡:正在打仗;CRISIS_YEARS 年内战败失地(每丢 LOSS_FULL 州加满 C_LOSS);迁过都;有州分裂出去;国势衰微 */
const CRISIS_YEARS = 50;
const C_WAR = 0.4;
const C_LOSS = 1.5;
const LOSS_FULL = 8;
const C_CAPITAL = 1;
const C_SPLIT = 1;
const RECENT_SPLIT = 60;
const DECLINE = 0.7;
const C_DECLINE = 0.8;
/** 根据地的州要这么多年没换过国家(刚打下来的地方出不了新朝) */
const SETTLE = 30;
/** 挑根据地:城的人口 ^ POP_EXP × (1 + FAR_W × min(FAR_MAX, 离国都的路程 ÷ FAR_REACH));国都(权臣篡位)× COURT */
const POP_EXP = 0.8;
const FAR_W = 0.6;
const FAR_MAX = 3;
const FAR_REACH = 8;
const COURT = 2.5;
/**
 * 新朝定都根据地:根据地的城人口至少是国都的这么多,再掷一次;
 * 根据地离别国的国都不到 CAP_GAP 州(紧挨着别国的都城)就不迁,入主旧都
 */
const CAP_GAP = 3;
const MOVE_POP = 0.2;
const MOVE_P = 0.7;

// 随机数用途编号
const U_CHECK_T = 1;
const U_ROLL = 2;
const U_BASE = 3;
const U_MOVE = 4;

// ---------------------------------------------------------------------------
// 模型

export interface DynastyModel {
  pm: PolityModel;
  wm: WarModel;
  base: number;
}

const models = new WeakMap<CivSim, DynastyModel>();

/** 推演引擎上挂着的王朝模型(测试、统计用) */
export function dynastyModelOf(sim: CivSim): DynastyModel | undefined {
  return models.get(sim);
}

/** 国家 p 第 k 次看王朝的时刻 */
function checkTime(dm: DynastyModel, p: number, k: number): number {
  return dm.pm.polities[p].founded + DYN_FIRST + DYN_EVERY * (k + 0.2 + 0.6 * keyed(dm.base, dm.pm.ptag[p], k, U_CHECK_T));
}

/** 当朝从哪一年起(没改朝换代过 = 立国那年) */
export function dynastyStart(p: Polity): Year {
  const d = p.dynasties;
  return d && d.length ? d[d.length - 1].year : p.founded;
}

/**
 * 这一国现在够不够格改朝换代:国号到过第 BIG_TIER 档(大国;国号只升不降,看现在的档位就行)、眼下还有 MIN_SIZE 州;
 * 当朝已经很老(OLD_AGE)的,到过第 1 档("国")、还有 OLD_SIZE 州就行
 */
function eligible(pm: PolityModel, p: number, age: number): boolean {
  const n = pm.size[p];
  if (age >= OLD_AGE && pm.tier[p] >= 1 && n >= OLD_SIZE) return true;
  return pm.tier[p] >= BIG_TIER && n >= MIN_SIZE;
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记王朝更替的事件处理和监听(installPolitics 之后调用) */
export function installDynasty(sim: CivSim, pm: PolityModel): DynastyModel {
  const wm = warModelOf(sim);
  if (!wm) throw new Error('installDynasty:先 installWars');
  const dm: DynastyModel = { pm, wm, base: subSeed(pm.seed, 'civ-dynasty') };
  hook(sim, dm);
  return dm;
}

function hook(sim: CivSim, dm: DynastyModel): void {
  models.set(sim, dm);
  const { pm, wm } = dm;
  const reg = pm.terrain.regions;
  const culture = sim.owners[Layer.Culture];

  // 新国家(立国、分裂、复国)拿到第一州时预约第一次看王朝
  sim.onChange(Layer.Polity, (_r, v, _prev, cause) => {
    if (v >= 0 && (cause === Ev.PolityFound || cause === Ev.Split) && pm.size[v] === 1) {
      sim.schedule(checkTime(dm, v, 0), Ev.DynastyCheck, 0, v);
    }
  });

  /** 动荡(≥ 1):打仗、战败失地、迁都不久、刚有州分裂出去、国势衰微 */
  const unrest = (P: Polity, t: number): number => {
    const pid = P.id;
    let u = 1;
    let lost = 0;
    for (const w of wm.active) if (w.a === pid || w.b === pid) u += C_WAR;
    for (const w of wm.wars) {
      if (!w || (w.a !== pid && w.b !== pid) || (w.end !== undefined && t - w.end >= CRISIS_YEARS)) continue;
      for (const e of w.takes) if (e.by !== pid && t - e.year < CRISIS_YEARS) lost++;
    }
    u += C_LOSS * Math.min(1, lost / LOSS_FULL);
    // 迁过都(多半是国都失守);当朝自己定都根据地的那次不算
    const caps = P.capitals!;
    const moved = caps.length > 1 ? caps[caps.length - 1].year : -Infinity;
    if (t - moved < CRISIS_YEARS && moved !== dynastyStart(P)) u += C_CAPITAL;
    const split = politicsModelOf(sim)?.lastSplit.get(pid);
    if (split !== undefined && t - split < RECENT_SPLIT) u += C_SPLIT;
    if (pm.size[pid] < DECLINE * TIER_REGIONS[Math.max(0, pm.tier[pid])]) u += C_DECLINE;
    return u;
  };

  /** 州 r 离别国(不是 pid)的国都不到 CAP_GAP 州(按陆上、海上相邻一步一州) */
  const nearForeignCapital = (pid: number, r: number, t: number): boolean => {
    const caps = new Set<number>();
    for (const Q of pm.polities) {
      if (Q.id !== pid && Q.ended === undefined && Q.founded <= t) caps.add(pm.settlements[capitalAt(Q, t)].region);
    }
    let ring = [r];
    const seen = new Set<number>(ring);
    for (let h = 0; h < CAP_GAP && ring.length; h++) {
      const next: number[] = [];
      for (const q of ring) {
        if (caps.has(q)) return true;
        for (let k = reg.adjStart[q]; k < reg.adjStart[q + 1]; k++) {
          const j = reg.adj[k];
          if (!seen.has(j)) {
            seen.add(j);
            next.push(j);
          }
        }
      }
      ring = next;
    }
    return false;
  };

  /** 新朝的根据地(州);挑不出 = −1 */
  const pickBase = (P: Polity, k: number, t: number): number => {
    const pid = P.id;
    const capR = pm.settlements[capitalAt(P, t)].region;
    const dist = pm.capDist[pid];
    let total = 0;
    const cand: number[] = [];
    const wt: number[] = [];
    for (const r of pm.lands[pid]) {
      const c = pm.cityOf[r];
      if (c < 0 || culture[r] !== P.culture || t - wm.since[r] < SETTLE) continue;
      const pop = populationAt(pm.settlements[c], t);
      if (!(pop > 0)) continue;
      const far = r === capR ? COURT : 1 + FAR_W * Math.min(FAR_MAX, (dist[r] < Infinity ? dist[r] : FAR_REACH * FAR_MAX) / FAR_REACH);
      const w = fpow(pop, POP_EXP) * far;
      cand.push(r);
      wt.push(w);
      total += w;
    }
    if (!(total > 0)) return -1;
    let x = keyed(dm.base, pm.ptag[pid], k, U_BASE) * total;
    for (let i = 0; i < cand.length; i++) {
      x -= wt[i];
      if (x < 0) return cand[i];
    }
    return cand[cand.length - 1];
  };

  sim.on(Ev.DynastyCheck, (k, p, t) => {
    const P = pm.polities[p];
    if (!P || P.ended !== undefined) return;
    sim.schedule(checkTime(dm, p, k + 1), Ev.DynastyCheck, k + 1, p);
    if (P.lineage === 'republic') return; // 海洋城邦共和一系没有王室
    // 东方 / 西幻(Polity.eastern)推演结束起名时才定,这里一视同仁:同一件事,起名后东方写"改朝换代",西幻写"王室更迭"
    const age = t - dynastyStart(P);
    if (age < MIN_AGE || !eligible(pm, p, age)) return;
    const odds = ODDS * fexp((age - AGE_REF) / AGE_SCALE) * unrest(P, t);
    if (keyed(dm.base, pm.ptag[p], k, U_ROLL) >= odds / (1 + odds)) return;
    const r = pickBase(P, k, t);
    if (r < 0) return;
    const seat = pm.cityOf[r];
    let sid = capitalAt(P, t);
    const capR = pm.settlements[sid].region;
    // 新朝定都根据地;刚迁过都(CAPITAL_GRACE 年内,多半是国都失守)的不再迁 —— 不会几年里一迁再迁
    if (
      r !== capR &&
      t - pm.capMoved[p] >= CAPITAL_GRACE &&
      populationAt(pm.settlements[seat], t) >= MOVE_POP * populationAt(pm.settlements[sid], t) &&
      keyed(dm.base, pm.ptag[p], k, U_MOVE) < MOVE_P &&
      !nearForeignCapital(p, r, t)
    ) {
      moveCapital(pm, p, seat, t);
      sid = seat;
    }
    if (!P.dynasties) P.dynasties = [{ year: P.founded, name: '', seat: P.capital }];
    P.dynasties.push({ year: t, name: '', seat });
    sim.record('dynasty', { a: p, region: r, settlement: sid });
  });
}

/**
 * 由 Civ 重建王朝更替的推演状态(CivSim.fromCiv 调用,在 resumePolitics 之后):
 * 当朝从哪年起、国都都在国家表里;按"国家 + 第几次"算出还没到的看王朝,补进引擎。
 */
export function resumeDynasty(sim: CivSim, _world: World, _civ: Civ): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  if (!pm || !wm) return;
  const dm: DynastyModel = { pm, wm, base: subSeed(pm.seed, 'civ-dynasty') };
  hook(sim, dm);
  const now = sim.now;
  for (const p of pm.polities) {
    if (p.ended !== undefined) continue;
    let k = 0;
    while (quantize(checkTime(dm, p.id, k)) <= now) k++;
    sim.schedule(checkTime(dm, p.id, k), Ev.DynastyCheck, k, p.id);
  }
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、单测用)

export interface DynastyStats {
  /** 改朝换代(东方)、王室更迭(西幻)的次数 */
  eastern: number;
  western: number;
  /** 已经结束的朝代(被取代的那些)平均立了多少年:东方、西幻(没有 = 0) */
  meanEastern: number;
  meanWestern: number;
  /** 各国的朝代数(只列改朝换代过的国家):国家编号 → 几朝 */
  perPolity: Map<number, number>;
  /** 新朝定都根据地(迁都)的次数 */
  moved: number;
}

export function dynastyStats(civ: Civ): DynastyStats {
  let eastern = 0;
  let western = 0;
  let moved = 0;
  const lenE: number[] = [];
  const lenW: number[] = [];
  const perPolity = new Map<number, number>();
  for (const p of civ.polities) {
    const d = p.dynasties;
    if (!d || d.length < 2) continue;
    perPolity.set(p.id, d.length);
    for (let i = 1; i < d.length; i++) {
      (p.eastern ? lenE : lenW).push(d[i].year - d[i - 1].year);
      if (p.eastern) eastern++;
      else western++;
    }
  }
  for (const e of civ.annals) {
    if (e.kind !== 'dynasty') continue;
    const p = civ.polities[e.a];
    if (p && p.capitals!.some((c) => c.year === e.year && c.settlement === e.settlement) && p.capitals![0].year !== e.year) moved++;
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { eastern, western, meanEastern: mean(lenE), meanWestern: mean(lenW), perPolity, moved };
}
