/** 数据图层:板块 / 海拔 / 气温 / 降水 / 生物群落 —— 看清"世界是怎么来的"。 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import { BIOMES } from '../gen/biomes';
import { latitudeAt, windAt } from '../gen/climate';
import { geometryOf } from '../gen/geometry';
import { bakedView, drawRivers, hexRGB, hillshade, mix, ramp, rowCos, wrapOf, wrapShifts, type RGB } from './common';

export type LayerId = 'plates' | 'elevation' | 'temperature' | 'precipitation' | 'biomes';

export const LAYERS: { id: LayerId; name: string }[] = [
  { id: 'plates', name: '板块' },
  { id: 'elevation', name: '海拔' },
  { id: 'temperature', name: '气温' },
  { id: 'precipitation', name: '降水' },
  { id: 'biomes', name: '生物群落' },
];

export const ELEV_RAMP: [number, RGB][] = [
  [-6000, hexRGB('#08204a')],
  [-2000, hexRGB('#1d4f8f')],
  [-200, hexRGB('#4a8cc7')],
  [0, hexRGB('#8cc4e0')],
  [1, hexRGB('#3f8f55')],
  [300, hexRGB('#86b061')],
  [1000, hexRGB('#d9cf85')],
  [2200, hexRGB('#b98a55')],
  [3800, hexRGB('#8a6a55')],
  [5500, hexRGB('#f2f0ee')],
];
export const TEMP_RAMP: [number, RGB][] = [
  [-30, hexRGB('#3b1f8f')],
  [-15, hexRGB('#3565c9')],
  [-3, hexRGB('#7fc3e6')],
  [5, hexRGB('#d8eed2')],
  [14, hexRGB('#f2df7a')],
  [22, hexRGB('#f09a42')],
  [30, hexRGB('#c7352b')],
];
export const PRECIP_RAMP: [number, RGB][] = [
  [0, hexRGB('#8c5a2b')],
  [250, hexRGB('#d8b26a')],
  [600, hexRGB('#e9e39a')],
  [1200, hexRGB('#7cc16a')],
  [2000, hexRGB('#2f9a8a')],
  [3200, hexRGB('#1c4f9c')],
];

function plateColor(k: number): RGB {
  const hue = (k * 137.508) % 360;
  const s = 0.45;
  const l = 0.62;
  const f = (nn: number) => {
    const kk = (nn + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)));
  };
  return [f(0), f(8), f(4)];
}

export function renderLayer(ctx: CanvasRenderingContext2D, world: World, r: Raster, layer: LayerId) {
  const { w, h, elev, water, temp, precip, biome, cell } = r;
  const shade = hillshade(r, 0.01, 0.2);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const { plate, plateContinental } = world.tect;
  for (let k = 0; k < w * h; k++) {
    let c: RGB;
    switch (layer) {
      case 'plates': {
        const p = plate[cell[k]];
        c = plateColor(p);
        if (!plateContinental[p]) c = mix(c, [40, 60, 90], 0.45);
        if (water[k] !== 0) c = mix(c, [20, 40, 70], 0.2);
        break;
      }
      case 'elevation':
        c = ramp(ELEV_RAMP, water[k] === 2 ? -100 : elev[k]);
        break;
      case 'temperature':
        c = ramp(TEMP_RAMP, temp[k]);
        break;
      case 'precipitation':
        c = water[k] === 1 ? mix(ramp(PRECIP_RAMP, precip[k]), [30, 40, 60], 0.5) : ramp(PRECIP_RAMP, precip[k]);
        break;
      default:
        c = BIOMES[biome[k]].real;
    }
    const s = shade[k];
    const f = layer === 'plates' ? 1 : Math.max(0.5, Math.min(1.4, 1 + (s - 1) * 0.7));
    d[k * 4] = c[0] * f;
    d[k * 4 + 1] = c[1] * f;
    d[k * 4 + 2] = c[2] * f;
    d[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  if (layer === 'plates') drawPlateOverlay(ctx, world, r.scale);
  if (layer === 'elevation' || layer === 'precipitation')
    drawRivers(ctx, world.rivers, { ...bakedView(r.scale), wrap: wrapOf(world) }, world.riverThreshold, {
      color: 'rgba(30,70,140,0.85)',
      minW: 0.4,
      maxW: 2.2,
      fluxRef: 900,
    });
  if (layer === 'precipitation') drawWind(ctx, world, r.scale);
}

/**
 * 板块图的叠加层:边界点 + 每个板块的漂移箭头。
 * 重心按球面算(跨 180° 经线的板块不会被"平均"到地图另一头),箭头 = 重心处的速度(东、南分量),
 * 画在主图上时东西向按纬度拉宽;挨着左右边的点、箭头在另一边再画一份
 */
function drawPlateOverlay(ctx: CanvasRenderingContext2D, world: World, S: number) {
  const { mesh, tect } = world;
  const { n, x, y } = mesh;
  const wrap = wrapOf(world);
  // 边界:红 = 碰撞(造山),蓝 = 张裂
  for (let i = 0; i < n; i++) {
    const c = tect.convergence[i];
    if (c === 0) continue;
    const a = Math.min(1, Math.abs(c) / 0.8);
    ctx.fillStyle = c > 0 ? `rgba(200,40,30,${0.35 + 0.6 * a})` : `rgba(30,90,220,${0.35 + 0.6 * a})`;
    for (const sh of wrapShifts(x[i], x[i], wrap, 3)) {
      ctx.beginPath();
      ctx.arc((x[i] + sh) * S, y[i] * S, (1.2 + 1.8 * a) * S, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 漂移方向箭头(画在板块重心)
  const P = tect.plateCount;
  const cx = new Float64Array(P);
  const cy = new Float64Array(P);
  const cnt = new Float64Array(P);
  for (let i = 0; i < n; i++) cnt[tect.plate[i]]++;
  // 箭头的东西向、南北向分量(世界单位 / 速度 1)
  const ex = new Float64Array(P).fill(1);
  const cen = geometryOf(mesh).groupCentroids(tect.plate, P, cnt);
  for (let p = 0; p < P; p++) {
    if (!cnt[p]) continue;
    cx[p] = cen.x[p] * cnt[p];
    cy[p] = cen.y[p] * cnt[p];
    // 重心处一段地面长度在主图上东西向占 1 / cos(纬度) 倍
    ex[p] = 1 / Math.max(0.2, Math.sin((cen.y[p] / world.height) * Math.PI));
  }
  ctx.strokeStyle = 'rgba(20,20,20,0.85)';
  ctx.fillStyle = 'rgba(20,20,20,0.85)';
  ctx.lineWidth = 2.2 * S;
  for (let p = 0; p < P; p++) {
    if (!cnt[p]) continue;
    const L = 70 * S;
    const x0 = (cx[p] / cnt[p]) * S;
    const dx = tect.plateVx[p] * ex[p] * L;
    for (const sh of wrapShifts(Math.min(x0, x0 + dx) / S - 12, Math.max(x0, x0 + dx) / S + 12, wrap)) {
      const ox = x0 + sh * S;
      const oy = (cy[p] / cnt[p]) * S;
      const tx = ox + dx;
      const ty = oy + tect.plateVy[p] * L;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      const a = Math.atan2(ty - oy, tx - ox);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(a - 0.45) * 12 * S, ty - Math.sin(a - 0.45) * 12 * S);
      ctx.lineTo(tx - Math.cos(a + 0.45) * 12 * S, ty - Math.sin(a + 0.45) * 12 * S);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ox, oy, 4 * S, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWind(ctx: CanvasRenderingContext2D, world: World, S: number) {
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.2 * S;
  const step = 64;
  const L = 16;
  for (let yy = step / 2; yy < world.height; yy += step) {
    let [wx, wy] = windAt(latitudeAt(yy, world.height));
    // 同样的风向在主图的高纬度东西向被拉宽(箭头长度不变,只改方向)
    const len = Math.sqrt(wx * wx + wy * wy);
    const sx = wx / Math.max(0.05, rowCos(yy, world.height));
    const l2 = Math.sqrt(sx * sx + wy * wy) || 1;
    wx = (sx / l2) * len;
    wy = (wy / l2) * len;
    for (let xx = step / 2; xx < world.width; xx += step) {
      const x0 = xx * S;
      const y0 = yy * S;
      const x1 = (xx + wx * L) * S;
      const y1 = (yy + wy * L) * S;
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(ang - 0.5) * 5 * S, y1 - Math.sin(ang - 0.5) * 5 * S);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(ang + 0.5) * 5 * S, y1 - Math.sin(ang + 0.5) * 5 * S);
      ctx.stroke();
    }
  }
}
