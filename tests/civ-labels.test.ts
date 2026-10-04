/**
 * 国名、城名标注 + 城镇符号(视口文字层),东方语感的中式国号。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { ownersAt } from '../src/gen/civ/timeline';
import {
  capitalAt,
  easternTitles,
  polityAlive,
  polityAllTitles,
  polityName,
  polityRoots,
  polityShortTitle,
  polityTierAt,
  polityTitles,
  POLITY_FORMS,
} from '../src/gen/civ/growth';
import { civLabelItems, civMapLayer, labelViewExtras } from '../src/render/civ/labels';
import { CIV_SHOW_DEFAULT, type CivDrawParams, type CivStyle } from '../src/render/civ/overlay';
import { pixelRegions } from '../src/render/civ/territory';
import { markBox, MIN_LABEL_PX, placeMap, REF_MAP_CSS, type LabelView, type Placement } from '../src/render/labels/draw';
import { GRID, polityLabels } from '../src/render/labels/polity';
import { glyphBox } from '../src/render/labels/layout';
import { NAME_MIN_ZOOM, SYMBOL_MIN_ZOOM } from '../src/render/labels/settlements';

interface Case {
  world: World;
  raster: Raster;
  civ: Civ;
  pix: Int16Array;
}
const cases = new Map<number, Case>();

beforeAll(() => {
  for (const seed of [7, 2024]) {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed });
    const raster = rasterize(world, 1);
    const civ = generateCiv(world);
    cases.set(seed, { world, raster, civ, pix: pixelRegions(world.mesh, raster, civ.regions.of) });
  }
});

const show = { ...CIV_SHOW_DEFAULT, polities: true, routes: true };

function paramsOf(c: Case, style: CivStyle, year: number): CivDrawParams {
  return { world: c.world, raster: c.raster, civ: c.civ, style, year, show };
}

/** 模拟截图时的视口:地图按 1326 CSS 像素宽显示,放大 k 倍,画布盖住整张图 */
function viewOf(c: Case, style: CivStyle, k: number): LabelView {
  const mapCss = 1326;
  const extras = labelViewExtras(paramsOf(c, style, c.civ.endYear));
  return { ...extras, scale: (mapCss / c.world.width) * k, ox: 0, oy: 0, dpr: 1, k, mapCss };
}

function place(c: Case, style: CivStyle, year: number, k: number, fast = false): { placed: Placement; view: LabelView } {
  const p = paramsOf(c, style, year);
  const layer = civMapLayer(p, { fast });
  const view = viewOf(c, style, k);
  return { placed: placeMap(civLabelItems(p).concat(layer.items), layer.marks, view), view };
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 世界坐标 → 所在的州(按像素归属,和画出来的色块一致) */
function regionAt(c: Case, wx: number, wy: number): number {
  const { w, h, scale } = c.raster;
  const x = Math.floor(wx * scale);
  const y = Math.floor(wy * scale);
  if (x < 0 || y < 0 || x >= w || y >= h) return -1;
  return c.pix[y * w + x];
}

/**
 * 字中心在不在本国国土内,和排版代码用同样的精度判:排版查"字中心在国土内"用的是 GRID(4 世界单位)一格的国土栅格
 * (render/labels/polity.ts 的 territoryGrid:每格按格子中心那个像素算归属),窄海湾、碎海岸处
 * 字中心那个像素可能是水,而同一格的中心像素是本国国土。所以:字中心的像素属于本国,或 GRID 以内有本国国土的像素,都算在国土内
 */
function inTerritory(c: Case, wx: number, wy: number, own: Int16Array, id: number): boolean {
  const r = regionAt(c, wx, wy);
  if (r >= 0 && own[r] === id) return true;
  const step = 1 / c.raster.scale;
  for (let dy = -GRID; dy <= GRID; dy += step) {
    for (let dx = -GRID; dx <= GRID; dx += step) {
      if (dx * dx + dy * dy > GRID * GRID) continue;
      const q = regionAt(c, wx + dx, wy + dy);
      if (q >= 0 && own[q] === id) return true;
    }
  }
  return false;
}

describe('东方语感的中式国号', () => {
  it('单字国名:昌部 → 昌国 → 大昌 → 大昌王朝;游牧:部 → 汗国 → 大X汗国', () => {
    expect(easternTitles('昌')).toEqual(['昌部', '昌国', '大昌', '大昌王朝']);
    expect(easternTitles('渭', 'republic')).toEqual(['渭部', '渭国', '大渭', '大渭王朝']);
    expect(easternTitles('乌', 'khanate')).toEqual(['乌部', '乌汗国', '乌汗国', '大乌汗国']);
  });

  it('两个字的不硬加"大";自带"大"的不叠成"大大"', () => {
    expect(easternTitles('景辰')).toEqual(['景辰部', '景辰国', '景辰王朝', '景辰皇朝']);
    expect(easternTitles('乌耐', 'khanate')).toEqual(['乌耐部', '乌耐汗国', '乌耐汗国', '乌耐大汗国']);
    expect(easternTitles('大安')).toEqual(['大安部', '大安国', '大安', '大安王朝']);
    for (const t of easternTitles('大安')) expect(t).not.toContain('大大');
  });

  it('生成的世界里:东方国家没有"王国 / 帝国 / 共和国"这类翻译腔;西幻国家照旧', () => {
    for (const { civ } of cases.values()) {
      const eastern = civ.polities.filter((p) => p.eastern);
      const western = civ.polities.filter((p) => !p.eastern);
      expect(eastern.length).toBeGreaterThan(0);
      expect(western.length).toBeGreaterThan(0);
      // 历朝的国号(阶段 3 王朝更替)都算
      for (const p of eastern) {
        for (const t of polityAllTitles(p)) {
          expect(t, p.name).not.toMatch(/王国|帝国|共和国|城邦/);
          expect(t).not.toContain('大大');
        }
      }
      for (const p of western) expect(polityTitles(p)).toEqual(POLITY_FORMS[p.lineage ?? 'realm'].map((f) => p.name + f));
      // 两个国家的国号(任何一档的全称、简称,历朝的都算)不会撞("昌"升格成"大昌"时,不会有另一个叫"大昌"的国家)
      const owner = new Map<string, number>();
      for (const p of civ.polities) {
        for (const t of polityAllTitles(p)) {
          const o = owner.get(t);
          expect(o === undefined || o === p.id, `${t} 撞名`).toBe(true);
          owner.set(t, p.id);
        }
      }
      // 简称:西幻 = 词根;东方单字国名第 2 档起 = "大X"(历朝各按那一朝的词根)
      for (const p of civ.polities) {
        const years = [p.founded, ...(p.dynasties ?? []).map((d) => d.year)];
        for (const y of years) {
          const root = polityRoots(p).find((r) => polityTitles(p, y)[0].startsWith(r))!;
          expect(root, `${p.name} 第 ${y} 年`).toBeDefined();
          for (let tier = 0; tier < 4; tier++) {
            const s = polityShortTitle(p, tier, y);
            expect(s.length).toBeGreaterThanOrEqual(2);
            expect(polityTitles(p, y)[tier].includes(s) || s === `大${root}` || (root.startsWith('大') && s === root)).toBe(true);
          }
        }
      }
    }
  });
});

describe('国名、城名标注与城镇符号(视口文字层)', () => {
  for (const seed of [7, 2024]) {
    for (const style of ['fantasy', 'realistic'] as const) {
      it(`seed ${seed} · ${style}:缩放 1 / 2 / 4 倍时,文字之间、文字和符号之间零重叠`, () => {
        const c = cases.get(seed)!;
        for (const k of [1, 2, 4]) {
          const { placed, view } = place(c, style, c.civ.endYear, k);
          const boxes: { text: string; b: number[] }[] = [];
          for (const pl of placed.labels) for (const g of pl.glyphs) boxes.push({ text: pl.item.text, b: glyphBox(g, pl.px, 0) });
          // 同一条文字里的字不互相比(字距再小也不重叠,排版保证),不同条之间一个都不许重叠
          const grid = new Map<number, number[]>();
          const cell = 64;
          boxes.forEach((e, i) => {
            for (let y = Math.floor(e.b[1] / cell); y <= Math.floor(e.b[3] / cell); y++)
              for (let x = Math.floor(e.b[0] / cell); x <= Math.floor(e.b[2] / cell); x++) {
                const key = y * 100000 + x;
                const l = grid.get(key) ?? [];
                for (const j of l) {
                  const o = boxes[j];
                  if (o.text !== e.text && overlap(o.b, e.b)) throw new Error(`${o.text} × ${e.text}(k=${k})`);
                }
                l.push(i);
                grid.set(key, l);
              }
          });
          // 文字不压符号(自家符号也不压)
          const marks = placed.marks.map((m) => ({ id: m.mark.id, b: markBox(m.mark, view) }));
          for (const e of boxes) for (const m of marks) expect(overlap(e.b, m.b), `${e.text} 压了符号 ${m.id}(k=${k})`).toBe(false);
          // 符号之间也不重叠(国都总画,不算)
          const cap = new Set(c.civ.polities.map((p) => p.capital));
          const plain = marks.filter((m) => !cap.has(m.id));
          for (let a = 0; a < plain.length; a++)
            for (let b = a + 1; b < plain.length; b++) expect(overlap(plain[a].b, plain[b].b), `符号 ${plain[a].id} × ${plain[b].id}`).toBe(false);
        }
      });
    }
  }

  it('国名都在本国国土内:锚点、每个字的中心所在的州都属于这个国家(几个年份)', () => {
    for (const c of cases.values()) {
      for (const year of [1500, 2200, c.civ.endYear]) {
        const own = ownersAt(c.civ, year).polity;
        for (const style of ['fantasy', 'realistic'] as const) {
          const { placed, view } = place(c, style, year, 1);
          const pl = placed.labels.filter((l) => l.item.sizeWorld !== undefined);
          const alive = c.civ.polities.filter((p) => polityAlive(p, year));
          if (alive.length) expect(pl.length).toBeGreaterThan(0);
          for (const l of pl) {
            const id = c.civ.polities.findIndex(
              (p) => polityName(p, year) === l.item.text || polityShortTitle(p, polityTierAt(p, year), year) === l.item.text,
            );
            expect(id, l.item.text).toBeGreaterThanOrEqual(0);
            for (const g of l.glyphs) {
              expect(inTerritory(c, g.x / view.scale, g.y / view.scale, own, id), `${l.item.text}「${g.ch}」第 ${year} 年`).toBe(true);
            }
          }
        }
        // 锚点(最难到达点)所在的州属于这个国家
        for (const l of polityLabels(c.world, c.raster, c.civ, year, { refCss: REF_MAP_CSS }).labels) {
          const r = regionAt(c, l.anchor[0], l.anchor[1]);
          expect(r >= 0 && own[r] === l.polity, `${l.full} 锚点(第 ${year} 年)`).toBe(true);
        }
      }
    }
  });

  it('回放时(国名 20 年才重排一次):灭亡的国家不留名字,国名不压在已经丢掉的土地上;迁都后国都符号换到新国都', () => {
    for (const c of cases.values()) {
      const A = c.civ.annals;
      const years = new Set<number>();
      // 刚亡国、刚丢了州的那几年(上一次重排时国土还在)
      for (const e of A) {
        if (e.kind === 'fall' || e.kind === 'capital') for (const d of [0.5, 3, 9, 17]) years.add(e.year + d);
        if (e.kind === 'conquer' && e.region % 3 === 0) years.add(e.year + 7);
      }
      expect(A.some((e) => e.kind === 'fall')).toBe(true);
      for (const year of [...years].filter((y) => y <= c.civ.endYear)) {
        const own = ownersAt(c.civ, year).polity;
        const { placed, view } = place(c, 'fantasy', year, 1, true);
        for (const l of placed.labels.filter((l) => l.item.sizeWorld !== undefined)) {
          const ids = c.civ.polities.filter((p) => polityAllTitles(p).includes(l.item.text));
          expect(ids.length, l.item.text).toBeGreaterThan(0);
          expect(ids.some((p) => polityAlive(p, year)), `${l.item.text} 第 ${year} 年已灭亡`).toBe(true);
          // 每个字都落在当年的国土上(按像素归属,和画出来的色块一致;国界附近差一格的不算)
          let off = 0;
          for (const g of l.glyphs) {
            const r = regionAt(c, g.x / view.scale, g.y / view.scale);
            if (!(r >= 0 && ids.some((p) => own[r] === p.id))) off++;
          }
          expect(off, `${l.item.text}(第 ${year} 年)有 ${off} 个字压在别国 / 失地上`).toBeLessThanOrEqual(0);
        }
        // 国都符号:在世国家当年的国都
        const capitals = new Set(c.civ.polities.filter((p) => polityAlive(p, year)).map((p) => capitalAt(p, year)));
        const drawn = placed.marks.filter((m) => (m.mark as unknown as { kind: number }).kind === 4).map((m) => m.mark.id);
        expect(new Set(drawn)).toEqual(capitals);
      }
    }
  });

  it('大国的国名缩放 1 倍时就显示,字号比小国大;国名字距拉开(疏排)', () => {
    for (const c of cases.values()) {
      const { placed } = place(c, 'fantasy', c.civ.endYear, 1);
      const own = c.civ.polity;
      const regions = new Map<number, number>();
      for (let r = 0; r < own.length; r++) if (own[r] >= 0) regions.set(own[r], (regions.get(own[r]) ?? 0) + 1);
      const shown = new Map<string, { px: number; pitch: number }>();
      for (const l of placed.labels) {
        if (l.item.sizeWorld === undefined) continue;
        const g = l.glyphs;
        shown.set(l.item.text, { px: l.px, pitch: g.length > 1 ? Math.hypot(g[1].x - g[0].x, g[1].y - g[0].y) : 0 });
      }
      let bigPx = 0;
      let smallPx = Infinity;
      // 国土太窄、连最小的字号都排不下国名的大国(阶段 3 分合以后偶尔有:半岛加一条窄边),缩放 1 倍时本来就不写:
      // 这种国家每个世界最多一个,其余的大国都要写出来
      const fit = polityLabels(c.world, c.raster, c.civ, c.civ.endYear, { refCss: REF_MAP_CSS }).labels;
      let narrow = 0;
      for (const p of c.civ.polities) {
        const n = regions.get(p.id) ?? 0;
        const tier = polityTierAt(p, c.civ.endYear);
        const hit = shown.get(polityName(p, c.civ.endYear)) ?? shown.get(polityShortTitle(p, tier, c.civ.endYear));
        const f = fit.find((l) => l.polity === p.id);
        if (n >= 25 && !hit && f && (f.size * REF_MAP_CSS) / c.world.width < MIN_LABEL_PX) {
          narrow++;
          continue;
        }
        if (n >= 25) {
          expect(hit, `${polityName(p, c.civ.endYear)}(${n} 州)`).toBeDefined();
          bigPx = Math.max(bigPx, hit!.px);
          expect(hit!.pitch).toBeGreaterThan(hit!.px * 1.4);
        }
        if (hit && n < 25) smallPx = Math.min(smallPx, hit.px);
      }
      expect(narrow).toBeLessThanOrEqual(1);
      expect(bigPx).toBeGreaterThan(20);
      if (smallPx < Infinity) expect(bigPx).toBeGreaterThan(smallPx * 1.4);
    }
  });

  it('城名紧挨自家符号;国都名缩放 1 倍时全都在', () => {
    for (const c of cases.values()) {
      for (const k of [1, 2, 4]) {
        const { placed, view } = place(c, 'fantasy', c.civ.endYear, k);
        const markOf = new Map(placed.marks.map((m) => [m.mark.id, m]));
        for (const l of placed.labels) {
          if (l.item.mark === undefined) continue;
          const m = markOf.get(l.item.mark)!;
          expect(m).toBeDefined();
          const mb = markBox(m.mark, view);
          const xs = l.glyphs.map((g) => g.x);
          const ys = l.glyphs.map((g) => g.y);
          const tb = [Math.min(...xs) - l.px / 2, Math.min(...ys) - l.px / 2, Math.max(...xs) + l.px / 2, Math.max(...ys) + l.px / 2];
          const dx = Math.max(0, tb[0] - mb[2], mb[0] - tb[2]);
          const dy = Math.max(0, tb[1] - mb[3], mb[1] - tb[3]);
          // 两圈候选里最远的(第二圈斜角)也就离符号一个半字
          expect(Math.hypot(dx, dy), `${l.item.text}(k=${k})`).toBeLessThanOrEqual(l.px * 1.5 + 3);
        }
        if (k === 1) {
          const capitals = c.civ.polities.filter((p) => polityAlive(p, c.civ.endYear)).map((p) => capitalAt(p, c.civ.endYear));
          const named = new Set(placed.labels.filter((l) => l.item.mark !== undefined).map((l) => l.item.mark));
          for (const id of capitals) expect(named.has(id), c.civ.settlements[id].name).toBe(true);
        }
      }
    }
  });

  it('按缩放逐级出现:远景只有国都、城的符号和国都名;放大后镇、村和它们的名字才出现', () => {
    const c = cases.get(7)!;
    const kinds = (k: number) => {
      const { placed } = place(c, 'fantasy', c.civ.endYear, k);
      const markKinds = placed.marks.map((m) => (m.mark as unknown as { kind: number }).kind);
      const named = new Set(placed.labels.filter((l) => l.item.mark !== undefined).map((l) => l.item.mark));
      const namedKinds = placed.marks.filter((m) => named.has(m.mark.id)).map((m) => (m.mark as unknown as { kind: number }).kind);
      return { markKinds, namedKinds, marks: placed.marks.length };
    };
    const k1 = kinds(1);
    expect(Math.min(...k1.markKinds)).toBeGreaterThanOrEqual(2);
    expect(Math.min(...k1.namedKinds)).toBeGreaterThanOrEqual(3);
    const k4 = kinds(4);
    expect(k4.markKinds).toContain(1);
    expect(k4.namedKinds).toContain(1);
    expect(k4.marks).toBeGreaterThan(k1.marks * 3);
    const k8 = kinds(8);
    expect(k8.markKinds).toContain(0);
    // 门槛表本身是递增的:国都 ≤ 大城 ≤ 城 ≤ 镇 ≤ 村
    for (let i = 1; i < 5; i++) {
      expect(NAME_MIN_ZOOM[i - 1]).toBeGreaterThanOrEqual(NAME_MIN_ZOOM[i]);
      expect(SYMBOL_MIN_ZOOM[i - 1]).toBeGreaterThanOrEqual(SYMBOL_MIN_ZOOM[i]);
    }
  });

  it('随年份变:国名随国家诞生出现、国号跟着升格;城名随城市出现', () => {
    const c = cases.get(2024)!;
    const p0 = c.civ.polities[0];
    const titles = p0.titles!;
    const before = place(c, 'realistic', p0.founded - 1, 1).placed.labels.map((l) => l.item.text);
    const all0 = new Set(polityAllTitles(p0));
    expect(before.some((t) => all0.has(t))).toBe(false);
    // 每次升格之后,地图上写的是那一档的全称或简称
    for (const t of titles) {
      const y = t.year + 1;
      const texts = civMapLayer(paramsOf(c, 'realistic', y)).items.filter((i) => i.sizeWorld !== undefined).map((i) => i.text);
      const want = [polityTitles(p0, y)[t.tier], polityShortTitle(p0, t.tier, y)];
      expect(texts.some((x) => want.includes(x)), `第 ${y} 年 ${want.join(' / ')}`).toBe(true);
    }
    // 城名:建城以前没有
    const s = c.civ.settlements[c.civ.settlements.length - 1];
    const has = (y: number) => civMapLayer(paramsOf(c, 'realistic', y)).marks.some((m) => m.id === s.id);
    expect(has(s.founded - 1)).toBe(false);
    expect(has(c.civ.endYear)).toBe(true);
  });

  it('确定性:同样的世界、年份、视口,排出来一模一样(同一个种子重新生成一遍也一样)', () => {
    const sig = (p: Placement) => JSON.stringify([p.labels.map((l) => [l.item.text, l.px, l.glyphs]), p.marks.map((m) => [m.mark.id, m.x, m.y])]);
    const c = cases.get(7)!;
    expect(sig(place(c, 'fantasy', 2400, 2).placed)).toBe(sig(place(c, 'fantasy', 2400, 2).placed));
    // 精细度低一点的世界,生成两遍(省时间)
    const fresh = (): Case => {
      const world = generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed: 7 });
      const raster = rasterize(world, 1);
      const civ = generateCiv(world);
      return { world, raster, civ, pix: pixelRegions(world.mesh, raster, civ.regions.of) };
    };
    const a = place(fresh(), 'realistic', 2400, 1).placed;
    expect(a.labels.length).toBeGreaterThan(10);
    expect(sig(place(fresh(), 'realistic', 2400, 1).placed)).toBe(sig(a));
  });
});
