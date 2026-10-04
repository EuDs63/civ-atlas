/**
 * 干预(阶段 4):作者在某一年给历史下的"命令" —— 不许灭、结盟、宣战、禁止分裂、划州、立国、迁都、不许扩张
 * (种类、字段、年份语义见 gen/edits.ts 文件头)。推演时在这里执行;挂在同一个推演引擎(sim.ts)上,改归属照旧走 setOwner,
 * 这里只定规则、下命令。
 *
 * 做法:**带着干预从第 0 年整段重推**(推演确定、便宜:文明部分一两百毫秒)。
 *   - 干预年份之前和不干预时逐字节一致:规则只在"年份 ≥ from"时生效;每条干预在 from 那一刻有一个事件(Ev.Intervene),
 *     在所有别的事件之前预约(scheduleInterventions:同一刻里最先处理),别的事件之间的先后不变;
 *     随机数照旧 keyed(和处理顺序无关),干预前的随机数一个都不变。
 *   - 干预年份之后按新规则展开,受波及的地方才变。
 *
 * 国家用稳定键(`polity:c4567#0`,见 edits.ts):要用时才解析成编号。键只由"立国时国都在哪州 + 这州第几个立国"定
 *   (州按地块找:包含地块 4567 的那一州;旧格式 `polity:r123#0` 直接是州号),国家一立国键就定了,
 *   所以按立国先后增量建一张"州号#第几个 → 编号"表即可(和 edits.ts 的 resolveKey 一致,有单测)。
 *   城键(`settlement:c4567#1`,迁都用)同理:按建城先后增量建。州键(`region:c4567`)= 包含这个地块的州。
 *   键指不到(新历史里没有这个国家、或者还没立国;改地形后那块地方成了水)= 这条干预此刻不生效,不报错。
 *
 * 各机制在做决定的地方查一下(WarModel.iv、PolityModel.iv;没有干预时为空,只多一次判空,推演不变慢):
 *   不许灭 protect   wars.ts 挑要打的州时跳过它的国都所在州,只剩几州时一州都不打(国都攻不下 → 不会亡国,也不会因丢了国都残部被并);
 *                   politics.ts 的合并不会把它并掉。国土照样会丢(可以缩小),照样会分裂、改朝换代。
 *                   有 until 的:until 那一刻起不再护着(都是做决定时现查,不用另外预约事件),之后照常会被攻灭、被并
 *   结盟   ally      wars.ts 看邻国时不对盟国宣战;结盟那一刻两国若在交战,当即议和;
 *                   一方被第三国宣战时,另一方(和攻方接壤)多半援盟参战(见 wars.ts 的 ALLY_JOIN;史事 war 的 settlement 列记盟国)
 *   宣战   declare   from 那一刻强制开战(不管停战冷却、歇战、同时在打几场);两国不接壤 / 已在交战 / 有一方已亡 = 打不成
 *   禁止分裂 unity   politics.ts 的分裂不会发生;它的国土里不会有遗民起兵复国
 *   划州   cede      from 那一刻州归 a(setOwner,原因 Ev.Cede;州里没人住 / a 已亡 = 划不成)。原主国照常:划走的是它的国都就迁都到
 *                   剩下的城里人口最多的(和战争里国都失守一样挑),剩下的州里一座城都没有就连同余州归 a、亡国;只有这一州的就亡了。
 *                   带"永久"的:这州还在 a 手里时 —— wars.ts 攻不下、议和不割让,a 丢了国都也不会被并掉残部;
 *                   politics.ts 分裂、复国不带走它(被切断就这次不分),a 是小国也不会被合并掉(locked / holdsLock)
 *   立国   found     from 那一刻以这州的城为国都立一个新国家(polities.ts 的 addPolity;州里没城就先建城 —— 故城遗址上的算重建;
 *                   民族 = 当地民族;变化日志原因记 Ev.PolityFound,和自然立国一样:之后按正常规则扩张、打仗、看内政……)。
 *                   州原来有主的,新国从原主分出来(Polity.parent:站稳期里别国不来打,配色和原主错开);原主照"划州"那样迁都 / 亡国。
 *                   国名:给了就用(namePolities 不再另起),不给按常规起
 *   迁都   move      from 那一刻迁都到这座城(polities.ts 的 moveCapital;城要在 a 的国土里、没被毁,否则不迁)
 *   不许扩张 halt    polities.ts 的"国家到达"不去(不进无主的州);wars.ts 看邻国时不宣战、不援盟;politics.ts 不合并别国;
 *                   from 那一刻它挑起的(它是攻方的)战争当即议和。被打时照常防守、反攻夺回自己的州(守方的反攻本来就只打丢掉的州)。
 *                   有 until 的:until 那一刻(Ev.HaltEnd,比同一刻的一切事件都早)从现有国土重新预约扩张(polities.ts 的 respread)
 *
 * 每条干预在 from 那一刻记一条史事 intervene(字段见 types.ts 的 AnnalKind;A 的键指不到就不记),编年史写"【干预】……"。
 * 紧跟着记它引起的事:宣战的 war、结盟 / 不许扩张引起的 peace、立国的 found、迁都的 capital、原主国迁都的 capital / 亡国的 fall。
 *
 * **不存内存状态**:Civ + 干预列表就能接着推(CivSim.fromCiv(world, civ, 干预列表)):规则本来就只看列表和当时的归属,
 *   还没到 from / until 的事件由 scheduleInterventions 按"比现在晚"补上;已经过去的"不许扩张到期"那一刻预约的扩张,
 *   由 resumePolities 按日志重放补上(haltEndsUpTo)。纯计算,不碰 DOM。
 */
import { cleanInterventions, keyByRegion, regionOfKey, type Intervention } from '../edits';
import { Layer, type Polity } from './types';
import { subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { addPolity, endPolity, foundCity, moveCapital, polityModelOf, respread, type PolityModel } from './polities';
import { bestCapital, polityBorders, warModelOf } from './wars';
import { capitalAt } from './growth';
import { REBUILD_GROWTH } from './cities';

type Ally = Extract<Intervention, { kind: 'ally' }>;
type Halt = Extract<Intervention, { kind: 'halt' }>;
type Cede = Extract<Intervention, { kind: 'cede' }>;
type Found = Extract<Intervention, { kind: 'found' }>;
type Move = Extract<Intervention, { kind: 'move' }>;

/** 推演里的干预:清理过的列表 + 键 → 编号的解析 + 各机制查询用的规则 */
export class InterventionModel {
  readonly list: readonly Intervention[];
  /** keyed 随机数的根(援盟) */
  readonly base: number;
  /** 城镇 / 国家模型(installInterventions 时挂上;解析键要用) */
  pm: PolityModel | null = null;
  /** 国家层的归属(installInterventions 时挂上;永久划州要看州此刻在谁手里) */
  owner: Int16Array | null = null;
  private readonly protectRules: Extract<Intervention, { kind: 'protect' }>[];
  private readonly unityRules: Extract<Intervention, { kind: 'unity' }>[];
  private readonly allyRules: Ally[];
  private readonly haltRules: Halt[];
  /** 永久划州:州号、得到它的国家(键)、年份(州键要按地块找州:挂上国家模型时才解析,见 bindRegions) */
  private lockRules: { region: number; a: string; from: number }[] = [];
  /** 有永久划州的州(先查它,别的州不用扫规则) */
  private readonly lockRegions = new Set<number>();
  /** 稳定键 → 按州定位的内部键(`polity:123#0`;解析一次记下;null = 格式不对 / 那块地方是水) */
  private readonly refs = new Map<string, string | null>();
  /** 内部键 `polity:123#0` → 国家编号(按立国先后增量建);known = 已经登记到第几个国家 */
  private readonly ids = new Map<string, number>();
  private readonly perRegion = new Map<number, number>();
  private known = 0;
  /** 内部键 `settlement:123#0` → 城编号(按建城先后增量建) */
  private readonly cityIds = new Map<string, number>();
  private readonly cityPerRegion = new Map<number, number>();
  private knownCities = 0;

  constructor(list: readonly Intervention[], seed: number) {
    this.list = list;
    this.base = subSeed(seed, 'civ-intervene');
    this.protectRules = list.filter((v): v is Extract<Intervention, { kind: 'protect' }> => v.kind === 'protect');
    this.unityRules = list.filter((v): v is Extract<Intervention, { kind: 'unity' }> => v.kind === 'unity');
    this.allyRules = list.filter((v): v is Ally => v.kind === 'ally');
    this.haltRules = list.filter((v): v is Halt => v.kind === 'halt');
  }

  /** 地块 → 州(国家模型挂上以后才有;按地块定位的键靠它找州) */
  get of(): ArrayLike<number> {
    return this.pm?.terrain.regions.of ?? [];
  }

  /** 挂上国家模型以后(installInterventions):解析永久划州的州键 */
  bindRegions(): void {
    const of = this.of;
    this.lockRules = this.list
      .filter((v): v is Cede => v.kind === 'cede' && v.permanent === true)
      .map((v) => ({ region: regionOfKey(v.region, of), a: v.a, from: v.from }))
      .filter((x) => x.region >= 0);
    this.lockRegions.clear();
    for (const x of this.lockRules) this.lockRegions.add(x.region);
  }

  /** 稳定键 → 按州定位的内部键(见 edits.ts 的 keyByRegion) */
  private ref(key: string): string | null {
    let r = this.refs.get(key);
    if (r === undefined) {
      r = keyByRegion(key, this.of);
      if (this.pm) this.refs.set(key, r);
    }
    return r;
  }

  /** 国家的稳定键 → 此刻的国家编号(还没立国 / 新历史里没有 = −1) */
  resolve(key: string): number {
    const pm = this.pm;
    if (!pm) return -1;
    const P = pm.polities;
    for (; this.known < P.length; this.known++) {
      // 和 edits.ts 的 polityKey 同一个算法:立国时的国都所在州 + 这州第几个立国(国家按立国先后编号)
      const r = pm.settlements[P[this.known].capital]?.region ?? -1;
      const n = this.perRegion.get(r) ?? 0;
      this.perRegion.set(r, n + 1);
      this.ids.set(`polity:${r}#${n}`, this.known);
    }
    const k = this.ref(key);
    return k === null ? -1 : (this.ids.get(k) ?? -1);
  }

  /** 国家的稳定键 → t 那一刻之前(不含这一刻)已经立国的国家编号(接着推时重放过去的某一刻用) */
  resolveBefore(key: string, t: number): number {
    const id = this.resolve(key);
    return id >= 0 && this.pm!.polities[id].founded < t ? id : -1;
  }

  /** 城的稳定键 → 此刻的城编号(还没建 / 新历史里没有 = −1;和 edits.ts 的 settlementKey 同一个算法) */
  resolveCity(key: string): number {
    const pm = this.pm;
    if (!pm) return -1;
    const S = pm.settlements;
    for (; this.knownCities < S.length; this.knownCities++) {
      const r = S[this.knownCities].region;
      const n = this.cityPerRegion.get(r) ?? 0;
      this.cityPerRegion.set(r, n + 1);
      this.cityIds.set(`settlement:${r}#${n}`, this.knownCities);
    }
    const k = this.ref(key);
    return k === null ? -1 : (this.cityIds.get(k) ?? -1);
  }

  /** 国家 p 此刻"不许灭" */
  protects(p: number, t: number): boolean {
    for (const v of this.protectRules) if (t >= v.from && (v.until === undefined || t < v.until) && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 国家 p 此刻"禁止分裂" */
  unites(p: number, t: number): boolean {
    for (const v of this.unityRules) if (t >= v.from && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 国家 p 此刻"不许扩张" */
  halted(p: number, t: number): boolean {
    for (const v of this.haltRules) if (haltActive(v, t) && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 州 r 此刻是"永久划给"它现在的主人的(战争、分裂、复国、议和割地都拿不走) */
  locked(r: number, t: number): boolean {
    if (!this.lockRegions.has(r)) return false;
    const o = this.owner ? this.owner[r] : -1;
    if (o < 0) return false;
    for (const v of this.lockRules) if (v.region === r && t >= v.from && this.resolve(v.a) === o) return true;
    return false;
  }

  /** 国家 p 此刻手里有永久划给它的州 */
  holdsLock(p: number, t: number): boolean {
    if (!this.lockRules.length || !this.owner) return false;
    for (const v of this.lockRules) if (t >= v.from && this.owner[v.region] === p && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 两国此刻结着盟 */
  allied(p: number, q: number, t: number): boolean {
    for (const v of this.allyRules) {
      if (!allyActive(v, t)) continue;
      const a = this.resolve(v.a);
      const b = this.resolve(v.b);
      if ((a === p && b === q) || (a === q && b === p)) return true;
    }
    return false;
  }

  /** 此刻和 p 结着盟的国家(编号升序,不重复) */
  alliesOf(p: number, t: number): number[] {
    const out: number[] = [];
    for (const v of this.allyRules) {
      if (!allyActive(v, t)) continue;
      const a = this.resolve(v.a);
      const b = this.resolve(v.b);
      const o = a === p ? b : b === p ? a : -1;
      if (o >= 0 && o !== p && !out.includes(o)) out.push(o);
    }
    return out.sort((x, y) => x - y);
  }

  /** 到 now(含)为止已经到期的"不许扩张"(到期时刻、国家键;按处理先后:时刻先后,同一刻按列表先后) */
  haltEndsUpTo(now: number): { t: number; key: string }[] {
    const out: { t: number; key: string }[] = [];
    for (const v of this.haltRules) if (v.until !== undefined && quantize(v.until) <= now) out.push({ t: quantize(v.until), key: v.a });
    return out.sort((x, y) => x.t - y.t);
  }
}

const allyActive = (v: Ally, t: number) => t >= v.from && (v.until === undefined || t < v.until);
const haltActive = (v: Halt, t: number) => t >= v.from && (v.until === undefined || t < v.until);

const models = new WeakMap<CivSim, InterventionModel>();

/** 推演引擎上挂着的干预(测试用) */
export function interventionModelOf(sim: CivSim): InterventionModel | undefined {
  return models.get(sim);
}

/**
 * 预约各条干预的事件(在所有别的事件之前调用:同一刻里干预最先处理;"不许扩张到期"又比干预事件更早)。
 * generateCiv 里全部预约;fromCiv 接着推(resume)时只预约比现在晚的(已经到了的在切开之前就处理过了)。
 * 没有(合格的)干预 = null,什么都不做
 */
export function scheduleInterventions(
  sim: CivSim,
  seed: number,
  raw: readonly Intervention[] | undefined,
  resume = false,
): InterventionModel | null {
  const list = cleanInterventions(raw);
  if (!list.length) return null;
  const iv = new InterventionModel(list, seed);
  list.forEach((v, i) => {
    if (v.kind === 'halt' && v.until !== undefined && (!resume || quantize(v.until) > sim.now)) sim.schedule(v.until, Ev.HaltEnd, i, 0);
  });
  list.forEach((v, i) => {
    if (!resume || quantize(v.from) > sim.now) sim.schedule(v.from, Ev.Intervene, i, 0);
  });
  return iv;
}

/** 登记干预的事件处理,把规则挂到战争模型、城镇国家模型上(installCities / resumeCities 之后调用) */
export function installInterventions(sim: CivSim, iv: InterventionModel): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  if (!pm || !wm) return;
  models.set(sim, iv);
  iv.pm = pm;
  iv.owner = sim.owners[Layer.Polity];
  iv.bindRegions();
  wm.iv = iv;
  pm.iv = iv;
  const owner = sim.owners[Layer.Polity];
  const culture = sim.owners[Layer.Culture];
  const R = pm.terrain.R;
  const S = pm.settlements;
  const alive = (p: number) => pm.polities[p].ended === undefined;
  const capRegion = (p: number, t: number) => S[capitalAt(pm.polities[p], t)].region;

  /** 国家 o 没了最后一州(被划走 / 在那里另立新国;by = 得到它的国家):亡国,它打着的仗全部结束(和战争里亡国一样记 fall) */
  const fallen = (o: number, r: number, t: number, by: number) => {
    sim.record('fall', { a: o, b: by, region: r });
    for (const w of wm.active.filter((x) => x.a === o || x.b === o)) wm.makePeace!(w, t);
  };

  /**
   * 国家 o 的国都所在州 r 要归别国:先挑新国都(剩下的国土里,和战争里国都失守时一样挑;那一块里没城就到别的块里挑)。
   * 返回新国都;剩下的州里一座城都没有 = −1(调用方让余州一并归过去、亡国)
   */
  const relocate = (o: number, r: number, t: number): number => {
    const sid = bestCapital(pm, owner, o, t, true, r);
    if (sid >= 0) moveCapital(pm, o, sid, t);
    return sid;
  };

  /** 划州:州 r 归 a */
  const cede = (v: Cede, i: number, a: number, t: number) => {
    const r = regionOfKey(v.region, iv.of);
    if (r < 0 || r >= R) {
      sim.record('intervene', { a, b: -2, war: i });
      return;
    }
    const o = owner[r];
    const peopled = culture[r] >= 0;
    sim.record('intervene', { a, b: peopled ? o : -2, region: r, settlement: pm.cityOf[r], war: i });
    if (!alive(a) || !peopled || o === a) return;
    const wasCap = o >= 0 && capRegion(o, t) === r;
    const sid = wasCap && pm.size[o] > 1 ? relocate(o, r, t) : -1;
    sim.setOwner(Layer.Polity, r, a, Ev.Cede);
    if (o < 0) return;
    if (!wasCap) {
      // 国都所在州总归本国所有,所以不是国都的这一州划走后原主总还有地;万一没了(不该发生),照样算亡国,不留"没有国土的国家"
      if (pm.size[o] <= 0) {
        endPolity(pm, o, t);
        fallen(o, r, t, a);
      }
      return;
    }
    if (sid >= 0) {
      sim.record('capital', { a: o, region: S[sid].region, settlement: sid });
      return;
    }
    // 原主只有这一州,或者剩下的州里一座城都没有(极少见):余州一并归 a,亡国
    for (const q of pm.lands[o].slice()) sim.setOwner(Layer.Polity, q, a, Ev.Cede);
    endPolity(pm, o, t);
    fallen(o, r, t, a);
  };

  /** 立国:以州 r 的城为国都立新国 */
  const found = (v: Found, i: number, t: number) => {
    const r = regionOfKey(v.region, iv.of);
    if (r < 0 || r >= R || culture[r] < 0) {
      sim.record('intervene', { region: r < R ? r : -1, war: i });
      return;
    }
    const o = owner[r];
    // 原主的国都在这州:先迁都(国都之位先让出来,新国的国都才记得上),剩下的州里没城 / 只有这一州就亡国
    let moved = -1;
    let dies = false;
    if (o >= 0 && capRegion(o, t) === r) {
      moved = pm.size[o] > 1 ? relocate(o, r, t) : -1;
      if (moved < 0) {
        dies = true;
        endPolity(pm, o, t);
      }
    }
    // 州里没城(还没建起来,或者毁了没重建):先建城(故城遗址上的算重建)
    let sid = pm.cityOf[r];
    if (sid < 0) {
      let ruin = -1;
      for (const s of S) if (s.region === r && s.ended !== undefined) ruin = s.id;
      sid = foundCity(sim, pm, r, t, ruin >= 0 ? { of: ruin, growth: REBUILD_GROWTH } : undefined).id;
    }
    const extra: Partial<Polity> = {};
    if (v.name) extra.name = v.name;
    if (o >= 0) extra.parent = o;
    const p = addPolity(pm, sid, culture[r], t, extra);
    sim.record('intervene', { a: p.id, b: o, region: r, settlement: sid, war: i });
    sim.record('found', { a: p.id, region: r, settlement: sid });
    sim.setOwner(Layer.Polity, r, p.id, Ev.PolityFound);
    if (o < 0) return;
    if (moved >= 0) sim.record('capital', { a: o, region: S[moved].region, settlement: moved });
    else if (dies) {
      for (const q of pm.lands[o].slice()) sim.setOwner(Layer.Polity, q, p.id, Ev.Cede);
      fallen(o, r, t, p.id);
    } else if (pm.size[o] <= 0) {
      // 同划州:不该发生,万一原主没地了照样算亡国
      endPolity(pm, o, t);
      fallen(o, r, t, p.id);
    }
  };

  /** 迁都:a 迁都到城 v.city */
  const move = (v: Move, i: number, a: number, t: number) => {
    const sid = iv.resolveCity(v.city);
    const s = sid >= 0 ? S[sid] : undefined;
    // b 列:城所在州此刻的主人(= a 才迁得成;−1 = 部落地带),城已毁 = −2
    const b = !s ? -1 : s.ended !== undefined ? -2 : owner[s.region];
    sim.record('intervene', { a, b, region: s ? s.region : -1, settlement: sid, war: i });
    if (!s || !alive(a) || b !== a || capitalAt(pm.polities[a], t) === sid) return;
    moveCapital(pm, a, sid, t);
    sim.record('capital', { a, region: s.region, settlement: sid });
  };

  sim.on(Ev.Intervene, (i, _b, t) => {
    const v = iv.list[i];
    if (!v) return;
    if (v.kind === 'found') {
      found(v, i, t);
      return;
    }
    const a = iv.resolve(v.a);
    if (a < 0) return; // 键指不到:这条干预在新历史里没有对象
    if (v.kind === 'cede') {
      cede(v, i, a, t);
      return;
    }
    if (v.kind === 'move') {
      move(v, i, a, t);
      return;
    }
    const b = v.kind === 'ally' || v.kind === 'declare' ? iv.resolve(v.b) : -1;
    const A = pm.polities[a];
    const sid = capitalAt(A, t);
    sim.record('intervene', { a, b, region: S[sid]?.region ?? -1, settlement: sid, war: i });
    if (v.kind === 'halt') {
      // 不许扩张:它挑起的战争当即议和
      if (alive(a)) for (const w of wm.active.filter((x) => x.a === a)) wm.makePeace!(w, t);
      return;
    }
    if (b < 0) return;
    const fighting = wm.active.filter((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
    if (v.kind === 'ally') {
      // 结盟:正在交战的当即议和
      for (const w of fighting) wm.makePeace!(w, t);
    } else if (v.kind === 'declare') {
      // 宣战:两国都在、没在交战、接壤,才打得成
      if (!alive(a) || !alive(b) || fighting.length || !polityBorders(pm, owner, a, b)) return;
      wm.declare!(a, b, t);
    }
  });

  // 不许扩张到期:从现有国土重新预约扩张(禁令期间的"国家到达"都丢掉了)
  sim.on(Ev.HaltEnd, (i) => {
    const v = iv.list[i];
    if (!v || v.kind !== 'halt') return;
    const a = iv.resolve(v.a);
    if (a >= 0 && alive(a)) respread(sim, pm, a);
  });
}

/** 接着推(CivSim.fromCiv 调用,在各层 resume 之后):和 installInterventions 一样 */
export function resumeInterventions(sim: CivSim, iv: InterventionModel): void {
  installInterventions(sim, iv);
}
