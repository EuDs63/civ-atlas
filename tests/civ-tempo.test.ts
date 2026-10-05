/**
 * 改过地形的世界,推演的扩张节拍(民族走一个标准路程要几年)按没改地形时的同一颗星球定(gen/civ/index.ts 的 planetTempo):
 * 远海放一座没人去的小岛,不再把全世界的推演快慢拨动、让各处的历史全跟着错开。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv, planetTempo, type Civ } from '../src/gen/civ';
import { polityName, capitalAt } from '../src/gen/civ/growth';
import type { TerrainOp } from '../src/gen/edits';

/** 结束时还在的国家:国名 + 国都 */
const alive = (c: Civ) =>
  c.polities
    .filter((p) => p.ended === undefined || p.ended > c.endYear)
    .map((p) => `${polityName(p, c.endYear)}@${c.settlements[capitalAt(p, c.endYear)].name}`)
    .sort();
const annals = (c: Civ) => JSON.stringify(c.annals);
/** 史事按人看得到的内容比:年份、种类、国名、州(按治所地块)、城名。多出一座岛的州会插进编号里,所以不按编号比 */
const story = (c: Civ) =>
  c.annals.map((a) => {
    const pn = (id: number) => (c.polities[id] ? polityName(c.polities[id], a.year) : id);
    const seat = a.region >= 0 ? c.regions.seat[a.region] : -1;
    return `${a.year}|${a.kind}|${pn(a.a)}|${a.b}|${seat}|${c.settlements[a.settlement]?.name ?? ''}|${a.war}`;
  });

describe('改过地形的世界沿用原来星球的扩张节拍', () => {
  const SMALL = { ...DEFAULT_PARAMS, cells: 12000, seed: 7 };
  /** 大洋正中一座火山岛:按改后的地形重新标定的话,节拍会被拨动一点 */
  const ISLAND: TerrainOp[] = [{ kind: 'volcano', pts: [0, 660], r: 28, s: 1.05 }];

  it('节拍和没改地形时一样;传进来的节拍和现算的结果逐字节相同', () => {
    const base = generateCiv(generateWorld(SMALL));
    const tempo = planetTempo(SMALL);
    expect(tempo).toBe(base.spreadYears);
    const w = generateWorld(SMALL, undefined, ISLAND);
    expect(w.terrain).toEqual(ISLAND);
    expect(generateCiv({ ...w, terrain: undefined }).spreadYears).not.toBe(base.spreadYears);
    const civ = generateCiv(w);
    expect(civ.spreadYears).toBe(base.spreadYears);
    expect(annals(generateCiv(w, { tempo }))).toBe(annals(civ));
  });

  it('没改地形的世界不看传进来的节拍', () => {
    const w = generateWorld(SMALL);
    expect(w.terrain).toBeUndefined();
    expect(annals(generateCiv(w, { tempo: 1 }))).toBe(annals(generateCiv(w)));
  });

  it('节拍给 null(没改过的星球长不出文明):改过的世界按它自己标定', () => {
    const w = generateWorld(SMALL, undefined, ISLAND);
    const own = generateCiv({ ...w, terrain: undefined });
    expect(generateCiv(w, { tempo: null }).spreadYears).toBe(own.spreadYears);
  });

  // 种子 2024 离陆地最远的那片海(GENERATOR_VERSION 8 时量的;以前这座岛把节拍从 212.0 拨到 211.2,14 国里 6 国的国名或国都变了)。
  // 生成算法以后有意改了、这里成了航路经过的岛,换一处更远的海就行
  it('远海放一座小火山岛:各国、整本史事和没改时一字不差', () => {
    const P = { ...DEFAULT_PARAMS, seed: 2024 };
    const base = generateCiv(generateWorld(P));
    const civ = generateCiv(generateWorld(P, undefined, [{ kind: 'volcano', pts: [91, 728], r: 18, s: 0.85 }]));
    expect(alive(civ)).toEqual(alive(base));
    expect(story(civ)).toEqual(story(base));
  }, 60_000);
});
