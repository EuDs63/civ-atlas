/**
 * 地球仪上的文字:和平面主图同一套排版(placeMap),世界坐标按正射投影换成屏幕位置(render/globeLabels.ts)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { civLabelItems, civMapLayer, labelSurface } from '../src/render/civ/labels';
import { CIV_SHOW_DEFAULT, type CivDrawParams } from '../src/render/civ/overlay';
import { placeMap, placedMarkBox, pathToCanvas } from '../src/render/labels/draw';
import { Polyline, glyphBox } from '../src/render/labels/layout';
import { GLYPH_MIN_D, MARK_MIN_D, globeLabelView, globeToCanvas, isQuickLabel, visibleMarks } from '../src/render/globeLabels';

let world: World;
let raster: Raster;
let civ: Civ;
beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
  raster = rasterize(world, 1);
  civ = generateCiv(world);
});

const D = Math.PI / 180;
const W = 1250;
const H = 848;
const DPR = 2;

function setup(lon: number, lat: number, k: number) {
  const p: CivDrawParams = { world, raster, civ, style: 'fantasy', year: civ.endYear, show: { ...CIV_SHOW_DEFAULT, polities: true, routes: true } };
  const lv = globeLabelView({ view: { lon: lon * D, lat: lat * D, k }, w: W, h: H, dpr: DPR, worldW: world.width, worldH: world.height, surface: labelSurface(world, raster, 1) });
  const layer = civMapLayer(p);
  const items = civLabelItems(p).concat(layer.items);
  return { p, lv, layer, items };
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

describe('地球仪文字:投影', () => {
  it('正面的点投过去再反投影回来还是原处;背面的点翻到球的轮廓外面', () => {
    const { lv } = setup(115, 15, 1.5);
    const P = lv.proj!;
    let front = 0;
    let back = 0;
    for (let i = 0; i < world.mesh.n; i += 53) {
      const x = world.mesh.x[i];
      const y = world.mesh.y[i];
      const [cx, cy, d] = globeToCanvas(lv, x, y);
      const [mx, my] = P.fwd(x, y);
      // 地图平面 → 画布
      const px = mx * lv.scale + lv.ox;
      const py = my * lv.scale + lv.oy;
      const r = Math.hypot(px - lv.globe.cx, py - lv.globe.cy) / lv.globe.R;
      if (d > 0.01) {
        front++;
        expect(Math.hypot(px - cx, py - cy)).toBeLessThan(1e-6);
        const b = P.inv(mx, my)!;
        expect(b).not.toBeNull();
        const dx = Math.abs(((b[0] - x + world.width * 1.5) % world.width) - world.width / 2);
        expect(dx + Math.abs(b[1] - y)).toBeLessThan(1e-6);
      } else if (d < -0.01) {
        back++;
        expect(r).toBeGreaterThan(1);
        expect(P.inside(mx, my, 0)).toBe(false);
      }
    }
    expect(front).toBeGreaterThan(100);
    expect(back).toBeGreaterThan(100);
  });
});

describe('地球仪文字:排版', () => {
  for (const [lon, lat, k] of [
    [115, 15, 1],
    [115, 15, 2.5],
    [-60, 10, 3],
    [180, 55, 2],
  ] as [number, number, number][]) {
    it(`视图 ${lon},${lat},${k}:不重叠、不压符号、字都在球的正面、符号朝着观察者`, () => {
      const { lv, layer, items } = setup(lon, lat, k);
      const vm = visibleMarks(layer.marks, lv);
      const placed = placeMap(items, vm.marks, lv);
      expect(placed.labels.length).toBeGreaterThan(8);
      const boxes: { text: string; b: number[] }[] = [];
      for (const l of placed.labels) for (const g of l.glyphs) boxes.push({ text: l.item.text, b: glyphBox(g, l.px, 0) });
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          if (boxes[i].text !== boxes[j].text) expect(overlap(boxes[i].b, boxes[j].b), `${boxes[i].text} × ${boxes[j].text}`).toBe(false);
      const cap = new Set(civ.polities.map((q) => q.capital));
      const mboxes = placed.marks.map((m) => ({ id: m.mark.id, b: placedMarkBox(m) }));
      for (const e of boxes) for (const m of mboxes) expect(overlap(e.b, m.b), `${e.text} 压了符号 ${m.id}`).toBe(false);
      const plain = mboxes.filter((m) => !cap.has(m.id));
      for (let a = 0; a < plain.length; a++) for (let b = a + 1; b < plain.length; b++) expect(overlap(plain[a].b, plain[b].b)).toBe(false);
      // 每个字的四个角都在球的正面(离轮廓还有一点)、在画布里
      const { cx, cy, R } = lv.globe;
      const rmax = Math.sqrt(1 - GLYPH_MIN_D * GLYPH_MIN_D) + 1e-9;
      for (const e of boxes) {
        for (const [x, y] of [
          [e.b[0], e.b[1]],
          [e.b[2], e.b[1]],
          [e.b[0], e.b[3]],
          [e.b[2], e.b[3]],
        ]) {
          expect(Math.hypot(x - cx, y - cy) / R, e.text).toBeLessThanOrEqual(rmax);
          expect(x >= 0 && y >= 0 && x <= W * DPR && y <= H * DPR, e.text).toBe(true);
        }
      }
      // 符号都朝着观察者
      for (const m of placed.marks) {
        const [, , d] = globeToCanvas(lv, m.mark.x, m.mark.y);
        expect(d).toBeGreaterThanOrEqual(MARK_MIN_D - 1e-9);
      }
    });
  }

  it('放大以后出现山名、河名,字挨着自己那条河 / 山脊(和平面主图同一条)', () => {
    let rivers = 0;
    let mountains = 0;
    for (const [lon, lat, k] of [
      [115, 15, 2.5],
      [100, 10, 3],
      [-60, 10, 3],
      [150, -20, 3],
      [0, -40, 3],
      [60, 30, 3],
    ] as [number, number, number][]) {
      const { lv, layer, items } = setup(lon, lat, k);
      const placed = placeMap(items, visibleMarks(layer.marks, lv).marks, lv);
      for (const l of placed.labels) {
        const pk = l.item.pick;
        if (pk?.kind !== 'place') continue;
        const kind = civ.places[pk.id].kind;
        if (kind !== 'river' && kind !== 'mountains') continue;
        if (kind === 'river') rivers++;
        else mountains++;
        // 每个字离这条河 / 山脊(投影到屏幕上)不远:河名排在河的一侧,山名压在山脊上
        const path = new Polyline(pathToCanvas(l.item.path, lv));
        for (const g of l.glyphs) expect(path.distance(g.x, g.y), l.item.text).toBeLessThan(l.px * 3);
      }
    }
    expect(rivers).toBeGreaterThan(0);
    expect(mountains).toBeGreaterThan(0);
  });

  it('放大以后出现的地名更多(按缩放分级)', () => {
    const count = (k: number) => {
      const { lv, layer, items } = setup(115, 15, k);
      return placeMap(items, visibleMarks(layer.marks, lv).marks, lv).labels.length;
    };
    expect(count(2.5)).toBeGreaterThan(count(1));
  });

  it('转动时只排大字:国名、大洋和海、国都和大城的名字', () => {
    const { items } = setup(115, 15, 1);
    const quick = items.filter(isQuickLabel);
    expect(quick.length).toBeGreaterThan(5);
    expect(quick.length).toBeLessThan(items.length / 2);
    for (const it of quick) {
      const pk = it.pick!;
      if (pk.kind === 'place') expect(civ.places[pk.id].kind).toBe('sea');
    }
    expect(quick.some((it) => it.pick?.kind === 'polity')).toBe(true);
  });
});
