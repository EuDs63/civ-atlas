/**
 * 地球仪上的手绘符号(山、丘陵、沙丘、草丛、火山):每帧在球上面那层 2D 画布里正立着画。
 *
 * 等距圆柱贴图包到球上,纬度 φ 处横向被压成 cos φ(60° 压成一半、75° 压到四分之一),烤在贴图里的符号跟着变扁,
 * 到了两极还转成放射状。所以地球仪的手绘贴图不带这几样(fantasy.ts 的 fantasyGlobeBase),改成这里每帧画:
 *   - 规划:和平面主图同一套(fantasy.ts 的 planGlyphs),间距按球面上的真实距离留(横向 × cos 纬度)——
 *     高纬度的符号不挤成一团;每个世界算一次
 *   - 位置:符号底边中点按正射投影到屏幕上;大小按屏幕像素(glyphScale × 等效主图缩放下一个世界单位的像素),
 *     和平面主图同样缩放时一样大;按缩放分级出现(GLYPH_TIERS,缩放按等效的主图缩放倍数)
 *   - 山脊走向按这一点的投影换算到屏幕上(峰顶偏向、符号宽窄跟着变,和弯边投影一样)
 *   - 背面的不画;靠近球边缘的淡出;球边缘附近地面被压扁,按屏幕距离再挑一遍(挤在一起的,优先级低的那个不画)
 *   - 从上到下排序后画(下面的压住上面的,和平面主图一样)
 * 规划、投影、挑选是纯计算(单测在 Node 里跑);画用 fantasy.ts 的 drawGlyph(和平面主图同一份画法)。
 */
import type { World } from '../gen/world';
import { G_DUNE, G_HILL, G_MOUNTAIN, G_TUFT, G_VOLCANO, drawGlyph, glyphScale, planGlyphs, type Glyph } from './fantasy';
import type { GlyphMetric } from './projection';
import type { GlobeProjector } from './globeLines';

const PI = Math.PI;

/** 朝向(视线和球面法线的夹角余弦)低于这个不画 */
export const GLYPH_D_MIN = 0.06;
/** 朝向在这以下淡出(到 GLYPH_D_MIN 时全透明) */
const GLYPH_D_FADE = 0.3;
/** 朝向低于这个(球边缘附近,地面在径向被压扁)才按屏幕距离再挑一遍 */
const THIN_BELOW = 0.85;

/** 球面上的"尺子":纬度 φ 处世界 1 单位在球面上横向 cos φ、纵向 1(按赤道处的世界单位量) */
export function sphereMetric(H: number): GlyphMetric {
  return {
    fx: (wy) => Math.max(0.04, Math.cos(PI / 2 - (wy / H) * PI)),
    fy: () => 1,
  };
}

/** 一个世界的地球仪符号:规划 + 预先算好的三维位置、山脊方向、挑选顺序 */
export interface GlobeGlyphSet {
  glyphs: Glyph[];
  /** 符号底边中点的单位向量 x,y,z… */
  xyz: Float32Array;
  /** 山脊走向(球面切平面上的三维方向,没归一化)x,y,z…;不是山的是 0 */
  ridge: Float32Array;
  /** 规划时的占位半径(世界单位,缩放 1 倍时) */
  rad: Float32Array;
  /** 挑选顺序:先出现的级别、火山 → 山 → 丘陵 → 沙丘 → 草丛、大的在前(下标) */
  order: Int32Array;
}

const KIND_RANK: Record<number, number> = { [G_VOLCANO]: 0, [G_MOUNTAIN]: 1, [G_HILL]: 2, [G_DUNE]: 3, [G_TUFT]: 4 };

/** 规划时的占位半径(和 planGlyphs 一致;山的主脊 / 侧脊不分,取中间) */
function planRadius(g: Glyph): number {
  switch (g.kind) {
    case G_VOLCANO:
      return g.s * 1.15;
    case G_MOUNTAIN:
      return g.s * 0.75;
    case G_HILL:
      return g.s * 2;
    case G_DUNE:
      return 5;
    default:
      return 2.6;
  }
}

const sets = new WeakMap<World, GlobeGlyphSet>();

/** 这个世界的地球仪符号(每个世界算一次,约几十毫秒) */
export function globeGlyphSet(world: World): GlobeGlyphSet {
  let gs = sets.get(world);
  if (gs) return gs;
  const W = world.width;
  const H = world.height;
  const glyphs = planGlyphs(world, sphereMetric(H)).glyphs;
  const n = glyphs.length;
  const xyz = new Float32Array(n * 3);
  const ridge = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = glyphs[i];
    const lon = (g.x / W) * 2 * PI - PI;
    const lat = PI / 2 - (g.y / H) * PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const co = Math.cos(lon);
    const so = Math.sin(lon);
    xyz[3 * i] = cl * co;
    xyz[3 * i + 1] = cl * so;
    xyz[3 * i + 2] = sl;
    rad[i] = planRadius(g);
    if (g.kind === G_MOUNTAIN) {
      // 世界坐标里的走向 (cos a, sin a)(x 东、y 南)→ 地面上:东 cos a · cos φ、南 sin a → 三维:东 E − 南 N
      const ge = Math.cos(g.a) * cl;
      const gsouth = Math.sin(g.a);
      // E = (−sin λ, cos λ, 0),N = (−sin φ cos λ, −sin φ sin λ, cos φ)
      ridge[3 * i] = -so * ge + sl * co * gsouth;
      ridge[3 * i + 1] = co * ge + sl * so * gsouth;
      ridge[3 * i + 2] = -cl * gsouth;
    }
  }
  const order = Int32Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => glyphs[a].z - glyphs[b].z || KIND_RANK[glyphs[a].kind] - KIND_RANK[glyphs[b].kind] || glyphs[b].s - glyphs[a].s || a - b);
  gs = { glyphs, xyz, ridge, rad, order };
  sets.set(world, gs);
  return gs;
}

/** 这一帧要画的一个符号(画布像素) */
export interface PlacedGlobeGlyph {
  i: number;
  x: number;
  y: number;
  /** 朝向 */
  d: number;
  /** 画面上的山脊走向(弧度,−90°…90°) */
  a: number;
  alpha: number;
}

export interface GlobeGlyphView {
  /** 画布像素的投影(球心、半径、画布大小、视图方向) */
  P: GlobeProjector;
  /** 等效的主图缩放倍数(分级、大小按它) */
  kEq: number;
  /** 一个世界单位在球心处是几个画布像素 */
  unit: number;
  /** 快速档(转动时):只画第一级(全图就有的)符号 */
  quick?: boolean;
}

/** 一个世界单位的符号尺寸(画布像素):和平面主图同样缩放时一样(glyphScale) */
export function globeGlyphScale(v: GlobeGlyphView): number {
  return glyphScale(v.kEq) * v.unit;
}

/**
 * 挑出这一帧要画的符号(纯计算):分级、背面、屏幕外、球边缘挤在一起的去掉;按屏幕 y 从上到下排好
 */
export function placeGlobeGlyphs(set: GlobeGlyphSet, v: GlobeGlyphView): PlacedGlobeGlyph[] {
  const { glyphs, xyz, ridge, rad, order } = set;
  const { cx, cy, R, w, h } = v.P;
  const [c0, c1, c2] = v.P.c;
  const [e0, e1, e2] = v.P.e;
  const [n0, n1, n2] = v.P.n;
  const kz = (v.quick ? 1 : v.kEq) * 1.0001;
  const S = globeGlyphScale(v);
  const tf = glyphScale(v.kEq);
  // 球边缘的挑选:格子边长 = 最大的占位距离
  const cell = Math.max(4, 15 * tf * v.unit);
  const gw = Math.ceil(w / cell) + 2;
  const grid = new Map<number, number[]>();
  const out: PlacedGlobeGlyph[] = [];
  for (let q = 0; q < order.length; q++) {
    const i = order[q];
    const g = glyphs[i];
    if (g.z > kz) continue;
    const px = xyz[3 * i];
    const py = xyz[3 * i + 1];
    const pz = xyz[3 * i + 2];
    const d = px * c0 + py * c1 + pz * c2;
    if (d < GLYPH_D_MIN) continue;
    const x = cx + R * (px * e0 + py * e1 + pz * e2);
    const y = cy - R * (px * n0 + py * n1 + pz * n2);
    const pad = (g.s * 1.6 + 4) * S;
    if (x < -pad || y < -pad || x > w + pad || y > h + pad) continue;
    // 球边缘附近:和已经放上的(优先级高的)符号在屏幕上挤在一起就不画(规划时按地面距离留的空当,在这里被压扁了)
    const need = rad[i] * tf * v.unit * 0.9;
    const gx = Math.floor(x / cell) + 1;
    const gy = Math.floor(y / cell) + 1;
    let clash = false;
    for (let yy = gy - 1; yy <= gy + 1 && !clash; yy++)
      for (let xx = gx - 1; xx <= gx + 1; xx++) {
        const l = grid.get(yy * gw + xx);
        if (!l) continue;
        for (const j of l) {
          const o = out[j];
          if (Math.min(o.d, d) >= THIN_BELOW) continue;
          const nd = Math.max(need, rad[o.i] * tf * v.unit * 0.9);
          if ((o.x - x) ** 2 + (o.y - y) ** 2 < nd * nd) {
            clash = true;
            break;
          }
        }
        if (clash) break;
      }
    if (clash) continue;
    let a = g.a;
    if (g.kind === G_MOUNTAIN) {
      const rx = ridge[3 * i];
      const ry = ridge[3 * i + 1];
      const rz = ridge[3 * i + 2];
      // 走向投到屏幕上(屏幕 y 向下),收回 (−90°, 90°]
      a = Math.atan2(-(rx * n0 + ry * n1 + rz * n2), rx * e0 + ry * e1 + rz * e2);
      if (a > PI / 2) a -= PI;
      else if (a <= -PI / 2) a += PI;
    }
    const t = Math.min(1, Math.max(0, (d - GLYPH_D_MIN) / (GLYPH_D_FADE - GLYPH_D_MIN)));
    const key = gy * gw + gx;
    const l = grid.get(key);
    if (l) l.push(out.length);
    else grid.set(key, [out.length]);
    out.push({ i, x, y, d, a, alpha: t * t * (3 - 2 * t) });
  }
  out.sort((p, q) => p.y - q.y || p.i - q.i);
  return out;
}

/** 画(调用方已经把变换设成画布像素);opacity = 整体再乘的不透明度。返回画了几个 */
export function drawGlobeGlyphs(ctx: CanvasRenderingContext2D, set: GlobeGlyphSet, placed: readonly PlacedGlobeGlyph[], v: GlobeGlyphView, opacity = 1): number {
  const S = globeGlyphScale(v);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let alpha = -1;
  for (const p of placed) {
    const a = p.alpha * opacity;
    if (a !== alpha) ctx.globalAlpha = alpha = a;
    drawGlyph(ctx, set.glyphs[p.i], p.x, p.y, p.a, S);
  }
  ctx.restore();
  return placed.length;
}
