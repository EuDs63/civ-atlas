/**
 * 编辑地形的工具(ui/TerrainTools.tsx):在地图上按下、拖动、松开画成草图的一笔或一条河,点一下放火山湖;
 * 撤销 / 重做按先后把草图的笔和放的一处混在一起算;全部清除;海岸线的选择在画第一笔前也记着;画了几笔的说法
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearEdits, getEdits, putSketch, addTerrainOp, setEdits } from '../src/ui/editsStore';
import { EMPTY_EDITS } from '../src/gen/edits';
import {
  clearAllTerrain,
  redoTerrain,
  setTerrainCoast,
  setTerrainTool,
  setTerrainWrap,
  terrainCancel,
  terrainClick,
  terrainCount,
  terrainDown,
  terrainMove,
  terrainSide,
  terrainUp,
  undoTerrain,
} from '../src/ui/TerrainTools';

/** 按下 → 依次移过这些点 → 松开 */
function drag(pts: [number, number][]) {
  expect(terrainDown(pts[0], 0)).toBe(true);
  for (const p of pts.slice(1)) terrainMove(p);
  terrainUp();
}

beforeEach(() => {
  clearEdits();
  clearAllTerrain();
  setTerrainWrap(2048);
  setTerrainTool({ on: true, tool: 'land', r: 40, method: 'paint', h: 1, size: 1, show: true, coast: 0.6 });
});
afterEach(() => setTerrainTool({ on: false }));

describe('编辑地形:画', () => {
  it('涂一笔 = 草图加一笔(半径、高低照工具);圈起来填满 = fill 1;没开编辑地形时不归它管', () => {
    drag([
      [400, 400],
      [460, 400],
      [520, 410],
    ]);
    setTerrainTool({ tool: 'mountain', r: 12, h: 2 });
    drag([
      [600, 300],
      [700, 320],
    ]);
    setTerrainTool({ tool: 'sea', method: 'lasso' });
    drag([
      [800, 500],
      [860, 500],
      [860, 560],
      [800, 560],
    ]);
    const s = getEdits().sketch!;
    expect(s.strokes.map((x) => x.kind)).toEqual(['land', 'mountain', 'sea']);
    expect(s.strokes[0]).toMatchObject({ r: 40, pts: [400, 400, 460, 400, 520, 410] });
    expect(s.strokes[0].h).toBeUndefined();
    expect(s.strokes[1]).toMatchObject({ r: 12, h: 2 });
    expect(s.strokes[2].fill).toBe(1);
    expect(s.strokes[2].pts.length).toBeGreaterThanOrEqual(8);
    setTerrainTool({ on: false });
    expect(terrainDown([100, 100], 0)).toBe(false);
    expect(terrainClick([100, 100])).toBe(false);
  });

  it('跨 180° 经线涂的一笔是连着的(点按上一个点展开)', () => {
    drag([
      [2030, 400],
      [10, 402],
      [40, 404],
    ]);
    const xs = getEdits().sketch!.strokes[0].pts.filter((_, i) => i % 2 === 0);
    expect(xs[0]).toBe(2030);
    expect(Math.max(...xs)).toBeGreaterThan(2048);
  });

  it('火山、湖点一下放一处(拖动不画);河要画成线,点一下不算', () => {
    setTerrainTool({ tool: 'volcano' });
    expect(terrainDown([500, 500], 0)).toBe(false);
    expect(terrainClick([500, 500])).toBe(true);
    setTerrainTool({ tool: 'river' });
    drag([[600, 600]]);
    drag([
      [600, 600],
      [640, 660],
      [650, 720],
    ]);
    const t = getEdits().terrain;
    expect(t.map((o) => o.kind)).toEqual(['volcano', 'river']);
    expect(t[1].pts.length).toBe(6);
    expect(getEdits().sketch).toBeUndefined();
  });

  it('第二根手指紧跟着按下:刚开始的那一笔不算', () => {
    expect(terrainDown([300, 300], 0)).toBe(true);
    expect(terrainCancel()).toBe(true);
    terrainUp();
    expect(getEdits().sketch).toBeUndefined();
  });
});

describe('编辑地形:撤销 / 重做 / 全部清除', () => {
  it('草图的笔和放的一处按先后撤销,撤掉的能重做;撤完又画了别的就不能重做', () => {
    drag([
      [400, 400],
      [460, 400],
    ]);
    setTerrainTool({ tool: 'volcano' });
    terrainClick([500, 500]);
    setTerrainTool({ tool: 'hills' });
    drag([
      [700, 400],
      [760, 400],
    ]);
    expect(terrainCount(getEdits())).toBe(3);
    undoTerrain();
    expect(getEdits().sketch!.strokes.map((s) => s.kind)).toEqual(['land']);
    expect(getEdits().terrain).toHaveLength(1);
    undoTerrain();
    expect(getEdits().terrain).toHaveLength(0);
    expect(terrainCount(getEdits())).toBe(1);
    redoTerrain();
    expect(getEdits().terrain.map((o) => o.kind)).toEqual(['volcano']);
    redoTerrain();
    expect(getEdits().sketch!.strokes.map((s) => s.kind)).toEqual(['land', 'hills']);
    // 都重做回来了,再重做没东西
    redoTerrain();
    expect(terrainCount(getEdits())).toBe(3);
    undoTerrain();
    drag([
      [900, 400],
      [960, 400],
    ]);
    redoTerrain();
    expect(getEdits().sketch!.strokes).toHaveLength(2);
  });

  it('别处加的(读档、助手)也撤得掉:先撤草图,再撤放的', () => {
    putSketch({ rest: 'auto', strokes: [{ kind: 'land', r: 20, pts: [100, 100] }] });
    addTerrainOp({ kind: 'range', pts: [200, 200, 260, 220], r: 20, s: 1 });
    undoTerrain();
    expect(getEdits().sketch).toBeUndefined();
    expect(getEdits().terrain).toHaveLength(1);
    undoTerrain();
    expect(getEdits().terrain).toHaveLength(0);
  });

  it('换了世界(整个换掉修改):上一个世界记的先后作废,撤销按"先撤草图,再撤放的"', () => {
    drag([
      [400, 400],
      [460, 400],
    ]);
    setTerrainTool({ tool: 'volcano' });
    terrainClick([500, 500]);
    setTerrainTool({ tool: 'land' });
    // 读档:新世界先放了一处、后画了一笔(记录里没有它们的先后)
    setEdits({ ...EMPTY_EDITS, sketch: { rest: 'auto', strokes: [{ kind: 'land', r: 20, pts: [100, 100] }] }, terrain: [{ kind: 'lake', pts: [200, 200], r: 16, s: 1 }] });
    undoTerrain();
    expect(getEdits().sketch).toBeUndefined();
    expect(getEdits().terrain).toHaveLength(1);
    // 上一个世界撤掉的也不能重做到这里
    setEdits({ ...EMPTY_EDITS });
    drag([
      [400, 400],
      [460, 400],
    ]);
    undoTerrain();
    setEdits({ ...EMPTY_EDITS });
    redoTerrain();
    expect(getEdits().sketch).toBeUndefined();
  });

  it('全部清除:草图、放的、"都是海"一起清掉', () => {
    putSketch({ rest: 'sea', coast: 1, strokes: [{ kind: 'land', r: 20, pts: [100, 100] }] });
    addTerrainOp({ kind: 'lake', pts: [200, 200], r: 16, s: 1 });
    clearAllTerrain();
    expect(getEdits().sketch).toBeUndefined();
    expect(getEdits().terrain).toHaveLength(0);
  });
});

describe('编辑地形:海岸线', () => {
  it('还没画就选了曲折:画第一笔时带上;撤掉最后一笔再重做,海岸线不变', () => {
    setTerrainCoast(1);
    expect(getEdits().sketch).toBeUndefined();
    drag([
      [400, 400],
      [460, 400],
    ]);
    expect(getEdits().sketch!.coast).toBe(1);
    setTerrainCoast(0);
    expect(getEdits().sketch!.coast).toBe(0);
    undoTerrain();
    expect(getEdits().sketch).toBeUndefined();
    redoTerrain();
    expect(getEdits().sketch!.coast).toBe(0);
    // 默认的适中不存
    setTerrainCoast(0.6);
    expect(getEdits().sketch!.coast).toBeUndefined();
  });
});

describe('编辑地形:说法', () => {
  it('画了几笔 = 草图的笔 + 放的一处;一笔没画但没涂的都是海 = "都是海"', () => {
    expect(terrainSide(getEdits(), '还没改')).toBe('还没改');
    putSketch({ rest: 'sea', strokes: [] });
    expect(terrainSide(getEdits(), '还没改')).toBe('都是海');
    addTerrainOp({ kind: 'volcano', pts: [200, 200], r: 28, s: 1 });
    putSketch({ rest: 'sea', strokes: [{ kind: 'land', r: 20, pts: [100, 100] }] });
    expect(terrainSide(getEdits(), '没改过')).toBe('画了 2 笔');
  });
});
