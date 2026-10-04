/**
 * 手指操作的纯计算(不碰 DOM,单测直接测):
 *
 *   pinchStep      两指从上一帧的位置移到这一帧:缩放倍数(两指距离之比)、以两指中点为中心、中点跟着手指平移
 *   isDoubleTap    这一下和上一下算不算"双击"(手指点两下:时间、距离都够近)
 *   sheetSnap      底部抽屉拖完松手停在哪:半高 / 展开 / 关掉(按拖了多远和甩的速度)
 *   sheetGeometry  底部抽屉半高 / 展开时的上边在哪、地图上"抽屉上方看得见的地方"(地图飞过去、地球仪球心上移用)
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * 两指捏合的一步:a0 / b0 = 上一帧两指的位置,a1 / b1 = 这一帧的。
 * f = 缩放倍数(以这一帧的两指中点 (mx, my) 为中心);dx / dy = 中点的位移(两指一起拖 = 平移)。
 * 两指贴得太近(距离 < 1)时不缩放
 */
export function pinchStep(a0: Pt, b0: Pt, a1: Pt, b1: Pt): { f: number; mx: number; my: number; dx: number; dy: number } {
  const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
  const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
  const f = d0 >= 1 && d1 >= 1 ? d1 / d0 : 1;
  const m0x = (a0.x + b0.x) / 2;
  const m0y = (a0.y + b0.y) / 2;
  const mx = (a1.x + b1.x) / 2;
  const my = (a1.y + b1.y) / 2;
  return { f: Number.isFinite(f) && f > 0 ? f : 1, mx, my, dx: mx - m0x, dy: my - m0y };
}

/** 手指点两下算双击:两下相隔 ≤ 320 毫秒、相距 ≤ 32 像素 */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_PX = 32;

export interface Tap extends Pt {
  t: number;
}

export function isDoubleTap(prev: Tap | null, cur: Tap): boolean {
  if (!prev) return false;
  const dt = cur.t - prev.t;
  return dt >= 0 && dt <= DOUBLE_TAP_MS && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= DOUBLE_TAP_PX;
}

export type SheetSnap = 'half' | 'full';

/** 半高:抽屉占屏高的比例(自己的高度,不含下面的时间轴);展开:上边离屏幕顶的比例 */
export const SHEET_HALF = 0.45;
export const SHEET_FULL_TOP = 0.12;

/**
 * 抽屉的几何(舞台坐标,像素):H = 界面高,rowH = 底部一行(时间轴)的高度,topRoom = 顶上世界名那一截。
 * halfTop / fullTop = 半高 / 展开时抽屉上边的 y;bottom = 抽屉下边(时间轴上边)的 y;
 * free = 半高时抽屉上方、顶栏下方看得见的地图 [上, 下]
 */
export function sheetGeometry(H: number, rowH: number, topRoom = 72): { halfTop: number; fullTop: number; bottom: number; free: [number, number] } {
  const bottom = H - rowH;
  // 太矮的屏幕:半高的抽屉至少露出头部(200),上面至少留 topRoom + 80 的地图
  const halfTop = Math.max(topRoom + 80, Math.min(bottom - 200, bottom - SHEET_HALF * H));
  const fullTop = Math.min(halfTop, Math.max(SHEET_FULL_TOP * H, 8));
  return { halfTop, fullTop, bottom, free: [topRoom, Math.max(topRoom + 80, halfTop)] };
}

/**
 * 抽屉拖完松手停在哪:from = 拖之前的状态,top = 松手时抽屉上边的 y,vy = 松手前的速度(像素 / 毫秒,向下为正);
 * 几何见 sheetGeometry。快速往上甩 → 展开;快速往下甩 → 半高(从展开)或关掉(从半高);
 * 慢慢拖 → 停在离得最近的那一档,拖到半高以下超过下面那截的三分之一 → 关掉
 */
export function sheetSnap(from: SheetSnap, top: number, vy: number, g: { halfTop: number; fullTop: number; bottom: number }): SheetSnap | 'close' {
  const FLICK = 0.5;
  if (vy <= -FLICK) return 'full';
  if (vy >= FLICK) return from === 'full' && top < g.halfTop ? 'half' : 'close';
  const closeAt = g.halfTop + (g.bottom - g.halfTop) / 3;
  if (top > closeAt) return 'close';
  return Math.abs(top - g.fullTop) < Math.abs(top - g.halfTop) ? 'full' : 'half';
}
