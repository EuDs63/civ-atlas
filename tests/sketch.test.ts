/**
 * 地形草图(gen/sketch.ts;新建世界时「画大陆和海」):笔画的清理、涂到格子上、照草图生成(tectonics.ts 的 4b 步)、
 * 草图算星球的一部分(planetTempo 照草图生成)、存档往返。没画草图的世界逐字节不变。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, planetTempo } from '../src/gen/civ';
import {
  SKETCH_H,
  SKETCH_HILLS,
  SKETCH_ISLES,
  SKETCH_LAND,
  SKETCH_MAX_STROKES,
  SKETCH_MOUNTAIN,
  SKETCH_PLATEAU,
  SKETCH_SHELF,
  SKETCH_NONE,
  SKETCH_SEA,
  SKETCH_W,
  cleanSketch,
  cleanSketchStroke,
  sameSketch,
  sketchGrid,
  type Sketch,
  type SketchEdit,
  type SketchStroke,
} from '../src/gen/sketch';
import { editCount, makeSave, parseSave, saveText, worldCheck } from '../src/gen/savefile';
import { EMPTY_EDITS } from '../src/gen/edits';

const SMALL = { ...DEFAULT_PARAMS, cells: 12000, seed: 7 };
const at = (s: Sketch, x: number, y: number) => s.grid[Math.floor(y / CELL) * SKETCH_W + (((Math.floor(x / CELL) % SKETCH_W) + SKETCH_W) % SKETCH_W)];
const CELL = 2048 / SKETCH_W;

describe('笔画的清理', () => {
  it('合格的原样返回;种类不认识、坐标不是数、没有点的丢掉', () => {
    const s: SketchStroke = { kind: 'land', r: 32, pts: [100, 200, 140, 210] };
    expect(cleanSketchStroke(s)).toBe(s);
    expect(cleanSketchStroke({ ...s, kind: 'lava' })).toBeNull();
    expect(cleanSketchStroke({ ...s, pts: [1, 'a'] })).toBeNull();
    expect(cleanSketchStroke({ ...s, pts: [] })).toBeNull();
    expect(cleanSketchStroke({ ...s, r: Number.NaN })).toBeNull();
    expect(cleanSketchStroke(null)).toBeNull();
  });

  it('坐标取整、y 夹在两极之间、x 和改地形一样绕圈;半径夹到范围内', () => {
    const v = cleanSketchStroke({ kind: 'sea', r: 999, pts: [2050.4, -20, 2040, 2000] })!;
    // 第一个点取模到 [0, 2048),第二个点挪到离它最近的那一圈(跨 180° 经线的一笔是连着的)
    expect(v.pts).toEqual([2, 0, -8, 1024]);
    expect(v.r).toBe(160);
  });

  it('一笔也没有、没涂的又交给程序 = 没画;选了"都是海"就算一笔没有也留着', () => {
    expect(cleanSketch({ rest: 'auto', strokes: [] })).toBeNull();
    expect(cleanSketch({ rest: 'sea', strokes: [] })).toEqual({ rest: 'sea', strokes: [] });
    expect(cleanSketch({ rest: 'x', strokes: [{ kind: 'land', r: 16, pts: [1, 1] }] })?.rest).toBe('auto');
    const ok: SketchEdit = { rest: 'auto', strokes: [{ kind: 'mountain', r: 16, pts: [10, 10] }] };
    expect(cleanSketch(ok)).toBe(ok);
    const many = { rest: 'auto', strokes: Array.from({ length: SKETCH_MAX_STROKES + 5 }, () => ({ kind: 'land', r: 16, pts: [5, 5] })) };
    expect(cleanSketch(many)!.strokes).toHaveLength(SKETCH_MAX_STROKES);
  });

  it('sameSketch 逐笔比', () => {
    const a: SketchEdit = { rest: 'auto', strokes: [{ kind: 'land', r: 16, pts: [1, 2, 3, 4] }] };
    expect(sameSketch(a, JSON.parse(JSON.stringify(a)))).toBe(true);
    expect(sameSketch(a, { ...a, rest: 'sea' })).toBe(false);
    expect(sameSketch(a, { rest: 'auto', strokes: [{ kind: 'land', r: 16, pts: [1, 2, 3, 5] }] })).toBe(false);
    expect(sameSketch(undefined, null)).toBe(true);
    expect(sameSketch(a, undefined)).toBe(false);
  });
});

describe('涂到格子上', () => {
  it('一笔涂出一条带子,后涂的盖住先涂的,擦掉涂回没涂', () => {
    const g = sketchGrid({
      rest: 'auto',
      strokes: [
        { kind: 'land', r: 32, pts: [400, 400, 600, 400] },
        { kind: 'mountain', r: 16, pts: [500, 400] },
        { kind: 'erase', r: 16, pts: [420, 400] },
      ],
    })!;
    expect(g.grid).toHaveLength(SKETCH_W * SKETCH_H);
    expect(g.coast).toBe(0.6);
    expect(at(g, 560, 400)).toBe(SKETCH_LAND);
    expect(at(g, 560, 425)).toBe(SKETCH_LAND);
    expect(at(g, 560, 445)).toBe(SKETCH_NONE);
    expect(at(g, 500, 400)).toBe(SKETCH_MOUNTAIN + 1);
    expect(at(g, 420, 400)).toBe(SKETCH_NONE);
  });

  it('跨 180° 经线的一笔两边都涂上', () => {
    const g = sketchGrid({ rest: 'auto', strokes: [{ kind: 'sea', r: 16, pts: [2030, 300, 2070, 300] }] })!;
    expect(at(g, 2040, 300)).toBe(SKETCH_SEA);
    expect(at(g, 10, 300)).toBe(SKETCH_SEA);
    expect(at(g, 1000, 300)).toBe(SKETCH_NONE);
  });

  it('"都是海":没涂的格子当海;只擦了几下、没涂的交给程序 = 没画', () => {
    const g = sketchGrid({ rest: 'sea', strokes: [{ kind: 'land', r: 16, pts: [800, 500] }] })!;
    expect(at(g, 800, 500)).toBe(SKETCH_LAND);
    expect(at(g, 100, 100)).toBe(SKETCH_SEA);
    expect(sketchGrid({ rest: 'auto', strokes: [{ kind: 'erase', r: 16, pts: [800, 500] }] })).toBeNull();
    expect(sketchGrid(null)).toBeNull();
  });
});

/** 世界坐标 (x, y) 附近 r 以内的地块 */
function near(w: World, x: number, y: number, r: number): number[] {
  const out: number[] = [];
  const { n, width } = w.mesh;
  for (let i = 0; i < n; i++) {
    let dx = Math.abs(w.mesh.x[i] - x);
    dx = Math.min(dx, width - dx);
    const dy = w.mesh.y[i] - y;
    if (dx * dx + dy * dy <= r * r) out.push(i);
  }
  return out;
}
const landShare = (w: World, cells: number[]) => cells.filter((i) => w.water[i] === 0).length / cells.length;
/** 中纬度一处方圆 r 全是海(want = 1)/ 全是陆地(want = 0)的地方 */
function findSpot(w: World, want: 0 | 1, r: number): [number, number] {
  for (let y = 300; y <= 724; y += 32)
    for (let x = 0; x < 2048; x += 32) {
      const cells = near(w, x, y, r);
      if (cells.length && cells.every((i) => (w.water[i] === 1) === (want === 1))) return [x, y];
    }
  throw new Error('没找到');
}

describe('新的几支笔', () => {
  it('圈起来填满:首尾连起来,圈里整片涂上;没封口的只涂笔走过的地方', () => {
    const ring = [400, 300, 600, 300, 600, 500, 400, 500, 400, 310];
    const filled = sketchGrid({ rest: 'auto', strokes: [{ kind: 'land', r: 8, pts: ring, fill: 1 }] })!;
    expect(at(filled, 500, 400)).toBe(SKETCH_LAND);
    expect(at(filled, 700, 400)).toBe(SKETCH_NONE);
    const line = sketchGrid({ rest: 'auto', strokes: [{ kind: 'land', r: 8, pts: ring }] })!;
    expect(at(line, 500, 400)).toBe(SKETCH_NONE);
    // 陆地里圈一片海 = 内海
    const lake = sketchGrid({ rest: 'auto', strokes: [{ kind: 'land', r: 8, pts: ring, fill: 1 }, { kind: 'sea', r: 4, pts: [460, 360, 540, 360, 540, 440, 460, 440], fill: 1 }] })!;
    expect(at(lake, 500, 400)).toBe(SKETCH_SEA);
    expect(at(lake, 420, 320)).toBe(SKETCH_LAND);
  });

  it('各种笔涂成各自的格子值;山地按高低分三档', () => {
    const g = sketchGrid({
      rest: 'auto',
      strokes: [
        { kind: 'hills', r: 8, pts: [100, 300] },
        { kind: 'plateau', r: 8, pts: [200, 300] },
        { kind: 'shelf', r: 8, pts: [300, 300] },
        { kind: 'isles', r: 8, pts: [400, 300] },
        { kind: 'mountain', r: 8, pts: [500, 300], h: 0 },
        { kind: 'mountain', r: 8, pts: [600, 300], h: 2 },
      ],
    })!;
    expect([100, 200, 300, 400, 500, 600].map((x) => at(g, x, 300))).toEqual([SKETCH_HILLS, SKETCH_PLATEAU, SKETCH_SHELF, SKETCH_ISLES, SKETCH_MOUNTAIN, SKETCH_MOUNTAIN + 2]);
  });

  it('清理:高低只留给山地、只留 0 和 2;填满至少要三个点;海岸线夹到 [0, 1]、默认的适中不存', () => {
    expect(cleanSketchStroke({ kind: 'land', r: 8, pts: [1, 1], h: 2 })).toEqual({ kind: 'land', r: 8, pts: [1, 1] });
    expect(cleanSketchStroke({ kind: 'mountain', r: 8, pts: [1, 1], h: 1 })).toEqual({ kind: 'mountain', r: 8, pts: [1, 1] });
    expect(cleanSketchStroke({ kind: 'mountain', r: 8, pts: [1, 1], h: 2 })?.h).toBe(2);
    expect(cleanSketchStroke({ kind: 'land', r: 8, pts: [1, 1, 5, 5], fill: 1 })?.fill).toBeUndefined();
    expect(cleanSketchStroke({ kind: 'land', r: 8, pts: [1, 1, 5, 5, 9, 1], fill: 1 })?.fill).toBe(1);
    const st = [{ kind: 'land', r: 8, pts: [1, 1] }];
    expect(cleanSketch({ rest: 'auto', coast: 0.6, strokes: st })?.coast).toBeUndefined();
    expect(cleanSketch({ rest: 'auto', coast: 1, strokes: st })?.coast).toBe(1);
    expect(cleanSketch({ rest: 'auto', strokes: st })?.coast).toBeUndefined();
    expect(cleanSketch({ rest: 'auto', coast: -3, strokes: st })?.coast).toBe(0);
    expect(cleanSketch({ rest: 'auto', coast: 0.6123, strokes: st })?.coast).toBe(0.61);
    expect(sketchGrid({ rest: 'auto', coast: 0.3, strokes: [{ kind: 'land', r: 8, pts: [1, 300] }] })?.coast).toBe(0.3);
  });
});

describe('照草图生成', () => {
  const base = generateWorld(SMALL);

  it('没画草图(不给 / null / 涂完什么也没有)的世界逐字节不变', () => {
    const check = worldCheck(base);
    expect(worldCheck(generateWorld(SMALL, undefined, undefined, null))).toBe(check);
    expect(worldCheck(generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'auto', strokes: [{ kind: 'erase', r: 32, pts: [9, 9] }] })))).toBe(check);
    expect(base.sketch).toBeUndefined();
  });

  it('海里涂一块陆地长出陆地;陆地上涂一道海沉成海;远处不变', () => {
    const [sx, sy] = findSpot(base, 1, 110);
    const [lx, ly] = findSpot(base, 0, 90);
    const edit: SketchEdit = {
      rest: 'auto',
      strokes: [
        { kind: 'land', r: 64, pts: [sx - 30, sy, sx + 30, sy] },
        { kind: 'sea', r: 72, pts: [lx, ly] },
      ],
    };
    const w = generateWorld(SMALL, undefined, undefined, sketchGrid(edit));
    expect(w.sketch).toBeDefined();
    expect(landShare(w, near(w, sx, sy, 40))).toBeGreaterThan(0.8);
    // 海岸线要自然,轮廓会被扭一扭(域扭曲),所以只看中间一圈
    expect(landShare(w, near(w, lx, ly, 40))).toBeLessThan(0.25);
    // 地块网格只由种子决定;离两处都远的海陆和原来几乎一样
    const far = [];
    for (let i = 0; i < w.mesh.n; i++) {
      const d = (x: number, y: number) => {
        const dx = Math.min(Math.abs(w.mesh.x[i] - x), 2048 - Math.abs(w.mesh.x[i] - x));
        return Math.hypot(dx, w.mesh.y[i] - y);
      };
      if (d(sx, sy) > 400 && d(lx, ly) > 400) far.push(i);
    }
    const same = far.filter((i) => (w.water[i] === 0) === (base.water[i] === 0)).length / far.length;
    expect(same).toBeGreaterThan(0.97);
  });

  it('山地起山:涂山的地方比只涂陆地高', () => {
    const [sx, sy] = findSpot(base, 1, 110);
    const land: SketchStroke = { kind: 'land', r: 64, pts: [sx - 40, sy, sx + 40, sy] };
    const flat = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'auto', strokes: [land] }));
    const hill = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'auto', strokes: [land, { kind: 'mountain', r: 20, pts: [sx - 40, sy, sx + 40, sy] }] }));
    const top = (w: World) => Math.max(...near(w, sx, sy, 30).map((i) => w.elevation[i]));
    expect(top(hill)).toBeGreaterThan(top(flat) + 500);
  });

  it('海岸线"贴着画"比"自然"更贴着涂的轮廓', () => {
    const [sx, sy] = [1000, 500];
    const strokes: SketchStroke[] = [{ kind: 'land', r: 90, pts: [sx - 40, sy, sx + 40, sy] }];
    const miss = (coast: number) => {
      const w = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', coast, strokes }));
      const g = sketchGrid({ rest: 'sea', strokes })!;
      let bad = 0;
      for (let i = 0; i < w.mesh.n; i++) if ((w.water[i] === 0) !== (at(g, w.mesh.x[i], w.mesh.y[i]) >= SKETCH_LAND)) bad++;
      return bad;
    };
    expect(miss(0)).toBeLessThan(miss(1));
  });

  it('群岛那片冒出好几个分开的小岛', () => {
    const [sx, sy] = [1000, 500];
    const w = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [{ kind: 'isles', r: 120, pts: [sx, sy] }] }));
    const cells = near(w, sx, sy, 100);
    const share = landShare(w, cells);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.6);
    // 数一数连成片的块数
    const inSet = new Set(cells.filter((i) => w.water[i] === 0));
    const seen = new Set<number>();
    let islands = 0;
    for (const s0 of inSet) {
      if (seen.has(s0)) continue;
      islands++;
      const st = [s0];
      seen.add(s0);
      while (st.length) {
        const i = st.pop()!;
        for (let k = w.mesh.adjStart[i]; k < w.mesh.adjStart[i + 1]; k++) {
          const j = w.mesh.adj[k];
          if (inSet.has(j) && !seen.has(j)) (seen.add(j), st.push(j));
        }
      }
    }
    expect(islands).toBeGreaterThanOrEqual(4);
  });

  it('浅海比深海浅;丘陵、高原比平地高', () => {
    const [sx, sy] = [1000, 500];
    const sea = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [{ kind: 'sea', r: 60, pts: [sx, sy] }] }));
    const shelf = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [{ kind: 'shelf', r: 60, pts: [sx, sy] }] }));
    const mean = (w: World, cells: number[]) => cells.reduce((a, i) => a + w.elevation[i], 0) / cells.length;
    const mid = near(sea, sx, sy, 30);
    expect(mean(shelf, mid)).toBeGreaterThan(mean(sea, mid) + 1000);
    const land = (k: 'land' | 'hills' | 'plateau') =>
      generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [{ kind: 'land', r: 100, pts: [sx, sy] }, ...(k === 'land' ? [] : [{ kind: k, r: 60, pts: [sx, sy] } as SketchStroke])] }));
    const flat = land('land');
    const c = near(flat, sx, sy, 30);
    expect(mean(land('hills'), c)).toBeGreaterThan(mean(flat, c) + 50);
    expect(mean(land('plateau'), c)).toBeGreaterThan(mean(flat, c) + 800);
  });

  it('"都是海":只长画的陆地', () => {
    const w = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [{ kind: 'land', r: 96, pts: [900, 500, 1100, 500] }] }));
    expect(landShare(w, near(w, 1000, 500, 60))).toBeGreaterThan(0.8);
    expect(landShare(w, near(w, 300, 500, 200))).toBe(0);
    let land = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.water[i] === 0) land++;
    expect(land / w.mesh.n).toBeLessThan(0.08);
  });

  it('一片陆地也没画的"都是海":整颗星球是海,推演不出文明也不出错', () => {
    const w = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'sea', strokes: [] }));
    expect(w.water.every((v) => v !== 0)).toBe(true);
    expect([...w.elevation].every(Number.isFinite)).toBe(true);
    const civ = generateCiv(w);
    expect(civ.polities).toHaveLength(0);
  });

  it('草图算星球的一部分:画了草图又改地形,扩张节拍按照草图长出来的星球定', () => {
    const grid = sketchGrid({ rest: 'auto', strokes: [{ kind: 'land', r: 64, pts: [...findSpot(base, 1, 110)] }] });
    const planet = generateCiv(generateWorld(SMALL, undefined, undefined, grid));
    expect(planetTempo(SMALL, undefined, grid)).toBe(planet.spreadYears);
    const edited = generateCiv(generateWorld(SMALL, undefined, [{ kind: 'volcano', pts: [0, 660], r: 28, s: 1.05 }], grid));
    expect(edited.spreadYears).toBe(planet.spreadYears);
  });
});

describe('存档', () => {
  const edit: SketchEdit = { rest: 'sea', strokes: [{ kind: 'land', r: 32, pts: [700, 300, 760, 310] }, { kind: 'mountain', r: 16, pts: [720, 305] }] };

  it('存进去、读回来一样;算一处修改', () => {
    const save = makeSave(SMALL, { ...EMPTY_EDITS, sketch: edit }, 'x');
    const back = parseSave(saveText(save));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.save.edits.sketch).toEqual(edit);
    expect(back.warnings).toEqual([]);
    expect(editCount(back.save.edits)).toBe(1);
    expect(makeSave(SMALL, EMPTY_EDITS, 'x').edits.sketch).toBeUndefined();
  });

  it('选了海岸线(贴着画 / 曲折)也存进去,读回来一样', () => {
    for (const coast of [0, 1]) {
      const save = makeSave(SMALL, { ...EMPTY_EDITS, sketch: { ...edit, coast } }, 'x');
      const back = parseSave(saveText(save));
      expect(back.ok && back.save.edits.sketch).toEqual({ ...edit, coast });
    }
  });

  it('格式不对的笔画跳过并提示', () => {
    const save = makeSave(SMALL, { ...EMPTY_EDITS, sketch: edit }, 'x');
    const raw = JSON.parse(saveText(save));
    raw.edits.sketch.strokes.push({ kind: 'lava', r: 3, pts: [1, 1] });
    const back = parseSave(JSON.stringify(raw));
    expect(back.ok && back.save.edits.sketch?.strokes).toHaveLength(2);
    expect(back.ok && back.warnings).toContain('草图有 1 笔格式不对,已跳过');
    raw.edits.sketch = 'oops';
    const bad = parseSave(JSON.stringify(raw));
    expect(bad.ok && bad.save.edits.sketch).toBeUndefined();
    expect(bad.ok && bad.warnings).toContain('草图格式不对,已跳过');
  });
});

describe('当前世界的草图(editsStore)', () => {
  it('加一笔、撤销一笔、没涂的地方、全部清除;撤销改名时草图留着', async () => {
    const { addSketchStroke, clearEdits, clearSketch, commitEdits, getEdits, revertEdits, setSketchRest, undoSketchStroke } = await import('../src/ui/editsStore');
    clearEdits();
    expect(addSketchStroke({ kind: 'land', r: 32, pts: [100, 200] })).toBe(true);
    expect(addSketchStroke({ kind: 'lava' as 'land', r: 32, pts: [100, 200] })).toBe(false);
    expect(getEdits().sketch).toEqual({ rest: 'auto', strokes: [{ kind: 'land', r: 32, pts: [100, 200] }] });
    setSketchRest('sea');
    expect(getEdits().sketch?.rest).toBe('sea');
    undoSketchStroke();
    // 一笔不剩但选了"都是海":草图还在(整颗星球是海)
    expect(getEdits().sketch).toEqual({ rest: 'sea', strokes: [] });
    setSketchRest('auto');
    expect(getEdits().sketch).toBeUndefined();
    addSketchStroke({ kind: 'mountain', r: 16, pts: [5, 5] });
    const before = getEdits();
    commitEdits({ ...before, names: { 'region:c1': '九州' } });
    const after = getEdits();
    expect(revertEdits(after, after, before).sketch).toBe(before.sketch);
    clearSketch();
    expect(getEdits().sketch).toBeUndefined();
    clearEdits();
  });
});
