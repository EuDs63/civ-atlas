/// <reference lib="webworker" />
/**
 * 整张主图山坡上的沟和山脊(gen/gully.ts 的 gullyHeights)分给几个帮手线程(gullyWorker.ts)同时算:
 * 生成世界、导出大图、地球仪贴图的后台线程里用(核多的电脑最多 3 个帮手)。
 * 线程里再开的线程,加载脚本、收消息都要本线程空下来才走得动:开始重活之前先等它们说"好了"(最多等 HELPER_WAIT 毫秒),
 * 发完活先让一下;不然本线程一口气算几秒,帮手要等本线程算完才开始。
 * 起不来(浏览器不支持线程里再开线程)、出了错 = 那一段本线程自己算(结果一样)。
 */
import { gullyHeights } from './gen/gully';
import { finishGully, rasterizeDeferred, type GullyJob, type Raster } from './gen/raster';
import type { World } from './gen/world';
import type { GullyRequest, GullyResponse } from './gullyWorker';

/** 开始重活之前最多等帮手加载多久(毫秒) */
const HELPER_WAIT = 400;
/** 帮手几个:留出主线程和本线程 */
const HELPERS = Math.max(0, Math.min(3, (self.navigator?.hardwareConcurrency || 2) - 2));

export class GullyPool {
  private helpers: Worker[] = [];
  private seq = 0;
  private readonly wait = new Map<number, (out: Float32Array | null) => void>();
  /** 帮手都加载好了(或者等够了) */
  readonly up: Promise<void>;

  constructor() {
    const ups: Promise<void>[] = [];
    try {
      for (let i = 0; i < HELPERS; i++) {
        const hw = new Worker(new URL('./gullyWorker.ts', import.meta.url), { type: 'module' });
        let up = () => {};
        ups.push(new Promise<void>((r) => (up = r)));
        hw.onmessage = (e: MessageEvent<GullyResponse | { ready: true }>) => {
          if ('ready' in e.data) return up();
          this.wait.get(e.data.id)?.(e.data.out);
          this.wait.delete(e.data.id);
        };
        hw.onerror = () => {
          // 这个帮手坏了:以后不用它,等着的那几段作废(本线程自己算)
          this.helpers = this.helpers.filter((x) => x !== hw);
          for (const f of this.wait.values()) f(null);
          this.wait.clear();
          up();
        };
        this.helpers.push(hw);
      }
    } catch {
      this.helpers = [];
    }
    this.up = Promise.race([Promise.all(ups).then(() => {}), new Promise<void>((r) => setTimeout(r, HELPER_WAIT))]);
  }

  /** 算 job 的沟壑:分段交给帮手,本线程同时做 during(推文明)。返回各像素的起伏(和一次算完一样)和 during 的结果 */
  async run<T>(job: GullyJob, during: () => T): Promise<{ heights: Float32Array; result: T }> {
    const r = await this.go(job, during);
    return { heights: r.heights, result: r.result as T };
  }

  /** 算 job 的沟壑:分段交给帮手,本线程自己也领一段 */
  async heights(job: GullyJob): Promise<Float32Array> {
    return (await this.go(job, null)).heights;
  }

  private async go<T>(job: GullyJob, during: (() => T) | null): Promise<{ heights: Float32Array; result: T | undefined }> {
    const hs = this.helpers.slice();
    const n = job.n;
    if (!hs.length || n < 1000) {
      const result = during?.();
      return { heights: gullyHeights(job, 0, n), result };
    }
    const k = hs.length + (during ? 0 : 1);
    const cut = (i: number) => Math.floor((n * i) / k);
    const parts = hs.map((hw, i) => this.send(hw, job, cut(i), cut(i + 1)));
    // 让一下,发给帮手的消息才送得出去
    await new Promise((r) => setTimeout(r, 0));
    const result = during?.();
    const mine = during ? null : gullyHeights(job, cut(k - 1), n);
    const outs = await Promise.all(parts);
    const heights = new Float32Array(n);
    outs.forEach((o, i) => heights.set(o ?? gullyHeights(job, cut(i), cut(i + 1)), cut(i)));
    if (mine) heights.set(mine, cut(k - 1));
    return { heights, result };
  }

  /** 不用了:关掉帮手 */
  close(): void {
    for (const hw of this.helpers) hw.terminate();
    this.helpers = [];
  }

  private send(hw: Worker, job: GullyJob, a: number, b: number): Promise<Float32Array | null> {
    const id = ++this.seq;
    const part = { seed: job.seed, w: job.w, h: job.h, R: job.R, scale: job.scale, idx: job.idx.slice(a, b), ge: job.ge.slice(a, b), gn: job.gn.slice(a, b), amp: job.amp.slice(a, b) };
    return new Promise<Float32Array | null>((resolve) => {
      this.wait.set(id, resolve);
      const req: GullyRequest = { id, job: part };
      hw.postMessage(req, [part.idx.buffer, part.ge.buffer, part.gn.buffer, part.amp.buffer]);
    });
  }
}

/** 铺像素(和 gen/raster.ts 的 rasterize 结果一样),沟和山脊分给临时开的几个帮手算:导出大图、地球仪贴图用 */
export async function rasterizeWithHelpers(world: World, scale: number): Promise<Raster> {
  const pool = new GullyPool();
  try {
    await pool.up;
    const { raster, job } = rasterizeDeferred(world, scale);
    finishGully(raster, job, await pool.heights(job));
    return raster;
  } finally {
    pool.close();
  }
}
