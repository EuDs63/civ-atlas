/**
 * 编年史(阶段 3):civ.annals → 中文纪事。
 * 措辞、折叠、重要度用手工造的史事测;再用真实世界(seed 7 / 2024)核对措辞、被迫迁都折进战争、"大事"的条数。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Annal, AnnalKind, Civ, Culture, Polity, Settlement } from '../src/gen/civ/types';
import { polityTierAt } from '../src/gen/civ/growth';
import {
  BIG_WAR,
  CAPITAL_TIER,
  FALL_WAR,
  MAJOR,
  TITAN_WAR,
  buildChronicle,
  chronicleText,
  cnNumber,
  entryInvolves,
  entryYearLabel,
  filterChronicle,
  type ChronicleEntry,
} from '../src/gen/civ/chronicle';

// ---------------------------------------------------------------------------
// 手工造的世界:10 个州、6 个国家、九种史事都有

const REGION_NAMES = ['汾州', '瑞州', '青州', '柳州', '白州', '渭州', '', '云州', '石州', '金州'];

function polity(id: number, name: string, founded: number, titles: [number, number][], extra: Partial<Polity> = {}): Polity {
  return {
    id,
    name,
    culture: 0,
    capital: extra.capital ?? 0,
    founded,
    kind: 'farm',
    expansionism: 1,
    color: [120, 90, 60],
    lineage: 'realm',
    titles: titles.map(([year, tier]) => ({ year, tier })),
    capitals: [{ year: founded, settlement: extra.capital ?? 0 }],
    ...extra,
  };
}

function settlement(id: number, name: string, region: number): Settlement {
  return { id, cell: 0, region, culture: 0, name, founded: 0, capacity: 50, growth: 0.002, port: false };
}

let seq = 0;
function annal(year: number, kind: AnnalKind, f: Partial<Omit<Annal, 'year' | 'kind'>> = {}): Annal {
  seq++;
  return { year, kind, a: f.a ?? -1, b: f.b ?? -1, region: f.region ?? -1, settlement: f.settlement ?? -1, war: f.war ?? -1 };
}

function fakeCiv(): Civ {
  const settlements = [
    settlement(0, '汾城', 0),
    settlement(1, '瑞城', 1),
    settlement(2, '渭城', 5),
    settlement(3, '青阳', 2),
    settlement(4, '金陵', 9),
    settlement(5, '索城', 8),
    settlement(6, '艾城', 7),
  ];
  const chang = polity(0, '昌', 812, [
    [812, 0],
    [900, 1],
  ], { eastern: true, capital: 0 });
  chang.capitals = [
    { year: 812, settlement: 0 },
    { year: 1300.5, settlement: 3 },
  ];
  chang.ended = 1305;
  const wei = polity(1, '渭', 700, [
    [700, 0],
    [800, 1],
    [1000, 2],
  ], { eastern: true, capital: 2 });
  wei.capitals = [
    { year: 700, settlement: 2 },
    { year: 1350, settlement: 0 },
  ];
  const sola = polity(2, '索拉特', 900, [
    [900, 0],
    [950, 1],
    [1200, 2],
    [1400, 3],
  ], { lineage: 'khanate', kind: 'nomad', capital: 5 });
  sola.ended = 1800;
  const ailes = polity(3, '艾莱斯', 1000, [
    [1000, 0],
    [1050, 1],
    [1100, 2],
    [1500, 3],
    [1600, 2],
  ], { capital: 6 });
  const rui = polity(4, '瑞', 1400, [[1400, 0]], { eastern: true, capital: 1 });
  const qing = polity(5, '青', 1100, [[1100, 0]], { eastern: true, capital: 4 });
  qing.ended = 1500;

  seq = 0;
  const annals: Annal[] = [
    annal(700, 'found', { a: 1, region: 5, settlement: 2 }),
    annal(800, 'rank', { a: 1, region: 5, settlement: 2 }),
    annal(812, 'found', { a: 0, region: 0, settlement: 0 }),
    annal(900, 'rank', { a: 0, region: 0, settlement: 0 }),
    annal(900, 'found', { a: 2, region: 8, settlement: 5 }),
    annal(950, 'rank', { a: 2, region: 8, settlement: 5 }),
    annal(1000, 'rank', { a: 1, region: 5, settlement: 2 }),
    annal(1000, 'found', { a: 3, region: 7, settlement: 6 }),
    annal(1050, 'rank', { a: 3, region: 7, settlement: 6 }),
    annal(1100, 'rank', { a: 3, region: 7, settlement: 6 }),
    annal(1100, 'found', { a: 5, region: 9, settlement: 4 }),
    annal(1200, 'rank', { a: 2, region: 8, settlement: 5 }),
    // 第一场战争:渭伐昌,三次攻占(其中一州被昌夺回),议和
    annal(1240.25, 'war', { a: 1, b: 0, war: 0 }),
    annal(1243, 'conquer', { a: 1, b: 0, region: 1, settlement: 1, war: 0 }),
    annal(1250, 'conquer', { a: 1, b: 0, region: 3, war: 0 }),
    annal(1252, 'conquer', { a: 0, b: 1, region: 3, war: 0 }),
    annal(1254, 'conquer', { a: 1, b: 0, region: 4, war: 0 }),
    annal(1256.5, 'peace', { a: 1, b: 0, war: 0 }),
    // 第二场:攻下国都、被迫迁都(带战争编号)、再攻下新都、灭亡、议和(同一年的先后:攻占 → 灭亡 / 迁都 → 议和)
    annal(1280, 'war', { a: 1, b: 0, war: 1 }),
    annal(1300.5, 'conquer', { a: 1, b: 0, region: 0, settlement: 0, war: 1 }),
    annal(1300.5, 'capital', { a: 0, region: 2, settlement: 3, war: 1 }),
    annal(1305, 'conquer', { a: 1, b: 0, region: 2, settlement: 3, war: 1 }),
    annal(1305, 'fall', { a: 0, b: 1, region: 2, war: 1 }),
    annal(1305, 'peace', { a: 1, b: 0, war: 1 }),
    // 收服部落:三次接连(一轮),隔很久再一次(另一轮)
    annal(1320, 'conquer', { a: 2, region: 7 }),
    annal(1330, 'conquer', { a: 2, region: 8 }),
    annal(1340, 'conquer', { a: 2, region: 6 }),
    // 主动迁都(不在战争里,war = −1)
    annal(1350, 'capital', { a: 1, region: 0, settlement: 0 }),
    annal(1400, 'split', { a: 4, b: 1, region: 1, settlement: 1 }),
    annal(1400, 'found', { a: 4, region: 1, settlement: 1 }),
    annal(1400, 'rank', { a: 2, region: 8, settlement: 5 }),
    annal(1500, 'merge', { a: 1, b: 5 }),
    annal(1500, 'fall', { a: 5, region: 9 }),
    annal(1500, 'rank', { a: 3, region: 7, settlement: 6 }),
    annal(1520, 'conquer', { a: 2, region: 9 }),
    annal(1550, 'conquer', { a: 1, b: 3, region: 7, settlement: 6 }),
    annal(1600, 'rank', { a: 3, region: 7, settlement: 6 }),
    // 打到结束年份还没打完
    annal(1700, 'war', { a: 3, b: 2, war: 2 }),
    annal(1710, 'conquer', { a: 3, b: 2, region: 9, war: 2 }),
    // 自己瓦解,最后失去的州不详
    annal(1800, 'fall', { a: 2 }),
  ];
  return {
    seed: 1,
    endYear: 2000,
    regions: {
      count: REGION_NAMES.length,
      name: REGION_NAMES,
      capacity: Float32Array.from([50, 40, 30, 20, 10, 60, 5, 8, 9, 7]),
    },
    polities: [chang, wei, sola, ailes, rui, qing],
    settlements,
    annals,
  } as unknown as Civ;
}

const BAD = /undefined|NaN|null|−1|-1|第 0 州|某国|Infinity|\[object/;

function flat(list: readonly ChronicleEntry[]): ChronicleEntry[] {
  return list.flatMap((e) => [e, ...(e.children ?? [])]);
}

function clean(e: ChronicleEntry) {
  expect(e.text.length, JSON.stringify(e)).toBeGreaterThan(2);
  expect(e.text, e.text).not.toMatch(BAD);
  expect(e.text, e.text).toMatch(/[\u4e00-\u9fff]/);
  expect(e.tag).toMatch(/^[\u4e00-\u9fff]$/);
  expect(Number.isFinite(e.year) && Number.isFinite(e.end)).toBe(true);
  expect(e.end).toBeGreaterThanOrEqual(e.year);
  for (const p of e.polities) expect(p).toBeGreaterThanOrEqual(0);
  for (const r of e.regions) expect(r).toBeGreaterThanOrEqual(0);
  expect([1, 2, 3]).toContain(e.importance);
  expect(entryYearLabel(e)).toMatch(/^第 \d+(—\d+)? 年$/);
}

describe('编年史', () => {
  const civ = fakeCiv();
  const list = buildChronicle(civ);
  const all = flat(list);
  const find = (re: RegExp) => all.find((e) => re.test(e.text));

  it('九种史事都写成了非空中文,没有 undefined / NaN / −1 / "第 0 州"', () => {
    const kinds = new Set(all.map((e) => e.kind));
    for (const k of ['found', 'rank', 'war', 'conquer', 'peace', 'fall', 'capital', 'split', 'merge'] as AnnalKind[]) {
      expect(kinds.has(k), k).toBe(true);
    }
    for (const e of all) clean(e);
    const text = chronicleText(list, '编年史');
    expect(text).not.toMatch(BAD);
  });

  it('措辞:立国、升格、称帝、降格、迁都、分裂、合并、灭亡', () => {
    expect(find(/^昌部立国/)?.text).toBe('昌部立国,都于汾城');
    expect(find(/^昌部升格/)?.text).toBe('昌部升格为昌国');
    expect(find(/^渭国升格/)?.text).toBe('渭国升格为大渭');
    expect(find(/称帝/)?.text).toBe('艾莱斯王国称帝,改号艾莱斯帝国');
    expect(find(/降为/)?.text).toBe('艾莱斯帝国国势衰微,降为艾莱斯王国');
    // 游牧汗国第 1 → 2 档国号不变:不写"升格为索拉特汗国"
    expect(find(/拓地至/)?.text).toBe('索拉特汗国拓地至二十五州');
    expect(find(/大汗国/)?.text).toBe('索拉特汗国升格为索拉特大汗国');
    // 主动迁都单列;被迫迁都在战争的子条目里,紧跟"国都汾城陷落",只说迁到哪
    expect(find(/^大渭自/)?.text).toBe('大渭自渭城迁都汾城');
    expect(find(/^昌国迁都/)?.text).toBe('昌国迁都青阳');
    expect(find(/叛/)?.text).toBe('瑞州叛大渭自立,号瑞部,都于瑞城');
    expect(find(/并入/)?.text).toBe('青部并入大渭');
    expect(find(/土崩瓦解/)?.text).toBe('索拉特大汗国土崩瓦解,享国 900 年');
    // 分裂出来的国家不再重复记"立国";并入别国的不再记"瓦解"
    expect(all.filter((e) => /瑞部立国/.test(e.text))).toHaveLength(0);
    expect(all.filter((e) => /青部土崩瓦解/.test(e.text))).toHaveLength(0);
    // 夺别国的州(不在战争里);艾城是艾莱斯的国都
    expect(find(/攻取艾莱斯/)?.text).toBe('大渭攻取艾莱斯帝国之云州,国都艾城陷落');
  });

  it('一场战争 + 多次攻占折叠成一条:起止年份、双方、结果;点开是每一件事', () => {
    const wars = list.filter((e) => e.kind === 'war');
    expect(wars).toHaveLength(3);
    const [w0, w1, w2] = wars;
    expect(entryYearLabel(w0)).toBe('第 1240—1256 年');
    // 柳州被昌夺回,净得瑞州、白州
    expect(w0.text).toBe('大渭伐昌国,得瑞州、白州');
    expect(w0.children!.map((c) => c.kind)).toEqual(['war', 'conquer', 'conquer', 'conquer', 'conquer', 'peace']);
    expect(w0.children![1].text).toBe('大渭攻取瑞州,瑞城陷落');
    expect(w0.children![3].text).toBe('昌国夺回柳州');
    expect(w0.children![5].text).toBe('大渭与昌国议和,得瑞州、白州');
    expect(w0.polities).toEqual([1, 0]);
    expect(w0.regions.sort()).toEqual([1, 3, 4]);
    // 攻下国都、灭国(昌只到过第 1 档、只易手两州:小国被灭,不算大事)
    expect(w1.text).toBe('大渭伐昌国,得汾州、青州,昌国亡');
    expect(w1.importance).toBe(2);
    expect(w1.children!.map((c) => c.text)).toContain('大渭攻取汾州,国都汾城陷落');
    expect(w1.children!.map((c) => c.text)).toContain('大渭攻取青州,国都青阳陷落');
    expect(w1.children!.at(-1)!.text).toBe('昌国既亡,兵戈遂息');
    // 亡国另列一条
    expect(list.filter((e) => e.kind === 'fall').map((e) => e.text)).toContain('昌国亡于大渭,享国 493 年');
    // 战事未休
    expect(w2.ongoing).toBe(true);
    expect(w2.end).toBe(2000);
    expect(w2.text).toBe('艾莱斯王国伐索拉特大汗国,已得金州,战事未休');
    // 战争里的攻占不再单独列出
    expect(list.filter((e) => e.kind === 'conquer' && !e.children).every((e) => !/瑞州,瑞城/.test(e.text))).toBe(true);
  });

  it('收服部落:同一国接连几次折叠成一条,隔得久的另起一条', () => {
    const tribal = list.filter((e) => e.tag === '征');
    expect(tribal).toHaveLength(2);
    expect(tribal[0].children).toHaveLength(3);
    expect(tribal[0].text).toBe('索拉特汗国征服石州等三州诸部');
    expect(entryYearLabel(tribal[0])).toBe('第 1320—1340 年');
    expect(tribal[0].children![2].text).toBe('索拉特汗国征服第 7 州诸部');
    expect(tribal[1].children).toBeUndefined();
    expect(tribal[1].text).toBe('索拉特大汗国征服金州诸部');
    expect(tribal[1].importance).toBe(1);
  });

  it('收服部落:一国一直在扩张时,每一百年左右一条', () => {
    const c = fakeCiv();
    c.annals = Array.from({ length: 60 }, (_, i) => annal(1000 + i * 10, 'conquer', { a: 1, region: i % 10 }));
    const out = buildChronicle(c);
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.length).toBeLessThanOrEqual(7);
    for (const e of out) expect(e.end - e.year).toBeLessThanOrEqual(100);
    expect(out.reduce((n, e) => n + (e.children?.length ?? 1), 0)).toBe(60);
  });

  it('条目按年份排好(子条目也是);同一年按发生先后', () => {
    for (let i = 1; i < list.length; i++) expect(list[i].year).toBeGreaterThanOrEqual(list[i - 1].year);
    for (const e of list) {
      const c = e.children ?? [];
      for (let i = 1; i < c.length; i++) expect(c[i].year).toBeGreaterThanOrEqual(c[i - 1].year);
    }
    // 第 1500 年:合并在称帝之前(史事里的先后)
    const y1500 = list.filter((e) => e.year === 1500).map((e) => e.kind);
    expect(y1500).toEqual(['merge', 'rank']);
    // id 唯一(列表 key)
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
  });

  it('按国家筛选、只看大事', () => {
    const chang = filterChronicle(list, { polity: 0 });
    expect(chang.length).toBeGreaterThan(0);
    for (const e of chang) expect(entryInvolves(e, 0)).toBe(true);
    // 昌:立国、升格、两场战争(被迫迁都在第二场里)、灭亡
    expect(chang.map((e) => e.kind)).toEqual(['found', 'rank', 'war', 'war', 'fall']);
    const notChang = list.filter((e) => !chang.includes(e));
    for (const e of notChang) expect(entryInvolves(e, 0)).toBe(false);
    const major = filterChronicle(list, { major: true });
    expect(major.length).toBeLessThan(list.length);
    for (const e of major) expect(e.importance).toBeGreaterThanOrEqual(MAJOR);
    // 瑞一直是部落:分出来只在"全部"里;索拉特(到过第 3 档):立国、称大汗、瓦解
    expect(filterChronicle(list, { major: true, polity: 4 })).toEqual([]);
    expect(filterChronicle(list, { major: true, polity: 2 }).map((e) => e.kind)).toEqual(['found', 'rank', 'fall']);
  });

  it('大事:大国立国、称王称帝、大国瓦解;小国立国、部 → 国、小国分合、小国被灭、王国迁都、小仗、收服部落、战争里的亡国只在"全部"里', () => {
    const major = filterChronicle(list, { major: true });
    const texts = major.map((e) => e.text);
    expect(texts).toEqual([
      '渭部立国,都于渭城', // 渭到过第 2 档(大渭):大国
      '索拉特部立国,都于索城',
      '渭国升格为大渭', // 升到第 2 档,而且是渭到过的最高一档:称王
      '艾莱斯部立国,都于艾城',
      '索拉特汗国升格为索拉特大汗国',
      '艾莱斯王国称帝,改号艾莱斯帝国',
      '索拉特大汗国土崩瓦解,享国 900 年', // 大国瓦解
    ]);
    const imp = (t: string) => all.find((e) => e.text === t)?.importance;
    // 小国被灭(只易手两州)、王国(第 2 档)主动迁都、部落分出来、部落并入大国:只在"全部"里
    expect(imp('大渭伐昌国,得汾州、青州,昌国亡')).toBe(2);
    expect(imp('大渭自渭城迁都汾城')).toBe(2);
    expect(imp('瑞州叛大渭自立,号瑞部,都于瑞城')).toBe(2);
    expect(imp('青部并入大渭')).toBe(2);
    // 昌只到过第 1 档:立国不是大事;青一直是部落
    expect(imp('昌部立国,都于汾城')).toBe(2);
    expect(imp('青部立国,都于金陵')).toBe(2);
    expect(imp('昌部升格为昌国')).toBe(1);
    // 艾莱斯升到第 2 档以后还称帝:"大事"里只留称帝,"称王"只在全部里
    expect(imp('艾莱斯国升格为艾莱斯王国')).toBe(2);
    expect(imp('艾莱斯帝国国势衰微,降为艾莱斯王国')).toBe(2);
    expect(imp('索拉特汗国拓地至二十五州')).toBe(2);
    // 只得了两州的仗、打到结束年份还没打完的小仗
    expect(list.find((e) => e.text === '大渭伐昌国,得瑞州、白州')?.importance).toBe(2);
    expect(list.find((e) => e.ongoing)?.importance).toBe(2);
    // 亡于战争的,单列的那条不算大事(战争那一条已经写了"昌国亡")
    expect(list.find((e) => e.kind === 'fall' && e.text.startsWith('昌国亡于'))?.importance).toBe(2);
    expect(major.some((e) => e.tag === '征')).toBe(false);
  });

  it('夺回:议和割让、分裂出去的州,后来在另一场战争里打回来,写"夺回"不写"攻取"', () => {
    const c = fakeCiv();
    seq = 0;
    c.annals = [
      // 渭伐昌,得瑞州,议和
      annal(1240, 'war', { a: 1, b: 0, war: 0 }),
      annal(1243, 'conquer', { a: 1, b: 0, region: 1, settlement: 1, war: 0 }),
      annal(1256, 'peace', { a: 1, b: 0, war: 0 }),
      // 昌再伐渭,打回瑞州
      annal(1270, 'war', { a: 0, b: 1, war: 1 }),
      annal(1272, 'conquer', { a: 0, b: 1, region: 1, settlement: 1, war: 1 }),
      annal(1275, 'peace', { a: 0, b: 1, war: 1 }),
      // 白州叛渭自立(白州原是渭的),渭后来伐瑞打回白州;青州从来不是渭的,照旧写"攻取"
      annal(1400, 'split', { a: 4, b: 1, region: 4 }),
      annal(1470, 'war', { a: 1, b: 4, war: 2 }),
      annal(1472, 'conquer', { a: 1, b: 4, region: 4, war: 2 }),
      annal(1474, 'conquer', { a: 1, b: 4, region: 2, war: 2 }),
      annal(1480, 'peace', { a: 1, b: 4, war: 2 }),
    ];
    const all = flat(buildChronicle(c));
    expect(all.find((e) => e.id === 4)?.text).toBe('昌国夺回瑞州,收复瑞城');
    expect(all.find((e) => e.id === 8)?.text).toBe('大渭夺回白州');
    expect(all.find((e) => e.id === 9)?.text).toBe('大渭攻取青州');
  });

  it('被迫迁都(capital 带战争编号)折进那场战争:不单列;标题写"某国国都某城陷落" / "连迁两都",亡了就只说亡', () => {
    const c = fakeCiv();
    const chang = c.polities[0];
    chang.capitals = [
      { year: 812, settlement: 0 },
      { year: 1243, settlement: 3 },
      { year: 1272, settlement: 1 },
      { year: 1276, settlement: 4 },
    ];
    chang.ended = 1300;
    seq = 0;
    c.annals = [
      // 丢了国都汾城,迁都青阳
      annal(1240, 'war', { a: 1, b: 0, war: 0 }),
      annal(1243, 'conquer', { a: 1, b: 0, region: 0, settlement: 0, war: 0 }),
      annal(1243, 'capital', { a: 0, region: 2, settlement: 3, war: 0 }),
      annal(1256, 'peace', { a: 1, b: 0, war: 0 }),
      // 一场战争里连丢两座国都:青阳 → 瑞城 → 金陵
      annal(1270, 'war', { a: 1, b: 0, war: 1 }),
      annal(1272, 'conquer', { a: 1, b: 0, region: 2, settlement: 3, war: 1 }),
      annal(1272, 'capital', { a: 0, region: 1, settlement: 1, war: 1 }),
      annal(1276, 'conquer', { a: 1, b: 0, region: 1, settlement: 1, war: 1 }),
      annal(1276, 'capital', { a: 0, region: 9, settlement: 4, war: 1 }),
      annal(1280, 'peace', { a: 1, b: 0, war: 1 }),
      // 主动迁都(war = −1)照常单列
      annal(1290, 'capital', { a: 1, region: 0, settlement: 0 }),
      // 丢了最后的国都,亡国
      annal(1298, 'war', { a: 1, b: 0, war: 2 }),
      annal(1300, 'conquer', { a: 1, b: 0, region: 9, settlement: 4, war: 2 }),
      annal(1300, 'fall', { a: 0, b: 1, region: 9, war: 2 }),
      annal(1300, 'peace', { a: 1, b: 0, war: 2 }),
    ];
    c.polities[1].capitals = [
      { year: 700, settlement: 2 },
      { year: 1290, settlement: 0 },
    ];
    const list = buildChronicle(c);
    // 顶层只有主动迁都那一条 capital
    expect(list.filter((e) => e.kind === 'capital').map((e) => e.text)).toEqual(['大渭自渭城迁都汾城']);
    const wars = list.filter((e) => e.kind === 'war');
    expect(wars.map((w) => w.text)).toEqual([
      '大渭伐昌国,得汾州,昌国国都汾城陷落',
      '大渭伐昌国,得瑞州、青州,昌国连迁两都',
      '大渭伐昌国,得金州,昌国亡',
    ]);
    // 子条目:"国都某城陷落"后面紧跟"某国迁都某城"
    expect(wars[0].children!.map((k) => k.text)).toEqual(['大渭起兵伐昌国', '大渭攻取汾州,国都汾城陷落', '昌国迁都青阳', '大渭与昌国议和,得汾州']);
    expect(wars[1].children!.filter((k) => k.kind === 'capital').map((k) => k.text)).toEqual(['昌国迁都瑞城', '昌国迁都金陵']);
    for (const w of wars) for (const k of w.children!) clean(k);
    // 每一条被迫迁都都在它那场战争的子条目里
    const ids = new Set(wars.flatMap((w) => w.children!.map((k) => k.id)));
    c.annals.forEach((e, i) => {
      if (e.kind === 'capital') expect(ids.has(i), `${i}`).toBe(e.war >= 0);
    });
    // 昌只到过第 1 档:丢了做了四百多年的国都也不算大事;小国被灭(只易手一州)也不算
    expect(wars.map((w) => w.importance)).toEqual([2, 2, 2]);
    const text = chronicleText(list);
    expect(text).toContain('第 1240—1256 年 大渭伐昌国,得汾州,昌国国都汾城陷落\n    第 1240 年 大渭起兵伐昌国\n    第 1243 年 大渭攻取汾州,国都汾城陷落\n    第 1243 年 昌国迁都青阳');

    // 大国(到过第 2 档)丢了做了 OLD_CAPITAL 年以上的国都、大国亡了:改变格局,算大事
    const c2 = fakeCiv();
    c2.polities[0].titles!.push({ year: 1200, tier: 2 });
    c2.polities[0].capitals = chang.capitals;
    c2.polities[1].capitals = c.polities[1].capitals;
    c2.annals = c.annals;
    expect(buildChronicle(c2).filter((e) => e.kind === 'war').map((w) => w.importance)).toEqual([3, 2, 3]);
  });

  it('战争的重要度:易手 ≥ BIG_WAR 州、两个第 3 档大国交兵易手 ≥ TITAN_WAR 州是大事;部落亡了、无功而还不是', () => {
    const war = (a: number, b: number, year: number, n: number, extra: Annal[] = []) => {
      const c = fakeCiv();
      seq = 0;
      c.annals = [
        annal(year, 'war', { a, b, war: 0 }),
        ...Array.from({ length: n }, (_, r) => annal(year + 1 + r, 'conquer', { a, b, region: r, war: 0 })),
        ...extra,
        annal(year + 20, 'peace', { a, b, war: 0 }),
      ];
      return buildChronicle(c).find((e) => e.kind === 'war')!;
    };
    // 渭伐艾莱斯(第 2 档打第 3 档)
    expect(war(1, 3, 1540, BIG_WAR).importance).toBe(3);
    expect(war(1, 3, 1540, BIG_WAR).text).toBe('大渭伐艾莱斯帝国,得渭州等十州');
    expect(war(1, 3, 1540, BIG_WAR - 1).importance).toBe(2);
    // 第 1550 年艾莱斯、索拉特都是第 3 档:大国交兵
    expect(war(3, 2, 1550, TITAN_WAR).importance).toBe(3);
    expect(war(3, 2, 1550, TITAN_WAR - 1).importance).toBe(2);
    // 第 1700 年艾莱斯已经降回第 2 档
    expect(war(3, 2, 1700, TITAN_WAR).importance).toBe(2);
    // 无功而还
    const none = war(3, 2, 1550, 0);
    expect(none.text).toBe('艾莱斯帝国伐索拉特大汗国,无功而还');
    expect(none.importance).toBe(1);
    // 青一直是部落:灭了它不算灭国
    const tribe = war(1, 5, 1200, 1, [annal(1201, 'fall', { a: 5, b: 1, region: 0, war: 0 })]);
    expect(tribe.text).toBe('大渭伐青部,得汾州,青部亡');
    expect(tribe.importance).toBe(2);
    // 灭国:亡的是大国一律是大事;小国(昌只到过第 1 档)要易手 ≥ FALL_WAR 州才算吞并了一个像样的国家
    const fallAt = (n: number) => [annal(1250 + n, 'fall', { a: 0, b: 1, region: n - 1, war: 0 })];
    expect(war(1, 0, 1230, FALL_WAR, fallAt(FALL_WAR)).importance).toBe(3);
    expect(war(1, 0, 1230, FALL_WAR - 1, fallAt(FALL_WAR - 1)).importance).toBe(2);
  });

  it('战争的重要度:小国分出去又被原主收回,不算改变格局(易手 ≥ BIG_WAR 州的照旧);别国灭了它照旧是大事', () => {
    const war = (a: number, n: number) => {
      const c = fakeCiv();
      c.polities[4].parent = 1;
      c.polities[4].titles = [{ year: 1400, tier: 1 }];
      seq = 0;
      c.annals = [
        annal(1400, 'split', { a: 4, b: 1, region: 1, settlement: 1 }),
        annal(1450, 'war', { a, b: 4, war: 0 }),
        ...Array.from({ length: n }, (_, r) => annal(1451 + r, 'conquer', { a, b: 4, region: r, war: 0 })),
        annal(1451 + n, 'fall', { a: 4, b: a, region: n - 1, war: 0 }),
        annal(1451 + n, 'peace', { a, b: 4, war: 0 }),
      ];
      return buildChronicle(c).find((e) => e.kind === 'war')!;
    };
    // 渭收回瑞(瑞是从渭分出去的)
    expect(war(1, FALL_WAR).importance).toBe(2);
    expect(war(1, BIG_WAR).importance).toBe(3);
    // 索拉特灭瑞:吞并;"大事"里瑞第一次出现,带一句来历
    const other = war(2, FALL_WAR);
    expect(other.importance).toBe(3);
    expect(other.text).toBe('索拉特大汗国伐瑞国(第 1400 年叛大渭自立),得汾州等五州,瑞国亡');
  });

  it('议和割让写"议定疆界,某州划归某国",残部一并归攻方写"余下某州尽归某国",都不写"攻取"', () => {
    const c = fakeCiv();
    c.polities[0].capitals = [{ year: 812, settlement: 0 }];
    seq = 0;
    const annals = [
      annal(1240, 'war', { a: 1, b: 0, war: 0 }),
      annal(1243, 'conquer', { a: 1, b: 0, region: 1, settlement: 1, war: 0 }),
      // 议和时两国互割飞地:渭得柳州、白州,昌得云州(peace 的 region = 紧挨在前面的三条)
      annal(1250, 'conquer', { a: 1, b: 0, region: 3, war: 0 }),
      annal(1250, 'conquer', { a: 1, b: 0, region: 4, war: 0 }),
      annal(1250, 'conquer', { a: 0, b: 1, region: 7, war: 0 }),
      annal(1250, 'peace', { a: 1, b: 0, region: 3, war: 0 }),
      // 丢了国都撑不下去:残部两州一并归渭,亡国
      annal(1300, 'war', { a: 1, b: 0, war: 1 }),
      annal(1305, 'conquer', { a: 1, b: 0, region: 0, settlement: 0, war: 1 }),
      annal(1305, 'conquer', { a: 1, b: 0, region: 2, war: 1 }),
      annal(1305, 'conquer', { a: 1, b: 0, region: 8, war: 1 }),
      annal(1305, 'fall', { a: 0, b: 1, region: 8, war: 1 }),
      annal(1305, 'peace', { a: 1, b: 0, war: 1 }),
    ];
    c.annals = annals;
    const [w0, w1] = buildChronicle(c).filter((e) => e.kind === 'war');
    expect(w0.children!.map((k) => k.text)).toEqual([
      '大渭起兵伐昌国',
      '大渭攻取瑞州,瑞城陷落',
      '议定疆界,柳州、白州划归大渭,云州划归昌国',
      '大渭与昌国议和,得瑞州等三州;昌国得云州',
    ]);
    const cede = w0.children![2];
    expect(cede.tag).toBe('割');
    expect(cede.kind).toBe('conquer');
    expect(cede.regions).toEqual([3, 4, 7]);
    expect(cede.id).toBe(2);
    // 攻方有得有失:"得…而失…"
    expect(w0.text).toBe('大渭伐昌国,得瑞州等三州而失云州');
    expect(w1.children!.map((k) => k.text)).toEqual([
      '大渭起兵伐昌国',
      '大渭攻取汾州,国都汾城陷落',
      '余下青州、石州尽归大渭',
      '昌国亡于大渭,享国 493 年',
      '昌国既亡,兵戈遂息',
    ]);
    for (const w of [w0, w1]) for (const k of w.children!) clean(k);
    // 只剩一州:"余下某州亦归某国"
    const c1 = fakeCiv();
    c1.polities[0].capitals = [{ year: 812, settlement: 0 }];
    c1.annals = annals.filter((e) => e.region !== 8 || e.kind === 'fall');
    const one = buildChronicle(c1).filter((e) => e.kind === 'war')[1];
    expect(one.children!.map((k) => k.text)).toContain('余下青州亦归大渭');
  });

  it('攻方先得后失、守方丢了国都:一眼分清两边("得…而失…,某国国都某城陷落",只有一个"失")', () => {
    const mk = (withGains: boolean) => {
      const c = fakeCiv();
      c.polities[0].capitals = [
        { year: 812, settlement: 0 },
        { year: 1250, settlement: 3 },
      ];
      seq = 0;
      c.annals = [
        annal(1240, 'war', { a: 1, b: 0, war: 0 }),
        ...(withGains
          ? [
              annal(1243, 'conquer', { a: 1, b: 0, region: 1, settlement: 1, war: 0 }),
              annal(1250, 'conquer', { a: 1, b: 0, region: 0, settlement: 0, war: 0 }),
              annal(1250, 'capital', { a: 0, region: 2, settlement: 3, war: 0 }),
            ]
          : []),
        annal(1252, 'conquer', { a: 0, b: 1, region: 5, settlement: 2, war: 0 }),
        annal(1256, 'peace', { a: 1, b: 0, war: 0 }),
      ];
      return buildChronicle(c).find((e) => e.kind === 'war')!;
    };
    const w = mk(true);
    expect(w.text).toBe('大渭伐昌国,得汾州、瑞州而失渭州,昌国国都汾城陷落');
    expect(w.text.match(/失/g)).toHaveLength(1);
    // 只失不得:"反失"
    expect(mk(false).text).toBe('大渭伐昌国,反失渭州');
  });

  it('来历:大事里第一次出现、来历不在大事里的国家,名字后面带一句;改朝换代换了国号(那次不是大事)的带"原某国"', () => {
    const c = fakeCiv();
    // 昌:第 1100 年(第 1 档,改朝换代不是大事)改号"景",第 1200 年升到第 2 档(大国,称王是大事)
    const chang = c.polities[0];
    chang.titles = [
      { year: 812, tier: 0 },
      { year: 900, tier: 1 },
      { year: 1200, tier: 2 },
    ];
    chang.dynasties = [
      { year: 812, name: '昌', seat: 0 },
      { year: 1100, name: '景', seat: 0 },
    ];
    delete chang.ended;
    // 青:第 1100 年立国的小国(第 1 档),第 1250 年被渭吞并
    c.polities[5].titles = [
      { year: 1100, tier: 0 },
      { year: 1150, tier: 1 },
    ];
    c.polities[5].ended = 1260;
    seq = 0;
    c.annals = [
      annal(812, 'found', { a: 0, region: 0, settlement: 0 }),
      annal(900, 'rank', { a: 0, region: 0, settlement: 0 }),
      annal(1100, 'dynasty', { a: 0, region: 0, settlement: 0 }),
      annal(1100, 'found', { a: 5, region: 9, settlement: 4 }),
      annal(1150, 'rank', { a: 5, region: 9, settlement: 4 }),
      annal(1200, 'rank', { a: 0, region: 0, settlement: 0 }),
      annal(1250, 'war', { a: 1, b: 5, war: 0 }),
      ...Array.from({ length: FALL_WAR }, (_, r) => annal(1251 + r, 'conquer', { a: 1, b: 5, region: r + 1, war: 0 })),
      annal(1251 + FALL_WAR, 'fall', { a: 5, b: 1, region: FALL_WAR, war: 0 }),
      annal(1251 + FALL_WAR, 'peace', { a: 1, b: 5, war: 0 }),
    ];
    const list = buildChronicle(c);
    const major = filterChronicle(list, { major: true }).map((e) => e.text);
    expect(major).toEqual(['昌部立国,都于汾城', '景国(原昌国)升格为大景', '大渭伐青国(第 1100 年立国),得渭州等五州,青国亡']);
    // 小事不带来历
    expect(list.find((e) => e.kind === 'dynasty')!.importance).toBe(2);
    expect(list.find((e) => e.kind === 'found' && e.polities[0] === 5)!.text).toBe('青部立国,都于金陵');
  });

  it('合写:改朝换代后不久有州叛离、亡国后逃难的迁徙,写进前一件大事,"大事"里不单占一行("全部"里照旧)', () => {
    const c = fakeCiv();
    const wei = c.polities[1];
    wei.dynasties = [
      { year: 700, name: '渭', seat: 2 },
      { year: 1100, name: '秦', seat: 2 },
    ];
    wei.culture = 1;
    const rui = c.polities[4];
    rui.founded = 1105;
    rui.parent = 1;
    rui.titles = [{ year: 1105, tier: 2 }];
    c.cultures = [
      { id: 0, name: '昌', migrations: [{ year: 1300, dir: '南' }] },
      { id: 1, name: '渭' },
    ] as unknown as Culture[];
    c.polities[0].capitals = [{ year: 812, settlement: 0 }];
    seq = 0;
    c.annals = [
      annal(1100, 'dynasty', { a: 1, region: 5, settlement: 2 }),
      annal(1105, 'split', { a: 4, b: 1, region: 1, settlement: 1 }),
      annal(1290, 'war', { a: 1, b: 0, war: 0 }),
      ...[0, 2, 3, 4, 6].map((r, k) => annal(1291 + k, 'conquer', { a: 1, b: 0, region: r, war: 0 })),
      annal(1295, 'fall', { a: 0, b: 1, region: 6, war: 0 }),
      annal(1295, 'peace', { a: 1, b: 0, war: 0 }),
      ...[7, 8, 9, 3, 4].map((r) => annal(1300, 'migrate', { a: 0, b: 1, region: r, war: 1 })),
    ];
    const list = buildChronicle(c);
    const major = filterChronicle(list, { major: true });
    expect(major.map((e) => e.text)).toEqual([
      '大渭享国 400 年而亡,权臣秦氏篡位,国号大秦;五年后瑞州叛大秦自立,号大瑞,都于瑞城',
      '大秦伐昌国,得汾州等五州,昌国亡,昌族南迁,入柳州等五州',
    ]);
    // 合写进去的那一件在"全部"里照旧单列
    expect(list.find((e) => e.kind === 'split')!.importance).toBe(2);
    expect(list.find((e) => e.kind === 'migrate')!.text).toBe('昌族避大秦兵锋南迁,入柳州等五州');
    expect(list.find((e) => e.kind === 'migrate')!.importance).toBe(2);
    // 按国家看瑞:合写的那一条也算
    expect(filterChronicle(list, { major: true, polity: 4 })).toHaveLength(1);
  });

  it('复制全文:一条一行,战争的子条目缩进', () => {
    const text = chronicleText(filterChronicle(list, { polity: 0 }), '编年史 · 只看昌');
    const lines = text.split('\n');
    expect(lines[0]).toBe('编年史 · 只看昌');
    expect(lines).toContain('第 812 年 昌部立国,都于汾城');
    expect(lines).toContain('第 1240—1256 年 大渭伐昌国,得瑞州、白州');
    expect(lines).toContain('    第 1243 年 大渭攻取瑞州,瑞城陷落');
  });

  it('缓存:同一个 civ 只算一次', () => {
    expect(buildChronicle(civ)).toBe(list);
  });

  it('中文数字', () => {
    expect([1, 2, 5, 10, 12, 20, 25, 70, 100, 105, 110, 1000, 1010, 2345].map(cnNumber)).toEqual([
      '一',
      '二',
      '五',
      '十',
      '十二',
      '二十',
      '二十五',
      '七十',
      '一百',
      '一百零五',
      '一百一十',
      '一千',
      '一千零一十',
      '二千三百四十五',
    ]);
  });

  it('坏数据也不写出 undefined:编号越界、州 / 城 / 国都缺失', () => {
    const c = fakeCiv();
    c.annals = [
      annal(10, 'found', { a: 0 }),
      annal(20, 'conquer', { a: 0, b: 1, region: 99, settlement: 99 }),
      annal(30, 'capital', { a: 0 }),
      annal(40, 'split', { a: 4 }),
      annal(50, 'merge', { a: 1 }),
      annal(60, 'war', { a: 1, b: 0, war: 7 }),
      annal(70, 'peace', { a: 9, b: 8 }),
      annal(80, 'rank', { a: 9 }),
    ];
    for (const e of flat(buildChronicle(c))) {
      expect(e.text.length).toBeGreaterThan(2);
      expect(e.text).not.toMatch(/undefined|NaN|null|−1|-1|第 0 州|Infinity/);
    }
  });

  it('几千条史事(攻占多):一次算完不到 100 毫秒', () => {
    const c = fakeCiv();
    const A: Annal[] = [];
    for (let w = 0; w < 200; w++) {
      const y = 100 + w * 9;
      A.push(annal(y, 'war', { a: w % 4, b: (w + 1) % 4, war: w }));
      for (let k = 0; k < 20; k++) A.push(annal(y + k * 0.3, 'conquer', { a: w % 4, b: (w + 1) % 4, region: k % 10, war: w }));
      A.push(annal(y + 7, 'peace', { a: w % 4, b: (w + 1) % 4, war: w }));
      for (let k = 0; k < 5; k++) A.push(annal(y + 8 + k * 0.1, 'conquer', { a: 2, region: k }));
    }
    A.sort((a, b) => a.year - b.year);
    c.annals = A;
    const t0 = performance.now();
    const out = buildChronicle(c);
    const ms = performance.now() - t0;
    expect(A.length).toBeGreaterThan(5000);
    expect(out.filter((e) => e.kind === 'war')).toHaveLength(200);
    expect(ms).toBeLessThan(process.env.CI ? 300 : 100);
  });
});

describe('编年史 · 真实世界(立国、升格)', () => {
  for (const seed of [7, 2024]) {
    it(`seed ${seed}:每条史事一条纪事,措辞干净,国名用当年的国号`, () => {
      const civ = generateCiv(generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed }));
      const list = buildChronicle(civ);
      expect(civ.annals.length).toBeGreaterThan(5);
      expect(flat(list).length).toBeGreaterThanOrEqual(list.length);
      for (const e of flat(list)) clean(e);
      for (let i = 1; i < list.length; i++) expect(list[i].year).toBeGreaterThanOrEqual(list[i - 1].year);
      // 每个国家都有一条立国;分裂 / 复国出来的国家(阶段 3 分合)是一条"分裂"
      for (const p of civ.polities) {
        const kind = p.parent === undefined ? 'found' : 'split';
        expect(list.some((e) => e.kind === kind && e.polities[0] === p.id), `${p.name}`).toBe(true);
      }
      // 立国写开国之君和当年的国号(第 0 档:"X部" / "X城邦"):"李昭建昌部,都于汾城"
      for (const e of list.filter((x) => x.kind === 'found')) {
        expect(e.text).toMatch(/^.+建.+(部|城邦),都于.+$/);
        const founder = civ.people!.find((x) => x.role === 'ruler' && x.polity === e.polities[0])!;
        expect(e.text.startsWith(`${founder.name}建`)).toBe(true);
        expect(e.people).toEqual([founder.id]);
      }
      // 分裂:"瑞州守将李昭叛大渭自立,号瑞国,都于瑞城";复国:"故昌宗室李昭据瑞州起兵,脱大渭复国,号后昌国,都于瑞城"
      for (const e of list.filter((x) => x.kind === 'split')) {
        expect(e.text).toMatch(e.tag === '复' ? /^故.+(宗室|王室之后|旧臣).+据.+起兵,脱.+复国,号.+,都于.+$/ : /^.+(守将|领主).+叛.+自立,号.+,都于.+$/);
      }
      for (const e of list.filter((x) => x.kind === 'merge')) expect(e.text).toMatch(/^.+并入.+$/);
    });
  }
});

describe('编年史 · 真实世界(默认参数):被迫迁都折进战争,"大事"几十条', () => {
  /**
   * "大事"条数的目标范围(一个世界 3000 年,一页能读完)。
   * 加入王朝更替、同化迁徙、城市兴衰以后涨到 70 条,再精选收回到 35–50 条。
   * 阶段 4 推演随机数改按位置取以后历史换了一遍,各种子 31–48 条(seed 7 的大国多是西幻、改朝换代少,31 条):下限放到 30
   */
  const RANGE: [number, number] = [30, 50];
  for (const seed of [7, 2024]) {
    it(`seed ${seed}`, () => {
      const civ = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }));
      const A = civ.annals;
      const list = buildChronicle(civ);
      // 史事:国都失守的迁都(紧跟在丢国都的那条攻占后面)带战争编号,主动迁都是 −1
      let forced = 0;
      A.forEach((e, i) => {
        if (e.kind !== 'capital') return;
        const prev = A[i - 1];
        const lost = !!prev && prev.kind === 'conquer' && prev.b === e.a && prev.year === e.year;
        expect(e.war >= 0, `第 ${i} 条迁都`).toBe(lost);
        if (lost) {
          expect(e.war).toBe(prev.war);
          forced++;
        }
      });
      expect(forced).toBeGreaterThan(0);
      // 被迫迁都不在顶层,而在同一个战争编号的那场战争的子条目里;主动迁都在顶层,帝国级的是大事
      const top = new Set(list.map((e) => e.id));
      const warOf = new Map<number, ChronicleEntry>();
      for (const w of list) if (w.kind === 'war') for (const k of w.children ?? []) warOf.set(k.id, w);
      A.forEach((e, i) => {
        if (e.kind !== 'capital') return;
        if (e.war >= 0) {
          expect(top.has(i)).toBe(false);
          const w = warOf.get(i);
          expect(w, `第 ${i} 条迁都`).toBeDefined();
          expect(A[w!.id].war).toBe(e.war);
          expect(w!.children!.find((k) => k.id === i)!.text).toMatch(/^.+迁都.+$/);
        } else {
          expect(top.has(i)).toBe(true);
          expect(list.find((x) => x.id === i)!.importance).toBe(polityTierAt(civ.polities[e.a], e.year) >= CAPITAL_TIER ? MAJOR : 2);
        }
      });
      // 有被迫迁都的战争,标题里写"某国国都某城陷落" / "连迁几都"(亡了的除外);标题里最多一个"失"(攻方的)
      for (const w of list.filter((x) => x.kind === 'war')) {
        const movers = new Set(w.children!.filter((k) => k.kind === 'capital').map((k) => k.polities[0]));
        const fallen = new Set(w.children!.filter((k) => k.kind === 'fall').map((k) => k.polities[0]));
        if ([...movers].some((p) => !fallen.has(p))) expect(w.text).toMatch(/国都.+陷落|连迁.都/);
        expect(w.text).not.toMatch(/失国都|失.*失/);
        clean(w);
      }
      // 议和割让:peace 的 region = 紧挨在前面的几条攻占,都合在一条"议定疆界"的子条目里,不写"攻取"
      const kidOf = new Map<number, ChronicleEntry>();
      for (const w of list) for (const k of w.children ?? []) kidOf.set(k.id, k);
      let ceded = 0;
      A.forEach((e, i) => {
        if (e.kind !== 'peace' || e.region < 0) return;
        for (let j = i - e.region; j < i; j++) expect(A[j].kind === 'conquer' && A[j].war === e.war, `第 ${j} 条`).toBe(true);
        const k = kidOf.get(i - e.region)!;
        expect(k.text).toMatch(/^议定疆界,.+划归.+$/);
        expect(k.tag).toBe('割');
        ceded += e.region;
      });
      expect(ceded, '真实世界里有议和割让').toBeGreaterThan(0);
      // "大事"几十条
      const major = filterChronicle(list, { major: true });
      expect(major.length).toBeGreaterThanOrEqual(RANGE[0]);
      expect(major.length).toBeLessThanOrEqual(RANGE[1]);
      expect(major.length).toBeLessThan(list.length / 2);
      // 大事里的来历、合写都写干净了
      for (const e of major) expect(e.text).not.toMatch(/\uff08\uff09|;;|,,|,,/);
    }, 60_000);
  }
  // 别的种子:都不超过 55 条
  for (const seed of [1, 3, 99]) {
    it(`seed ${seed}:"大事"不超过 55 条`, () => {
      const list = buildChronicle(generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed })));
      const n = filterChronicle(list, { major: true }).length;
      expect(n).toBeGreaterThanOrEqual(25);
      expect(n).toBeLessThanOrEqual(55);
    }, 60_000);
  }
});
