/**
 * 放大后按屏幕现算的写实风细节(一块块,见 tileWorker.ts、gen/rasterWindow.ts):后台线程池 + 算好的块的缓存。
 *   - 地图停下来以后,细节层(TerrainDetail.tsx)说要哪几块(按离视口中心的远近排好);空着的线程依次领走,
 *     一个线程一次只领一块 —— 又挪了地方,还没领的就换成新的那一批,不白算看不见的
 *   - 算好的块留着(最多 MAX_TILES 块,最久没看的先扔),来回拖、缩放回来不重算;换了世界全部作废
 *   - 后台线程出错(没加载上、出了没接住的错)或者不能画图:整组停掉,细节层照旧拉大整张图
 * 块的编号:S 倍主图(S 像素 / 世界单位,2 的幂)上第 (tx, ty) 块,每块 TILE × TILE 像素;tx 按一整圈取模。
 * 河按 k 倍缩放的样子画进块里,k 也是编号的一部分(地图框变宽变窄时 k 跟着变,旧的块不能接着用)。
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { TileRequest, TileResponse } from '../tileWorker';

/** 一块多少像素(边长) */
export const TILE = 256;
/** 最多留多少块(一块 256 KB 像素,约 50 MB) */
const MAX_TILES = 200;

export function tileKey(S: number, k: number, tx: number, ty: number): string {
  return `${S}/${k}/${tx}/${ty}`;
}

interface Slot {
  w: Worker;
  /** 正在算的块(null = 空着) */
  busy: string | null;
}

let slots: Slot[] | null = null;
let failed = false;
/** 第几个世界(换了世界加一,旧世界的结果不要) */
let wid = 0;
let curWorld: World | null = null;
let curRaster: Raster | null = null;
/** 算好的块(Map 的顺序 = 最近看过的在后) */
const cache = new Map<string, HTMLCanvasElement>();
/** 还没领走的块(按先后) */
let queue: { key: string; S: number; tx: number; ty: number; k: number }[] = [];
/** 算好一块调一次(块的编号);null = 后台线程停掉了,以后不再现算 */
let onReady: ((key: string | null) => void) | null = null;
/** 每块算了多久(毫秒,最近 20 块;给冒烟检查和调参看) */
const recent: number[] = [];

function poolSize(): number {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, hc - 1));
}

function ensurePool(): Slot[] | null {
  if (slots || failed) return slots;
  try {
    slots = Array.from({ length: poolSize() }, () => {
      const w = new Worker(new URL('../tileWorker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { w, busy: null };
      w.onmessage = (e: MessageEvent<TileResponse>) => done(slot, e.data);
      w.onerror = stop;
      return slot;
    });
  } catch {
    failed = true;
    slots = null;
  }
  return slots;
}

/** 后台线程能不能用(不能就不现算,细节层照旧拉大整张图) */
export function tilesAvailable(): boolean {
  return typeof Worker !== 'undefined' && !!ensurePool();
}

/** 换成这个世界(同一个世界不做事);旧世界的块全部作废 */
export function tilesWorld(world: World, raster: Raster): void {
  if (world === curWorld && raster === curRaster) return;
  curWorld = world;
  curRaster = raster;
  wid++;
  cache.clear();
  queue = [];
  const pool = ensurePool();
  if (!pool) return;
  // 回放用的历史快照用不着,不拷过去
  const lite = { ...world, history: [] } as World;
  const whole = { w: raster.w, h: raster.h, scale: raster.scale, elev: raster.elev, water: raster.water, ice: raster.ice, iceConc: raster.iceConc, iceTone: raster.iceTone };
  for (const s of pool) {
    const m: TileRequest = { type: 'world', wid, world: lite, whole };
    s.w.postMessage(m);
    s.busy = null;
  }
}

/** 算好的那一块(没有 = null);用到就算"刚看过" */
export function tileCanvas(key: string): HTMLCanvasElement | null {
  const c = cache.get(key);
  if (!c) return null;
  cache.delete(key);
  cache.set(key, c);
  return c;
}

/**
 * 要这几块(按先后;已经算好、正在算的跳过)。之前还没领走的那一批作废。
 * k:河按几倍缩放的样子画(见 TileRequest);ready:每算好一块调一次(块的编号),后台线程停掉了调一次 null
 */
export function wantTiles(list: { S: number; tx: number; ty: number; k: number }[], ready: (key: string | null) => void): void {
  onReady = ready;
  const pool = ensurePool();
  if (!pool) {
    // 刚停掉(出错的消息比这一次要块来得早):照样告诉细节层
    if (failed) ready(null);
    return;
  }
  const busy = new Set(pool.map((s) => s.busy));
  queue = [];
  const seen = new Set<string>();
  for (const t of list) {
    const key = tileKey(t.S, t.k, t.tx, t.ty);
    if (seen.has(key) || cache.has(key) || busy.has(key)) continue;
    seen.add(key);
    queue.push({ key, ...t });
  }
  for (const s of pool) dispatch(s);
}

function dispatch(s: Slot) {
  if (s.busy) return;
  const t = queue.shift();
  if (!t) return;
  s.busy = t.key;
  const m: TileRequest = { type: 'tile', wid, key: t.key, S: t.S, x0: t.tx * TILE, y0: t.ty * TILE, size: TILE, k: t.k };
  s.w.postMessage(m);
}

/** 后台线程出错或者不能画图:整组停掉,不再现算(细节层照旧拉大整张图) */
function stop() {
  if (failed) return;
  failed = true;
  for (const x of slots ?? []) x.w.terminate();
  slots = null;
  queue = [];
  cache.clear();
  onReady?.(null);
}

function done(s: Slot, r: TileResponse) {
  if (s.busy === r.key) s.busy = null;
  if (r.fatal) return stop();
  if (r.wid === wid && r.bitmap) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = TILE;
    cv.getContext('2d')!.drawImage(r.bitmap, 0, 0);
    r.bitmap.close();
    cache.set(r.key, cv);
    while (cache.size > MAX_TILES) {
      const old = cache.keys().next().value!;
      cache.get(old)!.width = 0;
      cache.delete(old);
    }
    recent.push(r.ms);
    if (recent.length > 20) recent.shift();
    onReady?.(r.key);
  } else r.bitmap?.close();
  dispatch(s);
}

/** 现在的状态(冒烟检查用):还没领走的、正在算的块数,最近每块平均多少毫秒 */
export function tileStats(): { queued: number; busy: number; workers: number; ms: number } {
  return {
    queued: queue.length,
    busy: slots ? slots.filter((s) => s.busy).length : 0,
    workers: slots?.length ?? 0,
    ms: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0,
  };
}
