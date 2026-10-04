/**
 * 文明推演引擎(民族扩张;战争、分裂、合并等也在这上面加事件):
 *
 * - **事件堆**:按时间排序(复用 util.ts 的 MinHeap)。每个事件是 {时间, 类型, 对象 a, 对象 b, 版本号}。
 *   时间精度 1/256 年;"时间 + 编号"拼成一个整数当优先级,同一时刻的事件按编号(预约先后)处理,保证确定性。
 * - **州的版本号**:州的归属(任何一层)一变就 +1。事件预约时记下州 a 的版本号,弹出时对不上就是过期了,
 *   直接丢掉 —— 不用去堆里找、删事件。哪些类型要核对版本号,见 EVENT_INFO。
 * - **唯一改归属的入口** setOwner(层, 州, 新值, 原因):写变化日志、版本号 +1、通知这一层的监听者
 *   (民族层的监听者负责"预约邻州的到达",见 cultures.ts)。
 * - **变化日志**:只记"哪一年、哪个州、哪一层、新值、原因"。回放 = 翻日志(timeline.ts 的 ownersAt)。
 * - **史事**(阶段 3):record(种类, …) 记"发生了什么事"(立国、升格、宣战、攻占、灭亡……),编年史只读它。
 *   各字段的含义见 types.ts 的 AnnalKind。
 * - **检查点**:每 100 年存一份各州的归属,时间轴一下跳到很远时不用从头翻。
 * - **不保存事件堆**:CivSim.fromCiv(world, civ) 由 Civ 数据本身重建"接下来该发生什么",从 civ.endYear 接着推。
 *   进行中的战争、厌战、停战冷却也一样(由史事 + 日志 + 国家表重建,见 wars.ts 的 resumeWars);
 *   分裂、合并、复国、主动迁都的冷却同样(见 politics.ts 的 resumePolitics);王朝更替也一样(dynasty.ts 的 resumeDynasty);
 *   同化与迁徙同样(见 assimilation.ts 的 resumeAssimilation);
 *   城市兴衰(毁城后的重建、旧都衰落)也一样(cities.ts 的 resumeCities)。
 *   阶段 4 的干预不存进事件堆:fromCiv(world, civ, 干预列表)按列表补上还没到的干预(interventions.ts 的 resumeInterventions)。
 *
 * 纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { MinHeap } from '../util';
import { Layer, type Annal, type AnnalKind, type ChangeLog, type Checkpoint, type Civ, type Year } from './types';
import { resumeCultures } from './cultures';
import { resumePolities } from './polities';
import { resumeWars } from './wars';
import { resumePolitics } from './politics';
import { resumeDynasty } from './dynasty';
import { resumeAssimilation } from './assimilation';
import { resumeCities } from './cities';
import { resumeInterventions, scheduleInterventions } from './interventions';
import type { Intervention } from '../edits';

// ---------------------------------------------------------------------------
// 事件类型编号表(变化日志的 cause 用同一套编号;阶段 3 从 7 往下接着编:战争 7–9,分合 10–14,王朝更替 15–19,
// 民族同化与迁徙 20–24,城市兴衰 25–29;阶段 4 干预 30–35)

export const enum Ev {
  /** 没有原因(初始状态) */
  None = 0,
  /** 民族诞生:a = 发源州,b = 民族。发源州已被别族占了,就近找一个空的可居州 */
  CultureBorn = 1,
  /** 民族到达:a = 州,b = 民族。州还没人住就归属这个民族;不可居的州只是路过 */
  CultureArrive = 2,
  /** 建城(polities.ts):a = 州,b = 城镇 */
  SettlementFound = 3,
  /** 立国(polities.ts):a = 国都所在州,b = 国家 */
  PolityFound = 4,
  /** 国家到达(polities.ts):a = 州,b = 国家。州有人住、还没归别国,就归这个国家 */
  PolityArrive = 5,
  /** 升格(polities.ts):a = 国都所在州,b = 国家。国土跨过一档(部 → 国 → 王国 → 帝国),国号升一级,记进 Polity.titles */
  PolityRank = 6,
  /**
   * 看邻国(阶段 3 战争,wars.ts):a = 立国后第几次看(按年份段编号),b = 国家。
   * 国家隔几十年看一眼接壤的邻国:国力比、扩张性、是不是异族、上次议和过了多久,决定要不要宣战
   */
  WarCheck = 7,
  /**
   * 战役(wars.ts):a = 这场战争的第几仗,b = 战争编号。攻方打一个和自己国土接壤的敌州,
   * 打不下来守方可能反攻、夺回这场战争里丢的州;打完看要不要议和,不议和就预约下一仗
   */
  Campaign = 8,
  /** 攻占(wars.ts):不单独预约,是战役里改归属(setOwner)时变化日志记的原因 */
  Conquer = 9,
  /**
   * 看内政(阶段 3 分合,politics.ts):a = 立国后第几次看(按年份段编号),b = 国家。
   * 国家隔几十年看一眼自己:边远的州会不会起兵自立(分裂)、国都要不要迁到国土中部(主动迁都)、
   * 小国会不会并入接壤的同族大国(合并)
   */
  PoliticsCheck = 10,
  /** 分裂 / 复国(politics.ts):不单独预约,是起兵自立的州改归新国家时变化日志记的原因 */
  Split = 11,
  /** 合并(politics.ts):不单独预约,是小国的州并入大国时变化日志记的原因 */
  Merge = 12,
  /**
   * 看复国(politics.ts):a = 亡国后第几次看,b = 亡国的国家。故国国都一带仍是同族人住、
   * 当前的宗主又弱(在打仗 / 刚分裂 / 刚迁都)时,遗民举旗复国
   */
  RestoreCheck = 13,
  /**
   * 看部落地带(politics.ts):a = 第几次看。阶段 2 里因为离别国国都太近没能立国的城,
   * 那个国都灭亡 / 迁走以后,在这里再试一次立国
   */
  TribalCheck = 14,
  /**
   * 看王朝(阶段 3 王朝更替,dynasty.ts):a = 立国后第几次看(按年份段编号),b = 国家。
   * 大国隔几十年看一眼:当朝立了多久(越久越容易亡)、国势动荡(战败失地、国都失守、刚分裂),决定会不会改朝换代。
   * 改朝换代不改归属(同一个国家编号),新朝定都根据地时迁都
   */
  DynastyCheck = 15,
  /**
   * 看民族(阶段 3 同化与迁徙,assimilation.ts;编号 20–24):a = 立国后第几次看(按年份段编号),b = 国家。
   * 国家隔几十年看一眼治下的各州:异族州被统治久了、离核心近、四周同族多,就改换成统治民族(同化);
   * 统治民族太少时反过来被多数民族同化;这些年打下来的州,游牧民族会迁人进来,被征服的民族会外迁
   */
  CultureCheck = 20,
  /** 同化(assimilation.ts):不单独预约,是一州改换民族时变化日志记的原因 */
  Assimilate = 21,
  /** 迁徙(assimilation.ts):不单独预约,是迁入的州改换民族时变化日志记的原因 */
  Migrate = 22,
  /**
   * 看孤地(assimilation.ts):a = 第几次看。每隔几十年看一眼部落地带(没有国家的州)里被别族团团围住的孤地:
   * 久了会被四邻同化(日志原因记 Assimilate)
   */
  EnclaveCheck = 23,
  /**
   * 看重建(阶段 3 城市兴衰,cities.ts):a = 城被毁后第几次看,b = 被毁的城。
   * 州里有人住、战火已息,就有机会在故址上重建一座新城;看够次数都没建 = 就此荒废
   */
  CityRebuild = 25,
  /**
   * 看旧都(cities.ts):a = 这座城的第几段国都(Settlement.capitalSpans 的下标),b = 城。
   * 失去国都之位约一百多年后,人口明显回落的记一条"旧都渐衰"
   */
  CityDecline = 26,
  /**
   * 干预(阶段 4,interventions.ts;编号 30–35):a = 第几条干预(干预列表的下标)。在它的年份(from)那一刻生效:
   * 记一条史事 intervene,结盟时正在交战的两国当即议和,宣战的强制开战,划州、立国、迁都当即改归属 / 国都,
   * 不许扩张的国家挑起的战争当即议和。在所有别的事件之前预约(同一刻里最先处理)
   */
  Intervene = 30,
  /** 划州(interventions.ts):不单独预约,是干预"划州"(和立国时带走的余州)改归属时变化日志记的原因 */
  Cede = 31,
  /**
   * 不许扩张到期(interventions.ts):a = 第几条干预。到 until 那一刻,这国从现有国土重新预约往外扩张
   * (禁令期间的"国家到达"都丢掉了)。在所有别的事件之前预约(同一刻里比干预事件还早)
   */
  HaltEnd = 32,
}

export interface EventInfo {
  id: number;
  name: string;
  /** 弹出时是否核对州 a 的版本号(预约之后州 a 的归属变过 → 过期丢掉) */
  watch: boolean;
}

/** 事件类型表。阶段 3 在末尾往下加(宣战、战役、攻占、分裂、合并、灭亡、迁都、瘟疫……) */
export const EVENT_INFO: EventInfo[] = [
  { id: Ev.None, name: '无', watch: false },
  { id: Ev.CultureBorn, name: '民族诞生', watch: false },
  { id: Ev.CultureArrive, name: '民族到达', watch: true },
  { id: Ev.SettlementFound, name: '建城', watch: false },
  { id: Ev.PolityFound, name: '立国', watch: false },
  { id: Ev.PolityArrive, name: '国家到达', watch: true },
  { id: Ev.PolityRank, name: '升格', watch: false },
  { id: Ev.WarCheck, name: '看邻国', watch: false },
  { id: Ev.Campaign, name: '战役', watch: false },
  { id: Ev.Conquer, name: '攻占', watch: false },
  { id: Ev.PoliticsCheck, name: '看内政', watch: false },
  { id: Ev.Split, name: '分裂', watch: false },
  { id: Ev.Merge, name: '合并', watch: false },
  { id: Ev.RestoreCheck, name: '看复国', watch: false },
  { id: Ev.TribalCheck, name: '看部落地带', watch: false },
  { id: Ev.DynastyCheck, name: '看王朝', watch: false },
  { id: Ev.CultureCheck, name: '看民族', watch: false },
  { id: Ev.Assimilate, name: '同化', watch: false },
  { id: Ev.Migrate, name: '迁徙', watch: false },
  { id: Ev.EnclaveCheck, name: '看孤地', watch: false },
  { id: Ev.CityRebuild, name: '看重建', watch: false },
  { id: Ev.CityDecline, name: '看旧都', watch: false },
  { id: Ev.Intervene, name: '干预', watch: false },
  { id: Ev.Cede, name: '划州', watch: false },
  { id: Ev.HaltEnd, name: '解除禁扩', watch: false },
];

/** 检查点间隔(年) */
export const CHECKPOINT_EVERY = 100;

/** 事件时间精度:1/256 年(约一天半) */
const TICKS_PER_YEAR = 256;
/** 优先级 = 时刻 × SEQ_SPAN + 编号;两者都是整数,拼起来不超过 2^52,Float64 里精确 */
const SEQ_SPAN = 2 ** 28;
/** 能预约的最远时刻:65536 年(Float32 的变化日志在这个范围内也能精确存下 1/256 年) */
const MAX_TICK = 2 ** 24;

/** 把时间取整到引擎的精度(1/256 年)。引擎里所有事件时间、日志年份都是这样的值 */
export function quantize(t: number): number {
  return Math.round(t * TICKS_PER_YEAR) / TICKS_PER_YEAR;
}

export type EventHandler = (a: number, b: number, t: number) => void;
export type ChangeListener = (region: number, value: number, prev: number, cause: number) => void;

/** 可增长的变化日志(结构数组) */
class LogBuffer {
  size = 0;
  year: Float32Array;
  region: Int32Array;
  layer: Uint8Array;
  value: Int16Array;
  cause: Uint8Array;
  constructor(cap = 1024) {
    this.year = new Float32Array(cap);
    this.region = new Int32Array(cap);
    this.layer = new Uint8Array(cap);
    this.value = new Int16Array(cap);
    this.cause = new Uint8Array(cap);
  }
  static from(log: ChangeLog): LogBuffer {
    const b = new LogBuffer(Math.max(1024, log.size * 2));
    b.size = log.size;
    b.year.set(log.year.subarray(0, log.size));
    b.region.set(log.region.subarray(0, log.size));
    b.layer.set(log.layer.subarray(0, log.size));
    b.value.set(log.value.subarray(0, log.size));
    b.cause.set(log.cause.subarray(0, log.size));
    return b;
  }
  push(year: number, region: number, layer: number, value: number, cause: number) {
    if (this.size === this.year.length) {
      const cap = this.size * 2;
      const grow = <T extends Float32Array | Int32Array | Uint8Array | Int16Array>(a: T, make: (n: number) => T): T => {
        const b = make(cap);
        b.set(a);
        return b;
      };
      this.year = grow(this.year, (n) => new Float32Array(n));
      this.region = grow(this.region, (n) => new Int32Array(n));
      this.layer = grow(this.layer, (n) => new Uint8Array(n));
      this.value = grow(this.value, (n) => new Int16Array(n));
      this.cause = grow(this.cause, (n) => new Uint8Array(n));
    }
    const i = this.size++;
    this.year[i] = year;
    this.region[i] = region;
    this.layer[i] = layer;
    this.value[i] = value;
    this.cause[i] = cause;
  }
  /** 裁成正好 size 条的副本(发给主线程用) */
  toChangeLog(): ChangeLog {
    const n = this.size;
    return {
      size: n,
      year: this.year.slice(0, n),
      region: this.region.slice(0, n),
      layer: this.layer.slice(0, n),
      value: this.value.slice(0, n),
      cause: this.cause.slice(0, n),
    };
  }
}

/** 推演结果:写回 Civ 的那几项 */
export interface SimResult {
  endYear: Year;
  log: ChangeLog;
  checkpoints: Checkpoint[];
  /** endYear 时各州的民族 */
  culture: Int16Array;
  /** endYear 时各州的国家 */
  polity: Int16Array;
  /** 史事(按发生先后) */
  annals: Annal[];
}

export class CivSim {
  /** 州数 */
  readonly R: number;
  /** 当前时间(年) */
  now: Year = 0;
  /** 各层的当前归属(按 Layer 下标);只读,改归属一律走 setOwner */
  readonly owners: [Int16Array, Int16Array];
  /** 各州的版本号:归属(任何一层)每变一次 +1 */
  readonly version: Int32Array;

  private log = new LogBuffer();
  private annals: Annal[] = [];
  private checkpoints: Checkpoint[] = [];
  private nextCheckpoint = CHECKPOINT_EVERY;

  // 事件:结构数组 + 空槽回收;堆里放槽号,优先级 = 时刻 × SEQ_SPAN + 编号
  private heap = new MinHeap(1024);
  private evT = new Float64Array(1024);
  private evKind = new Uint8Array(1024);
  private evA = new Int32Array(1024);
  private evB = new Int32Array(1024);
  private evVer = new Int32Array(1024);
  private evCount = 0;
  private free: number[] = [];
  private seq = 0;

  private handlers: (EventHandler | undefined)[] = [];
  private watch = new Uint8Array(256);
  private listeners: ChangeListener[][] = [[], []];

  /** 推演过程中处理了多少个事件(含过期丢掉的),调参 / 测试用 */
  processed = 0;

  constructor(regionCount: number) {
    this.R = regionCount;
    this.owners = [new Int16Array(regionCount).fill(-1), new Int16Array(regionCount).fill(-1)];
    this.version = new Int32Array(regionCount);
    for (const e of EVENT_INFO) this.watch[e.id] = e.watch ? 1 : 0;
  }

  /**
   * 由 Civ 数据重建推演状态(各层归属、版本号、日志、检查点),再让各层重建待发生的事件,
   * 然后就能从 civ.endYear 接着推:sim.run(更晚的年份)。不需要保存事件堆,阶段 4 的存档也只存 Civ。
   * interventions = 接着推时带着的干预(阶段 4;默认 = 这份历史推出来时带着的 civ.interventions):
   * 已经过了的只影响之后的决定(规则),还没到的补上它们的事件
   */
  static fromCiv(world: World, civ: Civ, interventions: readonly Intervention[] = civ.interventions ?? []): CivSim {
    const sim = new CivSim(civ.regions.count);
    sim.owners[Layer.Culture].set(civ.culture);
    sim.owners[Layer.Polity].set(civ.polity);
    sim.log = LogBuffer.from(civ.log);
    sim.annals = civ.annals.map((e) => ({ ...e }));
    for (let i = 0; i < civ.log.size; i++) sim.version[civ.log.region[i]]++;
    sim.checkpoints = civ.checkpoints.slice();
    sim.now = civ.endYear;
    sim.nextCheckpoint = (Math.floor(civ.endYear / CHECKPOINT_EVERY) + 1) * CHECKPOINT_EVERY;
    // 各层重建自己的事件(和 generateCiv 里 install 的顺序一样:先民族,再城镇和国家,再战争,再分合,再王朝,再同化与迁徙,
    // 再城市兴衰 —— 它要挂在战争模型上(攻城)、要国家模型的迁都回调,放最后)
    if (civ.viable && civ.cultures.length) {
      // 干预的事件最先预约(和 generateCiv 一样:同一刻里先于别的一切事件)
      const iv = scheduleInterventions(sim, civ.seed, interventions, true);
      resumeCultures(sim, world, civ);
      resumePolities(sim, world, civ, iv);
      resumeWars(sim, world, civ);
      resumePolitics(sim, world, civ);
      resumeDynasty(sim, world, civ);
      resumeAssimilation(sim, world, civ);
      resumeCities(sim, world, civ);
      if (iv) resumeInterventions(sim, iv);
    }
    return sim;
  }

  /** 登记某类事件的处理函数。watch 不给就按 EVENT_INFO 表 */
  on(kind: number, handler: EventHandler, opts: { watch?: boolean } = {}): void {
    this.handlers[kind] = handler;
    if (opts.watch !== undefined) this.watch[kind] = opts.watch ? 1 : 0;
  }

  /** 登记某一层归属变化的监听者(setOwner 之后同步调用) */
  onChange(layer: Layer, fn: ChangeListener): void {
    this.listeners[layer].push(fn);
  }

  /**
   * 预约一个事件。t 早于现在就按现在算;取整到 1/256 年;超出 65536 年或不是有限数就不预约。
   * 要核对版本号的类型,记下州 a 此刻的版本号。
   */
  schedule(t: number, kind: number, a: number, b: number): void {
    if (!(t < Infinity)) return; // Infinity / NaN
    const tick = Math.round(Math.max(t, this.now) * TICKS_PER_YEAR);
    if (tick >= MAX_TICK) return;
    if (this.seq >= SEQ_SPAN) throw new Error('CivSim:事件太多(超过 2^28 个)');
    let id: number;
    if (this.free.length) id = this.free.pop()!;
    else {
      id = this.evCount++;
      if (id === this.evT.length) this.growEvents();
    }
    this.evT[id] = tick / TICKS_PER_YEAR;
    this.evKind[id] = kind;
    this.evA[id] = a;
    this.evB[id] = b;
    this.evVer[id] = this.watch[kind] && a >= 0 && a < this.R ? this.version[a] : -1;
    this.heap.push(id, tick * SEQ_SPAN + this.seq++);
  }

  /** 待处理的事件数(含已过期、还没弹出的) */
  get pending(): number {
    return this.heap.size;
  }

  /** 唯一改归属的入口:写日志、版本号 +1、通知这一层的监听者。新值等于旧值时什么都不做 */
  setOwner(layer: Layer, region: number, value: number, cause: number): void {
    const own = this.owners[layer];
    const prev = own[region];
    if (prev === value) return;
    own[region] = value;
    this.version[region]++;
    this.log.push(this.now, region, layer, value, cause);
    for (const fn of this.listeners[layer]) fn(region, value, prev, cause);
  }

  /**
   * 记一条史事(年份 = 现在)。没给的字段记 −1;各种类用哪些字段见 types.ts 的 AnnalKind。
   * 只记,不改归属;改归属还是走 setOwner。
   */
  record(kind: AnnalKind, f: Partial<Omit<Annal, 'year' | 'kind'>> = {}): void {
    this.annals.push({
      year: this.now,
      kind,
      a: f.a ?? -1,
      b: f.b ?? -1,
      region: f.region ?? -1,
      settlement: f.settlement ?? -1,
      war: f.war ?? -1,
    });
  }

  /** 推演到 untilYear(含这一年的事件);途中每过一个整百年存一个检查点 */
  run(untilYear: Year): void {
    const untilTick = Math.floor(untilYear * TICKS_PER_YEAR + 1e-9);
    const limit = (untilTick + 1) * SEQ_SPAN;
    const heap = this.heap;
    while (heap.size && heap.pri[0] < limit) {
      const id = heap.pop();
      const t = this.evT[id];
      while (this.nextCheckpoint <= untilYear && t > this.nextCheckpoint) this.checkpoint();
      if (t > this.now) this.now = t;
      const kind = this.evKind[id];
      const a = this.evA[id];
      const b = this.evB[id];
      const ver = this.evVer[id];
      this.free.push(id);
      this.processed++;
      if (ver >= 0 && this.version[a] !== ver) continue; // 过期
      this.handlers[kind]?.(a, b, t);
    }
    while (this.nextCheckpoint <= untilYear) this.checkpoint();
    if (untilYear > this.now) this.now = untilYear;
  }

  /** 推演结果(日志裁成正好的长度;归属数组是副本) */
  result(): SimResult {
    return {
      endYear: this.now,
      log: this.log.toChangeLog(),
      checkpoints: this.checkpoints.slice(),
      culture: this.owners[Layer.Culture].slice(),
      polity: this.owners[Layer.Polity].slice(),
      annals: this.annals.map((e) => ({ ...e })),
    };
  }

  private checkpoint() {
    this.checkpoints.push({
      year: this.nextCheckpoint,
      culture: this.owners[Layer.Culture].slice(),
      polity: this.owners[Layer.Polity].slice(),
    });
    this.nextCheckpoint += CHECKPOINT_EVERY;
  }

  private growEvents() {
    const n = this.evT.length * 2;
    const t = new Float64Array(n);
    t.set(this.evT);
    this.evT = t;
    const k = new Uint8Array(n);
    k.set(this.evKind);
    this.evKind = k;
    const a = new Int32Array(n);
    a.set(this.evA);
    this.evA = a;
    const b = new Int32Array(n);
    b.set(this.evB);
    this.evB = b;
    const v = new Int32Array(n);
    v.set(this.evVer);
    this.evVer = v;
  }
}
