/**
 * 导入一张图当草图:认图(gen/sketchImage.ts 的点一下海、按深浅、放法、认得像不像样)、
 * 认出来的格子图怎么存(gen/sketch.ts 的 SketchImage:编码、清理、铺到草图格子上)、存档往返、照它生成、editsStore 的导入 / 去掉 / 撤销。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import {
  LAYER_H,
  LAYER_W,
  SKETCH_HILLS,
  SKETCH_IMAGE_NAME_MAX,
  SKETCH_LAND,
  SKETCH_MOUNTAIN,
  SKETCH_NONE,
  SKETCH_SEA,
  SKETCH_SHELF,
  SKETCH_W,
  cleanSketch,
  decodeLayer,
  encodeLayer,
  sameSketch,
  sketchGrid,
  type SketchEdit,
} from '../src/gen/sketch';
import {
  PICTURE_W,
  autoSeaLevel,
  importWarning,
  layerStats,
  levelsFrom,
  placeOnLayer,
  placeRect,
  preparePicture,
  seaFromClicks,
  type Pixels,
} from '../src/gen/sketchImage';
import { makeSave, parseSave, saveText } from '../src/gen/savefile';
import { EMPTY_EDITS } from '../src/gen/edits';

type RGBA = readonly [number, number, number, number?];

/** 按 (x, y) → 颜色画一张图 */
function picture(w: number, h: number, color: (x: number, y: number) => RGBA): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = color(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const landShareOf = (v: Uint8Array) => v.filter((x) => x >= SKETCH_LAND).length / v.length;

/** 一张格子图:先全是 fill,再把 [x0, x1) × [y0, y1)(格子坐标)涂成 v */
function layerWith(fill: number, box?: [number, number, number, number, number]): Uint8Array {
  const out = new Uint8Array(LAYER_W * LAYER_H).fill(fill);
  if (box) {
    const [x0, y0, x1, y1, v] = box;
    for (let y = y0; y < y1; y++) out.fill(v, y * LAYER_W + x0, y * LAYER_W + x1);
  }
  return out;
}

// 一张"手画的地图":海是蓝的(从左往右慢慢变浅),中间一块绿色的陆地描了深色海岸线,陆地中间一个也描了边的湖
const SEA = (x: number): RGBA => [60 + x * 0.08, 110 + x * 0.04, 200, 255];
function kidMap(x: number, y: number): RGBA {
  const d = Math.hypot(x - 200, y - 100);
  if (Math.abs(d - 60) < 1.5 || Math.abs(d - 15) < 1.2) return [40, 40, 45];
  if (d < 15) return SEA(x);
  if (d < 60) return [90, 170, 80];
  return SEA(x);
}

describe('点一下海', () => {
  const pic = preparePicture(picture(400, 200, kidMap));

  it('点外海:陆地连同湖都算陆地;再点一下湖,湖也成了海;一下也没点 = 还没认', () => {
    const disc = (Math.PI * 60 * 60) / (400 * 200);
    const lake = (Math.PI * 15 * 15) / (400 * 200);
    const one = seaFromClicks(pic, [[0.02, 0.05]], 4);
    expect(landShareOf(one)).toBeGreaterThan(disc - 0.005);
    expect(landShareOf(one)).toBeLessThan(disc + 0.015);
    const two = seaFromClicks(pic, [[0.02, 0.05], [0.5, 0.5]], 4);
    expect(landShareOf(one) - landShareOf(two)).toBeGreaterThan(lake * 0.6);
    expect(two[100 * 400 + 200]).toBe(SKETCH_SEA);
    expect(two[100 * 400 + 230]).toBe(SKETCH_LAND);
    expect(seaFromClicks(pic, [], 4).every((v) => v === SKETCH_NONE)).toBe(true);
  });

  it('只描了海岸线的线稿也认得出(线挡住);点在线上也行', () => {
    const sketch = preparePicture(
      picture(400, 200, (x, y) => (Math.abs(Math.hypot(x - 200, y - 100) - 60) < 1.2 ? [20, 20, 20] : [250, 248, 240])),
    );
    const v = seaFromClicks(sketch, [[0.02, 0.05]], 4);
    expect(v[100 * 400 + 200]).toBe(SKETCH_LAND);
    expect(v[5 * 400 + 5]).toBe(SKETCH_SEA);
    // 点在海岸线上:挪到旁边不是线的地方再走
    const onLine = seaFromClicks(sketch, [[260 / 400, 0.5]], 4);
    expect(onLine.filter((x) => x === SKETCH_SEA).length).toBeGreaterThan(0);
  });

  it('大图先缩小再认,细线在原图上找,缩小了也挡得住', () => {
    const big = picture(1600, 800, (x, y) => (Math.abs(Math.hypot(x - 800, y - 400) - 240) < 0.8 ? [30, 30, 30] : [250, 250, 250]));
    const p = preparePicture(big);
    expect(p.w).toBe(PICTURE_W);
    expect(p.h).toBe(PICTURE_W / 2);
    const v = seaFromClicks(p, [[0.02, 0.05]], 4);
    expect(v[(p.h >> 1) * p.w + (p.w >> 1)]).toBe(SKETCH_LAND);
    expect(landShareOf(v)).toBeLessThan(0.2);
  });

  it('颜色一下子变很多的地方走不过去,范围调大才走得过去', () => {
    const p = preparePicture(picture(200, 100, (x) => (x < 100 ? [60, 110, 200] : [200, 120, 160])));
    expect(landShareOf(seaFromClicks(p, [[0.1, 0.5]], 4))).toBeGreaterThan(0.45);
    // 糊过一下以后交界处一步一步变,范围最大时走得过去
    expect(landShareOf(seaFromClicks(p, [[0.1, 0.5]], 10))).toBeLessThan(landShareOf(seaFromClicks(p, [[0.1, 0.5]], 4)));
  });

  it('海里的小黑点(写的字、笔道)不算陆地;透明的地方当白纸', () => {
    const dotty = preparePicture(
      picture(400, 200, (x, y) => {
        if (x % 40 < 2 && y % 40 < 2 && x > 10) return [30, 30, 30];
        return kidMap(x, y);
      }),
    );
    const v = seaFromClicks(dotty, [[0.02, 0.05]], 4);
    expect(v[40 * 400 + 40]).toBe(SKETCH_SEA);
    const clear = preparePicture(picture(200, 100, (x, y) => (Math.hypot(x - 100, y - 50) < 30 ? [90, 170, 80, 255] : [0, 0, 0, 0])));
    const c = seaFromClicks(clear, [[0.02, 0.05]], 4);
    expect(c[50 * 200 + 100]).toBe(SKETCH_LAND);
    expect(c[5 * 200 + 5]).toBe(SKETCH_SEA);
    expect(clear.colorful).toBe(true);
  });
});

describe('按深浅', () => {
  // 从左往右由黑变白
  const ramp = preparePicture(picture(256, 16, (x) => [x, x, x]));

  it('比海平面亮的是陆地;「暗的是陆地」反过来', () => {
    const v = levelsFrom(ramp, { sea: 128 });
    expect(v[8 * 256 + 60]).toBe(SKETCH_SEA);
    expect(v[8 * 256 + 200]).toBe(SKETCH_LAND);
    expect(landShareOf(v)).toBeCloseTo(0.5, 1);
    const d = levelsFrom(ramp, { sea: 128, dark: true });
    expect(d[8 * 256 + 60]).toBe(SKETCH_LAND);
    expect(d[8 * 256 + 200]).toBe(SKETCH_SEA);
    expect(ramp.colorful).toBe(false);
  });

  it('「高低也照图」:越亮越高,依次是海、浅海、陆地、丘陵、山地低中高;关掉只分海陆', () => {
    const v = levelsFrom(ramp, { sea: 100, heights: true });
    const row = Array.from(v.subarray(8 * 256 + 2, 8 * 256 + 254));
    const order = [...new Set(row)];
    expect(order).toEqual([SKETCH_SEA, SKETCH_SHELF, SKETCH_LAND, SKETCH_HILLS, SKETCH_MOUNTAIN, SKETCH_MOUNTAIN + 1, SKETCH_MOUNTAIN + 2]);
    expect(new Set(levelsFrom(ramp, { sea: 100 }))).toEqual(new Set([SKETCH_SEA, SKETCH_LAND]));
  });

  it('海平面自动放在海和陆地之间的低谷', () => {
    // 左边七成是海(灰度 30–49),右边三成是陆地(100–249)
    const p = preparePicture(picture(200, 100, (x, y) => {
      const g = x < 140 ? 30 + ((x * 7 + y * 3) % 20) : 100 + ((x * 11 + y * 5) % 150);
      return [g, g, g];
    }));
    const t = autoSeaLevel(p);
    expect(t).toBeGreaterThan(45);
    expect(t).toBeLessThan(100);
    expect(landShareOf(levelsFrom(p, { sea: t }))).toBeCloseTo(0.3, 1);
  });
});

describe('放到格子图上', () => {
  it('铺满:拉伸到整张,四个角对上', () => {
    const v = Uint8Array.from([1, 2, 4, 5, 7, 8, 9, 4]);
    const l = placeOnLayer(v, 4, 2, { fit: 'fill' });
    expect(l[0]).toBe(1);
    expect(l[LAYER_W - 1]).toBe(5);
    expect(l[(LAYER_H - 1) * LAYER_W]).toBe(7);
    expect(l[LAYER_W * LAYER_H - 1]).toBe(4);
    expect(l.includes(SKETCH_NONE)).toBe(false);
  });

  it('保持比例:正方形的图放中间盖一半;缩小;挪到左右边上绕到另一边接上,挪到上下边切掉一半', () => {
    const v = new Uint8Array(100).fill(SKETCH_LAND);
    const covered = (p: Parameters<typeof placeOnLayer>[3]) => layerStats(placeOnLayer(v, 10, 10, p)).covered;
    expect(placeRect(10, 10, { fit: 'keep', x: 0.5, y: 0.5, scale: 1 })).toEqual({ x: LAYER_W / 4, y: 0, w: LAYER_H, h: LAYER_H });
    expect(covered({ fit: 'keep', x: 0.5, y: 0.5, scale: 1 })).toBeCloseTo(0.5, 5);
    expect(covered({ fit: 'keep', x: 0.5, y: 0.5, scale: 0.5 })).toBeCloseTo(0.125, 5);
    expect(covered({ fit: 'keep', x: 0.5, y: 0, scale: 0.5 })).toBeCloseTo(0.0625, 5);
    const lr = Uint8Array.from({ length: 100 }, (_, i) => (i % 10 < 5 ? SKETCH_SEA : SKETCH_LAND)); // 左半海、右半陆地
    const edge = placeOnLayer(lr, 10, 10, { fit: 'keep', x: 0, y: 0.5, scale: 1 });
    expect(layerStats(edge).covered).toBeCloseTo(0.5, 5);
    expect(edge[100 * LAYER_W + LAYER_W - 1]).toBe(SKETCH_SEA); // 图的左半绕到了格子图最右边
    expect(edge[100 * LAYER_W]).toBe(SKETCH_LAND);
    expect(edge[100 * LAYER_W + LAYER_W / 2]).toBe(SKETCH_NONE);
    const l = placeOnLayer(v, 10, 10, { fit: 'keep', x: 0.5, y: 0.5, scale: 1 });
    expect(l[100 * LAYER_W + 10]).toBe(SKETCH_NONE);
    expect(l[100 * LAYER_W + 256]).toBe(SKETCH_LAND);
  });
});

describe('认得像不像样', () => {
  it('碎成很多小块、几乎全是海 / 陆地时提醒;彩色的图用了按深浅,提醒改用点一下海', () => {
    const specks = layerWith(SKETCH_SEA);
    for (let y = 0; y < LAYER_H; y += 4) for (let x = 0; x < LAYER_W; x += 4) specks[y * LAYER_W + x] = SKETCH_LAND;
    const s = layerStats(specks);
    expect(s.specks).toBe(s.pieces);
    expect(importWarning(s, 'level', true)).toBe('colorful');
    expect(importWarning(s, 'level', false)).toBe('specks');
    expect(importWarning(s, 'wand', true)).toBe('specks');
    expect(importWarning(layerStats(layerWith(SKETCH_LAND)), 'wand', true)).toBe('land');
    expect(importWarning(layerStats(layerWith(SKETCH_LAND)), 'level', true)).toBe('colorful');
    expect(importWarning(layerStats(layerWith(SKETCH_SEA, [0, 0, 10, 10, SKETCH_LAND])), 'wand', false)).toBe('sea');
    const ok = layerStats(layerWith(SKETCH_SEA, [100, 50, 300, 150, SKETCH_LAND]));
    expect(ok.pieces).toBe(1);
    expect(importWarning(ok, 'level', true)).toBeNull();
    expect(importWarning(layerStats(layerWith(SKETCH_NONE)), 'wand', false)).toBeNull();
  });
});

describe('认出来的格子图怎么存', () => {
  const layer = layerWith(SKETCH_SEA, [100, 50, 300, 150, SKETCH_LAND]);
  layer.fill(SKETCH_MOUNTAIN + 2, 80 * LAYER_W + 120, 80 * LAYER_W + 140);
  const cells = encodeLayer(layer);

  it('编码再解码一样;格式不对的读不出来', () => {
    expect(decodeLayer(cells)).toEqual(layer);
    expect(cells.length).toBeLessThan(2000);
    expect(decodeLayer('不是 base64')).toBeNull();
    expect(decodeLayer(btoa('\x05\x01'))).toBeNull(); // 格数不够
    expect(decodeLayer(btoa('\x00\x01' + atob(cells)))).toBeNull(); // 个数是 0
    expect(decodeLayer(btoa(atob(cells).slice(0, -1) + '\x0a'))).toBeNull(); // 值超过 9
    expect(decodeLayer(btoa(atob(cells) + '\x01\x01'))).toBeNull(); // 格数多了
  });

  it('清理:合格的原样返回;读不出来、一格也没盖到的图片丢掉;文件名、at 规整', () => {
    const edit: SketchEdit = { rest: 'auto', strokes: [], image: { name: '我画的地图.jpg', cells } };
    expect(cleanSketch(edit)).toBe(edit);
    expect(cleanSketch({ ...edit, image: { name: 'x', cells: 'oops' } })).toBeNull();
    expect(cleanSketch({ ...edit, image: { name: 'x', cells: encodeLayer(layerWith(SKETCH_NONE)) } })).toBeNull();
    expect(cleanSketch({ ...edit, rest: 'sea', image: { name: 'x', cells: 'oops' } })).toEqual({ rest: 'sea', strokes: [] });
    const name = cleanSketch({ ...edit, image: { name: ' a\u0000b' + '长'.repeat(100), cells } })!.image!.name;
    expect(name.startsWith('ab')).toBe(true);
    expect([...name]).toHaveLength(SKETCH_IMAGE_NAME_MAX);
    const stroke = { kind: 'land' as const, r: 8, pts: [10, 10] };
    expect(cleanSketch({ ...edit, strokes: [stroke], image: { name: 'x', cells, at: 5 } })!.image!.at).toBe(1);
    expect(cleanSketch({ ...edit, image: { name: 'x', cells, at: 0 } })!.image).toEqual({ name: 'x', cells });
    // 图前面那笔不合格被丢掉:图还在后面那笔前面(at 按留下来的笔数算)
    const kept = cleanSketch({ ...edit, strokes: [{ kind: 'land', r: 8, pts: [] }, stroke], image: { name: 'x', cells, at: 1 } })!;
    expect(kept.strokes).toEqual([stroke]);
    expect(kept.image!.at).toBeUndefined();
    expect(cleanSketch({ ...edit, strokes: [stroke, { kind: 'nope', r: 8, pts: [1, 1] }, stroke], image: { name: 'x', cells, at: 3 } })!.image!.at).toBe(2);
    expect(cleanSketch({ ...edit, image: { cells } })!.image!.name).toBe('');
  });

  it('sameSketch 也比图片', () => {
    const a: SketchEdit = { rest: 'auto', strokes: [], image: { name: 'a', cells } };
    expect(sameSketch(a, { ...a, image: { ...a.image! } })).toBe(true);
    expect(sameSketch(a, { ...a, image: { ...a.image!, name: 'b' } })).toBe(false);
    expect(sameSketch(a, { ...a, image: { ...a.image!, cells: encodeLayer(layerWith(SKETCH_SEA)) } })).toBe(false);
    expect(sameSketch(a, { ...a, image: undefined })).toBe(false);
    expect(sameSketch({ ...a, image: { ...a.image!, at: 0 } }, a)).toBe(true);
  });

  it('铺到草图格子上:一格铺 2 × 2;没盖到的留着底下的;先后:前 at 笔被图盖住,后面的笔盖在图上', () => {
    const half = layerWith(SKETCH_NONE, [0, 0, LAYER_W / 2, LAYER_H, SKETCH_SEA]);
    half.fill(SKETCH_LAND, 10 * LAYER_W + 10, 10 * LAYER_W + 20);
    const before = { kind: 'mountain' as const, r: 40, pts: [40, 40, 1500, 40] };
    const after = { kind: 'hills' as const, r: 8, pts: [60, 44] };
    const g = sketchGrid({ rest: 'auto', strokes: [before, after], image: { name: 'x', cells: encodeLayer(half), at: 1 } })!.grid;
    const cell = (x: number, y: number) => g[y * SKETCH_W + x];
    expect(cell(20, 20)).toBe(SKETCH_LAND);
    expect(cell(21, 21)).toBe(SKETCH_LAND);
    expect(cell(40, 21)).toBe(SKETCH_SEA);
    // 前一笔山地:左半边被图盖住,右半边(图没盖到)还在
    expect(cell(200, 20)).toBe(SKETCH_SEA);
    expect(cell(700, 20)).toBe(SKETCH_MOUNTAIN + 1);
    // 后一笔丘陵盖在图上
    expect(cell(30, 22)).toBe(SKETCH_HILLS);
    // 没画也没盖到的:'auto' 交给程序,'sea' 当海
    expect(cell(700, 400)).toBe(SKETCH_NONE);
    expect(sketchGrid({ rest: 'sea', strokes: [], image: { name: 'x', cells: encodeLayer(half) } })!.grid[400 * SKETCH_W + 700]).toBe(SKETCH_SEA);
  });

  it('存进去、读回来一样;图片格式不对的跳过并提示', () => {
    const edit: SketchEdit = { rest: 'auto', strokes: [{ kind: 'land', r: 32, pts: [700, 300] }], image: { name: '地图.png', cells, at: 1 } };
    const save = makeSave(DEFAULT_PARAMS, { ...EMPTY_EDITS, sketch: edit }, 'x');
    const back = parseSave(saveText(save));
    expect(back.ok && back.save.edits.sketch).toEqual(edit);
    expect(back.ok && back.warnings).toEqual([]);
    const raw = JSON.parse(saveText(save));
    raw.edits.sketch.image.cells = 'AAAA';
    const bad = parseSave(JSON.stringify(raw));
    expect(bad.ok && bad.save.edits.sketch).toEqual({ rest: 'auto', strokes: edit.strokes });
    expect(bad.ok && bad.warnings).toContain('草图里导入的图片格式不对,已跳过');
  });
});

describe('照导入的图生成', () => {
  const SMALL = { ...DEFAULT_PARAMS, cells: 12000, seed: 7 };
  const landIn = (w: World, x0: number, y0: number, x1: number, y1: number) => {
    let land = 0;
    let all = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const x = w.mesh.x[i];
      const y = w.mesh.y[i];
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      all++;
      if (w.water[i] === 0) land++;
    }
    return land / all;
  };

  it('图上是陆地的地方长出陆地,海的地方是海', () => {
    // 格子图一格 = 世界坐标 4 × 4:陆地 = 世界坐标 x 600–1000、y 320–640
    const layer = layerWith(SKETCH_SEA, [150, 80, 250, 160, SKETCH_LAND]);
    const w = generateWorld(SMALL, undefined, undefined, sketchGrid({ rest: 'auto', strokes: [], image: { name: 'x', cells: encodeLayer(layer) } }));
    expect(landIn(w, 660, 380, 940, 580)).toBeGreaterThan(0.85);
    expect(landIn(w, 1300, 200, 1900, 800)).toBeLessThan(0.05);
  });
});

describe('当前世界的草图(editsStore):导入图片', () => {
  it('导入、再导入换掉的撤销时放回去;能撤几次;去掉只去图片;一格也没盖到的不导入', async () => {
    const { addSketchStroke, clearEdits, getEdits, redoSketchImage, removeSketchImage, setSketchImage, sketchImageSteps, undoSketchImage, undoSketchStroke } = await import(
      '../src/ui/editsStore'
    );
    clearEdits();
    const a = layerWith(SKETCH_SEA, [100, 50, 300, 150, SKETCH_LAND]);
    const b = layerWith(SKETCH_SEA, [10, 10, 60, 60, SKETCH_LAND]);
    expect(setSketchImage('空的.png', layerWith(SKETCH_NONE))).toBe(false);
    expect(getEdits().sketch).toBeUndefined();
    expect(sketchImageSteps()).toBe(0);
    expect(setSketchImage('a.png', a)).toBe(true);
    expect(getEdits().sketch).toEqual({ rest: 'auto', strokes: [], image: { name: 'a.png', cells: encodeLayer(a) } });
    addSketchStroke({ kind: 'mountain', r: 16, pts: [5, 5] });
    expect(setSketchImage('b.png', b)).toBe(true);
    const imgB = getEdits().sketch!.image!;
    expect(imgB).toEqual({ name: 'b.png', cells: encodeLayer(b), at: 1 });
    expect(sketchImageSteps()).toBe(2);
    undoSketchImage(); // 撤掉 b,a 放回去
    expect(getEdits().sketch?.image?.name).toBe('a.png');
    expect(getEdits().sketch?.strokes).toHaveLength(1);
    redoSketchImage(imgB); // 重做:b 又换上,撤销时 a 照样放回去
    expect(getEdits().sketch?.image).toBe(imgB);
    expect(sketchImageSteps()).toBe(2);
    undoSketchImage();
    undoSketchStroke(); // 撤笔画不动图片
    expect(getEdits().sketch).toEqual({ rest: 'auto', strokes: [], image: { name: 'a.png', cells: encodeLayer(a) } });
    addSketchStroke({ kind: 'land', r: 16, pts: [7, 7] });
    removeSketchImage();
    expect(getEdits().sketch).toEqual({ rest: 'auto', strokes: [{ kind: 'land', r: 16, pts: [7, 7] }] });
    expect(sketchImageSteps()).toBe(0);
    undoSketchStroke();
    expect(getEdits().sketch).toBeUndefined();
    clearEdits();
  });
});
