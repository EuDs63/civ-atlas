/**
 * 人物页用的数据(gen/civ/peopleInfo.ts、peopleText.ts)和搜人名(ui/searchIndex.ts):
 * 名人按事迹挑、同种子同一批、那句话写得出来;亲属称呼和编年史里的"其弟""其孙"一致;
 * 纪事正文里的人名切得对;某年在位的君主;搜名字、称号找得到人;重推历史后按稳定键找回同一个人。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { reignEntries } from '../src/gen/civ/chronicle';
import {
  FAME_MIN,
  commandFoes,
  famousPeople,
  fameLine,
  generalTally,
  peopleIndex,
  personMentions,
  personSpan,
  riseText,
  rulerAt,
  rulerNeighbors,
} from '../src/gen/civ/peopleInfo';
import { KIN_BACK, kinOf, personName, rulerFateWord, rulerRole, rulerShort } from '../src/gen/civ/peopleText';
import { searchCiv } from '../src/ui/searchIndex';
import { mapTarget, personKey, resolvePersonKey, selectionKey } from '../src/ui/flyTo';

const civs = new Map<number, Civ>();
function civOf(seed: number): Civ {
  let c = civs.get(seed);
  if (!c) civs.set(seed, (c = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }))));
  return c;
}

describe.each([7, 2024])('人物页 · seed=%i', (seed) => {
  it('名人:分数够、按上台年份新的在上;每人一句话,不出 undefined / NaN', () => {
    const civ = civOf(seed);
    const fs = famousPeople(civ);
    expect(fs.length).toBeGreaterThan(10);
    expect(fs.length).toBeLessThan(civ.people!.length / 5);
    let last = Infinity;
    for (const f of fs) {
      const x = civ.people![f.id];
      expect(f.score).toBeGreaterThanOrEqual(FAME_MIN);
      expect(f.deeds.length).toBeGreaterThan(0);
      const from = personSpan(x).from;
      expect(from).toBeLessThanOrEqual(last);
      last = from;
      const line = fameLine(civ, x, f);
      expect(line.length).toBeGreaterThan(4);
      expect(line).not.toMatch(/undefined|NaN|null/);
      expect(personName(civ, x)).not.toMatch(/undefined|NaN/);
    }
    // 将领、君主都有
    expect(fs.some((f) => civ.people![f.id].role === 'ruler')).toBe(true);
    expect(fs.some((f) => civ.people![f.id].role === 'general')).toBe(true);
  });

  it('同种子再生成一次:同一批名人,同样的话', () => {
    const a = civOf(seed);
    const b = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }));
    const lines = (c: Civ) => famousPeople(c).map((f) => `${f.id} ${f.score} ${fameLine(c, c.people![f.id], f)}`);
    expect(lines(b)).toEqual(lines(a));
  });

  it('历代君主:前任 / 继任首尾相接;亲属称呼和编年史里写的一致;某年在位的就是那一位', () => {
    const civ = civOf(seed);
    const ix = peopleIndex(civ);
    const reigns = reignEntries(civ);
    let kinChecked = 0;
    for (const rs of ix.rulers) {
      for (let i = 0; i < (rs?.length ?? 0); i++) {
        const x = rs[i];
        const { prev, next } = rulerNeighbors(civ, x);
        expect(prev?.id ?? -1).toBe(i > 0 ? rs[i - 1].id : -1);
        expect(next?.id ?? -1).toBe(i + 1 < rs.length ? rs[i + 1].id : -1);
        const mid = (x.from! + (x.until ?? civ.endYear)) / 2;
        if (x.until === undefined || x.until > x.from! + 1 / 128) expect(rulerAt(civ, x.polity, mid)?.id).toBe(x.id);
        expect(rulerRole(civ, x)).not.toMatch(/undefined|NaN/);
        if (x.until !== undefined) expect(rulerFateWord(civ, x)).not.toMatch(/undefined/);
        expect(riseText(civ, x)).not.toMatch(/undefined|NaN/);
        // 同一朝的上一位传给他:编年史那一条写"其弟 / 其孙 / 其兄 / 太子 / 其子"
        if (prev && x.rise === 'heir') {
          const e = reigns.find((r) => r.people?.[0] === prev.id && r.people?.[1] === x.id);
          if (!e || civ.polities[x.polity].lineage === 'republic') continue;
          const k = kinOf(prev, x);
          if (k === '子') expect(e.text).toMatch(/太子|世子|其子/);
          else expect(e.text).toContain(`其${k}`);
          expect(KIN_BACK[k]).toBeTruthy();
          kinChecked++;
        }
      }
    }
    expect(kinChecked).toBeGreaterThan(20);
  });

  it('将领:领兵的对手是另一方;攻下 / 守住的次数不为负', () => {
    const civ = civOf(seed);
    const gens = civ.people!.filter((x) => x.role === 'general');
    expect(gens.length).toBeGreaterThan(0);
    for (const x of gens) {
      const foes = commandFoes(civ, x);
      expect(foes.length).toBeGreaterThan(0);
      for (const f of foes) {
        expect(f.polity).not.toBe(x.polity);
        expect(civ.polities[f.polity]).toBeTruthy();
        expect(f.until).toBeGreaterThanOrEqual(f.from);
      }
      const t = generalTally(civ, x);
      expect(t.took).toBeGreaterThanOrEqual(0);
      expect(t.held).toBeGreaterThanOrEqual(0);
    }
  });

  it('纪事里的人名:每条写到的人都切得出来,拼回去和原文一样;自己不切', () => {
    const civ = civOf(seed);
    let found = 0;
    for (const e of reignEntries(civ)) {
      const ms = personMentions(civ, e.text, e.people, -1, e.year);
      expect(ms.map((m) => m.text).join('')).toBe(e.text);
      const ids = ms.filter((m) => m.person !== undefined).map((m) => m.person);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(e.people).toContain(id);
      if (ids.length === e.people!.length) found++;
      // 他自己的卡片里不变蓝
      const self = e.people![0];
      expect(personMentions(civ, e.text, e.people, self, e.year).some((m) => m.person === self)).toBe(false);
    }
    expect(found).toBeGreaterThan(reignEntries(civ).length * 0.9);
  });

  it('搜名字、称号都找得到这个人,点了选中他;重推后按稳定键找回', () => {
    const civ = civOf(seed);
    const x = civ.people!.find((p) => p.role === 'ruler' && p.title && p.until !== undefined)!;
    for (const q of [personName(civ, x), rulerShort(civ, x), x.name]) {
      const hits = searchCiv(civ, q, civ.endYear, 50);
      expect(hits.some((h) => h.kind === 'person' && h.id === x.id && h.select.kind === 'person')).toBe(true);
    }
    expect(mapTarget(civ, { kind: 'person', id: x.id })).toEqual({ kind: 'polity', id: x.polity });
    const key = selectionKey(civ, { kind: 'person', id: x.id });
    expect(key).toBe(personKey(civ, x.id));
    const again = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }));
    expect(resolvePersonKey(again, key)).toBe(x.id);
  });
});

describe('人物页 · 几处写法', () => {
  it('亲属:差 14–39 岁是子,40 岁以上是孙,比上一位小不到 14 岁是弟,比他大是兄', () => {
    const p = (born: number) => ({ born }) as never;
    expect(kinOf(p(100), p(125))).toBe('子');
    expect(kinOf(p(100), p(145))).toBe('孙');
    expect(kinOf(p(100), p(105))).toBe('弟');
    expect(kinOf(p(100), p(98))).toBe('兄');
  });

  it('seed=7:大景圣宗(柳玄)是名人,继兄即位;搜"圣宗"第一个就是他', () => {
    const civ = civOf(7);
    const x = civ.people!.find((p) => p.name === '柳玄' && p.role === 'ruler');
    expect(x).toBeTruthy();
    expect(personName(civ, x!)).toBe('圣宗柳玄');
    expect(rulerRole(civ, x!)).toBe('大景皇帝');
    expect(riseText(civ, x!)).toMatch(/^继兄/);
    expect(famousPeople(civ).some((f) => f.id === x!.id)).toBe(true);
    const hits = searchCiv(civ, '圣宗', 2512);
    expect(hits[0]).toMatchObject({ kind: 'person', id: x!.id, name: '圣宗柳玄', sub: '大景皇帝，2485–2519' });
    // 编年史里写他即位的那条:"大景明宗崩……其弟柳玄即位,是为圣宗" —— 前一位连国名一起切、他切名字
    const e = reignEntries(civ).find((r) => r.people?.[1] === x!.id)!;
    const ms = personMentions(civ, e.text, e.people, -1, e.year).filter((m) => m.person !== undefined);
    expect(ms.map((m) => m.text)).toEqual(['大景明宗', '柳玄']);
  });
});
