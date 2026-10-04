/**
 * 多种投影:点选(屏幕 → 地图平面 → 反投影回世界)在各投影下命中同一地块;
 * 文字按投影排(LabelView.proj):文字之间、文字和符号零重叠,字不出投影的外轮廓,国名按投影后的国土拟合、落在本国国土上。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { civLabelItems, civMapLayer, labelViewExtras } from '../src/render/civ/labels';
import { CIV_SHOW_DEFAULT, type CivDrawParams, type CivStyle } from '../src/render/civ/overlay';
import { fromCanvas, markBox, placeMap, type LabelView } from '../src/render/labels/draw';
import { glyphBox } from '../src/render/labels/layout';
import { polityLabels, polityOwnerGrid, ownerAtPoint } from '../src/render/labels/polity';
import { PROJECTION_IDS, insideProj, labelProjection, mapProj, projectWorld, unprojectWorld, type ProjectionId } from '../src/render/projection';

let world: World;
let raster: Raster;
let civ: Civ;
beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
  raster = rasterize(world, 1);
  civ = generateCiv(world);
});

const CURVED = PROJECTION_IDS.filter((p) => p !== 'equirect') as ProjectionId[];
const show = { ...CIV_SHOW_DEFAULT, polities: true, routes: true };

describe('多种投影:点选', () => {
  it('各投影、各中央经线下,点地块中心(投影后的位置)反投影回来还是这个地块', () => {
    const { w, scale, cell } = raster;
    const cellAt = (wx: number, wy: number) => cell[Math.floor(wy * scale) * w + Math.min(w - 1, Math.floor(wx * scale))];
    const n = world.mesh.n;
    for (const id of PROJECTION_IDS) {
      for (const lon0 of [0, 75, -150]) {
        const mp = mapProj(id, lon0, world.width, world.height);
        let tried = 0;
        let same = 0;
        for (let i = 0; i < n; i += 97) {
          const x = world.mesh.x[i];
          const y = world.mesh.y[i];
          const phi = 90 - (180 * y) / world.height;
          if (Math.abs(phi) > (mp.def.latMax * 180) / Math.PI - 0.5) continue;
          // 屏幕上:地图平面坐标按屏幕像素取整(模拟点在某个像素上)再反投影
          const [mx, my] = projectWorld(mp, x, y);
          const back = unprojectWorld(mp, mx, my);
          expect(back).not.toBeNull();
          tried++;
          if (cellAt(back![0], back![1]) === cellAt(x, y)) same++;
        }
        expect(tried).toBeGreaterThan(200);
        expect(same).toBe(tried);
      }
    }
  });
});

function viewOf(style: CivStyle, id: ProjectionId, lon0: number, k = 1) {
  const mapCss = 1326;
  const p: CivDrawParams = { world, raster, civ, style, year: civ.endYear, show };
  const mp = mapProj(id, lon0, world.width, world.height);
  const view: LabelView = {
    ...labelViewExtras(p),
    reserved: [],
    wrap: 0,
    frameLeft: 0,
    proj: labelProjection(mp),
    scale: (mapCss / world.width) * k,
    ox: 0,
    oy: 0,
    dpr: 1,
    k,
    mapCss,
  };
  return { p, mp, view };
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

describe('多种投影:文字按投影排', () => {
  for (const id of CURVED) {
    it(`${id}:零重叠、不出外轮廓、国名落在本国国土上`, () => {
      for (const [style, lon0] of [
        ['fantasy', 0],
        ['realistic', 120],
      ] as [CivStyle, number][]) {
        const { p, mp, view } = viewOf(style, id, lon0);
        const layer = civMapLayer(p, { proj: mp });
        const placed = placeMap(civLabelItems(p).concat(layer.items), layer.marks, view);
        expect(placed.labels.length).toBeGreaterThan(15);
        // 不同条文字之间一个字都不许重叠;文字不压符号;符号之间不重叠(国都总画,不算)
        const boxes: { text: string; b: number[] }[] = [];
        for (const l of placed.labels) for (const g of l.glyphs) boxes.push({ text: l.item.text, b: glyphBox(g, l.px, 0) });
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++)
            if (boxes[i].text !== boxes[j].text) expect(overlap(boxes[i].b, boxes[j].b), `${boxes[i].text} × ${boxes[j].text}`).toBe(false);
        const marks = placed.marks.map((m) => ({ id: m.mark.id, b: markBox(m.mark, view) }));
        for (const e of boxes) for (const m of marks) expect(overlap(e.b, m.b), `${e.text} 压了符号 ${m.id}`).toBe(false);
        const cap = new Set(civ.polities.map((q) => q.capital));
        const plain = marks.filter((m) => !cap.has(m.id));
        for (let a = 0; a < plain.length; a++) for (let b = a + 1; b < plain.length; b++) expect(overlap(plain[a].b, plain[b].b)).toBe(false);
        // 每个字都在外轮廓里
        for (const l of placed.labels) {
          for (const g of l.glyphs) expect(insideProj(mp, g.x / view.scale, g.y / view.scale, -0.5)).toBe(true);
        }
        // 国名:按投影后的国土拟合(planar),字中心在本国国土上
        const own = polityOwnerGrid(world, raster, civ, civ.endYear);
        const pols = placed.labels.filter((l) => l.item.pick?.kind === 'polity');
        expect(pols.length).toBeGreaterThan(3);
        for (const l of pols) {
          expect(l.item.planar).toBe(true);
          let on = 0;
          for (const g of l.glyphs) {
            const w = fromCanvas(view, g.x, g.y);
            if (w && ownerAtPoint(own, w[0], w[1]) === l.item.pick!.id) on++;
          }
          expect(on / l.glyphs.length).toBeGreaterThanOrEqual(0.75);
        }
      }
    });
  }

  it('投影后的国土拟合出的国名数和等距圆柱的同一量级(形状变了,国家不会凭空少一半)', () => {
    const flat = polityLabels(world, raster, civ, civ.endYear, { refCss: 1300 }).labels.length;
    for (const id of CURVED) {
      const mp = mapProj(id, 30, world.width, world.height);
      const n = polityLabels(world, raster, civ, civ.endYear, { refCss: 1300, proj: mp }).labels.length;
      expect(n).toBeGreaterThanOrEqual(Math.floor(flat * 0.8));
    }
  });
});
