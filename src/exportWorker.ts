/// <reference lib="webworker" />
/**
 * 导出用的后台线程(阶段 4):每次导出临时开一个,做完就关,和生成世界的线程(worker.ts)互不干扰 ——
 * 导出到一半改参数、重新生成世界,两边都不用等对方。
 *
 *   map:按导出倍数铺像素(1× 直接用主线程给的那张),在 OffscreenCanvas 上画地形 + 文明底图 + 外框罗盘
 *        (render/export.ts 的 drawMapBase),转成 ImageBitmap 交回主线程;文字在主线程画(要用页面里加载好的字体)。
 *   heightmap:按导出倍数铺像素,编码成 16 位 / 8 位灰度 PNG(gen/heightmap.ts),字节交回主线程。
 *
 * 浏览器太旧、线程里没有 OffscreenCanvas 时,map 回一个 code = 'no-offscreen',主线程自己画(会卡一下)。
 */
import type { World } from './gen/world';
import { rasterize, type Raster } from './gen/raster';
import { rasterizeWithHelpers } from './gullyPool';
import type { Civ, Year } from './gen/civ/types';
import type { CivShow, CivStyle } from './render/civ/overlay';
import type { LayerId } from './render/layers';
import { heightmapPng, type HeightmapBits, type HeightmapInfo } from './gen/heightmap';
import { drawMapBase, type ExportScale } from './render/export';
import type { ProjectionId } from './render/projection';

export type ExportRequest =
  | {
      job: 'map';
      world: World;
      /** 1× 时直接用主线程的那张;不给 = 按 scale 重新铺 */
      raster?: Raster;
      scale: ExportScale;
      civ: Civ | null;
      style: CivStyle;
      layer: LayerId;
      year: Year;
      show: CivShow;
      /** 球面世界:图片正中的世界 x(见 render/export.ts 的 ExportMapParams.center) */
      center?: number;
      /** 投影、经纬网(和屏幕上一样;见 ExportMapParams) */
      projection?: ProjectionId;
      graticule?: boolean;
    }
  | {
      job: 'heightmap';
      seed: number;
      /** 1× 时只给海拔和水域(比整张 Raster 小得多);不给 = 按 world 和 scale 重新铺 */
      raster?: Pick<Raster, 'w' | 'h' | 'elev' | 'water'>;
      world?: World;
      scale: ExportScale;
      bits: HeightmapBits;
    };

export type ExportResponse =
  | { ok: true; job: 'map'; bitmap: ImageBitmap; ms: { raster: number; draw: number } }
  | { ok: true; job: 'heightmap'; png: Uint8Array; info: HeightmapInfo; ms: { raster: number; encode: number } }
  | { ok: false; error: string; code?: 'no-offscreen' | 'raster' };

const post = (m: ExportResponse, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const m = e.data;
  try {
    if (m.job === 'map' && typeof OffscreenCanvas === 'undefined') {
      post({ ok: false, error: '这个浏览器不支持后台画图', code: 'no-offscreen' });
      return;
    }
    const t0 = performance.now();
    if (m.job === 'heightmap') {
      // 高度图只要海拔和水陆,不算沟壑
      const r = m.raster ?? (m.world ? rasterize(m.world, m.scale, false) : null);
      if (!r) throw new Error('没有世界数据');
      const t1 = performance.now();
      const { png, info } = await heightmapPng(r, m.bits, m.seed);
      post({ ok: true, job: 'heightmap', png, info, ms: { raster: t1 - t0, encode: performance.now() - t1 } }, [png.buffer]);
      return;
    }
    // 沟和山脊只有写实风打光用得着(分给帮手线程算)
    const raster = m.raster ?? (m.style === 'realistic' ? await rasterizeWithHelpers(m.world, m.scale) : rasterize(m.world, m.scale, false));
    const t1 = performance.now();
    const cv = new OffscreenCanvas(raster.w, raster.h);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('开不了这么大的画布(内存不够)');
    drawMapBase(
      ctx,
      { world: m.world, raster, civ: m.civ, style: m.style, layer: m.layer, year: m.year, show: m.show, center: m.center, projection: m.projection, graticule: m.graticule },
      (w, h) => new OffscreenCanvas(w, h),
    );
    const bitmap = cv.transferToImageBitmap();
    post({ ok: true, job: 'map', bitmap, ms: { raster: t1 - t0, draw: performance.now() - t1 } }, [bitmap]);
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
