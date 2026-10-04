/// <reference lib="webworker" />
/**
 * 后台线程:生成世界 + 文明骨架 + 铺像素 + 回放帧 + 带着干预重推文明,不卡界面。
 * 主线程要生成新世界时如果本线程还在忙,会直接 terminate() 再开一个新的;
 * 回放帧、重推文明这些短活不打断,排在后面(消息按先后处理)。每个线程只需要把手头的活按顺序干完。
 *
 * 改地形(阶段 4):世界 = 参数 + 地形修改(terrain)。改了地形就带着 terrain 重新 generate(连同当时的干预一起推文明);
 * 回放帧、重推文明也带着 terrain,线程被重开过时按"参数 + 地形修改"重新生成(同样的输入 = 同一个世界)。
 */
import { generateWorld, type World, type WorldParams } from './gen/world';
import { rasterize, type Raster } from './gen/raster';
import { buildHistoryFrames, type HistoryFrames } from './gen/history';
import { generateCiv, civTransferables, type Civ } from './gen/civ';
import type { Intervention, TerrainOp } from './gen/edits';

export type WorkerRequest =
  /** 生成世界。terrain = 地形修改(不给 = 没改);interventions = 推文明时带上的干预(改地形重新生成时用;不给 = 没有) */
  | { type: 'generate'; id: number; params: WorldParams; scale: number; terrain?: TerrainOp[]; interventions?: Intervention[] }
  /** 回放帧。带上参数:线程被重开过、手里没有这个世界时,按参数重新生成(同参数 = 同世界) */
  | { type: 'history'; id: number; params: WorldParams; terrain?: TerrainOp[] }
  /**
   * 阶段 4 干预:只重推文明(世界已在线程里,不重新生成地形;线程被重开过就按参数重新生成)。
   * seq = 第几次重推(主线程只认最新的一次)
   */
  | { type: 'resim'; id: number; seq: number; params: WorldParams; terrain?: TerrainOp[]; interventions: Intervention[] };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; pct: number }
  /** ms = 线程里花的时间(生成 + 文明 + 铺像素) */
  | { type: 'done'; id: number; world: World; raster: Raster; civ: Civ; ms: number }
  | ({ type: 'history'; id: number } & HistoryFrames)
  /** 重推好的文明;ms = 线程里花的时间(含按参数重新生成世界) */
  | { type: 'civ'; id: number; seq: number; civ: Civ; ms: number };

/** 上一个生成的世界(含回放快照),回放时直接用 */
let last: { key: string; world: World } | null = null;
const keyOf = (p: WorldParams, terrain?: TerrainOp[]) =>
  JSON.stringify([Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)), terrain ?? []]);

const post = (m: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

/** 这组参数(+ 地形修改)的世界:手里有就用,没有(线程被重开过)就重新生成(同样的输入 = 同一个世界) */
function worldOf(params: WorldParams, terrain?: TerrainOp[]): World {
  const key = keyOf(params, terrain);
  if (!last || last.key !== key) last = { key, world: generateWorld(params, undefined, terrain) };
  return last.world;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'generate') {
    const t0 = performance.now();
    const world = generateWorld(m.params, (stage, pct) => post({ type: 'progress', id: m.id, stage, pct }), m.terrain);
    last = { key: keyOf(m.params, m.terrain), world };
    // 文明骨架(宜居度、州……)只读 World,之后的文明步骤都在 gen/civ/index.ts 里接
    post({ type: 'progress', id: m.id, stage: '文明', pct: 0.93 });
    const civ = generateCiv(world, m.interventions?.length ? { interventions: m.interventions } : undefined);
    post({ type: 'progress', id: m.id, stage: '铺展地图', pct: 0.95 });
    const raster = rasterize(world, m.scale);
    const transfer = [raster.elev, raster.temp, raster.precip, raster.water, raster.biome, raster.cell, raster.ice, raster.iceConc, raster.iceTone].map((a) => a.buffer);
    transfer.push(...civTransferables(civ));
    // 回放快照体积大且主线程用不上,不随世界一起发送
    const { history: _history, ...rest } = world;
    void _history;
    post({ type: 'done', id: m.id, world: { ...rest, history: [] }, raster, civ, ms: performance.now() - t0 }, transfer);
  } else if (m.type === 'history') {
    const h = buildHistoryFrames(worldOf(m.params, m.terrain));
    post({ type: 'history', id: m.id, ...h }, h.frames.map((f) => f.buffer));
  } else if (m.type === 'resim') {
    const t0 = performance.now();
    const civ = generateCiv(worldOf(m.params, m.terrain), { interventions: m.interventions });
    post({ type: 'civ', id: m.id, seq: m.seq, civ, ms: performance.now() - t0 }, civTransferables(civ));
  }
};
