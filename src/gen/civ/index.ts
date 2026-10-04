/**
 * 文明生成总流程:generateWorld() 之后在 worker 里调用。纯计算,不碰 DOM。
 *
 * 步骤顺序固定:
 *   ① 宜居度 + 州          habitat.ts / regions.ts
 *   ② 民族扩张 + 回放引擎   sim.ts / cultures.ts   → cultures、log、checkpoints、culture
 *   ③ 城市成长 + 国家       polities.ts            → settlements、polities、polity
 *   ④ 道路网               routes.ts              → routes
 *   ⑤ 地理名称             places.ts              → places
 *   ⑥ 人物                 people.ts              → people(历代君主、战争里的统帅;按推出来的历史排,不改历史)
 *
 * 阶段 4 干预(params.interventions,interventions.ts):带着干预从第 0 年整段重推;干预年份之前和不干预时逐字节一致。
 *
 * 随机数一律从 subSeed(seed, 'civ-…') 取(见 rand.ts),不用 Math.random。
 */
import type { Progress, World } from '../world';
import type { ChangeLog, Civ, CivParams, Culture, Place, Polity, Route, Settlement } from './types';
import { computeHabitat } from './habitat';
import { buildRegions, emptyRegions } from './regions';
import { CivSim } from './sim';
import { BIRTH_SPAN, finishCultures, installCultures, planCultures } from './cultures';
import { buildRoutes } from './routes';
import { finishPolities, installPolities, planPolities, routeCities } from './polities';
import { findPlaces } from './places';
import { installWars } from './wars';
import { installPolitics } from './politics';
import { installDynasty } from './dynasty';
import { installAssimilation } from './assimilation';
import { installCities } from './cities';
import { warModelOf } from './wars';
import { installInterventions, scheduleInterventions } from './interventions';
import { buildPeople } from './people';

export * from './types';

export const DEFAULT_CIV_PARAMS: CivParams = {
  endYear: 3000,
  cultures: 'auto',
  polities: 'auto',
  regionArea: 750,
  pace: 1,
};

/** 可居地块(宜居分 ≥ 这个值)的总面积占陆地不到这个比例时,认为这颗星球没有文明 */
const MIN_HABITABLE_SUIT = 1;
const MIN_HABITABLE_FRAC = 0.02;

export function generateCiv(world: World, params: Partial<CivParams> = {}, progress: Progress = () => {}): Civ {
  const p: CivParams = { ...DEFAULT_CIV_PARAMS, ...params };
  const n = world.mesh.n;

  progress('宜居度', 0);
  const habitat = computeHabitat(world);

  let land = 0;
  let habitable = 0;
  for (let i = 0; i < n; i++) {
    if (world.water[i] !== 0) continue;
    land++;
    if (habitat.suitability[i] >= MIN_HABITABLE_SUIT) habitable++;
  }

  progress('划分州', 0.3);
  const regions = land > 0 ? buildRegions(world, habitat, { regionArea: p.regionArea }) : emptyRegions(n);
  const viable = land > 0 && habitable >= land * MIN_HABITABLE_FRAC;

  progress('文明', 0.8);
  const R = regions.count;
  // ---- 以下各步:viable 为 false 时一律保持为空 ----
  // ② 民族扩张 + 回放引擎(cultures.ts / sim.ts):定民族 → 按年推演到 endYear → 按最终疆域配色、起名。
  // ③ 城市成长 + 国家(polities.ts):在 sim.run 之前装上自己的事件(建城、立国、国家到达、升格),
  //    同一个引擎、同一本日志
  const sim = new CivSim(R);
  const birthSpan = p.birthSpan ?? BIRTH_SPAN;
  const model = viable ? planCultures(world, habitat, regions, { cultures: p.cultures, pace: p.pace, birthSpan }) : null;
  const pm = model ? planPolities(world, model, { polities: p.polities, pace: p.pace }) : null;
  // 阶段 4 干预(interventions.ts):事件最先预约(同一刻里先于别的一切事件,干预之前的历史一字不差)
  const iv = pm ? scheduleInterventions(sim, world.params.seed, p.interventions) : null;
  if (model) installCultures(sim, model);
  if (pm) installPolities(sim, pm);
  if (pm) installWars(sim, pm); // 阶段 3 战争与攻占(wars.ts):宣战、攻占、迁都、灭亡、议和
  if (pm) installPolitics(sim, pm, world); // 阶段 3 分与合(politics.ts):分裂、合并、复国、主动迁都、部落地带补立国
  if (pm) installDynasty(sim, pm); // 阶段 3 王朝更替(dynasty.ts):改朝换代、王室更迭,新朝定都根据地
  if (pm) installAssimilation(sim, pm, world); // 阶段 3 同化与迁徙(assimilation.ts):同化、随征服而来的移民、避兵外迁、民族消亡
  if (pm) installCities(sim, pm, warModelOf(sim)!); // 阶段 3 城市兴衰(cities.ts):洗劫、毁城、重建、旧都衰落
  if (iv) installInterventions(sim, iv); // 阶段 4 干预:不许灭、结盟、宣战、禁止分裂(各机制在决策点查 WarModel.iv)
  progress('民族推演', 0.85);
  sim.run(p.endYear);
  const { log, checkpoints, culture, polity, annals } = sim.result();
  progress('起名', 0.92);
  if (model) finishCultures(world, model, culture, checkpoints);
  if (pm) finishPolities(world, pm, polity);
  const cultures: Culture[] = model?.cultures ?? [];
  const settlements: Settlement[] = pm?.settlements ?? []; // ③ polities.ts
  const polities: Polity[] = pm?.polities ?? []; // ③ polities.ts
  // ④ routes.ts:城镇列表交给道路(国都之间修大路,路的修建年份取两端较晚者)
  const routes: Route[] = viable
    ? buildRoutes(world, habitat, regions, { progress, cities: settlements.length ? routeCities(settlements, polities, p.endYear) : undefined })
    : [];
  const places: Place[] = findPlaces(world, regions, { cultures, culture }); // ⑤ places.ts(山海湖岛是地理,不看 viable)
  const people = buildPeople({ seed: world.params.seed, endYear: p.endYear, polities, settlements, cultures, annals }); // ⑥ people.ts

  return {
    seed: world.params.seed,
    endYear: p.endYear,
    habitat,
    regions,
    cultures,
    settlements,
    polities,
    routes,
    places,
    culture,
    polity,
    log,
    checkpoints,
    annals,
    viable,
    spreadYears: model?.spreadYears,
    polityYears: pm?.years,
    ...(iv ? { interventions: iv.list.slice() } : {}),
    people,
  };
}

export function emptyLog(): ChangeLog {
  return {
    size: 0,
    year: new Float32Array(0),
    region: new Int32Array(0),
    layer: new Uint8Array(0),
    value: new Int16Array(0),
    cause: new Uint8Array(0),
  };
}

/** Civ 里所有类型化数组的底层缓冲区(去重),worker 发消息时用 transfer 传,省得复制 */
export function civTransferables(civ: Civ): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer && v.buffer.byteLength > 0) out.add(v.buffer);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(civ, 0);
  return [...out];
}
