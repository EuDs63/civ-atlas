/// <reference lib="webworker" />
/**
 * 后台线程:生成世界 + 文明骨架 + 铺像素 + 回放帧 + 带着干预重推文明,不卡界面。
 * 铺像素里最慢的沟和山脊分给几个帮手线程(gullyPool.ts;核多的电脑最多 3 个),和推文明同时算。
 * 主线程要生成新世界时如果本线程还在忙,会直接 terminate() 再开一个新的;
 * 回放帧、重推文明这些短活不打断,排在后面(消息按先后处理)。每个线程只需要把手头的活按顺序干完。
 *
 * 改地形(阶段 4):世界 = 参数 + 草图(sketch)+ 地形修改(terrain)。改了地形、画了草图就带着它们重新 generate(连同当时的干预一起推文明);
 * 回放帧、重推文明也带着它们,线程被重开过时按"参数 + 草图 + 地形修改"重新生成(同样的输入 = 同一个世界)。
 * 试推演(助手)和重推一样算,只是结果单独交回,主线程不换上它。
 */
import { generateWorld, type World, type WorldParams } from './gen/world';
import { finishGully, rasterizeDeferred, type Raster } from './gen/raster';
import { GullyPool } from './gullyPool';
import { buildHistoryFrames, type HistoryFrames } from './gen/history';
import { generateCiv, civTransferables, planetTempo, type Civ } from './gen/civ';
import type { Intervention, TerrainOp } from './gen/edits';
import { sketchGrid, type SketchEdit } from './gen/sketch';

/**
 * 一组参数 + 草图(没改地形的星球)的扩张节拍(gen/civ 的 planetTempo;null = 长不出文明),key = 这颗星球在线程里的键。
 * 线程推文明后回报给主线程,主线程下次生成、重推时带回来:线程被重开过也不用多生成一遍没改过的地形
 */
export interface TempoNote {
  key: string;
  tempo: number | null;
}

export type WorkerRequest =
  /**
   * 生成世界。terrain = 地形修改(不给 = 没改);sketch = 草图(不给 = 没画);interventions = 推文明时带上的干预(改地形重新生成时用;不给 = 没有);
   * tempo = 主线程记着的扩张节拍(星球对不上就不用)
   */
  | { type: 'generate'; id: number; params: WorldParams; scale: number; terrain?: TerrainOp[]; sketch?: SketchEdit; interventions?: Intervention[]; tempo?: TempoNote }
  /** 回放帧。带上参数:线程被重开过、手里没有这个世界时,按参数重新生成(同参数 = 同世界) */
  | { type: 'history'; id: number; params: WorldParams; terrain?: TerrainOp[]; sketch?: SketchEdit }
  /**
   * 阶段 4 干预:只重推文明(世界已在线程里,不重新生成地形;线程被重开过就按参数重新生成)。
   * seq = 第几次重推(主线程只认最新的一次)
   */
  | { type: 'resim'; id: number; seq: number; params: WorldParams; terrain?: TerrainOp[]; sketch?: SketchEdit; interventions: Intervention[]; tempo?: TempoNote }
  /** 试推演(助手用):和 resim 一样重推(同样带节拍),但只把结果交回去,主线程不换上它;tid = 第几次试推演 */
  | { type: 'trial'; id: number; tid: number; params: WorldParams; terrain?: TerrainOp[]; sketch?: SketchEdit; interventions: Intervention[]; tempo?: TempoNote };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; pct: number }
  /** ms = 线程里花的时间(生成 + 文明 + 铺像素);tempo = 这组参数的扩张节拍(知道的话) */
  | { type: 'done'; id: number; world: World; raster: Raster; civ: Civ; ms: number; tempo?: TempoNote }
  | ({ type: 'history'; id: number } & HistoryFrames)
  /** 重推好的文明;ms = 线程里花的时间(含按参数重新生成世界);tempo 同 done */
  | { type: 'civ'; id: number; seq: number; civ: Civ; ms: number; tempo?: TempoNote }
  /** 试推演的结果;tempo 同 done */
  | { type: 'trial'; id: number; tid: number; civ: Civ; ms: number; tempo?: TempoNote };

/** 上一个生成的世界(含回放快照),回放时直接用 */
let last: { key: string; world: World } | null = null;
const keyOf = (p: WorldParams, terrain?: TerrainOp[], sketch?: SketchEdit) =>
  JSON.stringify([Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)), terrain ?? [], sketch ?? null]);

const post = (m: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

/**
 * 各颗星球(参数 + 草图,没改地形)的扩张节拍(gen/civ 的 planetTempo;null = 长不出文明):改过地形的世界推文明时要用。
 * 生成没改过地形的世界时顺手记下(线程不改 pace,civ.spreadYears 就是节拍),新建时先看原样再改地形就不用多生成一遍
 */
const tempos = new Map<string, number | null>();
const TEMPO_KEEP = 32;
function rememberTempo(params: WorldParams, sketch: SketchEdit | undefined, tempo: number | null) {
  const key = keyOf(params, undefined, sketch);
  tempos.delete(key);
  tempos.set(key, tempo);
  if (tempos.size > TEMPO_KEEP) tempos.delete(tempos.keys().next().value!);
}
/** 主线程带回来的节拍:星球对得上才记 */
function takeTempo(params: WorldParams, sketch: SketchEdit | undefined, note?: TempoNote) {
  if (note && note.key === keyOf(params, undefined, sketch) && !tempos.has(note.key)) rememberTempo(params, sketch, note.tempo);
}
/** 回报给主线程的节拍(手里没有 = 不给) */
function noteOf(params: WorldParams, sketch: SketchEdit | undefined): TempoNote | undefined {
  const key = keyOf(params, undefined, sketch);
  const tempo = tempos.get(key);
  return tempo === undefined ? undefined : { key, tempo };
}
/** 推文明时带的节拍:没改地形 = 不用(按世界自己标定);改过 = 这颗星球(参数 + 草图)的节拍,手里没有就现算 */
function tempoOf(params: WorldParams, terrain: TerrainOp[] | undefined, sketch: SketchEdit | undefined): number | null | undefined {
  if (!terrain?.length) return undefined;
  const key = keyOf(params, undefined, sketch);
  if (!tempos.has(key)) rememberTempo(params, sketch, planetTempo(params, undefined, sketchGrid(sketch)) ?? null);
  return tempos.get(key);
}

/** 这组参数(+ 草图 + 地形修改)的世界:手里有就用,没有(线程被重开过)就重新生成(同样的输入 = 同一个世界) */
function worldOf(params: WorldParams, terrain?: TerrainOp[], sketch?: SketchEdit): World {
  const key = keyOf(params, terrain, sketch);
  if (!last || last.key !== key) last = { key, world: generateWorld(params, undefined, terrain, sketchGrid(sketch)) };
  return last.world;
}

// ---------------------------------------------------------------------------
// 帮手线程(gullyPool.ts):整张主图的沟和山脊分给它们算,本线程同时推文明。开线程时就起好
const pool = new GullyPool();

/** 消息按先后一件件处理(生成要等帮手线程,等的时候后面来的消息排着,不插进来) */
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  queue = queue.then(() => handle(m)).catch((err) => {
    // 和以前同步处理时一样,出错报到线程的 error 事件上
    setTimeout(() => {
      throw err;
    });
  });
};

async function handle(m: WorkerRequest): Promise<void> {
  if (m.type !== 'history') takeTempo(m.params, m.sketch, m.tempo);
  if (m.type === 'generate') {
    await pool.up;
    const t0 = performance.now();
    const world = generateWorld(m.params, (stage, pct) => post({ type: 'progress', id: m.id, stage, pct }), m.terrain, sketchGrid(m.sketch));
    last = { key: keyOf(m.params, m.terrain, m.sketch), world };
    // 先铺像素(山坡上的沟和山脊交给帮手线程),同时推文明
    post({ type: 'progress', id: m.id, stage: '铺展地图', pct: 0.93 });
    const { raster, job } = rasterizeDeferred(world, m.scale);
    const { heights, result: civ } = await pool.run(job, () => {
      // 文明骨架(宜居度、州……)只读 World,之后的文明步骤都在 gen/civ/index.ts 里接
      post({ type: 'progress', id: m.id, stage: '文明', pct: 0.95 });
      const c = generateCiv(world, { interventions: m.interventions?.length ? m.interventions : undefined, tempo: tempoOf(m.params, m.terrain, m.sketch) });
      if (!m.terrain?.length) rememberTempo(m.params, m.sketch, c.spreadYears ?? null);
      return c;
    });
    finishGully(raster, job, heights);
    const transfer = [raster.elev, raster.temp, raster.precip, raster.water, raster.biome, raster.cell, raster.ice, raster.iceConc, raster.iceTone, raster.gully!].map((a) => a.buffer);
    transfer.push(...civTransferables(civ));
    // 回放快照体积大且主线程用不上,不随世界一起发送
    const { history: _history, ...rest } = world;
    void _history;
    post({ type: 'done', id: m.id, world: { ...rest, history: [] }, raster, civ, ms: performance.now() - t0, tempo: noteOf(m.params, m.sketch) }, transfer);
  } else if (m.type === 'history') {
    const h = buildHistoryFrames(worldOf(m.params, m.terrain, m.sketch));
    post({ type: 'history', id: m.id, ...h }, h.frames.map((f) => f.buffer));
  } else if (m.type === 'resim' || m.type === 'trial') {
    const t0 = performance.now();
    const civ = generateCiv(worldOf(m.params, m.terrain, m.sketch), { interventions: m.interventions, tempo: tempoOf(m.params, m.terrain, m.sketch) });
    const ms = performance.now() - t0;
    const tempo = noteOf(m.params, m.sketch);
    if (m.type === 'resim') post({ type: 'civ', id: m.id, seq: m.seq, civ, ms, tempo }, civTransferables(civ));
    else post({ type: 'trial', id: m.id, tid: m.tid, civ, ms, tempo }, civTransferables(civ));
  }
}
