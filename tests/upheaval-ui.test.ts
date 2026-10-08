/**
 * 地形大事的界面部分:修改和撤销(ui/editsStore.ts、undo.ts)、卡片和地图上的笔(ui/upheavalStore.ts)、
 * 地图上那一层的形状(ui/upheavalShapes.ts)、主图补丁(gen/rasterPatch.ts)、地图跟着时间轴换段(ui/eras.ts:各段的历史、世界、主图)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addUpheaval, clearEdits, getEdits, removeUpheaval } from '../src/ui/editsStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { UPHEAVALS_MAX, UPHEAVAL_OPS_MAX } from '../src/gen/terrainEdits';
import {
  UP_SIZE,
  clearUpOps,
  closeUpheaval,
  getUpUi,
  openUpheaval,
  setUpKind,
  setUpSize,
  undoUpOp,
  upCancel,
  upClick,
  upDown,
  upMove,
  upUp,
  upYear,
  upheavalName,
} from '../src/ui/upheavalStore';
import { bandOutline, cellShapes } from '../src/ui/upheavalShapes';
import { composeRaster, diffRaster, type RasterPatch } from '../src/gen/rasterPatch';
import { baseRegions, civAtEra, dropComposed, eraData, eraIndex, eraReady, eraShown, patchKey, reuseRegions, type EraMaps } from '../src/ui/eras';
import type { Raster } from '../src/gen/raster';
import type { World } from '../src/gen/world';
import type { Civ } from '../src/gen/civ/types';

const SINK = { kind: 'sink' as const, pts: [100, 100, 140, 110], r: 20, s: 1.1 };
const VOLC = { kind: 'volcano' as const, pts: [300, 200], r: 30, s: 1.1 };

describe('地形大事 · 修改和撤销', () => {
  beforeEach(() => clearEdits());

  it('加一件:清理过的(年份取整),不合格的不加;最多几件', () => {
    expect(addUpheaval({ year: 1600.7, ops: [SINK] })).toEqual({ year: 1600, ops: [SINK] });
    expect(getEdits().upheavals).toEqual([{ year: 1600, ops: [SINK] }]);
    expect(addUpheaval({ year: 1700, ops: [] })).toBeNull();
    expect(addUpheaval({ year: 1700, ops: [{ kind: 'river', pts: [0, 0, 10, 10], r: 1, s: 1 }] })).toBeNull();
    for (let i = 1; i < UPHEAVALS_MAX; i++) expect(addUpheaval({ year: 1600 + i, ops: [VOLC] })).not.toBeNull();
    expect(addUpheaval({ year: 2500, ops: [VOLC] })).toBeNull();
    expect(getEdits().upheavals).toHaveLength(UPHEAVALS_MAX);
  });

  it('去掉一件;一件不剩就去掉这一项;越界不动', () => {
    addUpheaval({ year: 1600, ops: [SINK] });
    addUpheaval({ year: 1800, ops: [VOLC] });
    removeUpheaval(5);
    expect(getEdits().upheavals).toHaveLength(2);
    removeUpheaval(0);
    expect(getEdits().upheavals).toEqual([{ year: 1800, ops: [VOLC] }]);
    removeUpheaval(0);
    expect('upheavals' in getEdits()).toBe(false);
  });

  it('撤销 / 重做:加一件、去掉一件各是一步', () => {
    addUpheaval({ year: 1600, ops: [SINK] });
    addUpheaval({ year: 1800, ops: [VOLC] });
    removeUpheaval(0);
    expect(getEdits().upheavals).toEqual([{ year: 1800, ops: [VOLC] }]);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([
      { year: 1600, ops: [SINK] },
      { year: 1800, ops: [VOLC] },
    ]);
    expect(undoLastEdit()).toBe(true);
    expect(undoLastEdit()).toBe(true);
    expect('upheavals' in getEdits()).toBe(false);
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([{ year: 1600, ops: [SINK] }]);
  });

  it('撤销 / 重做:一模一样的两件各算各的', () => {
    const U = { year: 1800, ops: [VOLC] };
    addUpheaval(U);
    addUpheaval(U);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([U]);
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([U, U]);
    removeUpheaval(1);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([U, U]);
    // 同一年先后放了 A、B、A(笔按先后套,顺序要紧):撤销最后一件,留下的是前面的 A、B
    clearEdits();
    const B = { year: 1800, ops: [SINK] };
    addUpheaval(U);
    addUpheaval(B);
    addUpheaval(U);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().upheavals).toEqual([U, B]);
  });
});

describe('地形大事 · 卡片和地图上的笔', () => {
  beforeEach(() => {
    closeUpheaval();
    openUpheaval();
  });

  it('打开时从火山喷发开始,什么也没放;各种大小夹在范围里', () => {
    const ui = getUpUi();
    expect(ui.on).toBe(true);
    expect(ui.kind).toBe('volcano');
    expect(ui.ops).toEqual([]);
    expect(ui.size.sink).toBe(UP_SIZE.sink[2]);
    setUpSize('sink', 999);
    expect(getUpUi().size.sink).toBe(UP_SIZE.sink[1]);
    setUpSize('raise', 0);
    expect(getUpUi().size.raise).toBe(UP_SIZE.raise[0]);
  });

  it('火山喷发点一下放一座;按下拖动不归它管(地图照常平移)', () => {
    expect(upDown([10, 10], 0)).toBe(false);
    expect(upClick([300.4, 199.6])).toBe(true);
    expect(getUpUi().ops).toEqual([{ kind: 'volcano', pts: [300, 200], r: UP_SIZE.volcano[2], s: 1.1 }]);
  });

  it('涂的两种按住拖动涂一笔:点和点隔开小半个半径,松开的地方补上;单击不放东西', () => {
    setUpKind('sink');
    setUpSize('sink', 40);
    expect(upDown([100, 100], 0)).toBe(true);
    upMove([105, 100]); // 不到一步(半径的 0.4 = 16),不记
    upMove([120, 100]);
    upMove([150, 100]);
    upMove([152, 100]);
    upUp();
    expect(getUpUi().ops).toEqual([{ kind: 'sink', pts: [100, 100, 120, 100, 150, 100, 152, 100], r: 40, s: 1.1 }]);
    expect(upClick([10, 10])).toBe(true);
    expect(getUpUi().ops).toHaveLength(1);
  });

  it('右键、没开卡片不涂;第二根手指紧跟着按下 = 想捏合,这一笔不算', () => {
    setUpKind('raise');
    expect(upDown([0, 0], 2)).toBe(false);
    expect(upDown([0, 0], 0)).toBe(true);
    expect(upCancel()).toBe(true);
    upUp();
    expect(getUpUi().ops).toEqual([]);
    closeUpheaval();
    expect(upDown([0, 0], 0)).toBe(false);
    expect(upClick([0, 0])).toBe(false);
  });

  it('撤销最后一笔、全部清除;最多几笔;关上就不要了', () => {
    for (let i = 0; i < UPHEAVAL_OPS_MAX + 3; i++) upClick([i * 10, 0]);
    expect(getUpUi().ops).toHaveLength(UPHEAVAL_OPS_MAX);
    undoUpOp();
    expect(getUpUi().ops).toHaveLength(UPHEAVAL_OPS_MAX - 1);
    clearUpOps();
    expect(getUpUi().ops).toEqual([]);
    upClick([1, 1]);
    closeUpheaval();
    expect(getUpUi().on).toBe(false);
    expect(getUpUi().ops).toEqual([]);
  });

  it('年份跟着时间轴,夹在第 1 年到结束前一年;名字:只有一种 = 那一种,几种都有 = 地形大事', () => {
    expect(upYear(1600.8, 3000)).toBe(1600);
    expect(upYear(0, 3000)).toBe(1);
    expect(upYear(null, 3000)).toBe(2999);
    expect(upYear(5000, 2500)).toBe(2499);
    expect(upheavalName({ ops: [SINK, SINK] })).toBe('海水漫进来');
    expect(upheavalName({ ops: [VOLC] })).toBe('火山喷发');
    expect(upheavalName({ ops: [SINK, VOLC] })).toBe('地形大事');
  });
});

describe('地形大事 · 地图上的形状', () => {
  it('一笔的外轮廓:一个点 = 一圈圆,轮廓上的点离圆心约一个半径', () => {
    const loops = bandOutline([{ pts: [50, 50], r: 10 }]);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    for (let i = 0; i < l.length; i += 2) expect(Math.abs(Math.hypot(l[i] - 50, l[i + 1] - 50) - 10)).toBeLessThan(0.2);
  });

  it('几笔叠在一起合成一圈,隔得远的各一圈', () => {
    expect(bandOutline([{ pts: [0, 0, 30, 0], r: 10 }, { pts: [25, 5], r: 12 }])).toHaveLength(1);
    expect(bandOutline([{ pts: [0, 0], r: 10 }, { pts: [100, 0], r: 10 }])).toHaveLength(2);
    expect(bandOutline([])).toEqual([]);
  });

  it('地块的样子:围着它的三角形重心连成一块;外圈的边只在选中和没选中的地块之间', () => {
    // 3 × 3 的格点,每个方格切成两个三角形;中间那个点被六个三角形围着
    const x: number[] = [];
    const y: number[] = [];
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        x.push(i * 10);
        y.push(j * 10);
      }
    const T: number[] = [];
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const a = j * 3 + i;
        T.push(a, a + 1, a + 4, a, a + 4, a + 3);
      }
    const mesh = { x: Float64Array.from(x), y: Float64Array.from(y), triangles: Uint32Array.from(T), width: 1000 };
    const { polys, edges } = cellShapes(mesh as never, [4]);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(12);
    // 中间那个点连出去的 6 条边各被两个三角形夹着:每条一段
    expect(edges).toHaveLength(6 * 4);
    expect(cellShapes(mesh as never, [])).toEqual({ polys: [], edges: [] });
  });
});

/** 一张小主图(东西相连):各字段按位置填 */
function raster(W: number, H: number): Raster {
  const n = W * H;
  const f = (k: number) => Float32Array.from({ length: n }, (_, i) => (i % W) * k + Math.floor(i / W));
  return {
    w: W,
    h: H,
    scale: 1,
    elev: f(10),
    temp: f(0.5),
    precip: f(0.01),
    water: new Uint8Array(n),
    biome: new Uint8Array(n).fill(3),
    cell: Int32Array.from({ length: n }, (_, i) => i),
    ice: new Float32Array(n),
    iceConc: new Uint8Array(n),
    iceTone: new Uint8Array(n),
    gully: new Float32Array(n),
  } as unknown as Raster;
}

describe('地形大事 · 主图补丁', () => {
  it('只交回变了的那一块(框可以跨过右边接回左边);贴回去和后一张一样', () => {
    const a = raster(16, 8);
    const b = composeRaster(a, []);
    expect(b).toBe(a);
    const c = { ...a, elev: a.elev.slice(), water: a.water.slice(), biome: a.biome.slice() };
    for (const [x, y] of [
      [15, 2],
      [0, 3],
      [1, 4],
    ]) {
      c.elev[y * 16 + x] += 50;
      c.water[y * 16 + x] = 1;
    }
    c.biome[5 * 16 + 14] = 7;
    const p = diffRaster(a, c)!;
    expect(p).not.toBeNull();
    expect(p.w).toBeLessThan(16);
    expect(p.h).toBeLessThan(8);
    const d = composeRaster(a, [p]);
    expect(Array.from(d.elev)).toEqual(Array.from(c.elev));
    expect(Array.from(d.water)).toEqual(Array.from(c.water));
    expect(Array.from(d.biome)).toEqual(Array.from(c.biome));
    expect(d.cell).toBe(a.cell);
    // 原来那张不动
    expect(a.water.every((v) => v === 0)).toBe(true);
  });

  it('一个像素也没变 = 没有补丁;小到看不出来的差别不算', () => {
    const a = raster(8, 4);
    expect(diffRaster(a, a)).toBeNull();
    const b = { ...a, elev: a.elev.map((v) => v + 0.2), temp: a.temp.map((v) => v + 0.01) };
    expect(diffRaster(a, b)).toBeNull();
  });
});

describe('地形大事 · 地图跟着时间轴换段', () => {
  const R = (count: number) => ({ count, name: [], of: new Int32Array(0) }) as unknown as Civ['regions'];
  const civOf = (eraCounts: number[], last: number, years: number[]): Civ =>
    ({
      endYear: 3000,
      habitat: { last: true },
      regions: R(last),
      places: { last: true },
      routes: [],
      upheavals: years.map((year) => ({ year })),
      eras: eraCounts.map((c) => ({ habitat: { era: c }, regions: R(c), places: { era: c }, routes: [] })),
    }) as unknown as Civ;

  it('第几段:大事那一年就算"以后";没有大事 = 0;不给年份 = 结束年份', () => {
    const civ = civOf([10, 10], 11, [1600, 2000]);
    expect(eraIndex(civ, 1599.9)).toBe(0);
    expect(eraIndex(civ, 1600)).toBe(1);
    expect(eraIndex(civ, 2500)).toBe(2);
    expect(eraIndex(civ, null)).toBe(2);
    expect(eraIndex({ endYear: 3000 } as Civ, 1700)).toBe(0);
  });

  it('各段的历史:宜居度、州、地名、道路换成那一段的,同一段只拼一次;最后一段 = 原样', () => {
    const civ = civOf([10, 10], 11, [1600, 2000]);
    const e0 = civAtEra(civ, 0);
    expect(e0.places).toBe(civ.eras![0].places);
    expect(e0.habitat).toBe(civ.eras![0].habitat);
    expect(civAtEra(civ, 0)).toBe(e0);
    expect(civAtEra(civ, 2)).toBe(civ);
    expect(baseRegions(civ)).toBe(civ.eras![0].regions);
  });

  it('重推回来的文明沿用原来的州:大事以前那一份总是沿用;大事一样时各段、最后一段也沿用', () => {
    const old = civOf([10], 11, [1600]);
    const same = reuseRegions(old, civOf([10], 11, [1600]), true);
    expect(same.regions).toBe(old.regions);
    expect(same.eras![0].regions).toBe(old.eras![0].regions);
    expect(same.eras![0].habitat).toBe(old.eras![0].habitat);
    const changed = reuseRegions(old, civOf([10, 11], 12, [1600, 1800]), false);
    expect(changed.eras![0].regions).toBe(old.eras![0].regions);
    expect(changed.eras![0].habitat).toBe(old.eras![0].habitat);
    expect(changed.regions).not.toBe(old.regions);
    // 大事都撤销了:州和宜居度就是原来的那一份
    const none = reuseRegions(old, { ...civOf([], 10, []), upheavals: undefined, eras: undefined } as unknown as Civ, false);
    expect(none.regions).toBe(old.eras![0].regions);
    expect(none.habitat).toBe(old.eras![0].habitat);
  });

  it('各段的世界跟着主图:补丁还没到的段先用前一段的世界和主图;都到了 = 那一段的,同样的补丁拼出同一个对象', () => {
    dropComposed();
    const base = { world: { id: 0 } as unknown as World, raster: raster(8, 4) };
    const maps: EraMaps = { baseKey: 'k0', keys: ['k1', 'k2'], worlds: [{ id: 1 }, { id: 2 }] as unknown as World[] };
    const patches = new Map<string, RasterPatch | null>();
    expect(eraData(base, maps, patches, 0)).toBe(base);
    expect(eraData(base, maps, patches, 2)).toBe(base);
    expect(eraReady(maps, patches, 2)).toBe(false);
    expect(eraShown(maps, patches, 2)).toBe(0);
    // 第一件没改主图(没有补丁),第二件的还没到:地图上先画第 1 段(历史也按第 1 段)
    patches.set(patchKey('k0', 'k1'), null);
    expect(eraShown(maps, patches, 2)).toBe(1);
    expect(eraShown(null, patches, 2)).toBe(0);
    const d1 = eraData(base, maps, patches, 2);
    expect(d1.world).toBe(maps.worlds[0]);
    expect(d1.raster).toBe(base.raster);
    expect(eraReady(maps, patches, 1)).toBe(true);
    expect(eraReady(maps, patches, 2)).toBe(false);
    const c = { ...base.raster, water: base.raster.water.slice() };
    c.water[3] = 1;
    patches.set(patchKey('k1', 'k2'), diffRaster(base.raster, c));
    const d2 = eraData(base, maps, patches, 2);
    expect(d2.world).toBe(maps.worlds[1]);
    expect(Array.from(d2.raster.water)).toEqual(Array.from(c.water));
    expect(eraData(base, maps, patches, 2)).toBe(d2);
    expect(eraShown(maps, patches, 2)).toBe(2);
    expect(eraReady(maps, patches, 2)).toBe(true);
    expect(eraReady(null, patches, 2)).toBe(true);
  });
});
