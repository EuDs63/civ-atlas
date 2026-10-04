/**
 * 改地形(阶段 4):TerrainOp 的清理、生成流程里套上以后的效果(火山成岛、山脉抬高且有河流下、湖、抬起 / 沉下)、
 * 确定性(同样的地形修改两次生成逐字节相同;没有修改 = 和不改一模一样)、存档往返、
 * 手绘风的符号(山、丘陵、沙丘、草丛、林块)改地形后远处一个都不挪。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, MAP_H, MAP_W, generateWorld, type World } from '../src/gen/world';
import { EMPTY_EDITS, type TerrainOp, type WorldEdits } from '../src/gen/edits';
import { TERRAIN_H, TERRAIN_MAX_OPS, TERRAIN_MAX_PTS, TERRAIN_W, cleanTerrainOp, cleanTerrainOps, sameTerrain } from '../src/gen/terrainEdits';
import { editCount, makeSave, parseSave, saveText, worldCheck } from '../src/gen/savefile';
import { G_VOLCANO, planGlyphs, type Glyph } from '../src/render/fantasy';

const SMALL = { ...DEFAULT_PARAMS, cells: 12000, seed: 7 };
let base: World | undefined;
const base7 = () => (base ??= generateWorld(SMALL));

/** 离某类地块(陆地 / 海)最远的一格(按邻接步数;只在地图中间一带找,不挨着冰原和边框) */
function farthestFrom(w: World, wantLand: boolean): number {
  const { n, adjStart, adj, x, y } = w.mesh;
  const dist = new Int32Array(n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < n; i++) if ((w.water[i] === 0) !== wantLand) (dist[i] = 0), q.push(i);
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (dist[j] < 0) (dist[j] = dist[i] + 1), q.push(j);
    }
  }
  let best = -1;
  for (let i = 0; i < n; i++) {
    if ((w.water[i] === 0) !== wantLand || Math.abs(y[i] - MAP_H / 2) > 260 || x[i] < 200 || x[i] > MAP_W - 200) continue;
    if (best < 0 || dist[i] > dist[best]) best = i;
  }
  return best;
}

const near = (w: World, px: number, py: number, R: number) => {
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if ((w.mesh.x[i] - px) ** 2 + (w.mesh.y[i] - py) ** 2 < R * R) out.push(i);
  return out;
};
const mean = (w: World, cells: number[]) => cells.reduce((s, i) => s + w.elevation[i], 0) / cells.length;
const same = (a: World, b: World) => {
  expect(Buffer.from(a.elevation.buffer).equals(Buffer.from(b.elevation.buffer))).toBe(true);
  expect(Array.from(a.water)).toEqual(Array.from(b.water));
  expect(Array.from(a.biome)).toEqual(Array.from(b.biome));
  expect(Buffer.from(a.flux.buffer).equals(Buffer.from(b.flux.buffer))).toBe(true);
  expect(a.rivers.length).toBe(b.rivers.length);
  expect(a.history.length).toBe(b.history.length);
  for (let f = 0; f < a.history.length; f++) expect(Buffer.from(a.history[f].buffer).equals(Buffer.from(b.history[f].buffer))).toBe(true);
};

describe('改地形 · 格式', () => {
  it('世界坐标的范围和地图原图一致', () => {
    expect([TERRAIN_W, TERRAIN_H]).toEqual([MAP_W, MAP_H]);
  });

  it('清理:认不出的丢掉,超出范围的夹回来(x 是经度:取模、按上一个点展开),本来就合格的原样返回', () => {
    const ok: TerrainOp = { kind: 'volcano', pts: [800, 500], r: 22, s: 1 };
    expect(cleanTerrainOp(ok)).toBe(ok);
    for (const bad of [null, 3, 'x', {}, { kind: 'meteor', pts: [1, 2], r: 5, s: 1 }, { kind: 'lake', pts: [1], r: 5, s: 1 }, { kind: 'lake', pts: [1, 'a'], r: 5, s: 1 }, { kind: 'lake', pts: [1, 2], r: NaN, s: 1 }, { kind: 'range', pts: [1, 2, 3, 4], r: 5 }])
      expect(cleanTerrainOp(bad)).toBeNull();
    // 取整;y 夹在两极之间,x(经度)取模回 [0, 宽);火山只留第一个点;多余字段去掉
    expect(cleanTerrainOp({ kind: 'volcano', pts: [-50.4, 99999, 7, 8], r: 1000, s: -1, extra: 1 })).toEqual({ kind: 'volcano', pts: [TERRAIN_W - 50, TERRAIN_H], r: 160, s: 0.2 });
    expect(cleanTerrainOp({ kind: 'lake', pts: [TERRAIN_W, 3], r: 16, s: 1 })?.pts).toEqual([0, 3]);
    expect(cleanTerrainOp({ kind: 'lake', pts: [3 * TERRAIN_W + 7.4, 3], r: 16, s: 1 })?.pts).toEqual([7, 3]);
    // 跨 180° 经线的一笔:第一个点在图里,之后每个点挪到离上一个点最近的那一圈(x 可以超出地图),连着的一笔
    const seam = { kind: 'range', pts: [2040, 500, 10, 510, 30, 520, 2047, 530], r: 20, s: 1 } as TerrainOp;
    const cs = cleanTerrainOp(seam)!;
    expect(cs.pts).toEqual([2040, 500, 2058, 510, 2078, 520, 2047, 530]);
    // 已经展开的原样返回(同一个对象);清理两遍和一遍一样
    expect(cleanTerrainOp(cs)).toBe(cs);
    expect(cleanTerrainOp({ kind: 'raise', pts: [-100, 200, -60, 200], r: 20, s: 1 })?.pts).toEqual([TERRAIN_W - 100, 200, TERRAIN_W - 60, 200]);
    // 平面时代的存档(x 都在 [0, 2048] 里,每个点单独取模)照读,按经纬度解释:横穿半张图以内的线不变
    const old: TerrainOp = { kind: 'range', pts: [0, 512, 700, 300, 1400, 700, 2048, 512], r: 20, s: 1 };
    expect(cleanTerrainOp(old)).toBe(old);
    // 折线最多 TERRAIN_MAX_PTS 个点,奇数个坐标去掉最后一个
    const long = cleanTerrainOp({ kind: 'range', pts: Array.from({ length: TERRAIN_MAX_PTS * 2 + 41 }, (_, i) => i % 1000), r: 20, s: 1 });
    expect(long?.pts.length).toBe(TERRAIN_MAX_PTS * 2);
    // 列表:全合格 = 同一个数组;有坏的 = 新数组;最多 TERRAIN_MAX_OPS 处
    const list = [ok, { kind: 'lake', pts: [300, 400], r: 16, s: 1 }] as TerrainOp[];
    expect(cleanTerrainOps(list)).toBe(list);
    expect(cleanTerrainOps([ok, 'bad', null])).toEqual([ok]);
    expect(cleanTerrainOps('nope')).toEqual([]);
    expect(cleanTerrainOps(Array.from({ length: TERRAIN_MAX_OPS + 5 }, () => ok)).length).toBe(TERRAIN_MAX_OPS);
    expect(sameTerrain(list, [{ ...ok }, { kind: 'lake', pts: [300, 400], r: 16, s: 1 }])).toBe(true);
    expect(sameTerrain(list, [ok])).toBe(false);
  });
});

describe('改地形 · 生成', () => {
  it('没有地形修改:和不改一模一样(逐字节)', () => {
    const a = base7();
    same(a, generateWorld(SMALL, undefined, []));
    expect(a.volcanoes).toEqual([]);
  });

  it('同样的地形修改,两次生成逐字节相同', () => {
    const w = base7();
    const c = farthestFrom(w, true);
    const ops: TerrainOp[] = [
      { kind: 'volcano', pts: [Math.round(w.mesh.x[c]) + 60, Math.round(w.mesh.y[c])], r: 28, s: 1 },
      { kind: 'range', pts: [Math.round(w.mesh.x[c]) - 90, Math.round(w.mesh.y[c]) - 40, Math.round(w.mesh.x[c]) + 30, Math.round(w.mesh.y[c]) + 50], r: 20, s: 1 },
      { kind: 'lake', pts: [Math.round(w.mesh.x[c]) - 40, Math.round(w.mesh.y[c]) + 70], r: 16, s: 1 },
      { kind: 'sink', pts: [400, 300, 440, 320], r: 24, s: 1 },
      { kind: 'raise', pts: [1000, 520, 1040, 530], r: 24, s: 1 },
    ];
    const a = generateWorld(SMALL, undefined, ops);
    const b = generateWorld(SMALL, undefined, ops.map((o) => ({ ...o, pts: [...o.pts] })));
    same(a, b);
    expect(a.volcanoes).toEqual(b.volcanoes);
    expect(worldCheck(a)).toBe(worldCheck(b));
    expect(worldCheck(a)).not.toBe(worldCheck(w));
  });

  it('跨 180° 经线的笔画:一笔抬起的陆地在接缝两边连成一片;取模写和展开写是同一个世界', () => {
    const w0 = base7();
    // 赤道附近、接缝两边都是海的一段
    let y = -1;
    for (let yy = 380; yy <= 640 && y < 0; yy += 20) {
      const sea = near(w0, 2030, yy, 40).concat(near(w0, 18, yy, 40));
      if (sea.length > 4 && sea.every((i) => w0.water[i] === 1)) y = yy;
    }
    expect(y).toBeGreaterThan(0);
    const open: TerrainOp = { kind: 'raise', pts: [2010, y, 2086, y], r: 24, s: 1 };
    const wrapped: TerrainOp = { kind: 'raise', pts: [2010, y, 38, y], r: 24, s: 1 };
    expect(cleanTerrainOp(wrapped)).toEqual(open);
    const a = generateWorld(SMALL, undefined, [open]);
    same(a, generateWorld(SMALL, undefined, [wrapped]));
    // 接缝两边(西边 x ≈ 2030、东边 x ≈ 18)都抬成了陆地,中间不断
    for (const x of [2025, 2040, 8, 25]) expect(near(a, x, y, 8).every((i) => a.water[i] === 0), `x = ${x}`).toBe(true);
    // 横穿整张图的那一半没被抬起来(走的是短边)
    expect(near(a, 1024, y, 60).every((i) => a.water[i] === w0.water[i])).toBe(true);
  });

  it('海里的火山成岛:中心一带变成陆地、高高隆起,峰顶记在 volcanoes 里', () => {
    const w0 = base7();
    const c = farthestFrom(w0, false);
    const [px, py] = [Math.round(w0.mesh.x[c]), Math.round(w0.mesh.y[c])];
    expect(w0.water[c]).toBe(1);
    const w = generateWorld(SMALL, undefined, [{ kind: 'volcano', pts: [px, py], r: 28, s: 1 }]);
    const core = near(w, px, py, 12);
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((i) => w.water[i] === 0)).toBe(true);
    expect(w.volcanoes.length).toBe(1);
    const peak = w.volcanoes[0];
    expect(w.elevation[peak]).toBeGreaterThan(1500);
    expect((w.mesh.x[peak] - px) ** 2 + (w.mesh.y[peak] - py) ** 2).toBeLessThan(28 ** 2);
    // 离得远的海不受影响
    const far = near(w0, px + 300, py, 30).filter((i) => w0.water[i] === 1);
    for (const i of far) expect(w.water[i]).toBe(1);
  });

  it('山脉:沿线海拔明显升高,有河从山上流下来', () => {
    const w0 = base7();
    const c = farthestFrom(w0, true);
    const [cx, cy] = [Math.round(w0.mesh.x[c]), Math.round(w0.mesh.y[c])];
    const pts = [cx - 80, cy - 30, cx, cy, cx + 80, cy + 30];
    const w = generateWorld(SMALL, undefined, [{ kind: 'range', pts, r: 20, s: 1 }]);
    const ridge = near(w, cx, cy, 20);
    expect(mean(w, ridge)).toBeGreaterThan(mean(w0, ridge) + 800);
    // 河的源头在山脉两侧不远处
    const sources = (x: World) =>
      x.rivers.filter((r) => {
        const [sx, sy] = [r.pts[0], r.pts[1]];
        return Math.abs(sx - cx) < 120 && Math.abs(sy - cy) < 90;
      }).length;
    expect(sources(w)).toBeGreaterThan(0);
    expect(sources(w)).toBeGreaterThanOrEqual(sources(w0));
  });

  it('湖:点的位置出现湖,而且不会因为"太大"被填平', () => {
    const w0 = base7();
    const c = farthestFrom(w0, true);
    const [px, py] = [Math.round(w0.mesh.x[c]), Math.round(w0.mesh.y[c])];
    expect(w0.water[c]).toBe(0);
    const w = generateWorld(SMALL, undefined, [{ kind: 'lake', pts: [px, py], r: 16, s: 1 }]);
    expect(w.water[c]).toBe(2);
    const big = generateWorld(SMALL, undefined, [{ kind: 'lake', pts: [px, py], r: 40, s: 1 }]);
    const lake = near(big, px, py, 20).filter((i) => big.water[i] === 2);
    expect(lake.length).toBeGreaterThan(5);
    // 点在海里的湖不生效
    const o = farthestFrom(w0, false);
    same(w0, generateWorld(SMALL, undefined, [{ kind: 'lake', pts: [Math.round(w0.mesh.x[o]), Math.round(w0.mesh.y[o])], r: 16, s: 1 }]));
  });

  it('抬起陆地 / 沉成海:画笔走过的地方海陆互换', () => {
    const w0 = base7();
    const o = farthestFrom(w0, false);
    const l = farthestFrom(w0, true);
    const [ox, oy] = [Math.round(w0.mesh.x[o]), Math.round(w0.mesh.y[o])];
    const [lx, ly] = [Math.round(w0.mesh.x[l]), Math.round(w0.mesh.y[l])];
    const w = generateWorld(SMALL, undefined, [
      { kind: 'raise', pts: [ox - 30, oy, ox + 30, oy], r: 24, s: 1 },
      { kind: 'sink', pts: [lx - 30, ly, lx + 30, ly], r: 24, s: 1 },
    ]);
    expect(near(w, ox, oy, 10).every((i) => w.water[i] === 0)).toBe(true);
    expect(near(w, lx, ly, 10).every((i) => w.water[i] === 1 && w.elevation[i] < 0)).toBe(true);
    for (let i = 0; i < w.mesh.n; i++) expect(Number.isFinite(w.elevation[i])).toBe(true);
  });

  it('一座大火山不会把全世界别的山压矮', () => {
    const w0 = base7();
    const o = farthestFrom(w0, false);
    const w = generateWorld(SMALL, undefined, [{ kind: 'volcano', pts: [Math.round(w0.mesh.x[o]), Math.round(w0.mesh.y[o])], r: 40, s: 2 }]);
    // 原来最高的那座山,海拔几乎不变
    let top = 0;
    for (let i = 0; i < w0.mesh.n; i++) if (w0.elevation[i] > w0.elevation[top]) top = i;
    expect(Math.abs(w.elevation[top] - w0.elevation[top])).toBeLessThan(w0.elevation[top] * 0.08);
  });
});

describe('改地形 · 存档', () => {
  const TERRAIN: TerrainOp[] = [
    { kind: 'volcano', pts: [812, 403], r: 28, s: 1.05 },
    { kind: 'range', pts: [1156, 380, 1215, 430, 1273, 483], r: 20, s: 1 },
    { kind: 'lake', pts: [336, 410], r: 16, s: 1 },
    { kind: 'raise', pts: [900, 600], r: 24, s: 1 },
    { kind: 'sink', pts: [100, 200, 120, 220], r: 14, s: 1 },
  ];
  const EDITS: WorldEdits = { names: { 'region:r7': '九嶷州' }, interventions: [], terrain: TERRAIN };

  it('存读往返不变;改了几处把地形修改算进去', () => {
    const save = makeSave(SMALL, EDITS, 'abc', '火山岛', '2026-09-27T08:00:00.000Z');
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.save).toEqual(save);
    expect(r.save.edits.terrain).toEqual(TERRAIN);
    expect(editCount(r.save.edits)).toBe(1 + TERRAIN.length);
    // 存档是复制出来的
    const t = TERRAIN.map((o) => ({ ...o, pts: [...o.pts] }));
    const s2 = makeSave(SMALL, { ...EDITS, terrain: t }, 'x');
    t[0].pts[0] = 1;
    expect(s2.edits.terrain[0].pts[0]).toBe(812);
  });

  it('旧存档没有 terrain = 没改地形,不提示', () => {
    const old = JSON.parse(saveText(makeSave(SMALL, EMPTY_EDITS, 'c'))) as { edits: Record<string, unknown> };
    delete old.edits.terrain;
    const r = parseSave(JSON.stringify(old));
    expect(r.ok && r.save.edits.terrain).toEqual([]);
    expect(r.ok && r.warnings).toEqual([]);
  });

  it('格式不对的地形修改跳过,其余照读(y 夹回两极之间,x 按经度取模)', () => {
    const a = JSON.parse(saveText(makeSave(SMALL, EDITS, 'c'))) as { edits: Record<string, unknown> };
    a.edits.terrain = [TERRAIN[0], { kind: 'meteor', pts: [1, 2], r: 5, s: 1 }, 'bad', { kind: 'lake', pts: [5000, -3], r: 16, s: 1 }];
    const r = parseSave(JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.terrain).toEqual([TERRAIN[0], { kind: 'lake', pts: [5000 - 2 * TERRAIN_W, 0], r: 16, s: 1 }]);
    expect(r.warnings).toEqual(['有 2 处地形修改格式不对,已跳过']);
    const b = JSON.parse(saveText(makeSave(SMALL, EDITS, 'c'))) as { edits: Record<string, unknown> };
    b.edits.terrain = 'nope';
    const rb = parseSave(JSON.stringify(b));
    expect(rb.ok && rb.save.edits.terrain).toEqual([]);
    expect(rb.ok && rb.warnings).toEqual(['有 1 处地形修改格式不对,已跳过']);
  });
});

describe('改地形 · 手绘符号', () => {
  it('海里放一座小火山:离得远(> 200)的符号一个都不挪,林块不变', () => {
    const w0 = base7();
    const o = farthestFrom(w0, false);
    const [px, py] = [Math.round(w0.mesh.x[o]), Math.round(w0.mesh.y[o])];
    const w1 = generateWorld(SMALL, undefined, [{ kind: 'volcano', pts: [px, py], r: 28, s: 1 }]);
    const R = 200;
    const far = (x: number, y: number) => (x - px) ** 2 + (y - py) ** 2 > R * R;
    const a = planGlyphs(w0);
    const b = planGlyphs(w1);
    // 火山那里确实变了:多了一座火山符号
    expect(b.glyphs.filter((g) => g.kind === G_VOLCANO).length).toBe(1);
    // 远处的符号:位置、种类、地块、抖动、走向逐个相同;大小只许差一点点
    // (火山让远处个别地块的海拔差 1e-5 量级的浮点零头,符号大小跟着差 1e-6 量级,画出来看不出)
    const key = (g: Glyph) => `${g.kind}@${g.cell}:${g.x},${g.y}`;
    const ga = a.glyphs.filter((g) => far(g.x, g.y));
    const gb = new Map(b.glyphs.filter((g) => far(g.x, g.y)).map((g) => [key(g), g]));
    expect(ga.length).toBeGreaterThan(300);
    const moved = ga.filter((g) => !gb.has(key(g))).map(key);
    expect(moved).toEqual([]);
    expect(gb.size).toBe(ga.length);
    for (const g of ga) {
      const h = gb.get(key(g))!;
      expect([h.v, h.a, h.c]).toEqual([g.v, g.a, g.c]);
      expect(Math.abs(h.s - g.s)).toBeLessThan(1e-3);
    }
    // 画出来的先后(从上到下,互相遮挡)也一样
    expect(b.glyphs.filter((g) => far(g.x, g.y)).map(key)).toEqual(ga.map(key));
    // 林块:远处的地块逐个相同
    const { n, x, y } = w0.mesh;
    let diff = 0;
    let forested = 0;
    for (let i = 0; i < n; i++) {
      if (!far(x[i], y[i])) continue;
      if (a.forest[i]) forested++;
      if (a.forest[i] !== b.forest[i]) diff++;
    }
    expect(forested).toBeGreaterThan(300);
    expect(diff).toBe(0);
  });
});
