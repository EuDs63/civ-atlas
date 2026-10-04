/// <reference lib="webworker" />
/**
 * 地球仪的高清贴图(后台线程):放大地球仪到 1.5 倍以上以后(见 render/globe.ts 的 wantHdTexture),按两倍像素重新铺主图(4096×2048)、
 * 画地球仪用的地形贴图,转成 ImageBitmap 交回主线程换上去。每次临时开一个,画完就关;界面不卡。
 * 只画地形(不含文明层、外框、文字):文明层还是主图那么大的一张,随年份变。
 *   - 手绘:不带山 / 丘陵 / 沙丘 / 草丛 / 火山(地球仪上每帧正立着画),林块按纬度横向拉宽(fantasy.ts 的 fantasyGlobeBase)
 *   - 写实:不打光的底色 + 等效坡度(着色器按屏幕方向打光,realistic.ts 的 realisticGlobeMaps)
 *   - 数据图层:和主图一样
 */
import type { World } from './gen/world';
import { rasterize } from './gen/raster';
import type { LayerId } from './render/layers';
import { renderLayer } from './render/layers';
import { realisticGlobeMaps } from './render/realistic';
import { fantasyGlobeBase } from './render/fantasy';

export interface GlobeTexRequest {
  world: World;
  style: 'realistic' | 'fantasy' | 'data';
  layer: LayerId;
  scale: number;
}

export type GlobeTexResponse =
  | { ok: true; bitmap: ImageBitmap; ms: number; slope?: { w: number; h: number; data: Uint8Array } }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<GlobeTexRequest>) => {
  const m = e.data;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('这个浏览器不支持后台画图');
    const t0 = performance.now();
    const raster = rasterize(m.world, m.scale);
    let bitmap: ImageBitmap;
    let slope: { w: number; h: number; data: Uint8Array } | undefined;
    if (m.style === 'realistic') {
      const g = realisticGlobeMaps(m.world, raster);
      bitmap = (g.albedo as OffscreenCanvas).transferToImageBitmap();
      slope = { w: raster.w, h: raster.h, data: g.slope };
    } else if (m.style === 'fantasy') {
      bitmap = (fantasyGlobeBase(m.world, raster) as OffscreenCanvas).transferToImageBitmap();
    } else {
      const cv = new OffscreenCanvas(raster.w, raster.h);
      const ctx = cv.getContext('2d') as unknown as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error('开不了这么大的画布(内存不够)');
      renderLayer(ctx, m.world, raster, m.layer);
      bitmap = cv.transferToImageBitmap();
    }
    const res: GlobeTexResponse = { ok: true, bitmap, slope, ms: performance.now() - t0 };
    self.postMessage(res, { transfer: slope ? [bitmap, slope.data.buffer] : [bitmap] });
  } catch (err) {
    const res: GlobeTexResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(res);
  }
};
