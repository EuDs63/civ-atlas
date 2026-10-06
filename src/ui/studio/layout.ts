/**
 * 新建界面的摆放(纯计算):两边面板之间那块地方、星球在里面多大、摊平改地形时平面地图放在哪、
 * 创建以后平常页面的地图在哪(星球变形过去再淡出,接得上)。
 *
 * 位置都是视口里的 CSS 像素;一个"姿势"(Pose)= 投影平面 1 个单位多少像素 + 图的中心。
 */
import { PROJECTIONS, PROJ_PAD } from '../../render/projection';
import type { PlanetProjection } from '../../render/planet';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pose {
  k: number;
  cx: number;
  cy: number;
}

/** 电脑上左边设定、右边样式和投影的宽度(studio.css 里一样) */
export const LEFT_W = 340;
export const RIGHT_W = 228;
/** 卷成球时的俯角(弧度):北半球朝人一点,像地球仪 */
export const TILT = 0.32;
/** 世界的大小(和 gen/world 的 MAP_W × MAP_H 一样;平常页面的地图按它放进地图框) */
const WORLD_W = 2048;
const WORLD_H = 1024;

/** 一种投影铺开以后的宽高(投影平面单位);地球仪 = 直径 2 */
export function projExtent(id: PlanetProjection): { w: number; h: number } {
  if (id === 'globe') return { w: 2, h: 2 };
  const d = PROJECTIONS[id];
  return { w: 2 * Math.PI * d.kx(0), h: 2 * d.y(d.latMax) };
}

export interface FitOpts {
  phone: boolean;
  /** 开场:地图占满整个窗口,不让出底下的字幕 */
  intro: boolean;
}

/**
 * 星球在这块地方里的姿势:地球仪按短边的 0.38(手机 0.42)当半径;平面地图四周留边、底下让出字幕,
 * 电脑上平面图往上挪一点(和地球仪的视觉中心对齐)
 */
export function fitPose(id: PlanetProjection, b: Box, o: FitOpts): Pose {
  const cx = b.x + b.w / 2;
  if (id === 'globe') return { k: Math.min(b.w, b.h) * (o.phone ? 0.42 : 0.38), cx, cy: b.y + b.h / 2 - 6 };
  const e = projExtent(id);
  const pad = o.phone ? 14 : 44;
  const bottom = o.phone ? 60 : 90;
  const k = Math.max(1, Math.min((b.w - 2 * pad) / e.w, (b.h - pad - bottom) / e.h));
  return { k, cx, cy: b.y + b.h / 2 + (o.phone || o.intro ? 0 : -18) };
}

/** 摊平改地形时平面地图的位置:等距圆柱铺在 fitPose 的地方(正好 2:1,平常的地图放进去正好铺满、不用裁) */
export function flatRect(b: Box, o: FitOpts): Box {
  const p = fitPose('equirect', b, o);
  const w = Math.round(2 * Math.PI * p.k);
  const h = Math.round(w / 2);
  return { x: Math.round(p.cx - w / 2), y: Math.round(p.cy - h / 2), w, h };
}

/**
 * 平常页面(建好以后)的地图在一个 W × H 的舞台里的姿势:地图框按舞台"盖满"(宽 = max(W, 2H)),
 * 等距圆柱铺满地图框;弯边投影按 mapProj 的比例放在地图框中间(四周留 PROJ_PAD)
 */
export function appPose(id: PlanetProjection, W: number, H: number): Pose {
  const bw = Math.max(W, 2 * H);
  const cx = W / 2;
  const cy = H / 2;
  if (id === 'globe' || id === 'equirect') return { k: bw / (2 * Math.PI), cx, cy };
  const d = PROJECTIONS[id];
  const pad = PROJ_PAD * WORLD_H;
  const s = Math.min((WORLD_W - 2 * pad) / (2 * d.kx(0) * Math.PI), (WORLD_H - 2 * pad) / (2 * d.y(d.latMax)));
  return { k: (s * bw) / WORLD_W, cx, cy };
}

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { k: a.k + (b.k - a.k) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
}

/** 动画的缓动:三次方先快后慢再缓(两头都平) */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 漂移字幕上的年代:t = 0 约 1.8 亿年前,1 = 今天 */
export function driftYears(t: number): string {
  const my = 180 * (1 - t);
  if (t >= 0.995) return '今天';
  if (my >= 100) return `约 ${(my / 100).toFixed(1)} 亿年前`;
  return `约 ${Math.max(1, Math.round(my / 10)) * 1000} 万年前`;
}
