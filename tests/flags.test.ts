/**
 * 国旗(gen/civ/flags.ts,推演结束后照历史配的):同一个种子同一面旗;东方换朝代按五德相生换底色、图案不重样;
 * 分家加镶边 / 加星,复国用回故国的旗;存档里的写法往返、坏的读不进;作者改过的旗从那一朝起往下配;
 * 换一面的候选不重样;旗帜详情的字写得干净;存档、撤销带着改过的旗。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import {
  DE_TINCT,
  FLAG_CODE_MAX,
  deOf,
  decodeFlag,
  encodeFlag,
  flagAlternatives,
  flagBook,
  flagOverrides,
  isEastern,
  polityFlagAt,
  polityFlagKeys,
  type FlagSpec,
} from '../src/gen/civ/flags';
import { flagNote, flagRows } from '../src/gen/civ/flagText';
import { EMPTY_EDITS, type WorldEdits } from '../src/gen/edits';
import { editCount, makeSave, parseSave } from '../src/gen/savefile';
import { revertEdits } from '../src/ui/editsStore';
import { flagSvg } from '../src/render/flag/flagSvg';

const worlds = new Map<number, World>();
function world(seed: number): World {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed })));
  return w;
}
const civs = new Map<number, Civ>();
function civOf(seed: number): Civ {
  let c = civs.get(seed);
  if (!c) civs.set(seed, (c = generateCiv(world(seed))));
  return c;
}

const CLEAN = /undefined|NaN|null|\[object/;
const codes = (b: ReturnType<typeof flagBook>) => b.eras.map((es) => es.map((e) => encodeFlag(e.spec)));

describe.each([7, 2024])('国旗 · seed=%i', (seed) => {
  it('同一个种子同一面旗;每国一朝一面,第一面从立国那年起', () => {
    const civ = civOf(seed);
    const a = flagBook(world(seed), civ);
    const b = flagBook(world(seed), civ);
    expect(codes(a)).toEqual(codes(b));
    expect(a.eras).toHaveLength(civ.polities.length);
    civ.polities.forEach((p, id) => {
      const es = a.eras[id];
      expect(es.length).toBe(Math.max(1, p.dynasties?.length ?? 0));
      expect(es[0].year).toBe(p.founded);
      es.forEach((e, i) => {
        expect(e.dyn).toBe(i);
        expect(e.how).toBe('auto');
        if (i) expect(e.year).toBeGreaterThanOrEqual(es[i - 1].year);
      });
    });
  });

  it('存档里的写法:每一面都能往返,不超过长度上限;SVG 画得出来', () => {
    const book = flagBook(world(seed), civOf(seed));
    for (const es of book.eras)
      for (const e of es) {
        const code = encodeFlag(e.spec);
        expect(code.length).toBeLessThanOrEqual(FLAG_CODE_MAX);
        expect(encodeFlag(decodeFlag(code)!)).toBe(code);
        const svg = flagSvg(e.spec, { display: 24 });
        expect(svg).toMatch(/^<svg/);
        expect(svg).not.toMatch(CLEAN);
      }
  });

  it('东方王朝换朝代:底色按五德相生(木 → 火 → 土 → 金 → 水 → 木),中间的图案和上一朝不重样', () => {
    const civ = civOf(seed);
    const book = flagBook(world(seed), civ);
    let n = 0;
    for (const es of book.eras)
      for (let i = 1; i < es.length; i++) {
        const [a, b] = [es[i - 1].spec, es[i].spec];
        if (!isEastern(a) || deOf(a.c[0]) < 0) continue;
        expect(deOf(b.c[0])).toBe((deOf(a.c[0]) + 1) % 5);
        expect(b.mark).not.toBe(a.mark);
        n++;
      }
    expect(n).toBeGreaterThan(0);
  });

  it('分家:西幻的左上角加星(一到三颗),东方的加镶边;复国用回故国最后那面旗', () => {
    const civ = civOf(seed);
    const book = flagBook(world(seed), civ);
    civ.polities.forEach((p, id) => {
      const e = book.eras[id][0];
      if (e.why.restores !== undefined) {
        const old = book.eras[e.why.restores];
        expect(encodeFlag(e.spec)).toBe(encodeFlag(old[old.length - 1].spec));
      } else if (e.why.parent !== undefined && e.why.kind === 'west' && e.why.nth !== undefined) {
        expect(e.spec.mullets).toBeGreaterThanOrEqual(1);
        expect(e.spec.mullets).toBeLessThanOrEqual(3);
      } else if (e.why.parent !== undefined && e.why.kind === 'east' && isEastern(polityFlagAt(book, e.why.parent, p.founded)!.spec)) {
        expect(e.spec.trim).toBeDefined();
      }
    });
  });

  it('旗帜详情的字:每面都有几行意思和一句怎么来的,写得干净', () => {
    const civ = civOf(seed);
    const book = flagBook(world(seed), civ);
    book.eras.forEach((es, id) =>
      es.forEach((e) => {
        const rows = flagRows(civ, book, id, e);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const r of rows) {
          expect(r.k.length).toBeGreaterThan(0);
          expect(`${r.k}${r.v}`).not.toMatch(CLEAN);
        }
        expect(flagNote(e)).not.toMatch(CLEAN);
      }),
    );
  });

  it('换一面:配 8 面,不重样、不含现在这面,同一批每次一样;东方的底色不变', () => {
    const civ = civOf(seed);
    const w = world(seed);
    const book = flagBook(w, civ);
    for (const id of [0, 1, 2, 3]) {
      const es = book.eras[id];
      if (!es) continue;
      const e = es[es.length - 1];
      const alts = flagAlternatives(w, civ, id, e);
      expect(alts).toHaveLength(8);
      expect(alts.map(encodeFlag)).toEqual(flagAlternatives(w, civ, id, e).map(encodeFlag));
      expect(alts.map(encodeFlag)).not.toContain(encodeFlag(e.spec));
      expect(new Set(alts.map(encodeFlag)).size).toBe(8);
      if (isEastern(e.spec)) for (const a of alts) expect(a.c[0]).toBe(e.spec.c[0]);
      const next = flagAlternatives(w, civ, id, e, 1);
      expect(next.map(encodeFlag)).not.toEqual(alts.map(encodeFlag));
    }
  });
});

describe('国旗 · 作者改过的', () => {
  const seed = 7;
  /** 换过朝代的东方王朝、西幻王国各一个 */
  function pickPolities() {
    const civ = civOf(seed);
    const book = flagBook(world(seed), civ);
    const east = book.eras.findIndex((es) => es.length >= 3 && isEastern(es[0].spec) && es.every((e) => deOf(e.spec.c[0]) >= 0));
    const west = book.eras.findIndex((es) => es.length >= 3 && !isEastern(es[0].spec) && es[0].spec.charge?.sym !== 'tamga');
    expect(east).toBeGreaterThanOrEqual(0);
    expect(west).toBeGreaterThanOrEqual(0);
    return { civ, book, east, west };
  }

  it('东方:改的是这一朝起;之前的不变,之后照改过的底色按五德往下推', () => {
    const { civ, book, east } = pickPolities();
    const es = book.eras[east];
    const spec: FlagSpec = { ...es[1].spec, c: [DE_TINCT[0]], mark: 'feng' };
    const ov = flagBook(world(seed), civ, { [es[1].key]: spec });
    const after = ov.eras[east];
    expect(encodeFlag(after[0].spec)).toBe(encodeFlag(es[0].spec));
    expect(after[0].how).toBe('auto');
    expect(after[1].how).toBe('edited');
    expect(encodeFlag(after[1].spec)).toBe(encodeFlag(spec));
    expect(after[2].how).toBe('derived');
    expect(after[2].spec.c[0]).toBe(DE_TINCT[1]);
    expect(after[2].spec.mark).not.toBe('feng');
    expect(flagNote(after[1])).toContain('你改过');
    expect(flagNote(after[2])).toContain('照你改过');
    // 别的国家不受影响(除了从它分出去的)
    const others = ov.eras.map((x, i) => (i === east || civ.polities[i].parent === east || civ.polities[i].restores === east ? '' : x.map((e) => encodeFlag(e.spec)).join()));
    expect(others).toEqual(book.eras.map((x, i) => (i === east || civ.polities[i].parent === east || civ.polities[i].restores === east ? '' : x.map((e) => encodeFlag(e.spec)).join())));
  });

  it('西幻:改了第一朝的样式和颜色,之后每朝照旧只换图案', () => {
    const { civ, book, west } = pickPolities();
    const es = book.eras[west];
    const spec: FlagSpec = { shape: 'rect', layout: 'cross', c: ['G', 'W'], charge: { sym: 'star', t: 'Y', at: 'canton' } };
    const after = flagBook(world(seed), civ, { [es[0].key]: spec }).eras[west];
    expect(after[0].how).toBe('edited');
    for (const e of after.slice(1)) {
      expect(e.how).toBe('derived');
      expect(e.spec.layout).toBe('cross');
      expect(e.spec.c).toEqual(['G', 'W']);
    }
    for (let i = 1; i < after.length; i++) expect(after[i].spec.charge?.sym).not.toBe(after[i - 1].spec.charge?.sym);
  });

  it('恢复自动配的:这一国所有朝代的键;键和改名用的同一套', () => {
    const { civ, east } = pickPolities();
    const keys = polityFlagKeys(civ, east);
    expect(keys).toHaveLength(flagBook(world(seed), civ).eras[east].length);
    expect(keys[0]).toMatch(/^polity:/);
    for (const k of keys.slice(1)) expect(k).toMatch(/^dynasty:/);
  });

  it('写法坏了的读不进;flagOverrides 跳过坏的', () => {
    for (const bad of ['', 'x/plain/W', 'r/nope/W', 'r/plain/', 'r/plain/WWWW', 'r/plain/Z', 'r/plain/W/c=leaf.R.q', 'r/plain/W/c=oak.R.c', 'r/plain/W/m=W4', 'r/plain/W/k=yue', 'r/plain/W/zz=1', `r/plain/W/${'e=R/'.repeat(30)}`, 42, null])
      expect(decodeFlag(bad)).toBeNull();
    expect(decodeFlag('b/plain/W/e=R/k=long')).toEqual({ shape: 'banner', layout: 'plain', c: ['W'], edge: 'R', mark: 'long' });
    expect(decodeFlag('s/hoist/SY/c=tamga.Y.c.50')).toEqual({ shape: 'swallow', layout: 'hoist', c: ['S', 'Y'], charge: { sym: 'tamga', t: 'Y', at: 'center', tamga: 50 } });
    expect(Object.keys(flagOverrides({ 'polity:c1#0': 'r/plain/W', 'polity:c2#0': 'bad' }))).toEqual(['polity:c1#0']);
  });

  it('存档:改过的旗往返;格式不对的跳过并提示;算进"改了几处"', () => {
    const edits: WorldEdits = { ...EMPTY_EDITS, names: {}, flags: { 'polity:c12#0': 'b/plain/W/e=R/k=long', 'dynasty:c12#0/3': 'r/tri-h/RWB/c=leaf.R.c' } };
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, edits, 'abc');
    const r = parseSave(JSON.stringify(save));
    expect(r.ok && r.save.edits.flags).toEqual(edits.flags);
    expect(editCount(edits)).toBe(2);
    expect(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'abc').edits.flags).toBeUndefined();
    const bad = JSON.parse(JSON.stringify(save));
    bad.edits.flags = { 'polity:c12#0': 'b/plain/W/e=R/k=long', 'polity:c13#0': 'nope', 'name:x': 'r/plain/W' };
    const r2 = parseSave(JSON.stringify(bad));
    expect(r2.ok && r2.save.edits.flags).toEqual({ 'polity:c12#0': 'b/plain/W/e=R/k=long' });
    expect(r2.ok && r2.warnings.join()).toContain('2 面改过的旗');
    // 旧存档没有这一项 = 一面也没改
    delete bad.edits.flags;
    const r3 = parseSave(JSON.stringify(bad));
    expect(r3.ok && r3.save.edits.flags).toBeUndefined();
  });

  it('撤销、重做:改旗跟着改名一起走 revertEdits', () => {
    const before: WorldEdits = { ...EMPTY_EDITS, names: {} };
    const after: WorldEdits = { ...before, flags: { 'polity:c12#0': 'r/plain/W' } };
    expect(revertEdits(after, after, before)).toEqual(before);
    expect(revertEdits(before, before, after)).toEqual(after);
  });
});
