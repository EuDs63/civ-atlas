/**
 * 战争与攻占:国家之间宣战、攻城略地、议和;国土被占光的国家灭亡,国都失守的国家迁都。
 * 挂在同一个推演引擎(sim.ts)上,改归属一律走 setOwner(原因 = Ev.Conquer),发生了什么记进史事(sim.record)。
 *
 * 流程(index.ts 在 installPolities 之后调用 installWars):
 *
 *   看邻国(Ev.WarCheck)每个国家立国 CHECK_FIRST 年后,每 CHECK_EVERY 年看一眼(每段里随机一个时刻)。
 *     自己没在打仗(帝国级的大国可以两线作战)、上次议和过了 REST 年,就在接壤的邻国里挑一个最"值得打"的:
 *       赔率 = WAR_ODDS × 扩张性 × 边境胜算^LOCAL_EXP × 异族 FOREIGN × 收复失地 × 小国 PREY_ODDS × 边界长短
 *       边境胜算 = 对方边境上各州的胜率(和打仗时一样按局部国力算)的平均,换成"胜率 ÷ 败率":
 *       强国的边远处照样可能打不过近处的小国 —— 被夺去的州过些年又被夺回来,前线有来有回
 *     同一对国家议和后 TRUCE 年内不再开战;对方已经同时在打 MAX_WARS 场仗的不去凑;
 *     分裂 / 复国出来的国家(politics.ts)立国 NEWBORN 年内没人对它宣战(站稳期)。
 *     国力 = 本国城镇人口之和(growth.ts 的 populationAt 现算)。
 *   宣战 → 每隔 GAP 年打一仗(Ev.Campaign):
 *     攻方挑一个**和自己国土接壤**的敌州打(国土保持成片):被自己围得越多的州越先打(前线齐整,不打出飞地),
 *       其次是离敌国国都近的(直取国都)、好走的(翻山、跨河难打);打下来会把敌国切出一大块(> MAX_CUT 州)的先不打。
 *     打不打得下看局部国力:双方国力各按"离本国国都的路程"打折(远征越远越弱),
 *       守方再乘过界难度(翻山 / 跨河 / 渡海)、守国都、守本族的加成;胜率 = 攻² ÷ (攻² + 守²)。
 *     打不下来,守方有 COUNTER 的机会反攻,夺回被攻方占去的州(这场战争里丢的、以前丢的;同样按局部国力)。
 *     一州易手后 HOLD 年内不会再易手:前线有来有回,但不会闪烁。
 *   攻占 → 州归攻方(民族不变,只换国家;城可能被洗劫、被毁,见 cities.ts)。丢的是国都:还有别的州就迁都到剩下人口最多的城
 *     (剩下的国土被切成几块时,在人口最多的那一块里挑),新国都 CAPITAL_GRACE 年内攻不下;
 *     只剩不到 MIN_STATE 州的撑不下去,残部归攻方、亡国;
 *     一州不剩就灭亡(Polity.ended),它的所有战争随之结束。
 *   议和:打满这场战争的年限(厌战,LENGTH 里随机)、连着 STALL 年没打下一州(僵持)、
 *     攻方达成战争目标(拿下 GOAL 里随机的几州)、拿下国都、或守方丢了过半国土 → 议和,占领的州归攻方;
 *     议和时两国各自被切出去、挨着对方的飞地割给对方(划清边界;割让的州数记在史事 peace 的 region 列)。
 *     攻方国力是守方 CRUSH 倍以上时是灭国之战:拿下国都、对方丢了过半国土、达成战争目标都不停,直到厌战、僵持或对方亡国。
 *
 * 同一年里的先后:宣战 → 攻占 → 灭亡 / 迁都 → 议和(史事按这个顺序记)。
 *
 * 阶段 4 干预(interventions.ts,挂在 WarModel.iv 上;没有干预时为空,只多一次判空):
 *   不许灭的国家,国都和紧挨着国都的州(京畿)攻不下,只剩 PROTECT_KEEP 州以下时一州都攻不下(pickTarget 跳过,看邻国也不挑它),
 *   守得也格外牢(PROTECT_DEF);结盟的两国不互相宣战;
 *   一国被宣战时,它的盟国(和攻方接壤)有 ALLY_JOIN 的机会向攻方宣战(援盟,史事 war 的 settlement 列记盟国;援盟不再连锁);
 *   强制宣战、结盟时当即议和走 WarModel.declare / makePeace。
 *   永久划给某国的州(干预"划州"带"永久",还在那国手里时)攻不下、议和时不割让;手里有这种州的国家丢了国都也不会被并掉残部
 *   (迁都到剩下的城,那一块里没城就到别的块里挑;一座城都没有才照旧被并 —— 极少见);
 *   不许扩张的国家不主动宣战、不援盟(被打时照常防守、反攻夺回自己的州)。
 *
 * **不存内存状态**:进行中的战争、厌战、停战冷却都能由 Civ 重建(resumeWars,CivSim.fromCiv 调用)——
 *   战争 = 史事里的 war(没有对应 peace 的就还在打);每场战争攻占了哪些州 = 带战争编号的 conquer;
 *   冷却 = 最近一次 peace 的年份;一州多久没易手 = 变化日志;看邻国、打仗的时刻都是由"国家 / 战争 + 第几次"算出来的。
 *
 * 随机数:keyed(subSeed(seed, 'civ-war'), 国家…, 第几次, 用途);一场战争里的随机数按"攻方 + 守方 + 宣战时刻 + 第几仗"取,
 * 和处理顺序、战争编号都无关。国家、州一律用位置锚(PolityModel.ptag、治所地块;见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { AdjKind, Layer, type Civ, type Polity, type Year } from './types';
import { fexp, flog, fpow, keyed, keyed4, subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { canCross, coreOf, endPolity, moveCapital, polityModelOf, type PolityModel } from './polities';
import { capitalAt, populationAt } from './growth';
import type { InterventionModel } from './interventions';

// ---- 调参(以截图和统计数为准,见 scripts/gen-stats.ts) ----
/** 立国后多少年开始看邻国;之后每隔多少年看一次(每段里 20%–80% 处随机一个时刻) */
const CHECK_FIRST = 40;
const CHECK_EVERY = 40;
/** 宣战赔率的底数;边境胜算(胜率 ÷ 败率)的指数;对异族 */
const WAR_ODDS = 0.2;
const LOCAL_EXP = 0.65;
const FOREIGN = 1.6;
/** 边界不到这么多段(州与州相邻的对数)时,赔率按比例打折 */
const BORDER_FULL = 4;
/** 打完仗至少歇多少年才会再主动宣战;同一对国家议和后多少年内不再开战 */
const REST = 30;
const TRUCE = 35;
/** 一国最多同时打几场仗(被别国趁火打劫算在内);国土到这么多州(帝国一档)的大国可以同时主动开两场仗 */
const MAX_WARS = 2;
const TWO_FRONTS = 70;
/** 两仗之间隔几年(随机) */
const GAP: [number, number] = [2, 6];
/** 厌战:一场战争最多打多少年(随机) */
const LENGTH: [number, number] = [12, 45];
/** 僵持:连着这么多年没攻下一州就议和 */
const STALL = 15;
/** 小国:不超过这么多州的邻国,宣战赔率 × PREY_ODDS */
const PREY = 4;
const PREY_ODDS = 2.5;
/** 分裂 / 复国出来的国家(Polity.parent),这么多年内别国不对它宣战(站稳期) */
export const NEWBORN = 60;
/** 迁都后这么多年内新国都攻不下(不会几年里一迁再迁) */
export const CAPITAL_GRACE = 20;
/** 丢了国都后剩下不到这么多州的国家撑不下去,残部归攻方、亡国 */
const MIN_STATE = 4;
/** 打下一州会把守方的国土切出去超过这么多州(和守方国都不再连成一片)的,先不打(不打出大块飞地) */
const MAX_CUT = 2;
/** 一州换了国家以后,这么多年内不会再在战争里易手(前线不闪烁) */
export const HOLD = 25;
/** 远征打折:国力 × e^(−离本国国都的路程 / PROJECT)(路程以"标准路程"计,见 polities.ts 的 capDist) */
const PROJECT = 11;
/** 守方的过界加成(按 AdjKind:平地、跨河、翻山、海峡、航线):攻方从最好打的那条边打进来 */
const DEFENSE = [1, 1.35, 1.9, 1.6, 2.2];
/** 守国都;守本族的州;攻方打同族的州 */
const CAPITAL_DEF = 1.8;
const HOME_DEF = 1.25;
const KIN_ATTACK = 1.15;
/** 胜率的上下限(再强也有失手,再弱也有侥幸) */
const P_MIN = 0.04;
const P_MAX = 0.9;
/** 攻方没打下来时,守方反攻(夺回被攻方占去的州)的机会 */
const COUNTER = 0.5;
/** 战争目标:这场战争想拿下几州(随机,含两头);拿到就议和 */
const GOAL: [number, number] = [2, 7];
/** 灭国之战:攻方国力是守方的这么多倍;战争目标翻几倍(Infinity = 不设目标) */
const CRUSH = 3;
const CRUSH_GOAL = Infinity;
/** 收复失地:邻国手里每有一州原是本国的,宣战赔率 × (1 + REVANCHE)(最多算 4 州);打仗时先打这些州 */
const REVANCHE = 0.35;
const REGAIN = 0.8;
/** 阶段 4 结盟:盟国被第三国宣战时,另一方(和攻方接壤)援盟参战的机会 */
const ALLY_JOIN = 0.8;
/** 阶段 4 不许灭:国都攻不下;国土只剩这么多州(含)以下时,一州都攻不下(保住国都一带的几州,不至于缩成孤城) */
const PROTECT_KEEP = 3;
/** 阶段 4 不许灭:守方国力 × 这么多(天命所归,守得格外牢:国土会缩,但不至于一路缩到只剩国都) */
const PROTECT_DEF = 1.6;

// 随机数用途编号
const U_CHECK_T = 1;
const U_DECLARE = 2;
const U_GAP = 3;
const U_LENGTH = 4;
const U_ATTACK = 5;
const U_COUNTER = 6;
const U_RETAKE = 7;
const U_TARGET = 8;
const U_GOAL = 9;
const U_ALLY = 10;

// ---------------------------------------------------------------------------
// 模型

/** 一场战争(由史事就能重建) */
export interface War {
  /** 战争编号(0 起,按宣战先后) = 史事里的 war */
  id: number;
  /** 攻方、守方 */
  a: number;
  b: number;
  /** 宣战的年份 */
  start: Year;
  /** 议和的年份(还在打 = undefined) */
  end?: Year;
  /** 这场战争里攻占的州(按先后):by = 攻占它的一方 */
  takes: { year: Year; region: number; by: number }[];
}

export interface WarModel {
  pm: PolityModel;
  base: number;
  wars: War[];
  /** 还在打的仗(按编号) */
  active: War[];
  /** 州 → 最近一次换国家的年份(从来没归过国家 = −Infinity) */
  since: Float64Array;
  /** 州 → 换到现在这个国家之前属于哪国(−1 = 部落地带 / 没换过):收复失地用 */
  prev: Int16Array;
  /** 国家 → 最近一次议和的年份 */
  rest: Map<number, Year>;
  /** 两国最近一次议和的年份(键见 pairKey) */
  truce: Map<number, Year>;
  /**
   * 阶段 3 城市兴衰(cities.ts 挂上):战役里攻下一州(攻方打下来、守方反攻夺回;议和割让、亡国时残部归攻方的不算)、
   * 州里有城时调用 —— 城可能被洗劫、被毁。在记这条攻占之前调(洗劫 / 毁城记在攻占前面),sid = 州里的城,
   * capital = 打下的是守方的国都
   */
  onAssault?: (w: War, x: number, y: number, r: number, sid: number, t: number, capital: boolean) => void;
  /** 阶段 4 干预(interventions.ts 挂上;没有干预 = 不给):不许灭、结盟在这里查 */
  iv?: InterventionModel;
  /**
   * x 向 y 宣战(installWars 填;看邻国、干预的强制宣战、援盟共用):记 war、预约第一仗;y 的盟国可能援盟。
   * ally = 援的是哪个盟国(援盟宣战时给,不再连锁)
   */
  declare?: (x: number, y: number, t: Year, ally?: number) => War;
  /** 议和(installWars 填;干预的结盟用:结盟那一刻正在交战的两国当即议和) */
  makePeace?: (w: War, t: Year) => void;
}

const pairKey = (a: number, b: number) => Math.min(a, b) * 32768 + Math.max(a, b);

/** 国家 p 第 k 次看邻国的时刻 */
function checkTime(wm: WarModel, p: number, k: number): number {
  const P = wm.pm.polities[p];
  return P.founded + CHECK_FIRST + CHECK_EVERY * (k + 0.2 + 0.6 * keyed(wm.base, wm.pm.ptag[p], k, U_CHECK_T));
}

/** 一场战争里的随机数:按"攻方 + 守方(位置锚)+ 宣战时刻 + x + 用途"取 */
function warRand(wm: WarModel, w: War, x: number, use: number): number {
  const b = (wm.base ^ Math.imul(Math.round(w.start * 256), 0x27d4eb2d)) >>> 0;
  return keyed4(b, wm.pm.ptag[w.a], wm.pm.ptag[w.b], x, use);
}

/** 第 i 仗之前隔几年 */
function gapOf(wm: WarModel, w: War, i: number): number {
  return GAP[0] + (GAP[1] - GAP[0]) * warRand(wm, w, i, U_GAP);
}

/** 这场战争想拿下几州(战争目标;达成就议和,灭国之战除外) */
function goalOf(wm: WarModel, w: War): number {
  return GOAL[0] + Math.floor((GOAL[1] - GOAL[0] + 1) * warRand(wm, w, 0, U_GOAL));
}

/** 这场战争最多打几年 */
function lengthOf(wm: WarModel, w: War): number {
  return LENGTH[0] + (LENGTH[1] - LENGTH[0]) * warRand(wm, w, 0, U_LENGTH);
}

function newModel(pm: PolityModel): WarModel {
  return {
    pm,
    base: subSeed(pm.seed, 'civ-war'),
    wars: [],
    active: [],
    since: new Float64Array(pm.terrain.R).fill(-Infinity),
    prev: new Int16Array(pm.terrain.R).fill(-1),
    rest: new Map(),
    truce: new Map(),
  };
}

/** 国家 p 此刻各州离它国都的路程(远征远近;和国家扩张共用 polities.ts 的那一份,迁都时换成新国都的) */
function reachOf(wm: WarModel, p: number): Float32Array {
  return wm.pm.capDist[p];
}

const models = new WeakMap<CivSim, WarModel>();

/** 推演引擎上挂着的战争模型(测试、统计用) */
export function warModelOf(sim: CivSim): WarModel | undefined {
  return models.get(sim);
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记战争的事件处理和监听(installPolities 之后调用) */
export function installWars(sim: CivSim, pm: PolityModel, wm: WarModel = newModel(pm)): WarModel {
  models.set(sim, wm);
  const T = pm.terrain;
  const reg = T.regions;
  const R = T.R;
  const culture = sim.owners[Layer.Culture];
  const owner = sim.owners[Layer.Polity];

  // 州换了国家:记下年份;新立的国家(立国、分裂 / 复国出来的,拿到第一州时)预约第一次看邻国
  sim.onChange(Layer.Polity, (r, v, prev, cause) => {
    wm.since[r] = sim.now;
    wm.prev[r] = prev;
    if (v >= 0 && (cause === Ev.PolityFound || cause === Ev.Split) && pm.size[v] === 1) sim.schedule(checkTime(wm, v, 0), Ev.WarCheck, 0, v);
  });

  /**
   * 这几国此刻的国力(城镇人口之和,按州号顺序加,千人;至少 1)。只算要用的几国(别的国家留 0),
   * 只扫它们自己的国土(pm.lands):国家多了以后每次都把全世界的城算一遍太慢
   */
  const popAt = populationAt; // 热循环里用本地引用(tsx 下每次读导入的函数都要过一层 getter)
  const powers = (t: number, who: readonly number[]): Float64Array => {
    const pow = new Float64Array(pm.polities.length);
    for (const p of who) {
      if (pow[p] > 0) continue; // 重复的
      let sum = 0;
      for (const r of pm.lands[p]) {
        const c = pm.cityOf[r];
        if (c >= 0) sum += popAt(pm.settlements[c], t);
      }
      pow[p] = Math.max(1, sum);
    }
    return pow;
  };

  const warsOf = (p: number) => wm.active.filter((w) => w.a === p || w.b === p);

  /** x 攻打 y 的州 r(r 挨着 x 的国土,def = 攻方最好打的那条边的过界难度):胜率 */
  const chance = (x: number, y: number, r: number, def: number, t: number, pow: Float64Array): number => {
    const X = pm.polities[x];
    const Y = pm.polities[y];
    let sx = pow[x] * fexp(-reachOf(wm, x)[r] / PROJECT);
    let sy = pow[y] * fexp(-reachOf(wm, y)[r] / PROJECT) * def;
    if (culture[r] === X.culture) sx *= KIN_ATTACK;
    if (culture[r] === Y.culture) sy *= HOME_DEF;
    if (pm.settlements[capitalAt(Y, t)].region === r) sy *= CAPITAL_DEF;
    if (wm.iv?.protects(y, t)) sy *= PROTECT_DEF; // 阶段 4 干预"不许灭":守得格外牢
    const a2 = sx * sx;
    const d2 = sy * sy;
    const p = a2 + d2 > 0 ? a2 / (a2 + d2) : 0.5;
    return Math.min(P_MAX, Math.max(P_MIN, p));
  };

  /**
   * x 在这场战争的第 i 仗里打 y 的哪一州:和 x 的国土接壤、HOLD 年内没易过手;
   * retake = 只打被 y 占去的州(守方反攻:这场战争里丢的,或者以前被 y 夺去的)。返回 [州, 过界难度];没有可打的 = [−1, 0]
   */
  const pickTarget = (w: War, i: number, x: number, y: number, t: number, retake: boolean): [number, number] => {
    const X = pm.polities[x];
    const dy = reachOf(wm, y);
    let lost: Set<number> | null = null;
    if (retake) lost = new Set(w.takes.filter((e) => e.by === y).map((e) => e.region));
    const cand: [number, number, number][] = [];
    // 刚迁都的国家,新国都 CAPITAL_GRACE 年内攻不下(残兵收拢、新都严防):不会几年里一迁再迁
    const graceR = t - pm.capMoved[y] < CAPITAL_GRACE ? pm.settlements[capitalAt(pm.polities[y], t)].region : -1;
    // 阶段 4 干预"不许灭":国都和紧挨着国都的州(京畿)攻不下(不会亡国、不会因丢了国都被并掉残部);只剩几州时一州都攻不下
    let guardR = -1;
    if (wm.iv?.protects(y, t)) {
      if (pm.size[y] <= PROTECT_KEEP) return [-1, 0];
      guardR = pm.settlements[capitalAt(pm.polities[y], t)].region;
    }
    const Y = pm.polities[y];
    for (const r of pm.lands[y]) {
      if (t - wm.since[r] < HOLD || r === graceR || r === guardR) continue;
      if (wm.iv?.locked(r, t)) continue; // 阶段 4 干预:永久划给它的州攻不下
      if (guardR >= 0 && nextTo(r, guardR, Y)) continue;
      if (lost && !lost.has(r) && wm.prev[r] !== x) continue;
      let att = 0;
      let tot = 0;
      let def = Infinity;
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const kind = reg.adjKind[k];
        if (kind !== AdjKind.SeaRoute) tot += reg.adjBorder[k];
        if (owner[reg.adj[k]] === x && canCross(X, kind)) {
          att += reg.adjBorder[k];
          if (DEFENSE[kind] < def) def = DEFENSE[kind];
        }
      }
      if (def === Infinity) continue;
      const frac = tot > 0 ? att / tot : 0.5;
      const toward = dy[r] < Infinity ? fexp(-dy[r] / PROJECT) : 0;
      const score =
        3 * frac + 0.6 * toward - 0.8 * flog(def) + (wm.prev[r] === x ? REGAIN : 0) + 0.5 * warRand(wm, w, reg.seat[r] * 1024 + (i & 1023), U_TARGET);
      cand.push([r, def, score]);
    }
    // 分数从高往低,挑第一个"打下来不会把 y 的国土切出一大块飞地"的
    cand.sort((u, v) => v[2] - u[2] || reg.seat[u[0]] - reg.seat[v[0]]);
    const capR = pm.settlements[capitalAt(pm.polities[y], t)].region;
    let n0 = -1;
    for (const [r, def] of cand) {
      if (r !== capR) {
        if (n0 < 0) n0 = reachable(y, capR, -1);
        if (n0 - 1 - reachable(y, capR, r) > MAX_CUT) continue;
      }
      return [r, def];
    }
    return [-1, 0];
  };

  /** 州 r 和州 c 相邻(国家 P 能走的边) */
  const nextTo = (r: number, c: number, P: Polity): boolean => {
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (reg.adj[k] === c && canCross(P, reg.adjKind[k])) return true;
    return false;
  };

  /** 从州 from 出发、经 y 的国土(y 能走的边)能走到几州;skip = 当作已经丢了的州 */
  const seen = new Int32Array(R);
  let stamp = 0;
  const queue = new Int32Array(R);
  const reachable = (y: number, from: number, skip: number): number => {
    const Y = pm.polities[y];
    if (owner[from] !== y || from === skip) return 0;
    stamp++;
    let qt = 0;
    queue[qt++] = from;
    seen[from] = stamp;
    for (let h = 0; h < qt; h++) {
      const r = queue[h];
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (seen[j] === stamp || j === skip || owner[j] !== y || !canCross(Y, reg.adjKind[k])) continue;
        seen[j] = stamp;
        queue[qt++] = j;
      }
    }
    return qt;
  };

  const makePeace = (w: War, t: number) => {
    if (w.end !== undefined) return;
    // 议和时划清边界:两国各自和国都不连成一片的飞地,挨着对方的割给对方(一州易手后 HOLD 年内不动的照旧)
    let ceded = 0;
    if (pm.polities[w.a].ended === undefined && pm.polities[w.b].ended === undefined) {
      for (const [x, y] of [
        [w.a, w.b],
        [w.b, w.a],
      ]) {
        const X = pm.polities[x];
        const Y = pm.polities[y];
        for (let changed = true; changed; ) {
          changed = false;
          const { seen: core, stamp: cs } = coreOf(pm, owner, x, t);
          const give: number[] = [];
          for (let r = 0; r < R; r++) {
            if (owner[r] !== x || core[r] === cs || t - wm.since[r] < HOLD || wm.iv?.locked(r, t)) continue;
            for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
              if (owner[reg.adj[k]] === y && canCross(Y, reg.adjKind[k])) {
                give.push(r);
                break;
              }
            }
          }
          for (const r of give) take(w, y, x, r, t);
          ceded += give.length;
          changed = give.length > 0 && X.ended === undefined;
        }
      }
    }
    w.end = t;
    wm.active.splice(wm.active.indexOf(w), 1);
    wm.rest.set(w.a, t);
    wm.rest.set(w.b, t);
    wm.truce.set(pairKey(w.a, w.b), t);
    // region 列记割让了几州(紧挨在这条议和前面的那么多条攻占是划界割让的,编年史写"划归"而不写"攻取");没割让 = −1
    sim.record('peace', { a: w.a, b: w.b, war: w.id, region: ceded > 0 ? ceded : -1 });
  };

  /** y 亡国(最后一州 r 被 x 攻占):记灭亡,它打着的仗全部结束 */
  const fall = (w: War, x: number, y: number, r: number, t: number) => {
    endPolity(pm, y, t);
    sim.record('fall', { a: y, b: x, region: r, war: w.id });
    for (const v of warsOf(y)) makePeace(v, t);
  };

  /**
   * x 攻占 y 的州 r。返回 true = 拿下的是 y 的国都。
   * assault = 战役里打下来的(阶段 3 城市兴衰:城可能被洗劫、被毁,见 WarModel.onAssault;议和时割让的不算)
   */
  const take = (w: War, x: number, y: number, r: number, t: number, assault = false): boolean => {
    const Y = pm.polities[y];
    const capital = pm.settlements[capitalAt(Y, t)].region === r;
    const city = pm.cityOf[r];
    sim.setOwner(Layer.Polity, r, x, Ev.Conquer);
    if (assault && city >= 0) wm.onAssault?.(w, x, y, r, city, t, capital);
    sim.record('conquer', { a: x, b: y, region: r, settlement: city, war: w.id });
    w.takes.push({ year: t, region: r, by: x });
    if (!capital) return false;
    if (pm.size[y] <= 0) {
      fall(w, x, y, r, t);
      return true;
    }
    // 丢了国都只剩不到 MIN_STATE 州(而且都不是刚易手的):撑不下去,残部一并归攻方,亡国
    let left = 0;
    let settled = true;
    for (let q = 0; q < R; q++) {
      if (owner[q] !== y) continue;
      left++;
      if (t - wm.since[q] < HOLD) settled = false;
    }
    // 阶段 4 干预:手里有永久划给它的州的,不被并掉残部(迁都到剩下的城,那一块里没城就到别的块里挑)
    const keep = !!wm.iv?.holdsLock(y, t);
    if (left < MIN_STATE && settled && !keep) return annex(w, x, y, r, t);
    const sid = bestCapital(pm, owner, y, t, keep);
    if (sid >= 0) {
      moveCapital(pm, y, sid, t);
      sim.record('capital', { a: y, region: pm.settlements[sid].region, settlement: sid, war: w.id });
      return true;
    }
    // 剩下的州里一座城都还没建起来(极少见):同样亡国
    return annex(w, x, y, r, t);
  };

  /** y 丢了国都 r、撑不下去:余下的州一并归 x,亡国 */
  const annex = (w: War, x: number, y: number, r: number, t: number): boolean => {
    const X = pm.polities[x];
    let last = r;
    // 由近及远:先并挨着 x 国土的州,一圈圈往外(隔海的残部最后一并归 x)
    for (let any = true; pm.size[y] > 0; ) {
      const touch = any;
      any = false;
      for (let q = 0; q < R; q++) {
        if (owner[q] !== y) continue;
        if (touch) {
          let adj = false;
          for (let k = reg.adjStart[q]; k < reg.adjStart[q + 1] && !adj; k++) adj = owner[reg.adj[k]] === x && canCross(X, reg.adjKind[k]);
          if (!adj) continue;
        }
        sim.setOwner(Layer.Polity, q, x, Ev.Conquer);
        sim.record('conquer', { a: x, b: y, region: q, settlement: pm.cityOf[q], war: w.id });
        w.takes.push({ year: t, region: q, by: x });
        last = q;
        any = true;
      }
    }
    fall(w, x, y, last, t);
    return true;
  };

  /** x、y 的国土接壤(x 能走过去的边) */
  const borders = (x: number, y: number): boolean => polityBorders(pm, owner, x, y);

  const declare = (x: number, y: number, t: number, ally = -1): War => {
    const w: War = { id: wm.wars.length, a: x, b: y, start: t, takes: [] };
    wm.wars.push(w);
    wm.active.push(w);
    sim.record('war', ally >= 0 ? { a: x, b: y, war: w.id, settlement: ally } : { a: x, b: y, war: w.id });
    sim.schedule(t + gapOf(wm, w, 0), Ev.Campaign, 0, w.id);
    // 阶段 4 干预的结盟:y 被宣战,它的盟国(和 x 接壤、没和 x 结盟、没在和 x 打)有 ALLY_JOIN 的机会援盟
    const iv = wm.iv;
    if (iv && ally < 0) {
      for (const z of iv.alliesOf(y, t)) {
        if (z === x || pm.polities[z].ended !== undefined || iv.allied(z, x, t) || iv.halted(z, t)) continue;
        if (wm.active.some((v) => (v.a === z && v.b === x) || (v.a === x && v.b === z)) || !borders(z, x)) continue;
        if (keyed4(iv.base, pm.ptag[z], pm.ptag[x], Math.round(t * 256), U_ALLY) >= ALLY_JOIN) continue;
        declare(z, x, t, y);
      }
    }
    return w;
  };
  wm.declare = declare;
  wm.makePeace = (w, t) => makePeace(w, t);

  sim.on(Ev.WarCheck, (k, p, t) => {
    const P = pm.polities[p];
    if (!P || P.ended !== undefined) return;
    sim.schedule(checkTime(wm, p, k + 1), Ev.WarCheck, k + 1, p);
    // 阶段 4 干预"不许扩张":不主动宣战
    if (wm.iv?.halted(p, t)) return;
    // 正在打仗的不再开新仗(帝国级的大国可以两线作战);刚议和的歇几年
    if (warsOf(p).length >= (pm.size[p] >= TWO_FRONTS ? 2 : 1) || t - (wm.rest.get(p) ?? -Infinity) < REST) return;
    // 接壤的邻国:边界长短(州与州相邻的对数)、边境上对方的州(和最好打的那条边);邻国手里有几州是从本国夺去的(收复失地)
    const border = new Map<number, number>();
    const front = new Map<number, Map<number, number>>();
    /** 邻国 q 手里有几州是从本国夺去的(收复失地;只扫 q 的国土) */
    const claims = (q: number) => {
      let n = 0;
      for (const r of pm.lands[q]) if (wm.prev[r] === p) n++;
      return n;
    };
    for (const r of pm.lands[p]) {
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const j = reg.adj[e];
        const q = owner[j];
        const kind = reg.adjKind[e];
        if (q < 0 || q === p || !canCross(P, kind)) continue;
        border.set(q, (border.get(q) ?? 0) + 1);
        let f = front.get(q);
        if (!f) front.set(q, (f = new Map()));
        f.set(j, Math.min(f.get(j) ?? Infinity, DEFENSE[kind]));
      }
    }
    if (!border.size) return;
    const pow = powers(t, [p, ...border.keys()]);
    let target = -1;
    let odds = 0;
    for (const [q, n] of [...border].sort((u, v) => u[0] - v[0])) {
      const Q = pm.polities[q];
      if (Q.ended !== undefined || t - (wm.truce.get(pairKey(p, q)) ?? -Infinity) < TRUCE) continue;
      // 分裂 / 复国出来的国家有 NEWBORN 年的站稳期:不会一出生就被吞掉
      if (Q.parent !== undefined && t - Q.founded < NEWBORN) continue;
      const qw = warsOf(q);
      if (qw.length >= MAX_WARS || qw.some((v) => v.a === p || v.b === p)) continue;
      // 阶段 4 干预:不打盟国;不许灭的国家只剩几州时没什么可打的
      if (wm.iv && (wm.iv.allied(p, q, t) || (pm.size[q] <= PROTECT_KEEP && wm.iv.protects(q, t)))) continue;
      // 边境上的胜算(和打仗时一样按局部国力算,远征打折):强国的边远处打得过,就会有弱国来收复失地
      let sum = 0;
      for (const [y, def] of front.get(q)!) sum += chance(p, q, y, def, t, pow);
      const pbar = sum / front.get(q)!.size;
      let o = WAR_ODDS * P.expansionism * fpow(pbar / (1 - pbar), LOCAL_EXP) * Math.sqrt(Math.min(1, n / BORDER_FULL));
      if (Q.culture !== P.culture) o *= FOREIGN;
      o *= 1 + REVANCHE * Math.min(4, claims(q));
      // 小国(一场仗就能吞下)格外招人
      if (pm.size[q] <= PREY) o *= PREY_ODDS;
      if (o > odds) {
        odds = o;
        target = q;
      }
    }
    if (target < 0 || keyed(wm.base, pm.ptag[p], k, U_DECLARE) >= odds / (1 + odds)) return;
    declare(p, target, t);
  });

  sim.on(Ev.Campaign, (i, id, t) => {
    const w = wm.wars[id];
    if (!w || w.end !== undefined) return;
    const pow = powers(t, [w.a, w.b]);
    let capitalFell = false;
    const [r, def] = pickTarget(w, i, w.a, w.b, t, false);
    if (r >= 0 && warRand(wm, w, i, U_ATTACK) < chance(w.a, w.b, r, def, t, pow)) {
      capitalFell = take(w, w.a, w.b, r, t, true);
    } else if (warRand(wm, w, i, U_COUNTER) < COUNTER) {
      // 守方反攻:夺回被攻方占去的州
      const [q, qdef] = pickTarget(w, i, w.b, w.a, t, true);
      if (q >= 0 && warRand(wm, w, i, U_RETAKE) < chance(w.b, w.a, q, qdef, t, pow)) capitalFell = take(w, w.b, w.a, q, t, true);
    }
    if (w.end !== undefined) return; // 有一方亡国,已经议和
    // 议和?
    const last = w.takes.length ? w.takes[w.takes.length - 1].year : w.start;
    let peace = t - w.start >= lengthOf(wm, w) || t - last >= STALL;
    if (!peace) {
      let held = 0;
      for (const e of w.takes) if (e.by === w.a && owner[e.region] === w.a) held++;
      // 灭国之战:拿下国都、对方丢了过半国土都不停,战争目标翻倍
      if (pow[w.a] >= CRUSH * pow[w.b]) peace = held >= CRUSH_GOAL * goalOf(wm, w);
      else peace = capitalFell || held >= pm.size[w.b] || held >= goalOf(wm, w);
    }
    if (peace) makePeace(w, t);
    else sim.schedule(t + gapOf(wm, w, i + 1), Ev.Campaign, i + 1, id);
  });

  return wm;
}

/**
 * 由 Civ 重建战争的推演状态(CivSim.fromCiv 调用,在 resumePolities 之后):
 * 战争、每场战争攻占的州、议和(冷却)都从史事里读;一州多久没易手从变化日志里读;
 * 再按"国家 + 第几次""战争 + 第几仗"算出还没到的看邻国、下一仗,补进引擎。
 */
export function resumeWars(sim: CivSim, _world: World, civ: Civ): void {
  const pm = polityModelOf(sim);
  if (!pm) return;
  const wm = newModel(pm);
  const log = civ.log;
  {
    const cur = new Int16Array(civ.regions.count).fill(-1);
    for (let i = 0; i < log.size; i++) {
      if (log.layer[i] !== Layer.Polity) continue;
      const r = log.region[i];
      wm.since[r] = log.year[i];
      wm.prev[r] = cur[r];
      cur[r] = log.value[i];
    }
  }
  for (const e of civ.annals) {
    if (e.kind === 'war') wm.wars[e.war] = { id: e.war, a: e.a, b: e.b, start: e.year, takes: [] };
    else if (e.kind === 'conquer' && e.war >= 0) wm.wars[e.war]?.takes.push({ year: e.year, region: e.region, by: e.a });
    else if (e.kind === 'peace') {
      const w = wm.wars[e.war];
      if (w) w.end = e.year;
      wm.rest.set(e.a, e.year);
      wm.rest.set(e.b, e.year);
      wm.truce.set(pairKey(e.a, e.b), e.year);
    }
  }
  for (const w of wm.wars) if (w && w.end === undefined) wm.active.push(w);
  installWars(sim, pm, wm);

  const now = sim.now;
  // 在世的国家:下一次看邻国
  for (const p of pm.polities) {
    if (p.ended !== undefined) continue;
    let k = 0;
    while (quantize(checkTime(wm, p.id, k)) <= now) k++;
    sim.schedule(checkTime(wm, p.id, k), Ev.WarCheck, k, p.id);
  }
  // 还在打的仗:下一仗(和推演时一样逐仗累加、逐仗取整)
  for (const w of wm.active) {
    let i = 0;
    let t = quantize(w.start + gapOf(wm, w, 0));
    while (t <= now) {
      i++;
      t = quantize(t + gapOf(wm, w, i));
    }
    sim.schedule(t, Ev.Campaign, i, w.id);
  }
}

/**
 * 国家 y 丢了国都以后挑新国都(战争里国都失守、阶段 4 干预把国都所在州划走 / 在那里立国):
 * 剩下的国土被切成几块时,先挑城镇人口最多的那一块(不把国都迁进一小块飞地),再挑块里人口最多的城。
 * 那一块里一座城都没有 = −1;anyPiece = 那时到别的块里挑人口最多的城。skip = 当作已经不归 y 的州(立国干预:国都所在州要分出去)
 */
export function bestCapital(pm: PolityModel, owner: Int16Array, y: number, t: Year, anyPiece = false, skip = -1): number {
  const reg = pm.terrain.regions;
  const R = pm.terrain.R;
  const Y = pm.polities[y];
  const piece = new Int32Array(R).fill(-1);
  const piecePop: number[] = [];
  for (let q = 0; q < R; q++) {
    if (owner[q] !== y || piece[q] >= 0 || q === skip) continue;
    const id = piecePop.length;
    let sum = 0;
    const stack = [q];
    piece[q] = id;
    while (stack.length) {
      const u = stack.pop()!;
      if (pm.cityOf[u] >= 0) sum += populationAt(pm.settlements[pm.cityOf[u]], t);
      for (let k = reg.adjStart[u]; k < reg.adjStart[u + 1]; k++) {
        const j = reg.adj[k];
        if (piece[j] < 0 && owner[j] === y && j !== skip && canCross(Y, reg.adjKind[k])) {
          piece[j] = id;
          stack.push(j);
        }
      }
    }
    piecePop.push(sum);
  }
  let main = 0;
  for (let i = 1; i < piecePop.length; i++) if (piecePop[i] > piecePop[main]) main = i;
  let sid = -1;
  let best = -1;
  for (let pass = 0; pass < (anyPiece ? 2 : 1) && sid < 0; pass++) {
    for (let q = 0; q < R; q++) {
      if (owner[q] !== y || q === skip || pm.cityOf[q] < 0 || (pass === 0 && piece[q] !== main)) continue;
      const pop = populationAt(pm.settlements[pm.cityOf[q]], t);
      if (pop > best) {
        best = pop;
        sid = pm.cityOf[q];
      }
    }
  }
  return sid;
}

/** 国家 x、y 此刻国土接壤(陆上相邻;海洋国家 x 隔着海峡、航线也算,和看邻国时一样按 x 能走的边) */
export function polityBorders(pm: PolityModel, owner: Int16Array, x: number, y: number): boolean {
  const reg = pm.terrain.regions;
  const X = pm.polities[x];
  for (const r of pm.lands[x]) {
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (owner[reg.adj[k]] === y && canCross(X, reg.adjKind[k])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、stress.ts、单测用)

export interface WarStats {
  /** 战争场数、攻占次数、灭亡国家数、迁都次数 */
  wars: number;
  conquests: number;
  falls: number;
  capitalMoves: number;
  /** 结束时在世的国家数 */
  alive: number;
  /** 结束时有人住的州里没有国家(部落地带)的比例 */
  tribalShare: number;
  /** 50 年内换了 3 次以上国家的州(第一次归国家也算一次) */
  flippy: number;
  /** 结束时的飞地州(和本国国都经本国国土陆上不连通;海洋国家可以走海路)个数、占全部有国家的州的比例 */
  exclaves: number;
  exclaveShare: number;
}

/** 某一年的飞地:每州 1 = 飞地(和本国国都经本国国土不连通;海洋国家的海外领土不算飞地) */
export function exclaveMask(civ: Civ, owner: Int16Array = civ.polity, year: Year = civ.endYear): Uint8Array {
  const reg = civ.regions;
  const R = reg.count;
  const reached = new Uint8Array(R);
  const q: number[] = [];
  for (const p of civ.polities) {
    if (!(year >= p.founded) || (p.ended !== undefined && year >= p.ended)) continue;
    const c = civ.settlements[capitalAt(p, year)].region;
    if (owner[c] !== p.id) continue;
    q.length = 0;
    q.push(c);
    reached[c] = 1;
    for (let h = 0; h < q.length; h++) {
      const r = q[h];
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (reached[j] || owner[j] !== p.id || !canCross(p, reg.adjKind[k])) continue;
        reached[j] = 1;
        q.push(j);
      }
    }
  }
  const out = new Uint8Array(R);
  for (let r = 0; r < R; r++) if (owner[r] >= 0 && !reached[r]) out[r] = 1;
  return out;
}

export function warStats(civ: Civ): WarStats {
  const A = civ.annals;
  const count = (k: string) => A.filter((e) => e.kind === k).length;
  const R = civ.regions.count;
  let occ = 0;
  let tribal = 0;
  let owned = 0;
  for (let r = 0; r < R; r++) {
    if (civ.culture[r] < 0) continue;
    occ++;
    if (civ.polity[r] < 0) tribal++;
    else owned++;
  }
  // 各州国家层的变化年份
  const times: number[][] = Array.from({ length: R }, () => []);
  for (let i = 0; i < civ.log.size; i++) if (civ.log.layer[i] === Layer.Polity) times[civ.log.region[i]].push(civ.log.year[i]);
  let flippy = 0;
  for (const ts of times) {
    for (let i = 2; i < ts.length; i++) {
      if (ts[i] - ts[i - 2] < 50) {
        flippy++;
        break;
      }
    }
  }
  const ex = exclaveMask(civ);
  let exclaves = 0;
  for (let r = 0; r < R; r++) exclaves += ex[r];
  return {
    wars: count('war'),
    conquests: count('conquer'),
    falls: count('fall'),
    capitalMoves: count('capital'),
    alive: civ.polities.filter((p) => p.ended === undefined).length,
    tribalShare: occ ? tribal / occ : 0,
    flippy,
    exclaves,
    exclaveShare: owned ? exclaves / owned : 0,
  };
}
