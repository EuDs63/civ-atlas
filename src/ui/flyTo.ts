/**
 * 选中 → 地图飞过去(国家面板):算"飞到哪、放多大",App 按它逐帧改视图(0.6 秒,ease-out 三次方)。纯计算,不碰 DOM。
 *
 * - 国家:平移缩放到能看全当年的疆域(窄屏:目标落在底部抽屉上方看得见的地方);城 / 州 / 地理实体:平移过去,缩放不变或适度放大。
 * - 'home'(选目标、下令之后):缩回整张图,中心经线不变。
 * - 等距圆柱按平移量飞;弯边投影(罗宾森……)转中央经线 + 上下平移;地球仪直接用它自己的 flyTo(经纬度)。
 */
import type { World } from '../gen/world';
import type { Civ } from '../gen/civ/types';
import { capitalAt } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { placeKeyOf, polityKey, regionKey, settlementKey } from '../gen/edits';
import { projectWorld, projectWorldNear, type MapProj } from '../render/projection';
import { clampCurved, clampSphere, stageToWorld, type MapView, type StageBox } from './mapWrap';
import type { MapSelection } from './civView';
import { NARROW_MAX, safeInsets } from './device';
import { ABOVE_SHEET, sheetGeometry } from './gestures';

/** 飞行时长(毫秒) */
export const FLY_MS = 600;
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** 看全疆域时上下留出的地方:右上的图层按钮 / 提示条、时间轴(宽屏左边让出侧栏卡片,见 sideRoom) */
const TOP_ROOM = 64;
const BOTTOM_ROOM = 104;
/** 四周再留一点 */
const MARGIN = 28;

export interface Focus {
  /** 要看全的范围(世界坐标;x 在中心附近展开,可以超出 [0, W));没有 = 只平移到中心 */
  box: [number, number, number, number] | null;
  /** 中心(世界坐标,x 在 [0, W)) */
  x: number;
  y: number;
  /** 中心的经纬度(度) */
  lon: number;
  lat: number;
}

/** 选中的东西的稳定键(重推历史后编号变了、还是同一个东西 = 同一个键) */
export function selectionKey(civ: Civ, sel: MapSelection): string {
  if (sel.kind === 'polity') return civ.polities[sel.id] ? polityKey(civ, sel.id) : '';
  if (sel.kind === 'settlement') return civ.settlements[sel.id] ? settlementKey(civ, sel.id) : '';
  if (sel.kind === 'place') return civ.places[sel.id] ? placeKeyOf(civ, sel.id) : '';
  return sel.id >= 0 && sel.id < civ.regions.count ? regionKey(civ, sel.id) : '';
}

let owners: Owners | undefined;

/** 国家在 year 年(没立国 = 立国那年,已亡 = 亡国前)的样子按哪一年看 */
export function shownYearOf(p: { founded: number; ended?: number }, year: number, endYear: number): number {
  if (year < p.founded) return p.founded;
  if (p.ended !== undefined && year >= p.ended) return p.ended - 1 / 512;
  return Math.min(year, endYear);
}

function focusOf(W: number, H: number, box: [number, number, number, number] | null, x: number, y: number): Focus {
  const cx = x - W * Math.floor(x / W);
  return { box, x: cx, y, lon: (cx / W) * 360 - 180, lat: 90 - (y / H) * 180 };
}

/** 一串地块的外接框(x 按 ref 展开:跨过左右接缝的国家不会变成横跨整张图) */
function cellsBox(world: World, cells: Iterable<number>, ref: number): [number, number, number, number] | null {
  const { x, y } = world.mesh;
  const W = world.width;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cells) {
    const cx = x[c] - W * Math.round((x[c] - ref) / W);
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (y[c] < y0) y0 = y[c];
    if (y[c] > y1) y1 = y[c];
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** 选中的东西在地图上的位置和范围;找不到 = null */
export function selectionFocus(world: World, civ: Civ, sel: MapSelection, year: number): Focus | null {
  const { x, y } = world.mesh;
  const W = world.width;
  const H = world.height;
  const R = civ.regions;
  if (sel.kind === 'settlement') {
    const s = civ.settlements[sel.id];
    return s ? focusOf(W, H, null, x[s.cell], y[s.cell]) : null;
  }
  if (sel.kind === 'region') {
    if (!(sel.id >= 0 && sel.id < R.count)) return null;
    const seat = R.seat[sel.id];
    const b = cellsBox(world, R.cells.subarray(R.cellStart[sel.id], R.cellStart[sel.id + 1]), x[seat]);
    return focusOf(W, H, b, x[seat], y[seat]);
  }
  if (sel.kind === 'place') {
    const path = civ.places[sel.id]?.path;
    if (!path || path.length < 2) return null;
    // 路径的 x 是展开的:按相邻两点接着走
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let prev = path[0];
    for (let i = 0; i + 1 < path.length; i += 2) {
      const v = path[i] - W * Math.round((path[i] - prev) / W);
      prev = v;
      x0 = Math.min(x0, v);
      x1 = Math.max(x1, v);
      y0 = Math.min(y0, path[i + 1]);
      y1 = Math.max(y1, path[i + 1]);
    }
    return focusOf(W, H, [x0, y0, x1, y1], (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const p = civ.polities[sel.id];
  if (!p) return null;
  const y0 = shownYearOf(p, year, civ.endYear);
  owners = ownersAt(civ, y0, owners);
  const cap = civ.settlements[capitalAt(p, y0)];
  const regs: number[] = [];
  for (let r = 0; r < R.count; r++) if (owners.polity[r] === p.id) regs.push(r);
  const ref = cap ? x[cap.cell] : regs.length ? x[R.seat[regs[0]]] : NaN;
  if (!Number.isFinite(ref)) return null;
  function* cells() {
    for (const r of regs) for (let k = R.cellStart[r]; k < R.cellStart[r + 1]; k++) yield R.cells[k];
  }
  const b = regs.length ? cellsBox(world, cells(), ref) : null;
  if (!b) return focusOf(W, H, null, ref, cap ? y[cap.cell] : H / 2);
  return focusOf(W, H, b, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
}

/** 飞到哪:选中的东西(按种类定缩放)或整张图 */
export interface FlyGoal {
  focus: Focus | null;
  kind: MapSelection['kind'] | 'home';
}

/** 窄屏(手机)顶上留给提示条的一截(和 phone.css 的 --top-room 一致,刘海另算;右上的按钮竖着排在右边,不占这一截) */
export const NARROW_TOP_ROOM = 24;

/** 手机底部卡片的几何(gestures.ts 的 sheetGeometry),算上这台手机刘海、底部横条的安全区。H = 界面高 */
export function phoneSheet(H: number): ReturnType<typeof sheetGeometry> {
  const ins = safeInsets();
  return sheetGeometry(H, NARROW_TOP_ROOM + ins.t, ins.b);
}

/** 手机上看得见的地图 [上, 下]:详情卡片开着 = 卡片上的时间轴胶囊再往上;没开 = 收起的世界卡片和胶囊再往上 */
export function phoneFree(H: number, panel: boolean): [number, number] {
  const g = phoneSheet(H);
  return panel ? g.free : [g.free[0], Math.max(g.free[0] + 80, g.peekTop - ABOVE_SHEET)];
}

/**
 * 宽屏左边浮着的侧栏卡片占掉的宽度:左边距 + 卡片 + 右边留空(和 desktop.css 的 --side-room 一致);
 * 窄屏没有侧栏 = 0。sw = 舞台宽(铺满窗口,和视口一样宽)
 */
export function sideRoom(sw: number): number {
  if (sw <= NARROW_MAX) return 0;
  return 14 + (sw >= 1100 ? 372 : 340) + 14;
}

/** 面板开着时"看得见的地方"(舞台坐标):左、上、右、下 */
export function freeArea(b: StageBox, panel: boolean): [number, number, number, number] {
  const narrow = b.sw <= NARROW_MAX;
  if (narrow) {
    // 窄屏:面板是底部卡片(半高),看得见的是它上面的时间轴胶囊再往上那一截;没面板时让出收起的世界卡片和胶囊
    const [top, bottom] = phoneFree(b.sh, panel);
    return [0, top, b.sw, Math.max(top + 80, bottom)];
  }
  // 宽屏:地图铺满窗口,左边被侧栏卡片挡住的那一截不算
  return [sideRoom(b.sw), TOP_ROOM, b.sw, Math.max(TOP_ROOM + 80, b.sh - BOTTOM_ROOM)];
}

/**
 * 按种类定目标缩放:国家看全疆域(疆域占看得见的地方八成以内;1–3 倍,小国也留出周边);
 * 城至少 2 倍;州、地理实体(海、山、河……)缩放不变;已经放得更大的不缩小
 */
function goalZoom(goal: FlyGoal, k0: number, fit: number): number {
  switch (goal.kind) {
    case 'home':
      return 1;
    case 'polity':
      return Math.min(3, Math.max(1, fit * 0.8));
    case 'settlement':
      return Math.max(k0, 2);
    default:
      return k0;
  }
}

/** 州、地理实体只平移:已经在看得见的地方(不在面板底下、不贴边)就不动 */
const panOnly = (goal: FlyGoal) => goal.kind === 'region' || goal.kind === 'place';
const inside = (x: number, y: number, [l, t, r, b]: [number, number, number, number]) => x >= l + 60 && x <= r - 60 && y >= t + 30 && y <= b - 30;

/**
 * 等距圆柱:从视图 v0 飞到目标的每一帧(e = 0…1,已经过缓动)。几乎不用动 = null。
 * 目标中心放在"看得见的地方"的正中;中间每一帧是"中心点沿直线走、倍数按比例变"
 */
export function flatFly(v0: MapView, b: StageBox, W: number, H: number, goal: FlyGoal): ((e: number) => MapView) | null {
  if (!b.sw || !b.bw) return null;
  const home = goal.kind === 'home';
  const [l, t, r, btm] = home ? [0, 0, b.sw, b.sh] : freeArea(b, true);
  const ax = (l + r) / 2;
  const ay = (t + btm) / 2;
  const p0 = stageToWorld(ax, ay, v0, b, W, H);
  let fit = 1;
  if (goal.focus?.box) {
    const [x0, y0, x1, y1] = goal.focus.box;
    const pw = (Math.max(x1 - x0, W / 400) / W) * b.bw;
    const ph = (Math.max(y1 - y0, H / 400) / H) * b.bh;
    fit = Math.min((r - l - 2 * MARGIN) / pw, (btm - t - 2 * MARGIN) / ph);
  }
  const k1 = goalZoom(goal, v0.k, fit);
  const fx = home ? p0[0] : goal.focus ? goal.focus.x - W * Math.round((goal.focus.x - p0[0]) / W) : p0[0];
  const fy = home ? H / 2 : (goal.focus?.y ?? p0[1]);
  if (panOnly(goal) && inside(ax + ((fx - p0[0]) / W) * b.bw * v0.k, ay + ((fy - p0[1]) / H) * b.bh * v0.k, [l, t, r, btm])) return null;
  const bl = (b.sw - b.bw) / 2;
  const bt = (b.sh - b.bh) / 2;
  const at = (e: number): MapView => {
    const k = v0.k * (k1 / v0.k) ** e;
    const px = p0[0] + (fx - p0[0]) * e;
    const py = p0[1] + (fy - p0[1]) * e;
    return clampSphere({ k, x: ax - (bl + (px / W) * b.bw) * k, y: ay - (bt + (py / H) * b.bh) * k }, b);
  };
  const end = at(1);
  if (Math.abs(end.k - v0.k) < 1e-3 && Math.abs(end.y - v0.y) < 1 && Math.abs(clampSphere({ ...v0, x: end.x }, b).x - clampSphere(v0, b).x) < 1) return null;
  return at;
}

/**
 * 弯边投影:转中央经线(走短边)+ 上下平移 + 缩放。每一帧给出视图和中央经线。
 * proj(lon0) = 那条中央经线下的地图平面(算目标的上下位置、看全要放多大)
 */
export function curvedFly(
  v0: MapView,
  b: StageBox,
  m0: MapProj,
  proj: (lon0: number) => MapProj,
  goal: FlyGoal,
): ((e: number) => { v: MapView; lon: number }) | null {
  if (!b.sw || !b.bw) return null;
  const { W, H } = m0;
  const bt = (b.sh - b.bh) / 2;
  const home = goal.kind === 'home';
  if (home || !goal.focus) {
    const v1 = clampCurved({ k: 1, x: 0, y: 0 }, b);
    if (Math.abs(v1.k - v0.k) < 1e-3 && Math.abs(v1.y - v0.y) < 1) return null;
    return (e) => ({ v: clampCurved({ k: v0.k * (v1.k / v0.k) ** e, x: 0, y: v0.y + (v1.y - v0.y) * e }, b), lon: m0.lon0 });
  }
  const f = goal.focus;
  const [l, t, r, btm] = freeArea(b, true);
  const ax = (l + r) / 2;
  const ay = (t + btm) / 2;
  const phi = (f.lat * Math.PI) / 180;
  const pxPerDeg = (k: number) => k * (b.bw / W) * m0.s * Math.max(0.2, m0.def.kx(phi)) * (Math.PI / 180);
  // 先按目标中央经线 = 中心经度量范围、定缩放,再把中心往左挪出面板
  const m1 = proj(f.lon);
  let fit = 1;
  if (f.box) {
    const [x0, y0, x1, y1] = f.box;
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
      [f.x, y0],
      [f.x, y1],
      [x0, f.y],
      [x1, f.y],
    ].map(([x, y]) => projectWorldNear(m1, x, y, f.x));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pw = (Math.max(Math.max(...xs) - Math.min(...xs), W / 400) / W) * b.bw;
    const ph = (Math.max(Math.max(...ys) - Math.min(...ys), H / 400) / H) * b.bh;
    fit = Math.min((r - l - 2 * MARGIN) / pw, (btm - t - 2 * MARGIN) / ph);
  }
  const k1 = goalZoom(goal, v0.k, fit);
  if (panOnly(goal)) {
    const [mx, my] = projectWorld(m0, f.x, f.y);
    if (inside((b.sw - b.bw * v0.k) / 2 + (mx / W) * b.bw * v0.k, v0.y + (bt + (my / H) * b.bh) * v0.k, [l, t, r, btm])) return null;
  }
  const lon1 = f.lon + (b.sw / 2 - ax) / pxPerDeg(k1);
  let dLon = (((lon1 - m0.lon0 + 180) % 360) + 360) % 360 - 180;
  if (Math.abs(dLon) < 0.05) dLon = 0;
  const my1 = projectWorld(m1, f.x, f.y)[1];
  const my0 = (((ay - v0.y) / v0.k - bt) / b.bh) * H;
  return (e) => {
    const k = v0.k * (k1 / v0.k) ** e;
    const my = my0 + (my1 - my0) * e;
    return { v: clampCurved({ k, x: 0, y: ay - (bt + (my / H) * b.bh) * k }, b), lon: m0.lon0 + dLon * e };
  };
}
