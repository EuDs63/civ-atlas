/**
 * 地图文字(世界东西相连):视窗是"展开"的(中心可以转到任意经度),
 * 跨 180° 经线的国名、海名照常排成一条;国名拟合网格左右相接;转一整圈排出来和原来一样。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { ownersAt } from '../src/gen/civ/timeline';
import { civLabelItems, civMapLayer, labelViewExtras } from '../src/render/civ/labels';
import { CIV_SHOW_DEFAULT, type CivDrawParams, type CivStyle } from '../src/render/civ/overlay';
import { placedMarkBox, placeMap, type LabelView, type Placement } from '../src/render/labels/draw';
import { ownerAtPoint, territoryField, territoryGrid, type TerritoryGrid } from '../src/render/labels/polity';
import { glyphBox } from '../src/render/labels/layout';

interface Case {
  world: World;
  raster: Raster;
  civ: Civ;
}
const cases = new Map<number, Case>();

beforeAll(() => {
  for (const seed of [7, 2024, 1]) {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed });
    const raster = rasterize(world, 1);
    const civ = generateCiv(world);
    cases.set(seed, { world, raster, civ });
  }
}, 120_000);

const show = { ...CIV_SHOW_DEFAULT, polities: true, routes: true };
const MAP_CSS = 1326;

function paramsOf(c: Case, style: CivStyle): CivDrawParams {
  return { world: c.world, raster: c.raster, civ: c.civ, style, year: c.civ.endYear, show };
}

/**
 * 视窗中心在世界 x = cx(展开的,可以超出 [0, 宽)),放大 k 倍,画布 = 地图 k = 1 时那么大(MAP_CSS × MAP_CSS / 2)。
 * 外框(不随平移)和画布同心:k = 1 时正好一整圈、外框 = 画布
 */
function viewAt(c: Case, style: CivStyle, cx: number, k = 1): LabelView {
  const W = c.world.width;
  const H = c.world.height;
  const scale = (MAP_CSS / W) * k;
  const frameLeft = cx - W / 2;
  const extras = labelViewExtras(paramsOf(c, style), frameLeft);
  const cw = MAP_CSS;
  const ch = MAP_CSS / 2;
  return { ...extras, frameLeft, scale, ox: cw / 2 - cx * scale, oy: ch / 2 - (H / 2) * scale, dpr: 1, k, mapCss: MAP_CSS, canvasW: cw, canvasH: ch };
}

function place(c: Case, style: CivStyle, cx: number, k = 1): Placement {
  const p = paramsOf(c, style);
  const layer = civMapLayer(p);
  return placeMap(civLabelItems(p).concat(layer.items), layer.marks, viewAt(c, style, cx, k));
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 跨 180° 经线的国家(最左一列和最右一列同一行都是它的国土),按州数从大到小 */
function seamPolities(c: Case): number[] {
  const grid = territoryGrid(c.world, c.raster, c.civ);
  const own = ownersAt(c.civ, c.civ.endYear);
  const n = new Map<number, number>();
  for (let gy = 0; gy < grid.gh; gy++) {
    const a = grid.region[gy * grid.gw];
    const b = grid.region[gy * grid.gw + grid.gw - 1];
    if (a < 0 || b < 0) continue;
    const pa = own.polity[a];
    if (pa >= 0 && pa === own.polity[b]) n.set(pa, (n.get(pa) ?? 0) + 1);
  }
  const size = new Int32Array(c.civ.polities.length);
  for (let r = 0; r < own.polity.length; r++) if (own.polity[r] >= 0) size[own.polity[r]]++;
  return [...n.keys()].sort((a, b) => size[b] - size[a]);
}

describe('地图文字(展开的视窗)', () => {
  it('国名拟合网格左右相接:整张网格左右转一段,离界距离跟着转、数值不变', () => {
    const c = cases.get(7)!;
    const grid = territoryGrid(c.world, c.raster, c.civ);
    expect(grid.wrap).toBe(true);
    const own = ownersAt(c.civ, c.civ.endYear).polity;
    const f0 = territoryField(grid, own);
    const S = 137;
    const { gw, gh } = grid;
    const region = new Int16Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) region[y * gw + ((x + S) % gw)] = grid.region[y * gw + x];
    const shifted: TerritoryGrid = { ...grid, region };
    const f1 = territoryField(shifted, own);
    let worst = 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) worst = Math.max(worst, Math.abs(f1.dist[y * gw + ((x + S) % gw)] - f0.dist[y * gw + x]));
    expect(worst).toBeLessThan(1e-3);
    // 查归属:x 差一整圈是同一格
    const W = c.world.width;
    for (const [wx, wy] of [[3, 500], [W - 2, 300], [1024, 600]]) expect(ownerAtPoint(f0, wx + W, wy)).toBe(ownerAtPoint(f0, wx, wy));
  });

  // 这两个世界都有跨 180° 经线的国家,国名正好骑在 180° 经线上
  for (const seed of [2024, 1]) {
    for (const style of ['fantasy', 'realistic'] as const) {
      it(`seed ${seed} · ${style}:视窗中心转到 180° 经线,跨接缝的国家国名只出现一次、完整、落在本国国土上`, () => {
        const c = cases.get(seed)!;
        const W = c.world.width;
        const seam = seamPolities(c);
        expect(seam.length, '这个世界要有跨 180° 经线的国家').toBeGreaterThan(0);
        const field = territoryField(territoryGrid(c.world, c.raster, c.civ), ownersAt(c.civ, c.civ.endYear).polity);
        let checked = 0;
        let crosses = false;
        for (const k of [1, 2]) {
          const view = viewAt(c, style, 0, k);
          const placed = place(c, style, 0, k);
          for (const id of seam.slice(0, 3)) {
            const ls = placed.labels.filter((l) => l.item.pick?.kind === 'polity' && l.item.pick.id === id);
            expect(ls.length, `国家 ${id} 的国名出现了 ${ls.length} 次`).toBeLessThanOrEqual(1);
            if (!ls.length) continue;
            const l = ls[0];
            expect(l.glyphs.length).toBe([...l.item.text].length);
            // 每个字的中心都在本国国土上(画布像素 → 展开的世界坐标)
            const wx = l.glyphs.map((g) => (g.x - view.ox) / view.scale);
            for (let i = 0; i < wx.length; i++) expect(ownerAtPoint(field, wx[i], (l.glyphs[i].y - view.oy) / view.scale)).toBe(id);
            // 字跨在 180° 经线两边(展开坐标里 x 有正有负):这条国名本来会被接缝劈开
            if (Math.min(...wx) < 0 && Math.max(...wx) > 0) crosses = true;
            checked++;
          }
        }
        expect(checked, '最大的几个跨接缝国家里至少有一个国名排得下').toBeGreaterThan(0);
        expect(crosses, '有国名骑在 180° 经线上').toBe(true);
      });
    }
  }

  it('转一整圈回到原处:中心差一整圈,排出来的文字、符号一模一样', () => {
    const c = cases.get(7)!;
    const W = c.world.width;
    for (const cx of [W / 2, 0, W * 0.3]) {
      const a = place(c, 'fantasy', cx);
      const b = place(c, 'fantasy', cx + W);
      expect(b.labels.map((l) => l.item.text)).toEqual(a.labels.map((l) => l.item.text));
      expect(b.marks.map((m) => [m.mark.id, Math.round(m.x * 100), Math.round(m.y * 100)])).toEqual(a.marks.map((m) => [m.mark.id, Math.round(m.x * 100), Math.round(m.y * 100)]));
      const gl = (p: Placement) => p.labels.flatMap((l) => l.glyphs.map((g) => Math.round(g.x * 100) + ',' + Math.round(g.y * 100)));
      expect(gl(b)).toEqual(gl(a));
    }
  });

  it('换中心以后文字之间、文字和符号之间照样零重叠;地名、城名只出现一次', () => {
    const c = cases.get(2024)!;
    const W = c.world.width;
    for (const cx of [W / 2, W * 0.75, 0]) {
      const placed = place(c, 'fantasy', cx);
      const boxes: { text: string; b: number[] }[] = [];
      for (const pl of placed.labels) for (const g of pl.glyphs) boxes.push({ text: pl.item.text, b: glyphBox(g, pl.px, 0) });
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          if (boxes[i].text !== boxes[j].text) expect(overlap(boxes[i].b, boxes[j].b), `${boxes[i].text} × ${boxes[j].text}(中心 ${cx})`).toBe(false);
      const marks = placed.marks.map((m) => placedMarkBox(m));
      for (const e of boxes) for (const m of marks) expect(overlap(e.b, m)).toBe(false);
      const picks = placed.labels.map((l) => `${l.item.pick?.kind}:${l.item.pick?.id}`);
      expect(new Set(picks).size).toBe(picks.length);
      const ids = placed.marks.map((m) => m.mark.id);
      expect(new Set(ids).size).toBe(ids.length);
      // 都在画布里(一整圈宽)
      for (const e of boxes) expect(e.b[0] >= -1 && e.b[2] <= MAP_CSS + 1).toBe(true);
    }
  });
});
