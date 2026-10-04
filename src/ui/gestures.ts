/**
 * 手指操作的纯计算(不碰 DOM,单测直接测):
 *
 *   pinchStep      两指从上一帧的位置移到这一帧:缩放倍数(两指距离之比)、以两指中点为中心、中点跟着手指平移
 *   isDoubleTap    这一下和上一下算不算"双击"(手指点两下:时间、距离都够近)
 *   sheetSnap      详情卡片(底部)拖完松手停在哪:半高 / 展开 / 关掉(按拖了多远和甩的速度)
 *   worldSnap      世界卡片(没选东西时的底部卡片)拖完松手停在哪:收起 / 拉到顶
 *   releaseVelocity 松手时的速度(只看最后一小段;停住再松手不算甩)
 *   sheetGeometry  底部卡片各档的上边在哪、地图上"卡片和时间轴上方看得见的地方"(地图飞过去、地球仪球心上移用)
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
/** 手机上没选东西时底部那张"世界"卡片:收起(只露搜索框和世界名一行)/ 拉到顶 */
export type WorldSnap = 'peek' | 'full';

/**
 * 手机布局的几块高度(CSS 像素;和 phone.css 的 --peek-h、--capsule-h、--capsule-gap 一致):
 * PEEK_H = 世界卡片收起时露出的高度(没有底部横条时;有横条见 peekHeight);CAPSULE_H = 时间轴胶囊;
 * CAPSULE_GAP = 胶囊和下面卡片之间的空(上面再留一道一样的)
 */
export const PEEK_H = 108;
/** 世界卡片收起时露出的高度:底部有横条(安全区 safeB)时多出横条那一截,和 phone.css 的 calc(100px + max(安全区, 8px)) 一致 */
export function peekHeight(safeB = 0): number {
  return PEEK_H - 8 + Math.max(safeB, 8);
}
export const CAPSULE_H = 52;
export const CAPSULE_GAP = 10;
/** 卡片上方被时间轴胶囊占掉的一截(胶囊 + 上下各一道空) */
export const ABOVE_SHEET = CAPSULE_H + 2 * CAPSULE_GAP;

/** 半高:详情卡片占屏高的比例(卡片一直铺到屏幕底);展开:上边离屏幕顶的比例 */
export const SHEET_HALF = 0.5;
export const SHEET_FULL_TOP = 0.08;

/**
 * 手机底部卡片的几何(舞台坐标,像素):H = 界面高,topRoom = 顶上留给提示条的一截(含刘海),safeB = 底部横条的安全区。
 * halfTop / fullTop = 详情卡片半高 / 展开时上边的 y;peekTop = 世界卡片收起时上边的 y;bottom = 卡片下边(屏幕底);
 * free = 详情卡片半高时,它上面的时间轴胶囊再往上、顶上那截往下看得见的地图 [上, 下]
 */
export function sheetGeometry(H: number, topRoom = 24, safeB = 0): { halfTop: number; fullTop: number; peekTop: number; bottom: number; free: [number, number] } {
  const bottom = H;
  // 太矮的屏幕:半高的卡片至少露出头部和一排按钮(240),上面至少留胶囊 + 80 的地图
  const halfTop = Math.max(topRoom + ABOVE_SHEET + 80, Math.min(bottom - 240, bottom - SHEET_HALF * H));
  const fullTop = Math.min(halfTop, Math.max(SHEET_FULL_TOP * H, 8));
  return { halfTop, fullTop, peekTop: bottom - peekHeight(safeB), bottom, free: [topRoom, Math.max(topRoom + 80, halfTop - ABOVE_SHEET)] };
}

/**
 * 详情卡片拖完松手停在哪:from = 拖之前的状态,top = 松手时卡片上边的 y,vy = 松手前的速度(像素 / 毫秒,向下为正);
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

/** 拖动时记下的手指位置(clientY、performance.now() 毫秒) */
export interface DragSample {
  y: number;
  t: number;
}

/** 算松手时的速度只看最后这么多毫秒的移动 */
export const VELOCITY_MS = 120;

/**
 * 松手时的速度(像素 / 毫秒,往下为正):松手前 VELOCITY_MS 毫秒内记下的位置连到松手那一点。
 * 甩完按住停一会儿再松手 = 0,按慢慢拖算(停在离得近的那一档)
 */
export function releaseVelocity(samples: readonly DragSample[], y: number, t: number): number {
  const a = samples.find((s) => t - s.t <= VELOCITY_MS);
  return a && t > a.t ? (y - a.y) / (t - a.t) : 0;
}

/** 世界卡片拖完松手停在哪:快速甩 → 甩的方向;慢慢拖 → 离得近的那一档(收起 / 拉到顶) */
export function worldSnap(top: number, vy: number, g: { fullTop: number; peekTop: number }): WorldSnap {
  const FLICK = 0.5;
  if (vy <= -FLICK) return 'full';
  if (vy >= FLICK) return 'peek';
  return Math.abs(top - g.fullTop) < Math.abs(top - g.peekTop) ? 'full' : 'peek';
}
