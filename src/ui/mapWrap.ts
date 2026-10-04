/**
 * 主图视图(世界东西相连):左右无限拖动、"当前中心经度"。
 *
 * 做法(画两份):地图框(.map-box)还是整体用 CSS 缩放平移,里面每张和世界一样大的画布(地形、文明底图、选中、高亮、回放)
 * 在右边再接一份一模一样的(.wrap-copy,画完就把像素复制过去,显卡里复制,很快)。
 * 平移量 x 每次都挪整数圈,让主图那一份的左边正好落在视窗左边或更左一点 —— 右边接的那一份就补满视窗,转多少圈都是这两份。
 * 拖动时只改 CSS 变换,底图一张都不用重画;文字层、细节层、视窗装饰按"展开"的世界坐标(x 可以超出 [0, 宽))画。
 *
 * 屏幕层(.screen-layer):文字层、细节层、视窗装饰这几张按屏幕像素画的画布不放进被 CSS 放大的地图框,
 * 而是放在铺满舞台、不缩放的屏幕层里,按地图框的位置自己摆(placeOnScreen)—— 画布像素和屏幕像素一一对应。
 * 放在放大十几倍的容器里时,有的浏览器(Safari)会按很低的分辨率显示它们,放大后整片发糊。
 * 上下顺序和原来一样:地形图(放大的地图框)→ 细节层、视窗装饰(屏幕层)→ 文明层、回放(又一层放大的地图框)→ 文字层(屏幕层)。
 *
 * 视窗:外框和地图框一样大、一样居中(缩放 1 倍时正好是地图框,放大后是"外框 ∩ 舞台"),左右不随平移动 ——
 * 视窗外面的那一份被裁掉,所以永远只看到一整圈以内,同一个地方不会出现两次。
 * 手绘风的纸边做旧、外框、罗盘就画在这个外框上(MapDecor),拖动时地图从下面滑过。
 *
 * 当前中心经度(getMapCenter / useMapCenter / requestMapCenter):等距圆柱时 App 每次视图变了就更新;
 * 弯边投影(ui/projection.ts)时它就是中央经线本身,左右拖动、弹层里的中央经线滑条、"设为中心"改它,整图按它重投影。
 * "中央经线"设置、存档、分享链接、导出都读它、改它。
 */
import { useSyncExternalStore } from 'react';

/** 舞台(视口)和地图框(缩放 1 倍时)的大小,CSS 像素 */
export interface StageBox {
  sw: number;
  sh: number;
  bw: number;
  bh: number;
  /**
   * 舞台底部被界面盖住的高度(窄屏的底部抽屉 + 时间轴;没有 = 0):地图可以往上推进这一截,
   * 下半截的地方也能挪到抽屉上方看得见的地方(推上去以后露出的底色在抽屉下面,看不见)
   */
  padB?: number;
}

export interface MapView {
  k: number;
  x: number;
  y: number;
}

/** 外框(不随平移,在舞台里居中)在舞台上的左右位置 */
export function frameSpan(k: number, b: StageBox): [number, number] {
  return [b.sw / 2 - (k * b.bw) / 2, b.sw / 2 + (k * b.bw) / 2];
}

/** 视窗(看得见的左右范围)= 外框 ∩ 舞台 */
export function windowSpan(k: number, b: StageBox): [number, number] {
  const [fl, fr] = frameSpan(k, b);
  return [Math.max(0, fl), Math.min(b.sw, fr)];
}

/** 地图框(缩放 1 倍、平移 0 时)在舞台上的左上角:在舞台里居中 */
const boxLeft = (b: StageBox) => (b.sw - b.bw) / 2;
const boxTop = (b: StageBox) => (b.sh - b.bh) / 2;

/**
 * 上下的平移范围:地图框比舞台矮(或一样高)时,放大后的画面不离开舞台;
 * 地图框比舞台高(舞台比 2:1 还宽,地图框按宽度盖满)时,地图框的上下边不进到舞台里面 —— 放大、拖动都能看到两极
 */
function clampY(y: number, k: number, b: StageBox): number {
  const pad = b.padB ?? 0;
  if (b.bh <= b.sh) return Math.min(0, Math.max(b.sh - b.sh * k - pad, y));
  const top = boxTop(b);
  return Math.min(-k * top, Math.max(b.sh - k * (top + b.bh) - pad, y));
}

/**
 * 平移范围:上下夹在两极以内(地图框不离开舞台);左右不限,x 挪整数圈到
 * "主图那一份的左边在视窗左边或更左一点(差不到一圈)"(右边接的那一份补满视窗)
 */
export function clampSphere(v: MapView, b: StageBox): MapView {
  const [wl] = windowSpan(v.k, b);
  const P = v.k * b.bw;
  let x = v.x;
  if (P > 0 && Number.isFinite(x)) {
    const L = x + v.k * boxLeft(b);
    x -= P * Math.ceil((L - wl) / P - 1e-9);
  }
  return { k: v.k, x, y: clampY(v.y, v.k, b) };
}

/**
 * 弯边投影(罗宾森、摩尔威德……,见 ui/projection.ts):整张图就在地图框里,不接右边那一份;
 * 地图框横向永远正对外框(左右拖动改的是中央经线,整图重投影,不是平移),上下照常夹在地图以内
 */
export function clampCurved(v: MapView, b: StageBox): MapView {
  return { k: v.k, x: (b.sw * (1 - v.k)) / 2, y: clampY(v.y, v.k, b) };
}

/** 舞台坐标 → 展开的世界坐标(x 可以超出 [0, W):主图那一份左边起算) */
export function stageToWorld(X: number, Y: number, v: MapView, b: StageBox, W: number, H: number): [number, number] {
  return [(((X - v.x) / v.k - boxLeft(b)) / b.bw) * W, (((Y - v.y) / v.k - boxTop(b)) / b.bh) * H];
}

/** 展开的世界坐标 → 舞台坐标 */
export function worldToStage(wx: number, wy: number, v: MapView, b: StageBox, W: number, H: number): [number, number] {
  return [v.x + (boxLeft(b) + (wx / W) * b.bw) * v.k, v.y + (boxTop(b) + (wy / H) * b.bh) * v.k];
}

/** 视窗中心的世界 x(取模到 [0, W)) */
export function centerX(v: MapView, b: StageBox, W: number): number {
  const x = stageToWorld(b.sw / 2, 0, v, b, W, 1)[0];
  return x - W * Math.floor(x / W);
}

/** 世界 x → 经度(度,−180 … 180;x = 0 是 180° 经线,地图正中是 0°) */
export function lonOfX(x: number, W: number): number {
  const t = x / W - Math.floor(x / W);
  const lon = t * 360 - 180;
  return lon >= 180 ? lon - 360 : lon;
}

/** 经度 → 世界 x([0, W)) */
export function xOfLon(lon: number, W: number): number {
  const t = (lon + 180) / 360;
  return (t - Math.floor(t)) * W;
}

/** 平移成"视窗中心在世界 x = wx"(缩放、上下不变) */
export function viewCentredAt(v: MapView, b: StageBox, W: number, wx: number): MapView {
  return clampSphere({ k: v.k, x: b.sw / 2 - v.k * (boxLeft(b) + (wx / W) * b.bw), y: v.y }, b);
}

/** 经度写成 "45°E" / "120°W" / "0°" / "180°" */
export function formatLon(lon: number): string {
  const a = Math.round(Math.abs(lon));
  if (a === 0) return '0°';
  if (a === 180) return '180°';
  return `${a}°${lon > 0 ? 'E' : 'W'}`;
}

// ---------------------------------------------------------------------------
// 右边接的那一份:把画好的画布复制过去

/** 把 src 的像素复制到 dst(右边接的那一份);on = false 时把 dst 清空、释放显存 */
export function mirrorCanvas(dst: HTMLCanvasElement | null, src: HTMLCanvasElement | null, on: boolean): void {
  if (!dst) return;
  if (!on || !src || !src.width || !src.height) {
    if (dst.width) dst.width = dst.height = 0;
    return;
  }
  if (dst.width !== src.width || dst.height !== src.height) {
    dst.width = src.width;
    dst.height = src.height;
  }
  const ctx = dst.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(src, 0, 0);
}

// ---------------------------------------------------------------------------
// 看得见的那一块(文字层、细节层、视窗装饰按它铺画布)

export interface Visible {
  /** 缩放倍数 */
  k: number;
  /** 地图框(缩放 1 倍)的 CSS 宽高 */
  bw: number;
  bh: number;
  /** 看得见的那一块,地图框自己的 CSS 坐标(缩放前);x 可以到 2 × bw(右边接的那一份) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 外框左边在地图框坐标里的 x(缩放前) */
  frameX: number;
  /** 看得见的那一块左上角的屏幕坐标(clientX / clientY) */
  left: number;
  top: number;
  /** 地图框左上角在舞台(屏幕层)里的位置 */
  ox: number;
  oy: number;
}

/**
 * 地图框(.map-box,已被 CSS 放大)里看得见的那一块:地图框(往右多算一份)和视窗(外框 ∩ 舞台)的交集,
 * 换回地图框自己的坐标
 */
export function visibleBox(box: HTMLElement): Visible | null {
  const stage = (box.closest('.stage') as HTMLElement | null) ?? box.parentElement ?? box;
  const br = box.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  if (!bw || !br.width) return null;
  const k = br.width / bw;
  const mid = sr.left + sr.width / 2;
  const fl = mid - (bw * k) / 2;
  const left = Math.max(sr.left, fl);
  const right = Math.min(sr.right, mid + (bw * k) / 2);
  const boxRight = br.left + 2 * br.width;
  const frameX = (fl - br.left) / k;
  const vx0 = Math.max(br.left, left);
  const vy0 = Math.max(br.top, sr.top);
  const vx1 = Math.min(boxRight, right);
  const vy1 = Math.min(br.bottom, sr.bottom);
  if (vx1 - vx0 < 1 || vy1 - vy0 < 1) return null;
  return {
    k,
    bw,
    bh,
    x0: (vx0 - br.left) / k,
    y0: (vy0 - br.top) / k,
    x1: (vx1 - br.left) / k,
    y1: (vy1 - br.top) / k,
    frameX,
    left: vx0,
    top: vy0,
    ox: br.left - sr.left,
    oy: br.top - sr.top,
  };
}

/** 屏幕层里的画布 → 同一个舞台里的地图框(地形图那一层的 .map-box;按它的位置、缩放倍数摆) */
export function mapBoxOf(el: Element | null): HTMLElement | null {
  return (el?.closest('.stage')?.querySelector('.map-box') as HTMLElement | null) ?? null;
}

/**
 * 屏幕层里的一张画布(按屏幕像素画的:文字层、细节层、视窗装饰)摆到屏幕上:
 * 它画的是地图框坐标 (x0, y0) 起的一块、画的时候缩放 k0 倍,CSS 宽高 = 画布像素 ÷ 画的时候的像素密度。
 * 现在的缩放倍数和画的时候一样时只平移(对齐到屏幕像素,不糊);不一样时(细节层放大一点点还没重画)再按比例缩放
 */
export function placeOnScreen(cv: HTMLCanvasElement, vis: Visible, x0: number, y0: number, k0: number): void {
  const s = vis.k / k0;
  let X = vis.ox + x0 * vis.k;
  let Y = vis.oy + y0 * vis.k;
  const same = Math.abs(s - 1) < 1e-6;
  if (same) {
    const dpr = window.devicePixelRatio || 1;
    X = Math.round(X * dpr) / dpr;
    Y = Math.round(Y * dpr) / dpr;
  }
  cv.style.transform = `translate(${X}px, ${Y}px)${same ? '' : ` scale(${s})`}`;
}

// ---------------------------------------------------------------------------
// 当前中心经度

let center = 0;
const centerSubs = new Set<() => void>();
let onRequest: ((lon: number) => void) | null = null;

/** 视窗中心的经度(度,−180 … 180) */
export function getMapCenter(): number {
  return center;
}

export function useMapCenter(): number {
  return useSyncExternalStore(
    (f) => (centerSubs.add(f), () => centerSubs.delete(f)),
    getMapCenter,
    getMapCenter,
  );
}

/** App 用:视图变了,记下新的中心经度 */
export function publishMapCenter(lon: number): void {
  if (Math.abs(lon - center) < 1e-9) return;
  center = lon;
  for (const f of centerSubs) f();
}

/** 把地图平移成这条经线在正中(缩放不变)。App 挂上处理函数以后才生效 */
export function requestMapCenter(lon: number): void {
  onRequest?.(lon);
}

/** App 用:挂上"平移到某经度"的处理函数 */
export function handleMapCenterRequests(f: ((lon: number) => void) | null): void {
  onRequest = f;
}
