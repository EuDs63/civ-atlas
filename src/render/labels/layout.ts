/**
 * 地图文字排版(纯几何,不碰画布):把一条标注摆成一个个字的位置。坐标都是画布像素。
 *
 * 四种排法(中文地图的传统字列):
 *   line   直线字列:沿一段直线(水平 / 竖直 / 斜)均匀散开,字距随线长在 [最小, 最大] 之间取
 *          —— 海洋、荒漠、岛屿
 *   curve  屈曲字列:沿折线排,每个字随路径转(读的方向始终从左到右);路径很陡时改成竖排
 *          —— 山脉
 *   river  每个字正立,位置沿着河道走,排在河的一侧(横向的河从左到右读,竖向的从上到下读)
 *          —— 河流(中国古地图的写法;canvas 没有 textPath,本来就要一个字一个字地画)
 *   point  围着一个点:先试放在实体里面,放不下就放在旁边 8 个方位 —— 湖泊、小岛
 *
 * 每种排法给出若干候选位置(按优先顺序),由 draw.ts 挑第一个不压字、不压海岸线的。
 */

export interface Glyph {
  ch: string;
  /** 字的中心 */
  x: number;
  y: number;
  /** 旋转(弧度,0 = 正立) */
  a: number;
}

/** 一个候选摆法 + 它要求字下面是什么地面(位掩码,见 SURFACE) */
export interface Candidate {
  glyphs: Glyph[];
  on: number;
  /** 这个摆法用的字号(画布像素);不给 = 标注本身的字号(国名放不下时可以小一档) */
  px?: number;
}

/** 地面类型的位掩码(对应地面查询的返回值 0 陆地 / 1 海 / 2 湖 / 3 陆上的河道) */
export const SURFACE = {
  land: 1,
  sea: 2,
  lake: 4,
  river: 8,
  any: 15,
} as const;

/** 折线 + 弧长参数化 */
export class Polyline {
  readonly xs: number[];
  readonly ys: number[];
  readonly cum: number[];
  readonly length: number;
  constructor(pts: ArrayLike<number>) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      // 去掉重合的点
      if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6 && Math.abs(y - ys[ys.length - 1]) < 1e-6) continue;
      xs.push(x);
      ys.push(y);
    }
    const cum = [0];
    for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
    this.xs = xs;
    this.ys = ys;
    this.cum = cum;
    this.length = cum[cum.length - 1] ?? 0;
  }
  /** 按弧长每隔 step 重采样,再在 ±win 的窗口里取平均:去掉小弯,给沿河排字用 */
  smoothed(step: number, win: number): Polyline {
    const L = this.length;
    if (L <= 0 || this.xs.length < 3) return this;
    const m = Math.max(2, Math.ceil(L / step) + 1);
    const rx: number[] = [];
    const ry: number[] = [];
    for (let i = 0; i < m; i++) {
      const [x, y] = this.at((i / (m - 1)) * L);
      rx.push(x);
      ry.push(y);
    }
    const k = Math.max(1, Math.round(win / (L / (m - 1))));
    const pts: number[] = [];
    for (let i = 0; i < m; i++) {
      // 两端窗口收窄,端点不动
      const r = Math.min(k, i, m - 1 - i);
      let sx = 0;
      let sy = 0;
      for (let j = i - r; j <= i + r; j++) {
        sx += rx[j];
        sy += ry[j];
      }
      pts.push(sx / (2 * r + 1), sy / (2 * r + 1));
    }
    return new Polyline(pts);
  }
  reversed(): Polyline {
    const pts: number[] = [];
    for (let i = this.xs.length - 1; i >= 0; i--) pts.push(this.xs[i], this.ys[i]);
    return new Polyline(pts);
  }
  /** 弧长 s 处的点(超出两端时沿端点切线外推) */
  at(s: number): [number, number] {
    const { xs, ys, cum } = this;
    const m = xs.length;
    if (m === 1) return [xs[0], ys[0]];
    let i: number;
    if (s <= 0) i = 0;
    else if (s >= this.length) i = m - 2;
    else {
      let lo = 0;
      let hi = m - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const seg = cum[i + 1] - cum[i] || 1;
    const t = (s - cum[i]) / seg;
    return [xs[i] + (xs[i + 1] - xs[i]) * t, ys[i] + (ys[i + 1] - ys[i]) * t];
  }
  /** s 附近 ±w 的平均方向(单位向量);窗口越大越平滑 */
  dir(s: number, w: number): [number, number] {
    // 窗口两端都夹在路径范围内(超出两端时取端点那一段的方向,不外推,免得方向反过来)
    const L = this.length;
    let a = Math.max(0, Math.min(L, s - w));
    let b = Math.max(0, Math.min(L, s + w));
    if (b - a < Math.min(L, 2 * w) * 0.5) {
      if (s >= L / 2) a = Math.max(0, L - Math.max(w, 1e-6) * 2);
      else b = Math.min(L, Math.max(w, 1e-6) * 2);
    }
    const [x0, y0] = this.at(a);
    const [x1, y1] = this.at(b);
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d < 1e-9) {
      const m = this.xs.length;
      if (m < 2) return [1, 0];
      const dx = this.xs[m - 1] - this.xs[0];
      const dy = this.ys[m - 1] - this.ys[0];
      const dd = Math.hypot(dx, dy) || 1;
      return [dx / dd, dy / dd];
    }
    return [(x1 - x0) / d, (y1 - y0) / d];
  }
  /** 点到折线的最近距离 */
  distance(px: number, py: number): number {
    const { xs, ys } = this;
    let best = Infinity;
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i];
      const ay = ys[i];
      const bx = xs[i + 1] - ax;
      const by = ys[i + 1] - ay;
      const L = bx * bx + by * by;
      const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / L)) : 0;
      const d = Math.hypot(px - ax - bx * t, py - ay - by * t);
      if (d < best) best = d;
    }
    return xs.length === 1 ? Math.hypot(px - xs[0], py - ys[0]) : best;
  }
}

const chars = (text: string) => [...text];

/** 字距:线长能摊开就摊开,夹在 [最小, 最大] 之间;返回字中心之间的间隔 */
function pitchFor(n: number, len: number, size: number, tracking: [number, number]): number {
  if (n <= 1) return size;
  const lo = size * (1 + tracking[0]);
  const hi = size * (1 + tracking[1]);
  return Math.max(lo, Math.min(hi, len / n));
}

/** 竖排判定:方向和竖直线的夹角小于约 35° */
const steep = (dx: number, dy: number) => Math.abs(dy) > Math.abs(dx) * 1.4;

/**
 * 直线字列:沿 path 的首尾连线,以中点为中心散开。
 * 近水平(< 6°)的摆正;竖直的改竖排(字正立,从上往下读);其余斜排(字随线转)。
 * 另给沿法线、沿线挪开一两个字的候选,让开别的字。
 */
export function layoutLine(text: string, path: Polyline, size: number, tracking: [number, number], on: number): Candidate[] {
  const cs = chars(text);
  const n = cs.length;
  const m = path.xs.length;
  if (!n || !m) return [];
  const [cx, cy] = path.at(path.length / 2);
  let dx = path.xs[m - 1] - path.xs[0];
  let dy = path.ys[m - 1] - path.ys[0];
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 1;
    dy = 0;
    len = 0;
  }
  let ux = dx / (len || 1);
  let uy = dy / (len || 1);
  const vertical = steep(ux, uy);
  if (vertical) {
    // 从上往下
    if (uy < 0) {
      ux = -ux;
      uy = -uy;
    }
  } else if (ux < 0) {
    ux = -ux;
    uy = -uy;
  }
  let a = vertical ? 0 : Math.atan2(uy, ux);
  if (!vertical && Math.abs(a) < (6 * Math.PI) / 180) {
    a = 0;
    ux = 1;
    uy = 0;
  }
  if (vertical) {
    ux = 0;
    uy = 1;
  }
  const pitch = pitchFor(n, len, size, tracking);
  const out: Candidate[] = [];
  const nx = -uy;
  const ny = ux;
  // 候选:正中;沿法线挪开;沿线前后挪;斜着挪(让开别的字)
  const shifts: [number, number][] = [
    [0, 0],
    [0, -0.8],
    [0, 0.8],
    [-1.3, 0],
    [1.3, 0],
    [-1.3, -0.9],
    [1.3, 0.9],
    [-1.3, 0.9],
    [1.3, -0.9],
    [0, -1.6],
    [0, 1.6],
  ];
  for (const [along, across] of shifts) {
    const glyphs: Glyph[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) * pitch + along * size;
      glyphs.push({ ch: cs[i], x: cx + ux * t + nx * across * size, y: cy + uy * t + ny * across * size, a });
    }
    out.push({ glyphs, on });
  }
  return out;
}

/**
 * 屈曲字列:沿折线排,字随路径方向转(转角限制在 ±40° 以内、相邻两字转角差不超过 22°,免得字躺倒、忽左忽右)。
 * 路径整体从右往左时先倒过来,保证从左往右读;整体很陡时改为竖排(字正立、沿路径从上往下)。
 * 候选:居中,再往两头各挪 ¼。
 */
export function layoutCurve(text: string, path0: Polyline, size: number, tracking: [number, number], on: number): Candidate[] {
  const cs = chars(text);
  const n = cs.length;
  if (!n || path0.xs.length < 2) return layoutLine(text, path0, size, tracking, on);
  const m = path0.xs.length;
  const gx = path0.xs[m - 1] - path0.xs[0];
  const gy = path0.ys[m - 1] - path0.ys[0];
  const vertical = steep(gx, gy);
  const path = (vertical ? gy < 0 : gx < 0) ? path0.reversed() : path0;
  const L = path.length;
  const pitch = pitchFor(n, L * 0.92, size, tracking);
  const span = pitch * (n - 1);
  const lim = (40 * Math.PI) / 180;
  /** 相邻两个字的转角最多差这么多,整行字转得柔和 */
  const turn = (22 * Math.PI) / 180;
  const out: Candidate[] = [];
  for (const f of [0.5, 0.3, 0.7]) {
    const sc = span >= L ? L / 2 : Math.max(span / 2, Math.min(L - span / 2, L * f));
    if (f !== 0.5 && Math.abs(sc - L / 2) < pitch * 0.5) continue;
    const glyphs: Glyph[] = [];
    if (vertical) {
      for (let i = 0; i < n; i++) {
        const [x, y] = path.at(sc - span / 2 + i * pitch);
        glyphs.push({ ch: cs[i], x, y, a: 0 });
      }
      // 竖排时沿路径走的间距可能因为路径斜着而不够:按竖直距离补足
      spreadVertical(glyphs, size * (1 + tracking[0]));
    } else {
      for (let i = 0; i < n; i++) {
        const s = sc - span / 2 + i * pitch;
        const [x, y] = path.at(s);
        const [ux, uy] = path.dir(s, pitch * 0.6);
        let a = Math.atan2(uy, ux);
        a = Math.max(-lim, Math.min(lim, a));
        if (i > 0) {
          const prev = glyphs[i - 1].a;
          a = Math.max(prev - turn, Math.min(prev + turn, a));
        }
        glyphs.push({ ch: cs[i], x, y, a });
      }
    }
    out.push({ glyphs, on });
  }
  return out;
}

/** 竖排的字之间竖直距离至少 minGap(不够就往下推开,再整体挪回原来的中心) */
function spreadVertical(glyphs: Glyph[], minGap: number) {
  const n = glyphs.length;
  if (n < 2) return;
  const before = (glyphs[0].y + glyphs[n - 1].y) / 2;
  for (let i = 1; i < n; i++) {
    const need = glyphs[i - 1].y + minGap - glyphs[i].y;
    if (need > 0) glyphs[i].y += need;
  }
  const d = before - (glyphs[0].y + glyphs[n - 1].y) / 2;
  for (const g of glyphs) g.y += d;
}

/**
 * 河名:每个字正立,沿河道排在河的一侧。
 * halfW:半河宽(画布像素),字要让开这么宽再加一点空隙。
 * 候选:标注中心放在河长的 50% / 36% / 64% / 22% / 78% 处,每处先试上侧(竖向河先试右侧),再试另一侧。
 * 字沿抹平了小弯的河道走;离真实河道的距离由 draw.ts 再查一遍(不压河)。
 */
export function layoutRiver(text: string, river: Polyline, size: number, tracking: [number, number], halfW: number, on: number): Candidate[] {
  const cs = chars(text);
  const n = cs.length;
  if (!n || river.xs.length < 2 || river.length < size * n) return [];
  // 字沿着"抹平小弯"的河道走,排出来是一条顺滑的弧,不会随河的小曲折忽上忽下
  const path = river.smoothed(size / 3, size * 1.2);
  const L = path.length;
  const pitch = size * (1 + tracking[0]);
  const gap = Math.max(1.5, size * 0.25);
  const out: Candidate[] = [];
  const reversed = path.reversed();
  for (const f of [0.5, 0.36, 0.64, 0.22, 0.78]) {
    const sc = L * f;
    // 这一段整体朝哪:决定先试从哪头开始读、先放哪一侧
    const [ux, uy] = path.dir(sc, (pitch * n) / 2);
    const vertical = steep(ux, uy);
    const flip = vertical ? uy < 0 : ux < 0;
    const orients: [Polyline, number][] = flip ? [[reversed, L - sc], [path, sc]] : [[path, sc], [reversed, L - sc]];
    for (const [p, s0] of orients) {
      // 先试上侧(横向河)或右侧(竖向河)。法线 = (−dy, dx) × side
      const [dx, dy] = p.dir(s0, (pitch * n) / 2);
      const firstSide = vertical ? (dy > 0 ? -1 : 1) : dx > 0 ? -1 : 1;
      for (const side of [firstSide, -firstSide]) {
        const glyphs = walkUpright(cs, p, s0, size, pitch, halfW + gap, side);
        // 窗口平均方向判不准时(斜着的河、河湾),按排出来的实际形状再核对一次读序
        if (glyphs && readsForward(glyphs)) out.push({ glyphs, on });
      }
    }
  }
  return out;
}

/**
 * 正立字列的读序是否自然:字列整体偏竖(上下跨度大于左右)时要从上往下读,偏横时要从左往右读。
 * 斜着往上走的河,按"从左到右"排出来,字却几乎摞成一竖,人会从上往下读成倒序("水之柱桃")。
 */
export function readsForward(glyphs: Glyph[]): boolean {
  if (glyphs.length < 2) return true;
  const a = glyphs[0];
  const b = glyphs[glyphs.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dy) > Math.abs(dx) ? dy > 0 : dx > 0;
}

/** 从弧长 sc 附近开始,沿路径每隔"切比雪夫距离 ≥ pitch"放一个正立的字,偏到 side 一侧;先试走一遍量出跨度,再居中 */
function walkUpright(cs: string[], p: Polyline, sc: number, size: number, pitch: number, clear: number, side: number): Glyph[] | null {
  const L = p.length;
  const step = Math.max(0.5, size * 0.1);
  const h = size / 2;
  const place = (s: number): [number, number] => {
    const [x, y] = p.at(s);
    const [ux, uy] = p.dir(s, size);
    const nx = -uy * side;
    const ny = ux * side;
    // 正立的方块到直线的距离 = 中心距离 − 半边长 ×(|nx| + |ny|)
    const off = clear + h * (Math.abs(nx) + Math.abs(ny));
    return [x + nx * off, y + ny * off];
  };
  const walk = (s0: number): { glyphs: Glyph[]; end: number } | null => {
    const glyphs: Glyph[] = [];
    let s = s0;
    let [x, y] = place(s);
    glyphs.push({ ch: cs[0], x, y, a: 0 });
    for (let i = 1; i < cs.length; i++) {
      for (;;) {
        s += step;
        if (s > L + size) return null;
        [x, y] = place(s);
        const last = glyphs[glyphs.length - 1];
        if (Math.max(Math.abs(x - last.x), Math.abs(y - last.y)) >= pitch) break;
      }
      glyphs.push({ ch: cs[i], x, y, a: 0 });
    }
    return { glyphs, end: s };
  };
  const trial = walk(Math.max(0, sc - (pitch * (cs.length - 1)) / 2));
  if (!trial) return null;
  const span = trial.end - Math.max(0, sc - (pitch * (cs.length - 1)) / 2);
  const start = Math.max(0, Math.min(L - span, sc - span / 2));
  const r = walk(start);
  if (!r) return null;
  // 河拐急弯时字会一下子隔得很远,读起来像两个词:这种摆法不要
  for (let i = 1; i < r.glyphs.length; i++) {
    const a = r.glyphs[i - 1];
    const b = r.glyphs[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) > pitch * 1.75) return null;
  }
  return r.glyphs;
}

/**
 * 围着一个点(半径 r)摆:先横排在正中(要求地面 inside),再放右、左、上、下、右上、右下、左上、左下(要求地面 around)。
 */
export function layoutPoint(text: string, cx: number, cy: number, r: number, size: number, tracking: [number, number], inside: number, around: number): Candidate[] {
  const cs = chars(text);
  const n = cs.length;
  if (!n) return [];
  const pitch = size * (1 + tracking[0]);
  const w = pitch * (n - 1) + size;
  const row = (x: number, y: number, on: number): Candidate => ({
    on,
    glyphs: cs.map((ch, i) => ({ ch, x: x - w / 2 + size / 2 + i * pitch, y, a: 0 })),
  });
  const out: Candidate[] = [];
  if (inside) out.push(row(cx, cy, inside));
  const g = Math.max(2, size * 0.3) + r;
  const dx = g + w / 2;
  const dy = g + size / 2;
  const d = 0.72;
  out.push(
    row(cx + dx, cy, around),
    row(cx - dx, cy, around),
    row(cx, cy - dy, around),
    row(cx, cy + dy, around),
    row(cx + g * d + w / 2, cy - g * d - size / 2, around),
    row(cx + g * d + w / 2, cy + g * d + size / 2, around),
    row(cx - g * d - w / 2, cy - g * d - size / 2, around),
    row(cx - g * d - w / 2, cy + g * d + size / 2, around),
  );
  return out;
}

/** 一个字(旋转 a 的正方形,边长 size)的外接矩形,四边再放宽 pad */
export function glyphBox(g: Glyph, size: number, pad: number): [number, number, number, number] {
  const h = (size / 2) * (Math.abs(Math.cos(g.a)) + Math.abs(Math.sin(g.a))) + pad;
  return [g.x - h, g.y - h, g.x + h, g.y + h];
}
