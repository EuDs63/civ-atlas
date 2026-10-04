/**
 * "看世界长出来":把侵蚀过程中的地形快照渲成一帧帧小图(RGBA),给界面回放。
 * 在 worker 里算,不依赖 DOM。
 * 按球面三角形插值成等距圆柱小图(和主图同一套铺法,见 raster.ts 的 sphereField),
 * 晕渲的左右邻居列下标取模、东西向坡度按纬度修正。
 */
import type { World } from './world';
import { sphereField } from './raster';

export interface HistoryFrames {
  w: number;
  h: number;
  frames: Uint8ClampedArray[];
  /** 每帧对应"距今多少百万年" */
  mya: number[];
}

/** 把网格上的一个标量场按球面三角形插值到 w×h 的等距圆柱小图(和主图同一套铺法,见 raster.ts 的 sphereField) */
function rasterField(world: World, field: Float32Array, w: number, h: number): Float32Array {
  return sphereField(world.mesh, field, w, h);
}

const LAND: [number, [number, number, number]][] = [
  [0, [92, 128, 74]],
  [400, [128, 146, 88]],
  [1200, [168, 150, 104]],
  [2500, [140, 118, 96]],
  [4000, [200, 196, 190]],
  [5500, [246, 246, 246]],
];

function landColor(e: number): [number, number, number] {
  if (e <= LAND[0][0]) return LAND[0][1];
  for (let i = 1; i < LAND.length; i++) {
    if (e <= LAND[i][0]) {
      const [e0, c0] = LAND[i - 1];
      const [e1, c1] = LAND[i];
      const t = (e - e0) / (e1 - e0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return LAND[LAND.length - 1][1];
}

export function buildHistoryFrames(world: World, w = 1024, h = 512): HistoryFrames {
  const land = world.tect.land;
  const frames: Uint8ClampedArray[] = [];
  const total = world.history.length;
  const mya: number[] = [];
  const zf = (0.012 * w) / world.width;
  const isLand = rasterField(world, Float32Array.from(land), w, h);
  for (let f = 0; f < total; f++) {
    const e = rasterField(world, world.history[f], w, h);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      // 上下邻居按列夹住;东西相连,左右邻居列下标取模,
      // 东西向坡度除以 cos(纬度)(高纬度一个像素的地面宽度更窄)
      const up = yy > 0 ? -w : 0;
      const dn = yy < h - 1 ? w : 0;
      const zx = zf / Math.max(0.01, Math.sin(((yy + 0.5) / h) * Math.PI));
      for (let xx = 0; xx < w; xx++) {
        const k = yy * w + xx;
        let c: [number, number, number];
        let shade = 1;
        if (isLand[k] > 0.5) {
          c = landColor(e[k]);
          const lf = xx > 0 ? k - 1 : k + w - 1;
          const rt = xx < w - 1 ? k + 1 : k - w + 1;
          const dx = (e[rt] - e[lf]) * zx;
          const dy = (e[k + dn] - e[k + up]) * zf;
          shade = Math.max(0.4, Math.min(1.5, 1 + (-dx - dy) * 0.5 / Math.sqrt(dx * dx + dy * dy + 1)));
        } else {
          const d = Math.min(1, -e[k] / 5000);
          c = [40 - 25 * d, 105 - 60 * d, 150 - 60 * d];
        }
        const o = k * 4;
        px[o] = c[0] * shade;
        px[o + 1] = c[1] * shade;
        px[o + 2] = c[2] * shade;
        px[o + 3] = 255;
      }
    }
    frames.push(px);
    // 把整个侵蚀过程映射到约 1.8 亿年
    mya.push(Math.round(180 * (1 - (f + 1) / total)));
  }
  return { w, h, frames, mya };
}
