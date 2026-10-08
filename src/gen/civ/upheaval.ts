/**
 * 地形大事:作者选一年让火山喷发、大地抬升、海水漫进来(gen/edits.ts 文件头"地形大事")。那一年以前的历史一字不差,之后按新地形接着推。
 *
 * 做法(index.ts 的 generateCiv):
 *   1. 用原来的地形推到大事那一年的前一刻(和没有大事时同一次推演,所以之前的日志、史事逐字节相同)
 *   2. 套上这次的地形修改重新生成世界(upheavalSteps;gen/terrainEdits.ts:改动只在附近,远处的地块逐位不变),
 *      州沿用原来的划分和编号,只改地形变了的地方(regions.ts 的 reshapeRegions)
 *   3. CivSim.fromCiv 按新地形重建"接下来该发生什么",大事那一刻(同一刻里最先)按这里的规则处理后果,再接着推
 *
 * 大事那一刻的后果:
 *   - 记一条史事 upheaval(a = 第几件大事,region = 受灾最重的州),经过(哪些州沉了、连起了哪两块陆地……)记进 Civ.upheavals
 *   - 城:城址变成了水(沉入海中)、在火山脚下(山体半径的一半以内)的,城没了(史事 sunk)。沉入海的不再重建,毁于火山的过些年可能重建
 *   - 一块陆地也不剩的州:国家、民族都撤出(变化日志原因 Ev.Upheaval)。那是国都所在州的,先迁都(和战争里国都失守一样挑);
 *     国家一州也不剩 = 亡于天灾(史事 fall,b = −2),它打着的仗全部结束
 *   - 国都没了、州还在的:能迁就迁都;一座城也不剩的国家同样亡于天灾,余下的州成了无主之地
 * 之后的扩张、战争……照常:新冒出来的陆地(并进邻州的、新撒的州)有人渡海、走过去住,淹掉的州从此是海。
 *
 * 纯计算,不碰 DOM。
 */
import { generateWorld, type World, type WorldParams } from '../world';
import type { Sketch } from '../sketch';
import type { TerrainOp, Upheaval } from '../edits';
import { Layer, type Civ, type Polity, type Regions, type Settlement, type UpheavalFact, type Year } from './types';
import { computeHabitat } from './habitat';
import { buildRegions, reshapeRegions } from './regions';
import { ownersAt } from './timeline';
import { Ev, type CivSim } from './sim';
import { endPolity, moveCapital, polityModelOf } from './polities';
import { bestCapital, warModelOf, type War } from './wars';
import { capitalAt, populationAt } from './growth';
import { scheduleRebuild } from './cities';

/** 推演里的一件地形大事(同一年的已合成一件):年份、这件的地形修改、合进来的是作者列表里的哪几件、改后的世界 */
export interface UpheavalStep {
  year: number;
  ops: TerrainOp[];
  items: number[];
  world: World;
}

/** 推演结束的年份(index.ts 的默认值;这里不引 index.ts,免得循环引用) */
const END_YEAR = 3000;

/**
 * 作者的地形大事按年份排好,同一年的按列表先后合成一件(修改接在一起,items = 合进来的下标);
 * 年份不在 (0, endYear) 里的、一笔也没有的不算
 */
export function mergeUpheavals(list: readonly Upheaval[], endYear: Year = END_YEAR): { year: number; ops: TerrainOp[]; items: number[] }[] {
  const order = list
    .map((_, i) => i)
    .filter((i) => list[i].year > 0 && list[i].year < endYear && list[i].ops.length > 0)
    .sort((a, b) => list[a].year - list[b].year || a - b);
  const out: { year: number; ops: TerrainOp[]; items: number[] }[] = [];
  for (const i of order) {
    const u = list[i];
    const last = out[out.length - 1];
    if (last && last.year === u.year) {
      last.ops.push(...u.ops);
      last.items.push(i);
    } else out.push({ year: u.year, ops: u.ops.slice(), items: [i] });
  }
  return out;
}

/**
 * 推演用的几步(generateCiv 的 CivParams.upheavals):第 k 步的世界 = 原来的地形修改 + 前 k 步大事的修改,从头生成(和改地形一样)。
 * terrain、sketch = 这个世界本来的地形修改、草图;progress(k, n) = 开始生成第 k 步(共 n 步)
 */
export function upheavalSteps(
  params: WorldParams,
  terrain: readonly TerrainOp[],
  sketch: Sketch | null | undefined,
  list: readonly Upheaval[],
  opts: { endYear?: Year; progress?: (k: number, n: number) => void } = {},
): UpheavalStep[] {
  const merged = mergeUpheavals(list, opts.endYear);
  let ops: TerrainOp[] = terrain.slice();
  return merged.map((m, k) => {
    opts.progress?.(k, merged.length);
    ops = [...ops, ...m.ops];
    return { ...m, world: generateWorld(params, undefined, ops, sketch) };
  });
}

/** 世界坐标里两点的距离(x 绕一圈) */
function wrapDist(ax: number, ay: number, bx: number, by: number, W: number): number {
  let dx = Math.abs(ax - bx);
  if (dx > W / 2) dx = W - dx;
  return Math.hypot(dx, ay - by);
}

/** 离世界坐标 (px, py) 最近的、在州里的地块(没有 = −1) */
function nearestRegionCell(world: World, regions: Regions, px: number, py: number): number {
  const { x, y, n } = world.mesh;
  let best = -1;
  let bd = Infinity;
  for (let c = 0; c < n; c++) {
    if (regions.of[c] < 0) continue;
    const d = wrapDist(x[c], y[c], px, py, world.width);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** 一件地形大事在地图上改了什么(大事前后两份地形、两份州逐地块比;和历史无关) */
export interface UpheavalImpact {
  /** 变成水 / 变成陆地的地块数 */
  sunk: number;
  risen: number;
  /** 受灾最重的州:火山 = 第一座火山所在的州;否则 = 地块变得最多的老州;都没有 = 离第一笔最近的州(−1 = 找不到) */
  region: number;
  /** 一块陆地也不剩的州、沉掉一块的州、新陆地并进的老州、新划出来的州(编号见 UpheavalFact) */
  drowned: number[];
  shrunk: number[];
  grown: number[];
  added: number[];
  /** 隆起的新陆地连起了大事前分开的两块陆地:两边挨着新陆地最多的州(先多后少);没有 = null */
  joined: [number, number] | null;
}

/** 比较大事前(w0、r0)和大事后(w1、r1;reshapeRegions 出来的,编号沿用)的地形和州 */
export function upheavalImpact(w0: World, r0: Regions, w1: World, r1: Regions, ops: readonly TerrainOp[]): UpheavalImpact {
  const { n, adjStart, adj } = w0.mesh;
  const R0 = r0.count;
  const hit = new Float64Array(R0);
  const lost = new Uint8Array(R0);
  /** 大事前还有陆地的州(预览同一年的第二件时 r0 是那一年以前的州,有的已经被同一年的前一件淹没了) */
  const had = new Uint8Array(R0);
  const gain = new Uint8Array(r1.count);
  const rose = new Uint8Array(n);
  let sunk = 0;
  let risen = 0;
  for (let c = 0; c < n; c++) {
    const a = w0.water[c] === 0;
    const b = w1.water[c] === 0;
    if (a && r0.of[c] >= 0) had[r0.of[c]] = 1;
    if (a && !b) {
      sunk++;
      const r = r0.of[c];
      if (r >= 0) {
        hit[r]++;
        lost[r] = 1;
      }
    } else if (!a && b) {
      risen++;
      rose[c] = 1;
      const r = r1.of[c];
      if (r >= 0) {
        gain[r] = 1;
        if (r < R0) hit[r]++;
      }
    }
  }
  const cells = (rg: Regions, r: number) => rg.cellStart[r + 1] - rg.cellStart[r];
  const drowned: number[] = [];
  const shrunk: number[] = [];
  const grown: number[] = [];
  const added: number[] = [];
  for (let r = 0; r < R0; r++) {
    if (cells(r0, r) > 0 && had[r] && cells(r1, r) === 0) drowned.push(r);
    else if (lost[r]) shrunk.push(r);
    if (gain[r] && cells(r1, r) > 0) grown.push(r);
  }
  for (let r = R0; r < r1.count; r++) if (gain[r]) added.push(r);

  let region = -1;
  const volcano = ops.find((o) => o.kind === 'volcano');
  if (volcano) {
    const c = nearestRegionCell(w1, r1, volcano.pts[0], volcano.pts[1]);
    region = c >= 0 ? r1.of[c] : -1;
  } else {
    for (let r = 0; r < R0; r++) if (hit[r] > 0 && (region < 0 || hit[r] > hit[region])) region = r;
    if (region < 0 && ops.length) {
      const c = nearestRegionCell(w1, r1, ops[0].pts[0], ops[0].pts[1]);
      region = c >= 0 ? r1.of[c] : -1;
    }
  }

  // 连起来的陆地:沿每一片新陆地(隆起的地块连成片)看它挨着的老陆地分属几个陆块
  let joined: [number, number] | null = null;
  let joinedScore = 0;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!rose[s] || seen[s]) continue;
    /** 陆块 → (州 → 挨着几次) */
    const touch = new Map<number, Map<number, number>>();
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (rose[j]) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (w0.water[j] === 0 && w1.water[j] === 0 && r0.of[j] >= 0) {
          const r = r0.of[j];
          const L = r0.landmass[r];
          let m = touch.get(L);
          if (!m) touch.set(L, (m = new Map()));
          m.set(r, (m.get(r) ?? 0) + 1);
        }
      }
    }
    if (touch.size < 2) continue;
    const sides = [...touch.entries()]
      .map(([L, m]) => {
        let best = -1;
        let bn = 0;
        let sum = 0;
        for (const [r, v] of m) {
          sum += v;
          if (v > bn || (v === bn && r < best)) {
            bn = v;
            best = r;
          }
        }
        return { L, best, sum };
      })
      .sort((a, b) => b.sum - a.sum || a.L - b.L);
    const score = sides[0].sum + sides[1].sum;
    if (score > joinedScore) {
      joinedScore = score;
      joined = [sides[0].best, sides[1].best];
    }
  }
  return { sunk, risen, region, drowned, shrunk, grown, added, joined };
}

/** 一座在地形大事里没了的城 */
export interface UpheavalVictim {
  /** 城的编号 */
  id: number;
  /** true = 城址沉入海中;false = 毁于火山 */
  drowned: boolean;
  /** 那一刻是不是某国的国都 */
  capital: boolean;
}

/** 火山毁城的范围:山体底半径的这么多倍以内 */
const BLAST = 0.5;

/**
 * 大事那一刻(t)会没了的城:城址变成了水的、离某座火山不到山体半径一半的。owner = 那一刻各州的国家。
 * 国都在前,再按那时的人口从多到少(一样多按编号)
 */
export function upheavalVictims(
  settlements: readonly Settlement[],
  polities: readonly Polity[],
  owner: ArrayLike<number>,
  t: Year,
  w1: Pick<World, 'mesh' | 'water' | 'width'>,
  ops: readonly TerrainOp[],
): UpheavalVictim[] {
  const { x, y } = w1.mesh;
  const vol = ops.filter((o) => o.kind === 'volcano');
  const out: (UpheavalVictim & { pop: number })[] = [];
  for (const s of settlements) {
    // 大事那一刻还在的城(同一刻里大事最先:这一年刚建的还没建,这一年被毁的还在)
    if (!(s.founded < t) || (s.ended !== undefined && s.ended < t)) continue;
    const drowned = w1.water[s.cell] !== 0;
    const burnt = !drowned && vol.some((o) => wrapDist(x[s.cell], y[s.cell], o.pts[0], o.pts[1], w1.width) < o.r * BLAST);
    if (!drowned && !burnt) continue;
    const p = s.region >= 0 && s.region < owner.length ? owner[s.region] : -1;
    const capital = p >= 0 && p < polities.length && capitalAt(polities[p], t) === s.id;
    out.push({ id: s.id, drowned, capital, pop: populationAt(s, t) });
  }
  out.sort((a, b) => Number(b.capital) - Number(a.capital) || b.pop - a.pop || a.id - b.id);
  return out.map(({ id, drowned, capital }) => ({ id, drowned, capital }));
}

// ---------------------------------------------------------------------------
// 预览("会怎么样"):放好、涂好还没让它发生时,先照新地形真生成一遍,和那一年的地形、州比

/**
 * 第 year 年(大事前)的地形和州:从原来的世界起,更早的地形大事一件件套上(和推演里同一套州,编号沿用)。
 * 同一年已经有的大事:地形算在"之前"里(预览只看再加的这几笔改了什么);州停在那一年以前
 * (再加的一件和它合成一件,推演里从那一年以前的州一次划到底,预览也一样)
 */
export function upheavalBase(world: World, steps: readonly UpheavalStep[], year: Year, regionArea: number): { world: World; regions: Regions } {
  let w = world;
  let r = buildRegions(w, computeHabitat(w), { regionArea });
  for (const s of steps) {
    if (s.year > year) break;
    w = s.world;
    if (s.year < year) r = reshapeRegions(w, computeHabitat(w), r, { regionArea });
  }
  return { world: w, regions: r };
}

/** 预览:地块、州怎么变(upheavalImpact),外加变成水 / 变成陆地的地块(地图上标出来)、火山的山体压到的州 */
export interface UpheavalPreview extends UpheavalImpact {
  sunkCells: number[];
  risenCells: number[];
  /** 火山喷发:山体压到的州(陆地明显抬高了的州,按编号;没有火山 = 空) */
  cone: number[];
}

/** 山体:抬高超过最高处这么多的地块算(和地图上山体的圈差不多大) */
const CONE_FRAC = 0.12;
/** 最高处抬得不到这么多(米)= 山体压不到什么(火山放在本来就很高的山上) */
const CONE_MIN = 40;

/** w0、r0 = 那一年的地形和州(upheavalBase;同一年已经有大事时 r0 是那以前的州);w1 = 再套上这几笔(ops)生成的世界 */
export function previewUpheaval(w0: World, r0: Regions, w1: World, ops: readonly TerrainOp[], regionArea: number): UpheavalPreview {
  const r1 = reshapeRegions(w1, computeHabitat(w1), r0, { regionArea });
  const impact = upheavalImpact(w0, r0, w1, r1, ops);
  const sunkCells: number[] = [];
  const risenCells: number[] = [];
  for (let c = 0; c < w0.mesh.n; c++) {
    const a = w0.water[c] === 0;
    const b = w1.water[c] === 0;
    if (a && !b) sunkCells.push(c);
    else if (!a && b) risenCells.push(c);
  }
  const cone: number[] = [];
  if (ops.some((o) => o.kind === 'volcano')) {
    let top = 0;
    for (let c = 0; c < w0.mesh.n; c++) if (w0.water[c] === 0 && w1.water[c] === 0) top = Math.max(top, w1.elevation[c] - w0.elevation[c]);
    if (top >= CONE_MIN) {
      const hit = new Set<number>();
      for (let c = 0; c < w0.mesh.n; c++) {
        const r = r0.of[c];
        if (r >= 0 && w0.water[c] === 0 && w1.water[c] === 0 && w1.elevation[c] - w0.elevation[c] > top * CONE_FRAC) hit.add(r);
      }
      cone.push(...[...hit].sort((x, y) => x - y));
    }
  }
  return { ...impact, sunkCells, risenCells, cone };
}

/**
 * 预览里会没了的城(按这份历史:那一年还在的城;同一年已经发生过的大事里没了的不算)。water1 = 再套上这几笔以后的海陆
 * (只用它的 water;地块网格和 civ 的世界一样)。国都在前
 */
export function previewVictims(civ: Civ, world: Pick<World, 'mesh' | 'width'>, water1: ArrayLike<number>, year: Year, ops: readonly TerrainOp[]): UpheavalVictim[] {
  const own = ownersAt(civ, year - 1 / 256);
  const gone = new Set(civ.annals.filter((e) => e.kind === 'sunk' && e.year === year).map((e) => e.settlement));
  const alive = civ.settlements.filter((s) => !gone.has(s.id));
  return upheavalVictims(alive, civ.polities, own.polity, year, { mesh: world.mesh, width: world.width, water: water1 as World['water'] }, ops);
}

/** 预约第 k 件大事(fromCiv 的 first 回调里调用:同一刻里先于别的一切事件) */
export function scheduleUpheaval(sim: CivSim, k: number, year: number): void {
  sim.schedule(year, Ev.Upheaval, k, 0);
}

/**
 * 登记第 k 件大事的处理(fromCiv 之后调用)。impact = upheavalImpact 比出来的;fact = 这件大事的经过,
 * 那一刻填上当时的国家(Civ.upheavals[k]);before = 大事以前的地形(只用它的 water)
 */
export function installUpheaval(sim: CivSim, k: number, step: UpheavalStep, impact: UpheavalImpact, fact: UpheavalFact, before: Pick<World, 'water'>): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  const owner = sim.owners[Layer.Polity];
  const culture = sim.owners[Layer.Culture];
  sim.on(Ev.Upheaval, (i, _b, t) => {
    if (i !== k) return;
    const own = (r: number) => (r >= 0 && r < owner.length ? owner[r] : -1);
    fact.polity = own(impact.region);
    if (fact.polity < 0 && !fact.kinds.includes('volcano')) {
      // 受灾最重的那州没有主:算沉没 / 沉掉一块 / 长出新陆地的州最多的国家
      const tally = new Map<number, number>();
      for (const r of [...impact.drowned, ...impact.shrunk, ...impact.grown]) {
        const o = own(r);
        if (o >= 0) tally.set(o, (tally.get(o) ?? 0) + 1);
      }
      let bn = 0;
      for (const [o, c] of tally) if (c > bn || (c === bn && o < fact.polity)) [fact.polity, bn] = [o, c];
    }
    fact.drownedBy = impact.drowned.map(own);
    if (impact.joined) fact.joinedBy = [own(impact.joined[0]), own(impact.joined[1])];
    sim.record('upheaval', { a: k, region: impact.region });
    if (!pm) return;
    const S = pm.settlements;
    // 城:沉入海中 / 毁于火山(国都在前)
    for (const v of upheavalVictims(S, pm.polities, owner, t, step.world, step.ops)) {
      const s = S[v.id];
      s.ended = t;
      if (pm.cityOf[s.region] === s.id) pm.cityOf[s.region] = -1;
      sim.record('sunk', { a: own(s.region), b: v.drowned ? 1 : 0, region: s.region, settlement: s.id, war: k });
      if (!v.drowned) scheduleRebuild(sim, s.id);
    }
    // 早先毁了的城:城址这回成了海、湖,遗址也没了
    const ruins = S.filter((s) => s.ended !== undefined && s.ended < t && before.water[s.cell] === 0 && step.world.water[s.cell] !== 0).map((s) => s.id);
    if (ruins.length) fact.ruins = ruins;
    const alive = (p: number) => pm.polities[p].ended === undefined;
    /** 亡了的国家打着的仗:后果都记完再议和(编年史把紧跟大事的沉城、迁都、亡国并成一条,中间不能插进议和) */
    const ending: War[] = [];
    const fallen = (o: number, r: number) => {
      endPolity(pm, o, t);
      sim.record('fall', { a: o, b: -2, region: r });
      if (wm) for (const w of wm.active) if ((w.a === o || w.b === o) && !ending.includes(w)) ending.push(w);
    };
    const relocate = (p: number, skip: number) => {
      const sid = bestCapital(pm, owner, p, t, true, skip);
      if (sid < 0) return false;
      moveCapital(pm, p, sid, t);
      sim.record('capital', { a: p, b: -2, region: S[sid].region, settlement: sid });
      return true;
    };
    const capRegion = (p: number) => S[capitalAt(pm.polities[p], t)].region;
    // 一块陆地也不剩的州:国家、民族撤出(国都所在州最后处理:先迁都)
    const gone = impact.drowned.filter((r) => owner[r] >= 0 || culture[r] >= 0);
    const isCap = (r: number) => owner[r] >= 0 && capRegion(owner[r]) === r;
    gone.sort((a, b) => Number(isCap(a)) - Number(isCap(b)) || a - b);
    for (const r of gone) {
      const o = owner[r];
      if (o >= 0 && alive(o) && capRegion(o) === r && pm.size[o] > 1) relocate(o, r);
      if (o >= 0) sim.setOwner(Layer.Polity, r, -1, Ev.Upheaval);
      if (o >= 0 && alive(o) && pm.size[o] <= 0) fallen(o, r);
      if (culture[r] >= 0) sim.setOwner(Layer.Culture, r, -1, Ev.Upheaval);
    }
    // 国都没了(城沉了、毁了)、州还在:能迁就迁;一座城也不剩的,亡于天灾,余下的州成了无主之地
    for (let p = 0; p < pm.polities.length; p++) {
      if (!alive(p) || !(pm.polities[p].founded < t)) continue;
      const cap = S[capitalAt(pm.polities[p], t)];
      if (cap.ended !== t) continue;
      if (relocate(p, -1)) continue;
      const lands = pm.lands[p].slice();
      for (const r of lands) sim.setOwner(Layer.Polity, r, -1, Ev.Upheaval);
      fallen(p, lands.length ? lands[lands.length - 1] : cap.region);
    }
    for (const w of ending) wm!.makePeace!(w, t);
  });
}
