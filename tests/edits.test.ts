/**
 * 用户的修改(阶段 4):稳定键 ↔ 实体一一对应、来回转换不变;applyNames 不改原 Civ;
 * 改了的名字出现在国名 / 编年史里;改回默认后和原来逐字相同;复国、重建的城跟着故国 / 旧城的名字变。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { buildChronicle, chronicleDocument, chronicleText } from '../src/gen/civ/chronicle';
import { capitalAt, dynastyIndexAt, polityAlive, polityName, polityRootAt, polityTitleChain } from '../src/gen/civ/growth';
import { legendRows } from '../src/render/export';
import {
  EMPTY_EDITS,
  GENERATOR_VERSION,
  applyNames,
  cleanName,
  cultureKey,
  dynastyKey,
  placeKey,
  placeKeyOf,
  polityKey,
  regionKey,
  resolveKey,
  settlementKey,
  upgradeLegacyKeys,
  type Intervention,
  type WorldEdits,
} from '../src/gen/edits';

const worlds = new Map<number, Civ>();
function civOf(seed: number): Civ {
  let c = worlds.get(seed);
  if (!c) worlds.set(seed, (c = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }))));
  return c;
}

/** 所有名字拍个快照(看原 Civ 有没有被改) */
function nameSnapshot(civ: Civ): string {
  return JSON.stringify({
    p: civ.polities.map((p) => [p.name, p.dynasties?.map((d) => d.name)]),
    s: civ.settlements.map((s) => s.name),
    pl: civ.places.map((p) => [p.name, p.defaultName]),
    c: civ.cultures.map((c) => c.name),
  });
}

const fullText = (civ: Civ) => chronicleText(buildChronicle(civ), '编年史');

describe('用户的修改 · 格式', () => {
  it('空修改、生成器版本', () => {
    expect(EMPTY_EDITS.names).toEqual({});
    expect(EMPTY_EDITS.interventions).toEqual([]);
    expect(Object.isFrozen(EMPTY_EDITS)).toBe(true);
    // 2:名字按位置取、稳定键按地块定位;3:推演随机数按位置取
    expect(Number.isInteger(GENERATOR_VERSION) && GENERATOR_VERSION >= 3).toBe(true);
  });

  it('名字清理:去空白、去顺手打上的国号 / 族字 / 王朝', () => {
    expect(cleanName('settlement', '  饕餮城 \n')).toBe('饕餮城');
    expect(cleanName('polity', '秦国')).toBe('秦');
    expect(cleanName('polity', '索拉特王国')).toBe('索拉特');
    expect(cleanName('polity', '国')).toBe('国');
    expect(cleanName('dynasty', '卡诺王朝')).toBe('卡诺');
    expect(cleanName('dynasty', '大景王朝', true)).toBe('大景');
    expect(cleanName('culture', '越族')).toBe('越');
    expect(cleanName('place', '')).toBe('');
    expect([...cleanName('place', '一二三四五六七八九十一二三四五六七八')].length).toBe(16);
  });
});

describe.each([7, 2024])('用户的修改 · seed=%i', (seed) => {
  it('稳定键 ↔ 实体一一对应,来回转换不变', () => {
    const civ = civOf(seed);
    expect(civ.polities.length).toBeGreaterThan(5);
    const all = new Set<string>();
    const check = (kind: string, n: number, keyOf: (id: number) => string) => {
      for (let id = 0; id < n; id++) {
        const k = keyOf(id);
        expect(k.startsWith(`${kind}:`), k).toBe(true);
        expect(all.has(k), `重复的键 ${k}`).toBe(false);
        all.add(k);
        expect(resolveKey(civ, k)).toEqual({ kind, id });
      }
    };
    check('polity', civ.polities.length, (id) => polityKey(civ, id));
    check('settlement', civ.settlements.length, (id) => settlementKey(civ, id));
    check('place', civ.places.length, (id) => placeKeyOf(civ, id));
    check('culture', civ.cultures.length, (id) => cultureKey(civ, id));
    let dyn = 0;
    for (const p of civ.polities) {
      (p.dynasties ?? []).forEach((_, i) => {
        const k = dynastyKey(civ, p.id, i);
        expect(all.has(k)).toBe(false);
        all.add(k);
        expect(resolveKey(civ, k)).toEqual({ kind: 'dynasty', id: p.id, index: i });
        dyn++;
      });
    }
    expect(dyn).toBeGreaterThan(0);
    // 地理实体的锚点地块互不相同:只看 Place 本身算出来的键和按下标的一致
    civ.places.forEach((p, i) => expect(placeKey(p)).toBe(placeKeyOf(civ, i)));
    // 格式:人能看懂;按地块定位(国家 = 立国时国都的地块,城 = 所在地块,民族 = 发源州的治所地块)
    expect(polityKey(civ, 0)).toBe(`polity:c${civ.settlements[civ.polities[0].capital].cell}#0`);
    expect(settlementKey(civ, 0)).toMatch(new RegExp(`^settlement:c${civ.settlements[0].cell}#\\d+$`));
    expect(placeKeyOf(civ, 0)).toMatch(/^place:(sea|mountains|river|lake|island|desert)@c\d+#\d+$/);
    expect(cultureKey(civ, 0)).toMatch(new RegExp(`^culture:c${civ.regions.seat[civ.cultures[0].hearth]}#\\d+$`));
    // 找不到的 / 格式不对的(水上的地块、超出范围的地块也找不到)
    const sea = civ.regions.of.findIndex((r) => r < 0);
    for (const bad of ['', 'polity:r99999#0', 'polity:r1#77', 'dynasty:r1#0/99', 'dynasty:x', 'city:r1#0', 'place:sea@c-5#0', `polity:c${sea}#0`, 'polity:c99999999#0', 'polity:c-1#0', `settlement:c${sea}#0`, `dynasty:c${sea}#0/0`]) {
      expect(resolveKey(civ, bad), bad).toBeNull();
    }
  });

  it('旧格式的键(r + 州号,GENERATOR_VERSION 2 以前写的)照样解析,指的和新键是同一个', () => {
    const civ = civOf(seed);
    const S = civ.settlements;
    const old = (k: string, region: number) => k.replace(/:c\d+#/, `:r${region}#`);
    civ.polities.forEach((p, id) => {
      const k = polityKey(civ, id);
      const r = S[p.capital].region;
      expect(resolveKey(civ, old(k, r))).toEqual({ kind: 'polity', id });
      (p.dynasties ?? []).forEach((_, i) => expect(resolveKey(civ, old(dynastyKey(civ, id, i), r))).toEqual({ kind: 'dynasty', id, index: i }));
    });
    S.forEach((s, id) => expect(resolveKey(civ, old(settlementKey(civ, id), s.region))).toEqual({ kind: 'settlement', id }));
    civ.cultures.forEach((c, id) => expect(resolveKey(civ, old(cultureKey(civ, id), c.hearth))).toEqual({ kind: 'culture', id }));
    // 州里任何一个地块都能当国家 / 城的位置锚(改地形后治所挪了一两格也还指这一州)
    const s = S[0];
    const cells = Array.from(civ.regions.cells.subarray(civ.regions.cellStart[s.region], civ.regions.cellStart[s.region + 1]));
    for (const c of cells.slice(0, 4)) expect(resolveKey(civ, settlementKey(civ, 0).replace(/:c\d+#/, `:c${c}#`))).toEqual({ kind: 'settlement', id: 0 });
  });

  it('读档时旧键就地换成 c 格式(upgradeLegacyKeys):改名、干预里的国家 / 州 / 城都换,指的还是同一个;新旧撞了留 c 格式的', () => {
    const civ = civOf(seed);
    const S = civ.settlements;
    const seat = civ.regions.seat;
    const toOld = (k: string, region: number) => k.replace(/:c\d+(#|$)/, `:r${region}$1`);
    // 改名:国家、朝代、城、民族、州各一个(旧格式),外加一个地理实体(没有州号,原样)和一个超出范围的州号(原样)
    const p = civ.polities.find((x) => (x.dynasties?.length ?? 0) > 1) ?? civ.polities[0];
    const pr = S[p.capital].region;
    const s = S[5];
    const cu = civ.cultures[1];
    const names: Record<string, string> = {
      [toOld(polityKey(civ, p.id), pr)]: '秦',
      [toOld(dynastyKey(civ, p.id, 1), pr)]: '汉',
      [toOld(settlementKey(civ, s.id), s.region)]: '饕餮城',
      [toOld(cultureKey(civ, cu.id), cu.hearth)]: '九黎',
      [`region:r${s.region}`]: '九嶷州',
      [placeKeyOf(civ, 0)]: '北冥',
      'region:r99999': '无此州',
    };
    const iv: Intervention[] = [
      { kind: 'protect', a: toOld(polityKey(civ, p.id), pr), from: 1200 },
      { kind: 'cede', a: polityKey(civ, p.id), region: `region:r${s.region}`, from: 1500 },
      { kind: 'move', a: toOld(polityKey(civ, p.id), pr), city: toOld(settlementKey(civ, s.id), s.region), from: 1600 },
    ];
    const edits: WorldEdits = { names, interventions: iv, terrain: [] };
    const before = JSON.stringify(edits);
    const up = upgradeLegacyKeys(edits, seat);
    expect(JSON.stringify(edits), '原对象不改').toBe(before);
    // 旧键都换成了 c 格式,指的和原来同一个;地理实体、超出范围的州号原样
    expect(up.names).toEqual({
      [polityKey(civ, p.id)]: '秦',
      [dynastyKey(civ, p.id, 1)]: '汉',
      [settlementKey(civ, s.id)]: '饕餮城',
      [cultureKey(civ, cu.id)]: '九黎',
      [regionKey(civ, s.region)]: '九嶷州',
      [placeKeyOf(civ, 0)]: '北冥',
      'region:r99999': '无此州',
    });
    for (const k of Object.keys(names)) {
      const o = resolveKey(civ, k);
      if (!o || k.startsWith('place:')) continue;
      const n = Object.keys(up.names).find((x) => up.names[x] === names[k])!;
      expect(resolveKey(civ, n), `${k} → ${n}`).toEqual(o);
    }
    expect(up.interventions).toEqual([
      { kind: 'protect', a: polityKey(civ, p.id), from: 1200 },
      { kind: 'cede', a: polityKey(civ, p.id), region: regionKey(civ, s.region), from: 1500 },
      { kind: 'move', a: polityKey(civ, p.id), city: settlementKey(civ, s.id), from: 1600 },
    ]);
    expect(up.interventions[1]).not.toBe(iv[1]);
    // 同一个东西新旧两个键都改过名:留 c 格式那个(后写的)
    const both = upgradeLegacyKeys({ names: { [`region:r${s.region}`]: '旧名', [regionKey(civ, s.region)]: '新名' }, interventions: [], terrain: [] }, seat);
    expect(both.names).toEqual({ [regionKey(civ, s.region)]: '新名' });
    // 没有旧键:原样返回同一个对象(自动存不会因此重写)
    expect(upgradeLegacyKeys(up, seat)).toBe(up);
    expect(upgradeLegacyKeys(EMPTY_EDITS, seat)).toBe(EMPTY_EDITS);
  });

  it('同一个世界再生成一次,键完全一样(键只看州、地块、先后,不看编号以外的随机)', () => {
    const a = civOf(seed);
    const b = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }));
    expect(b.polities.map((_, i) => polityKey(b, i))).toEqual(a.polities.map((_, i) => polityKey(a, i)));
    expect(b.settlements.map((_, i) => settlementKey(b, i))).toEqual(a.settlements.map((_, i) => settlementKey(a, i)));
  });

  it('城的键:同一州按建城先后编号,毁了又重建的 +1', () => {
    const civ = civOf(seed);
    for (const s of civ.settlements) {
      if (s.rebuilds === undefined) continue;
      const old = civ.settlements[s.rebuilds];
      const [, ro, no] = settlementKey(civ, old.id).match(/c(\d+)#(\d+)/)!;
      const [, rn, nn] = settlementKey(civ, s.id).match(/c(\d+)#(\d+)/)!;
      expect(rn).toBe(ro);
      expect(Number(nn)).toBeGreaterThan(Number(no));
    }
  });

  it('applyNames 不改原 Civ;没有改名 / 键找不到时返回原 Civ', () => {
    const civ = civOf(seed);
    const before = nameSnapshot(civ);
    expect(applyNames(civ, {})).toBe(civ);
    expect(applyNames(civ, { 'polity:r99999#0': '无此国', [polityKey(civ, 0)]: '' })).toBe(civ);
    const names = {
      [polityKey(civ, 0)]: '饕',
      [settlementKey(civ, 0)]: '饕餮城',
      [placeKeyOf(civ, 0)]: '饕餮海',
      [cultureKey(civ, 0)]: '餮',
    };
    const named = applyNames(civ, names);
    expect(named).not.toBe(civ);
    expect(nameSnapshot(civ)).toBe(before);
    expect(named.polities[0].name).toBe('饕');
    expect(named.settlements[0].name).toBe('饕餮城');
    expect(named.places[0].name).toBe('饕餮海');
    expect(named.places[0].defaultName).toBe(civ.places[0].name);
    expect(named.cultures[0].name).toBe('餮');
    // 没改名的对象、地理和史事数据原样共用
    expect(named.polities[1]).toBe(civ.polities[1]);
    expect(named.regions).toBe(civ.regions);
    expect(named.log).toBe(civ.log);
    expect(named.annals).toBe(civ.annals);
  });

  it('改了的国名出现在国号、编年史里;改回默认后和原来逐字相同', () => {
    const civ = civOf(seed);
    // 挑一个立过国、编年史里出现过的大国
    const list = buildChronicle(civ);
    const big = civ.polities.find((p) => list.some((e) => e.polities[0] === p.id && e.kind === 'found' && e.importance === 3)) ?? civ.polities[0];
    const text0 = fullText(civ);
    const key = polityKey(civ, big.id);
    const root = big.eastern ? '饕' : '饕餮尔';
    const named = applyNames(civ, { [key]: root });
    const p = named.polities[big.id];
    const y = big.founded + 1;
    expect(polityName(p, y)).toContain(root);
    expect(polityRootAt(p, y)).toBe(root);
    expect(polityTitleChain(p)).toContain(root);
    const text1 = fullText(named);
    expect(text1).toContain(root);
    expect(text1).not.toBe(text0);
    // 原来的编年史没被改
    expect(fullText(civ)).toBe(text0);
    // 恢复默认:names 里去掉 / 写回原名
    expect(fullText(applyNames(civ, {}))).toBe(text0);
    expect(fullText(applyNames(civ, { [key]: big.name }))).toBe(text0);
  });

  it('改了的城名出现在编年史里(立国时的国都)', () => {
    const civ = civOf(seed);
    const list = buildChronicle(civ);
    const found = list.find((e) => e.kind === 'found' && e.settlement >= 0)!;
    const sid = found.settlement;
    const named = applyNames(civ, { [settlementKey(civ, sid)]: '饕餮城' });
    const e = buildChronicle(named).find((x) => x.id === found.id)!;
    expect(e.text).toContain('饕餮城');
    expect(e.text.replace('饕餮城', civ.settlements[sid].name)).toBe(found.text);
  });

  it('东方国家可以分别改每一朝的国号;西幻的王朝名', () => {
    const civ = civOf(seed);
    const multi = civ.polities.filter((p) => (p.dynasties?.length ?? 0) >= 2);
    for (const p of multi.slice(0, 4)) {
      const d = p.dynasties!;
      const key = dynastyKey(civ, p.id, 1);
      const named = applyNames(civ, { [key]: p.eastern ? '霆' : '饕餮' });
      const q = named.polities[p.id];
      expect(q.dynasties![1].name).toBe(p.eastern ? '霆' : '饕餮');
      expect(q.dynasties![0].name).toBe(d[0].name);
      if (p.eastern) {
        expect(polityRootAt(q, d[1].year)).toBe('霆');
        expect(polityRootAt(q, d[0].year)).toBe(p.name);
      }
      // 东方的第一朝 = 国名词根
      if (p.eastern) {
        const r = applyNames(civ, { [dynastyKey(civ, p.id, 0)]: '霁' }).polities[p.id];
        expect(r.name).toBe('霁');
        expect(r.dynasties![0].name).toBe('霁');
        // polityKey 优先
        const both = applyNames(civ, { [dynastyKey(civ, p.id, 0)]: '霁', [polityKey(civ, p.id)]: '霖' }).polities[p.id];
        expect(both.name).toBe('霖');
      }
    }
  });

  it('复国的国家跟着故国的国号变;同族重建的城跟着旧城变(自己改过名的不跟)', () => {
    const civ = civOf(seed);
    for (const p of civ.polities) {
      if (p.restores === undefined) continue;
      const fallen = civ.polities[p.restores];
      const last = polityRootAt(fallen, fallen.ended ?? Infinity);
      const base = p.eastern && [...last].length === 2 && last[0] === '大' ? last.slice(1) : last;
      if (!(p.name.length === base.length + 1 && p.name.endsWith(base))) continue; // 前缀都被占了、另起国名的
      const d = fallen.dynasties;
      const key = fallen.eastern && d && d.length >= 2 ? dynastyKey(civ, fallen.id, d.length - 1) : polityKey(civ, fallen.id);
      const named = applyNames(civ, { [key]: '霆' });
      expect(named.polities[p.id].name).toBe(`${p.name[0]}霆`);
      const own = applyNames(civ, { [key]: '霆', [polityKey(civ, p.id)]: '雩' });
      expect(own.polities[p.id].name).toBe('雩');
    }
    for (const s of civ.settlements) {
      if (s.rebuilds === undefined) continue;
      const old = civ.settlements[s.rebuilds];
      const named = applyNames(civ, { [settlementKey(civ, old.id)]: '霆城' });
      expect(named.settlements[s.id].name).toBe(s.name === old.name ? '霆城' : s.name);
      const own = applyNames(civ, { [settlementKey(civ, old.id)]: '霆城', [settlementKey(civ, s.id)]: '雩城' });
      expect(own.settlements[s.id].name).toBe('雩城');
    }
  });

  it('导出(编年史文档、图例)用的是改过的名字', () => {
    const civ = civOf(seed);
    const y = civ.endYear;
    const alive = civ.polities.filter((p) => polityAlive(p, y));
    const big = alive.sort((a, b) => b.id - a.id)[0];
    const cap = civ.settlements[capitalAt(big, y)];
    const d = big.dynasties;
    // 当朝的国号:东方改朝换代过的改当朝那一条,别的改国名词根
    const key = big.eastern && d && d.length >= 2 ? dynastyKey(civ, big.id, dynastyIndexAt(big, y)) : polityKey(civ, big.id);
    const named = applyNames(civ, { [key]: big.eastern ? '霆' : '饕餮尔', [settlementKey(civ, cap.id)]: '饕餮城' });
    const doc = chronicleDocument(named, { format: 'md', seed });
    expect(doc).toContain('饕餮城');
    expect(doc).toContain(big.eastern ? '霆' : '饕餮尔');
    const rows = legendRows(named, y).polities;
    const row = rows.find((r) => r.name === polityName(named.polities[big.id], y));
    expect(row?.name).toContain(big.eastern ? '霆' : '饕餮尔');
    expect(row?.note).toContain('饕餮城');
    // 原来的不受影响
    expect(chronicleDocument(civ, { format: 'md', seed })).not.toContain('饕餮城');
  });

  it('改一次名(套名 + 重写编年史)够快', () => {
    const civ = civOf(seed);
    buildChronicle(civ);
    const t0 = performance.now();
    const named = applyNames(civ, { [polityKey(civ, 0)]: '饕', [settlementKey(civ, 3)]: '饕餮城' });
    buildChronicle(named);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(200);
  });
});
