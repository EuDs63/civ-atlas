/**
 * 地理实体识别(places.ts)+ 文字排版避让(render/labels)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { findPlaces, worldNameStyle } from '../src/gen/civ/places';
import { NAME_STYLES } from '../src/gen/names';
import { placeLabelItems, labelViewExtras } from '../src/render/civ/labels';
import { CIV_SHOW_DEFAULT } from '../src/render/civ/overlay';
import { glyphBox } from '../src/render/labels/layout';
import { placeLabels, type LabelView } from '../src/render/labels/draw';
import { geometryOf } from '../src/gen/geometry';

let world: World;
let raster: Raster;
let civ: Civ;

beforeAll(() => {
  // seed 2024:六类地理实体都有(seed 7 没有大荒漠)
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 2024 });
  raster = rasterize(world, 1);
  civ = generateCiv(world);
});

/** 模拟截图时的视口:地图按 1326 CSS 像素宽显示,放大 k 倍,视口盖住整张图 */
function viewFor(style: 'fantasy' | 'realistic', k: number): LabelView {
  const mapCss = 1326;
  const extras = labelViewExtras({ world, raster, civ, style, year: civ.endYear, show: CIV_SHOW_DEFAULT });
  return { ...extras, scale: (mapCss / world.width) * k, ox: 0, oy: 0, dpr: 1, k, mapCss };
}

describe('地理实体(places.ts)', () => {
  it('六类都找得到,名字不重复,路径数值合法、上下在两极之间(跨 180° 经线的见下面)', () => {
    const kinds = new Set(civ.places.map((p) => p.kind));
    for (const k of ['sea', 'mountains', 'river', 'lake', 'island', 'desert']) expect(kinds.has(k as never), k).toBe(true);
    const names = civ.places.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of civ.places) {
      expect(p.path.length % 2).toBe(0);
      expect(p.path.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < p.path.length; i += 2) {
        expect(Number.isFinite(p.path[i]) && Number.isFinite(p.path[i + 1])).toBe(true);
        expect(p.path[i + 1]).toBeGreaterThanOrEqual(0);
        expect(p.path[i + 1]).toBeLessThanOrEqual(world.height);
      }
      expect([1, 2, 3]).toContain(p.rank);
      expect([...p.name].length).toBeGreaterThanOrEqual(2);
      expect([...p.name].length).toBeLessThanOrEqual(7);
    }
  });

  it('锚点落在对的地面上:海在海上,山、岛、荒漠在陆上,湖在湖里', () => {
    for (const p of civ.places) {
      const c = p.cell!;
      if (p.kind === 'sea') expect(world.water[c], p.name).toBe(1);
      else if (p.kind === 'lake') expect(world.water[c], p.name).toBe(2);
      else if (p.kind === 'mountains' || p.kind === 'desert') expect(world.water[c], p.name).toBe(0);
    }
  });

  it('海洋用中性的叫法(不带民族),名字以 洋 / 海 / 湾 结尾', () => {
    for (const p of civ.places.filter((q) => q.kind === 'sea')) {
      expect(p.culture).toBe(-1);
      expect(p.name).toMatch(/[洋海湾]$/);
    }
    expect(civ.places.filter((q) => q.kind === 'sea' && q.rank === 1).length).toBeGreaterThanOrEqual(1);
  });

  it('同一个种子两次结果一样;没有民族数据时整个世界一种语感', () => {
    // civ.places 是按各州民族的语感起的名:用同样的民族数据再算一遍,应该完全一样
    const again = findPlaces(world, civ.regions, { cultures: civ.cultures, culture: civ.culture });
    expect(again.map((p) => p.name)).toEqual(civ.places.map((p) => p.name));
    for (let i = 0; i < again.length; i++) expect(Array.from(again[i].path)).toEqual(Array.from(civ.places[i].path));
    // 不给民族数据:两次一样,地名的位置和给了民族数据时一样(只是名字的语感不同)
    const plain = findPlaces(world, civ.regions);
    expect(findPlaces(world, civ.regions).map((p) => p.name)).toEqual(plain.map((p) => p.name));
    expect(plain.length).toBe(civ.places.length);
    for (let i = 0; i < plain.length; i++) expect(Array.from(plain[i].path)).toEqual(Array.from(civ.places[i].path));
    for (const p of plain) expect(p.culture).toBe(-1);
    expect(NAME_STYLES.map((s) => s.id)).toContain(worldNameStyle(7));
  });

  it('传入民族数据后,按所在州的民族换语感', () => {
    const style = NAME_STYLES.find((s) => s.id !== worldNameStyle(7) && s.family === 'eastern')!.id;
    const culture = new Int16Array(civ.regions.count).fill(0);
    const cultures = [{ id: 0, name: '测试族', style, kind: 'farm' as const, hearth: 0, born: 0, expansionism: 1, color: [0, 0, 0] as [number, number, number] }];
    const ps = findPlaces(world, civ.regions, { cultures, culture });
    const land = ps.filter((p) => p.kind === 'mountains' || p.kind === 'river');
    expect(land.length).toBeGreaterThan(0);
    for (const p of land) expect(p.culture).toBe(0);
    for (const p of ps.filter((q) => q.kind === 'sea')) expect(p.culture).toBe(-1);
  });
});

describe('文字排版与避让(render/labels)', () => {
  for (const style of ['fantasy', 'realistic'] as const) {
    it(`${style}:缩放 1 / 2 / 4 倍时文字之间零重叠,都在图内`, () => {
      const items = placeLabelItems(civ.places, style);
      for (const k of [1, 2, 4]) {
        const view = viewFor(style, k);
        const placed = placeLabels(items, view);
        expect(placed.length).toBeGreaterThan(8);
        const boxes = placed.map((pl) => pl.glyphs.map((g) => glyphBox(g, pl.px, 0)));
        for (let a = 0; a < boxes.length; a++) {
          for (const b of boxes[a]) {
            expect(b[0]).toBeGreaterThanOrEqual(0);
            expect(b[1]).toBeGreaterThanOrEqual(0);
            expect(b[2]).toBeLessThanOrEqual(world.width * view.scale);
            expect(b[3]).toBeLessThanOrEqual(world.height * view.scale);
            for (let c = a + 1; c < boxes.length; c++) {
              for (const o of boxes[c]) {
                const overlap = o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1];
                expect(overlap, `${placed[a].item.text} × ${placed[c].item.text}(k=${k})`).toBe(false);
              }
            }
          }
        }
      }
    });
  }

  it('打开页面(缩放 1 倍)时海、山、河、湖、岛的名字都至少出现一个,放大两倍六类都有;放大后出现得更多', () => {
    const items = placeLabelItems(civ.places, 'fantasy');
    const kindsAt = (k: number) => new Set(placeLabels(items, viewFor('fantasy', k)).map((pl) => civ.places[items.indexOf(pl.item)].kind));
    const at1 = placeLabels(items, viewFor('fantasy', 1));
    const k1 = kindsAt(1);
    for (const k of ['sea', 'mountains', 'river', 'lake', 'island']) expect(k1.has(k as never), k).toBe(true);
    const k2 = kindsAt(2);
    for (const k of ['sea', 'mountains', 'river', 'lake', 'island', 'desert']) expect(k2.has(k as never), `放大两倍:${k}`).toBe(true);
    const at4 = placeLabels(items, viewFor('fantasy', 4));
    expect(at4.length).toBeGreaterThan(at1.length);
  });

  it('海名在水上、陆上的名字在陆上(不压海岸线)', () => {
    const items = placeLabelItems(civ.places, 'realistic');
    const view = viewFor('realistic', 1);
    for (const pl of placeLabels(items, view)) {
      const p = civ.places[items.indexOf(pl.item)];
      if (p.kind !== 'sea' && p.kind !== 'desert') continue;
      let bad = 0;
      for (const g of pl.glyphs) {
        const s = view.surface!(g.x / view.scale, g.y / view.scale);
        if (p.kind === 'sea' ? s !== 1 : s === 1) bad++;
      }
      expect(bad, p.name).toBe(0);
    }
  });
});

describe('地理实体 · 跨 180° 经线、两极', () => {
  const spheres: { w: World; civ: Civ }[] = [];
  beforeAll(() => {
    for (const seed of [7, 2024]) {
      const w = generateWorld({ ...DEFAULT_PARAMS, seed });
      spheres.push({ w, civ: generateCiv(w) });
    }
  }, 60_000);
  /** 世界坐标 → 经纬度(度) */
  const lonOf = (w: World, c: number) => (w.mesh.x[c] / w.width) * 360 - 180;
  const latOf = (w: World, c: number) => 90 - (w.mesh.y[c] / w.height) * 180;

  it('六类都找得到,名字不重复;标注路径连成一笔(跨 180° 经线不跳回另一头),按长度的中点落在地图里', () => {
    const kinds = new Set<string>();
    let crossing = 0;
    for (const { w, civ: c } of spheres) {
      const W = w.width;
      for (const p of c.places) kinds.add(p.kind);
      const names = c.places.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      for (const p of c.places) {
        expect(p.path.length % 2).toBe(0);
        expect(p.path.length).toBeGreaterThanOrEqual(2);
        let L = 0;
        for (let i = 0; i < p.path.length; i += 2) {
          expect(Number.isFinite(p.path[i]) && Number.isFinite(p.path[i + 1])).toBe(true);
          expect(p.path[i + 1]).toBeGreaterThanOrEqual(0);
          expect(p.path[i + 1]).toBeLessThanOrEqual(w.height);
          if (i >= 2) {
            expect(Math.abs(p.path[i] - p.path[i - 2]), p.name).toBeLessThan(W / 2);
            L += Math.hypot(p.path[i] - p.path[i - 2], p.path[i + 1] - p.path[i - 1]);
          }
        }
        // 按长度的中点
        let acc = 0;
        let xm = p.path[0];
        for (let i = 2; i < p.path.length; i += 2) {
          const l = Math.hypot(p.path[i] - p.path[i - 2], p.path[i + 1] - p.path[i - 1]);
          if (acc + l >= L / 2) {
            xm = p.path[i - 2] + (l > 0 ? ((L / 2 - acc) / l) * (p.path[i] - p.path[i - 2]) : 0);
            break;
          }
          acc += l;
        }
        expect(xm, p.name).toBeGreaterThanOrEqual(0);
        expect(xm, p.name).toBeLessThan(W);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < p.path.length; i += 2) {
          lo = Math.min(lo, p.path[i]);
          hi = Math.max(hi, p.path[i]);
        }
        if (lo < 0 || hi > W) crossing++;
        expect([1, 2, 3]).toContain(p.rank);
      }
    }
    for (const k of ['sea', 'mountains', 'river', 'lake', 'island', 'desert']) expect(kinds.has(k), k).toBe(true);
    // 两个世界里都有跨 180° 经线的山脉 / 河
    expect(crossing).toBeGreaterThanOrEqual(2);
  });

  it('锚点落在对的地面上(海、湖、荒漠),标注路径经过锚点附近(跨 180° 经线的也是:路径没有被挪到别处)', () => {
    for (const { w, civ: c } of spheres) {
      const geo = geometryOf(w.mesh);
      for (const p of c.places) {
        const a = p.cell!;
        // 山脉的锚点是山脊线中点附近的地块,山脊弯成弧时可能落在水上(平面世界也一样),这里不查
        if (p.kind === 'sea') expect(w.water[a], p.name).toBe(1);
        else if (p.kind === 'lake') expect(w.water[a], p.name).toBe(2);
        else if (p.kind === 'desert') expect(w.water[a], p.name).toBe(0);
        // 沿路径每隔约 1 个单位取样,离锚点最近的一处
        let best = Infinity;
        const P = p.path;
        if (P.length === 2) best = geo.distTo(a, P[0], P[1]);
        for (let i = 2; i < P.length; i += 2) {
          const steps = Math.max(1, Math.ceil(Math.hypot(P[i] - P[i - 2], P[i + 1] - P[i - 1])));
          for (let t = 0; t <= steps; t++) {
            const f = t / steps;
            best = Math.min(best, geo.distTo(a, P[i - 2] + (P[i] - P[i - 2]) * f, P[i - 1] + (P[i + 1] - P[i - 1]) * f));
          }
        }
        expect(best, `${p.kind} ${p.name}`).toBeLessThan(2 * w.mesh.spacing);
      }
    }
  });

  it('横排的海名沿纬线、竖排的沿经线:在主图上横平竖直', () => {
    let horizontal = 0;
    for (const { civ: c } of spheres) {
      for (const p of c.places) {
        if (p.kind !== 'sea' || p.path.length !== 6) continue;
        const flat = p.path[1] === p.path[3] && p.path[3] === p.path[5];
        const upright = p.path[0] === p.path[2] && p.path[2] === p.path[4];
        expect(flat || upright, p.name).toBe(true);
        if (flat) horizontal++;
      }
    }
    expect(horizontal).toBeGreaterThan(5);
  });

  it('大洋的方位按在主图上的位置:东大洋在东边、西大洋在西边、北 / 南在高纬度;180° 经线附近的不叫东西', () => {
    let named = 0;
    for (const { w, civ: c } of spheres) {
      const geo = geometryOf(w.mesh);
      for (const p of c.places) {
        if (p.kind !== 'sea') continue;
        const a = p.cell!;
        const lon = lonOf(w, a);
        const lat = latOf(w, a);
        const m = /^([东西南北])(大洋|海)$/.exec(p.name);
        if (!m) continue;
        named++;
        const dir = { 东: 'e', 西: 'w', 南: 's', 北: 'n' }[m[1] as '东'];
        expect(geo.mapSide(a), p.name).toBe(dir);
        if (dir === 'e') expect(lon, p.name).toBeGreaterThan(90);
        if (dir === 'w') expect(lon, p.name).toBeLessThan(-90);
        if (dir === 'e' || dir === 'w') expect(Math.abs(lon), p.name).toBeLessThanOrEqual(150);
        if (dir === 'n') expect(lat, p.name).toBeGreaterThan(35);
        if (dir === 's') expect(lat, p.name).toBeLessThan(-35);
      }
    }
    expect(named).toBeGreaterThanOrEqual(1);
  });
});
