/**
 * 等距圆柱放大后的海岸墨线、湖岸描边(矢量线):折线切成小段、只拿视口附近的段、东西相连时在另一边再出一份;
 * 放大不多时按画布像素抽稀。(真正的画面在 scripts/snap.ts 放大截图里看)
 */
import { describe, expect, it } from 'vitest';
import { coastChunks, forChunksIn, simplifyLine } from '../src/render/fantasy';

const W = 2048;

/** 一条折线:从 (x0, y) 起往右走 n 步,y 上下小幅摆动 */
function wiggle(x0: number, y: number, n: number, step = 0.7): Float32Array {
  const p: number[] = [];
  for (let i = 0; i <= n; i++) p.push(x0 + i * step, y + Math.sin(i * 0.9) * 0.6);
  return Float32Array.from(p);
}

/** 范围里出了哪些 (段号, 平移量) */
function hits(c: ReturnType<typeof coastChunks>, x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  forChunksIn(c, W, x0, y0, x1, y1, (j, dx) => out.push([j, dx || 0])); // −0 记成 0
  return out;
}

describe('等距圆柱的海岸线:切段', () => {
  it('切成的小段首尾相接,拼回去就是原来的折线;外框框住段里的每个点', () => {
    const lines = [wiggle(100, 300, 500), wiggle(900, 600, 7)];
    const c = coastChunks(lines);
    expect(c.pts.length).toBeGreaterThan(5);
    const joined: number[][] = [[], []];
    let li = 0;
    let left = lines[0].length / 2;
    for (let j = 0; j < c.pts.length; j++) {
      const q = c.pts[j];
      const m = q.length / 2;
      expect(m).toBeLessThanOrEqual(49);
      for (let i = 0; i < m; i++) {
        const [x, y] = [q[i * 2], q[i * 2 + 1]];
        expect(x).toBeGreaterThanOrEqual(c.box[j * 4]);
        expect(y).toBeGreaterThanOrEqual(c.box[j * 4 + 1]);
        expect(x).toBeLessThanOrEqual(c.box[j * 4 + 2]);
        expect(y).toBeLessThanOrEqual(c.box[j * 4 + 3]);
      }
      // 接头那一点两段共用:接着上一段时去掉第一点
      const from = joined[li].length ? 1 : 0;
      for (let i = from; i < m; i++) joined[li].push(q[i * 2], q[i * 2 + 1]);
      left -= m - from;
      if (left === 0 && li + 1 < lines.length) {
        li++;
        left = lines[li].length / 2;
      }
    }
    expect(Float32Array.from(joined[0])).toEqual(lines[0]);
    expect(Float32Array.from(joined[1])).toEqual(lines[1]);
  });

  it('只给范围附近的段:离得远的段不出', () => {
    const c = coastChunks([wiggle(100, 300, 500)]);
    const all = hits(c, -10, -10, W + 10, 1100);
    expect(all.length).toBe(c.pts.length);
    expect(all.every(([, dx]) => dx === 0)).toBe(true);
    // 放大后只看 x 120..140 一小块:只出一两段
    const few = hits(c, 120, 290, 140, 310);
    expect(few.length).toBeGreaterThan(0);
    expect(few.length).toBeLessThanOrEqual(2);
    // 上下不挨着、左右不挨着都不出
    expect(hits(c, 120, 500, 140, 520)).toEqual([]);
    expect(hits(c, 1000, 290, 1100, 310)).toEqual([]);
  });

  it('跨过右边(180° 经线)的折线:看主图左边时,平移 −一整圈的那一份出来,线是连着的', () => {
    // 折线 x 展开成连续的:从 W − 5 走到 W + 9(伸出主图右边)
    const c = coastChunks([wiggle(W - 5, 400, 20)]);
    expect(c.pts.length).toBe(1);
    // 看主图右边那一块:原位那一份
    expect(hits(c, W - 30, 390, W, 410)).toEqual([[0, 0]]);
    // 看主图左边那一块:挪到左边的那一份(x −5 … 9)
    expect(hits(c, 0, 390, 30, 410)).toEqual([[0, -W]]);
    // 范围跨过接缝(细节层的画布伸进右边接的那一份):原位那一份就够了
    expect(hits(c, W - 30, 390, W + 30, 410)).toEqual([[0, 0]]);
    // 范围比一整圈还宽(缩放不到 1.5 倍时画布连同四周余量可能超过一圈):每一份都给
    expect(hits(c, -W, 390, 2 * W, 410).map(([, dx]) => dx)).toEqual([-2 * W, -W, 0, W]);
  });

  it('挨着左边、伸出左边的折线:看主图右边时出平移 +一整圈的那一份', () => {
    const c = coastChunks([wiggle(-6, 200, 12)]);
    expect(hits(c, W - 20, 190, W, 210)).toEqual([[0, W]]);
    expect(hits(c, 0, 190, 20, 210)).toEqual([[0, 0]]);
  });
});

describe('等距圆柱的海岸线:抽稀', () => {
  /** 点 (px, py) 到折线 q 的最近距离 */
  function distTo(q: Float32Array, px: number, py: number): number {
    let best = Infinity;
    for (let i = 0; i + 3 < q.length; i += 2) {
      const [ax, ay, bx, by] = [q[i], q[i + 1], q[i + 2], q[i + 3]];
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
    }
    return best;
  }

  it('去掉的点离抽稀后的折线都不到容差;两端不动;一条直线上的点全去掉', () => {
    const p = wiggle(10, 50, 48);
    for (const tol of [0.05, 0.12, 0.3]) {
      const q = simplifyLine(p, tol);
      expect(q.length).toBeLessThan(p.length);
      expect([q[0], q[1]]).toEqual([p[0], p[1]]);
      expect([q[q.length - 2], q[q.length - 1]]).toEqual([p[p.length - 2], p[p.length - 1]]);
      for (let i = 0; i < p.length; i += 2) expect(distTo(q, p[i], p[i + 1])).toBeLessThanOrEqual(tol + 1e-6);
    }
    const straight = Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(Array.from(simplifyLine(straight, 0.01))).toEqual([0, 0, 4, 4]);
    // 容差 0 = 不抽稀
    expect(simplifyLine(p, 0)).toBe(p);
  });

  it('首尾重合的小环(小岛)抽稀后还是闭合的', () => {
    const ring: number[] = [];
    for (let i = 0; i <= 24; i++) ring.push(100 + 3 * Math.cos((i / 24) * 2 * Math.PI), 100 + 3 * Math.sin((i / 24) * 2 * Math.PI));
    ring[ring.length - 2] = ring[0];
    ring[ring.length - 1] = ring[1];
    const q = simplifyLine(Float32Array.from(ring), 0.12);
    expect(q.length).toBeGreaterThanOrEqual(8);
    expect([q[q.length - 2], q[q.length - 1]]).toEqual([q[0], q[1]]);
  });

  it('折回去、伸出弦两头的点不会因为离那条直线近就被去掉', () => {
    // 离直线只有 0.1,但离线段 (0,0)–(1,0) 有 10
    const p = Float32Array.from([0, 0, -10, 0.1, 1, 0]);
    expect(Array.from(simplifyLine(p, 0.3))).toEqual(Array.from(p));
    // 来回折的窄岬:去掉的点离抽稀后的折线照样不到容差
    const spit = Float32Array.from([0, 0, 5, 0.05, 10, 0.1, 5, 0.15, -3, 0.2, 2, 0.25]);
    const q = simplifyLine(spit, 0.3);
    for (let i = 0; i < spit.length; i += 2) expect(distTo(q, spit[i], spit[i + 1])).toBeLessThanOrEqual(0.3 + 1e-6);
  });
});
