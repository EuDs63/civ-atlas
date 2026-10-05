/**
 * 文明叠加层 · 道路与航线。
 *
 *   写实:大路是浅土黄色细线(外面一道很淡的暗边,雪地、沙漠上也看得清),小路是更淡更细的虚线
 *   手绘:大路是墨色长虚线,小路是更淡的短虚线
 *   航线:两种画风都是海上的点线
 *
 * 路径是一串地块中心;同一类的路段先在岔口 / 城之间串成长折线(虚线的节奏不会在每段开头重来),
 * 再用 Chaikin 抹平折角。城和岔口是折线的端点,平滑时不动,所以路正好穿过城镇符号。
 * 只画这一年已经修好、还没停用的路(路有修建年份;小路升级成大路的那一年停用,由大路接着画)。
 * 折线按"这一年看得见哪些路"缓存,回放时没有新路就不重算;切画风 / 开关时不重算。
 */
import type { Civ, Route } from '../../gen/civ/types';
import type { Mesh } from '../../gen/mesh';
import { addToPath, chaikin, cullLines, meshWrap, unwrapLine, type Polyline } from './lines';
import type { CivDrawParams } from './overlay';

type Kind = Route['kind'];

interface RouteLines {
  road: Polyline[];
  trail: Polyline[];
  sea: Polyline[];
}

/**
 * 把同一类的路段串成折线:地块是节点,路段的每一步是一条边;
 * 度数 ≠ 2 的节点(岔口、端点)和城是断点,其余节点把两边的边接起来。
 */
function chains(mesh: Mesh, routes: Route[], kind: Kind, stops: Set<number>): Polyline[] {
  const n = mesh.n;
  const links = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    let l = links.get(a);
    if (!l) links.set(a, (l = []));
    if (!l.includes(b)) l.push(b);
  };
  for (const r of routes) {
    if (r.kind !== kind) continue;
    for (let t = 1; t < r.cells.length; t++) {
      add(r.cells[t - 1], r.cells[t]);
      add(r.cells[t], r.cells[t - 1]);
    }
  }
  const used = new Set<number>();
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const isStop = (c: number) => stops.has(c) || links.get(c)!.length !== 2;
  const out: Polyline[] = [];
  const walk = (start: number, next: number) => {
    const cells = [start];
    let prev = start;
    let cur = next;
    used.add(key(prev, cur));
    for (;;) {
      cells.push(cur);
      if (cur === start || isStop(cur)) break;
      const l = links.get(cur)!;
      const nxt = l[0] === prev ? l[1] : l[0];
      const k = key(cur, nxt);
      if (used.has(k)) break;
      used.add(k);
      prev = cur;
      cur = nxt;
    }
    const pts = new Float32Array(cells.length * 2);
    cells.forEach((c, i) => {
      pts[i * 2] = mesh.x[c];
      pts[i * 2 + 1] = mesh.y[c];
    });
    // 球面世界:x 展开成连续的(跨 180° 经线的路不横穿整张图,画的时候在另一边再画一份)
    unwrapLine(pts, meshWrap(mesh));
    return { pts, closed: false };
  };
  // 按节点编号顺序走,结果确定
  const nodes = [...links.keys()].sort((a, b) => a - b);
  for (const a of nodes) {
    if (!isStop(a)) continue;
    for (const b of links.get(a)!) if (!used.has(key(a, b))) out.push(walk(a, b));
  }
  // 剩下的是不经过断点的环
  for (const a of nodes) for (const b of links.get(a)!) if (!used.has(key(a, b))) out.push(walk(a, b));
  return out;
}

interface RouteCache {
  stops: Set<number>;
  /** 修建年份 / 停用年份排好序,用来算"这一年看得见哪些路"的键 */
  built: Float64Array;
  ended: Float64Array;
  key: string;
  lines: RouteLines;
}
const caches = new WeakMap<Civ, RouteCache>();

function countAtMost(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 这一年看得见的路,串好、平滑好的折线 */
export function routeLines(mesh: Mesh, civ: Civ, year: number = Infinity): RouteLines {
  let c = caches.get(civ);
  if (!c) {
    // 城:有城镇时是城镇,没有时是各州治所
    const stops = new Set<number>();
    if (civ.settlements.length) for (const s of civ.settlements) stops.add(s.cell);
    else for (let r = 0; r < civ.regions.count; r++) stops.add(civ.regions.seat[r]);
    c = {
      stops,
      built: Float64Array.from(civ.routes.map((r) => r.built)).sort(),
      ended: Float64Array.from(civ.routes.map((r) => r.abandoned ?? Infinity)).sort(),
      key: '',
      lines: { road: [], trail: [], sea: [] },
    };
    caches.set(civ, c);
  }
  const key = `${countAtMost(c.built, year)}|${countAtMost(c.ended, year)}`;
  if (key !== c.key) {
    const live = civ.routes.filter((r) => r.built <= year && !((r.abandoned ?? Infinity) <= year));
    const stops = c.stops;
    const smooth = (kind: Kind, rounds: number) => chains(mesh, live, kind, stops).map((l) => chaikin(l, rounds));
    c.lines = { road: smooth('road', 3), trail: smooth('trail', 3), sea: smooth('sea', 3) };
    c.key = key;
  }
  return c.lines;
}

export function drawRoutes(ctx: CanvasRenderingContext2D, p: CivDrawParams): void {
  if (!p.show.routes || !p.civ.routes.length) return;
  const S = p.raster.scale;
  // 线宽、虚线长短(细节层按屏幕重画时 × pen,见 overlay.ts)
  const P = S * (p.pen ?? 1);
  const lines = routeLines(p.world.mesh, p.civ, p.year);
  const wrap = meshWrap(p.world.mesh);
  const path = (ls: Polyline[]) => {
    const pa = new Path2D();
    addToPath(pa, p.cull ? cullLines(ls, p.cull, wrap, 4) : ls, S, wrap, p.proj);
    return pa;
  };
  const road = path(lines.road);
  const trail = path(lines.trail);
  const sea = path(lines.sea);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.style === 'fantasy') {
    // 墨色:航线是海上的点线;大路长虚线、小路短虚线。
    // 路下面先垫一道很淡的纸色,穿过深色树林时也看得清(像旧地图上路从树林符号里"让"出来)
    ctx.strokeStyle = 'rgba(52,58,66,0.62)';
    ctx.lineWidth = 1.25 * P;
    ctx.setLineDash([0.01, 3.4 * P]);
    ctx.stroke(sea);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(246,236,210,0.3)';
    ctx.lineWidth = 2 * P;
    ctx.stroke(trail);
    ctx.strokeStyle = 'rgba(246,236,210,0.45)';
    ctx.lineWidth = 2.8 * P;
    ctx.stroke(road);
    ctx.strokeStyle = 'rgba(74,46,28,0.7)';
    ctx.lineWidth = 0.8 * P;
    ctx.setLineDash([2.2 * P, 2.4 * P]);
    ctx.stroke(trail);
    ctx.strokeStyle = 'rgba(74,42,24,0.9)';
    ctx.lineWidth = 1.2 * P;
    ctx.setLineDash([4.6 * P, 2.6 * P]);
    ctx.stroke(road);
  } else {
    // 写实:浅色点线航线;土黄细线,先描一道很淡的暗边(雪地、沙漠上也看得清)
    ctx.strokeStyle = 'rgba(226,238,246,0.7)';
    ctx.lineWidth = 1.2 * P;
    ctx.setLineDash([0.01, 3.2 * P]);
    ctx.stroke(sea);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(38,28,14,0.24)';
    ctx.lineWidth = 2 * P;
    ctx.stroke(trail);
    ctx.strokeStyle = 'rgba(38,28,14,0.36)';
    ctx.lineWidth = 2.5 * P;
    ctx.stroke(road);
    ctx.setLineDash([2.4 * P, 2 * P]);
    ctx.strokeStyle = 'rgba(246,230,186,0.85)';
    ctx.lineWidth = 0.9 * P;
    ctx.stroke(trail);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(248,228,174,0.97)';
    ctx.lineWidth = 1.2 * P;
    ctx.stroke(road);
  }
  ctx.restore();
}
