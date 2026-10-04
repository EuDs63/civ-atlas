/**
 * 存档 / 读档(阶段 4):makeSave → JSON → parseSave 往返不变;坏文件、别的 JSON、未来版本给中文错误 / 提示;
 * worldCheck 确定性;州改名的稳定键 region:r123 往返;浏览器存储(saveStore)自动存 / 恢复、
 * 存储不可用(隐私模式)时退回内存、配额满了删最旧的;这几种情况顶部提示条上说一句;读档提示的短说法。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { buildChronicle, chronicleText, interventionOutcome } from '../src/gen/civ/chronicle';
import { regionLabel } from '../src/gen/civ/display';
import { EMPTY_EDITS, GENERATOR_VERSION, applyNames, regionKey, resolveKey, upgradeLegacyKeys, type WorldEdits } from '../src/gen/edits';
import {
  CHECK_WARNING,
  NEWER_WARNING,
  SAVE_APP,
  STALE_WARNING,
  DEFAULT_VIEW,
  checkWarning,
  cleanView,
  decodeShare,
  editCount,
  encodeShare,
  makeSave,
  parseSave,
  saveFileName,
  saveText,
  worldCheck,
  worldKey,
} from '../src/gen/savefile';
import * as saveStore from '../src/ui/saveStore';
import { clearEdits, getEdits, setEdits, setName } from '../src/ui/editsStore';
import { getProjection, setProjection } from '../src/ui/projection';
import { getMapCenter, publishMapCenter } from '../src/ui/mapWrap';
import { _resetToasts, clearToast, peekToast } from '../src/ui/toastStore';

const SMALL = { ...DEFAULT_PARAMS, cells: 12000 };
const worlds = new Map<number, World>();
function worldOf(seed: number): World {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = generateWorld({ ...SMALL, seed })));
  return w;
}
let civ7: Civ | undefined;
const civOf7 = () => (civ7 ??= generateCiv(worldOf(7)));

const EDITS: WorldEdits = {
  names: { 'settlement:r123#0': '饕餮城', 'polity:r45#0': '秦', 'region:r7': '九嶷州', 'place:river@c4567#0': '弱水' },
  // 干预:存档里当成不透明的数组,原样存、原样读回
  // (第二条是认不出的种类:存档照样原样存、原样读回,推演时由 cleanInterventions 丢掉)
  interventions: [
    { kind: 'protect', a: 'polity:r45#0', from: 1200 },
    { kind: 'war', from: 1800, a: 'polity:r1#0', b: 'polity:r2#0', extra: { deep: [1, 2] } },
  ] as unknown as WorldEdits['interventions'],
  // 地形修改的往返在 terrain-edits.test.ts
  terrain: [],
};

describe('存档文件 · 往返', () => {
  it('makeSave → JSON → parseSave 不变', () => {
    const p = { ...DEFAULT_PARAMS, seed: 7, landFraction: 0.41, plates: 20 };
    const save = makeSave(p, EDITS, 'abc123def456', '九州大陆', '2026-09-27T08:00:00.000Z');
    expect(save).toMatchObject({ app: SAVE_APP, format: 1, generator: GENERATOR_VERSION, seed: 7, check: 'abc123def456', title: '九州大陆' });
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.save).toEqual(save);
    expect(r.save.edits.interventions).toEqual(EDITS.interventions);
    // 存档是复制出来的:之后改原来的修改不影响存档
    const names = { ...EDITS.names };
    const s2 = makeSave(p, { ...EDITS, names }, 'x');
    names['region:r7'] = '别的名字';
    expect(s2.edits.names['region:r7']).toBe('九嶷州');
  });

  it('没起名的存档不带 title;参数按固定顺序、缺的补默认值', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 9 }, EMPTY_EDITS, 'c', '   ');
    expect('title' in save).toBe(false);
    expect(Object.keys(save.params)).toEqual(Object.keys(DEFAULT_PARAMS));
    const r = parseSave(JSON.stringify({ app: SAVE_APP, format: 1, generator: GENERATOR_VERSION, seed: 9, params: { seed: 9 }, edits: {}, check: 'c', savedAt: '' }));
    expect(r.ok && r.save.params).toEqual({ ...DEFAULT_PARAMS, seed: 9 });
    expect(r.ok && r.save.edits).toEqual({ names: {}, interventions: [], terrain: [] });
    expect(r.ok && r.warnings).toEqual([]);
  });

  it('文件名:带世界名,没名字用种子;去掉文件名里不能用的字符', () => {
    expect(saveFileName({ title: '九州大陆', seed: 7 })).toBe('文明与地图-九州大陆.json');
    expect(saveFileName({ seed: 2024 })).toBe('文明与地图-种子2024.json');
    expect(saveFileName({ title: 'a/b:c*?', seed: 1 })).toBe('文明与地图-abc.json');
  });

  it('改了几处 = 改名条数 + 干预条数', () => {
    expect(editCount(EDITS)).toBe(6);
    expect(editCount(EMPTY_EDITS)).toBe(0);
  });

  it('世界的身份:种子 + 全部参数', () => {
    expect(worldKey({ ...DEFAULT_PARAMS, seed: 7 })).toBe(worldKey({ ...DEFAULT_PARAMS, seed: 7 }));
    expect(worldKey({ ...DEFAULT_PARAMS, seed: 7 })).not.toBe(worldKey({ ...DEFAULT_PARAMS, seed: 7, plates: 15 }));
  });
});

describe('存档文件 · 坏文件、别的 JSON、别的版本', () => {
  const good = () => JSON.parse(saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c'))) as Record<string, unknown>;
  const err = (text: string) => {
    const r = parseSave(text);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error;
  };
  const zh = /[一-鿿]/;

  it('不是 JSON / 空文件 / 别的 JSON:中文错误', () => {
    for (const t of ['', '   ', '{坏了', '<html></html>', 'null', '[]', '42', '"文明与地图"', '{"name":"package","version":"1.0.0"}', '{"app":"别的应用","format":1,"seed":7}']) {
      const e = err(t);
      expect(e).toMatch(zh);
    }
    expect(err('{"name":"x"}')).toContain('不是「文明与地图」的存档');
  });

  it('缺格式版本、缺种子:中文错误', () => {
    const a = good();
    delete a.format;
    expect(err(JSON.stringify(a))).toContain('格式');
    const b = good();
    delete b.seed;
    (b.params as Record<string, unknown>).seed = 'abc';
    expect(err(JSON.stringify(b))).toContain('种子');
  });

  it('未来的存档格式:不读,提示更新页面', () => {
    const a = { ...good(), format: 2 };
    expect(err(JSON.stringify(a))).toMatch(/更新版本.*刷新页面/);
  });

  it('生成器版本不同:照样打开,提示"来自旧版本 / 更新的版本"', () => {
    const old = parseSave(JSON.stringify({ ...good(), generator: GENERATOR_VERSION - 1 }));
    expect(old.ok && old.warnings).toEqual([STALE_WARNING]);
    expect(STALE_WARNING).toBe('这个存档来自旧版本,地形可能不同,改过的名字会尽量套上');
    const newer = parseSave(JSON.stringify({ ...good(), generator: GENERATOR_VERSION + 1 }));
    expect(newer.ok && newer.warnings).toEqual([NEWER_WARNING]);
    expect(old.ok && old.save.edits).toEqual(EDITS);
  });

  it('参数超出范围 / 不是数:调回合理的值并提示', () => {
    const a = good();
    a.params = { ...(a.params as object), cells: 1e9, plates: 'many', rainfall: -3 };
    const r = parseSave(JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.params.cells).toBe(200000);
    expect(r.save.params.plates).toBe(DEFAULT_PARAMS.plates);
    expect(r.save.params.rainfall).toBe(0);
    expect(r.warnings.join()).toMatch(/精细度.*板块数量.*降水/);
  });

  it('个别改名、干预格式不对:跳过那几条,其余照读', () => {
    const a = good();
    a.edits = { names: { 'settlement:r1#0': '好名字', 'settlement:r2#0': 42, ['x'.repeat(200)]: '太长', nokey: '没冒号', 'place:sea@c1#0': '' }, interventions: [{ kind: 'protect', from: 1 }, 'bad', null, 3] };
    const r = parseSave(JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.names).toEqual({ 'settlement:r1#0': '好名字' });
    expect(r.save.edits.interventions).toEqual([{ kind: 'protect', from: 1 }]);
    expect(r.warnings).toEqual(['有 4 处改名格式不对,已跳过', '有 3 条干预格式不对,已跳过']);
  });

  it('带 BOM 的文件照样读;世界名去掉控制字符、超长截断', () => {
    const a = { ...good(), title: '九州\u0000大陆' + '长'.repeat(40) };
    const r = parseSave('﻿' + JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.title!.startsWith('九州大陆')).toBe(true);
    expect([...r.save.title!].length).toBe(24);
  });
});

describe('地形校验', () => {
  it('worldCheck:确定性(同种子 + 参数两次生成一样)、不同世界不一样、12 位十六进制', () => {
    const a = worldCheck(worldOf(7));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(worldCheck(generateWorld({ ...SMALL, seed: 7 }))).toBe(a);
    expect(worldCheck(worldOf(8))).not.toBe(a);
    expect(worldCheck(generateWorld({ ...SMALL, seed: 7, mountains: 1.05 }))).not.toBe(a);
  });

  it('checkWarning:同版本地形对不上才提示(版本不同 parseSave 已经提示过)', () => {
    const s = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'aaaa');
    expect(checkWarning(s, 'aaaa')).toBeNull();
    expect(checkWarning(s, 'bbbb')).toBe(CHECK_WARNING);
    expect(checkWarning({ ...s, generator: GENERATOR_VERSION - 1 }, 'bbbb')).toBeNull();
    expect(checkWarning({ ...s, check: '' }, 'bbbb')).toBeNull();
  });
});

describe('州改名 · region:c4567', () => {
  it('稳定键往返(按治所地块);旧格式 region:r123 照样认;格式不对 / 越界 / 水上的认不出', () => {
    const civ = civOf7();
    for (const r of [0, 1, Math.floor(civ.regions.count / 2), civ.regions.count - 1]) {
      expect(regionKey(civ, r)).toBe(`region:c${civ.regions.seat[r]}`);
      expect(resolveKey(civ, regionKey(civ, r))).toEqual({ kind: 'region', id: r });
      expect(resolveKey(civ, `region:r${r}`)).toEqual({ kind: 'region', id: r });
    }
    // 州里任何一个地块都指这一州
    const r = 5;
    const cells = Array.from(civ.regions.cells.subarray(civ.regions.cellStart[r], civ.regions.cellStart[r + 1]));
    for (const c of cells.slice(0, 5)) expect(resolveKey(civ, `region:c${c}`)).toEqual({ kind: 'region', id: r });
    const sea = civ.regions.of.findIndex((x) => x < 0);
    for (const k of ['region:r-1', `region:r${civ.regions.count}`, 'region:rabc', 'region:r1#0', 'region:', 'region:12', `region:c${sea}`, 'region:c-3', `region:c${civ.regions.of.length}`])
      expect(resolveKey(civ, k), k).toBeNull();
  });

  it('applyNames:州名换了,原 Civ 和 civ.regions 不动(画国土的缓存按它存),编年史跟着变', () => {
    const civ = civOf7();
    const before = JSON.stringify(civ.regions.name);
    // 编年史里出现过的一个州
    const text0 = chronicleText(buildChronicle(civ), '编年史');
    let r = civ.regions.name?.findIndex((n, i) => n && text0.includes(n) && civ.regions.name!.indexOf(n) === i) ?? -1;
    if (r < 0) r = 0;
    const old = regionLabel(civ, r);
    const c2 = applyNames(civ, { [regionKey(civ, r)]: '九嶷州' });
    expect(c2).not.toBe(civ);
    expect(c2.regions).toBe(civ.regions);
    expect(regionLabel(c2, r)).toBe('九嶷州');
    expect(regionLabel(civ, r)).toBe(old);
    expect(JSON.stringify(civ.regions.name)).toBe(before);
    // 别的州不变
    const other = (r + 1) % civ.regions.count;
    expect(regionLabel(c2, other)).toBe(regionLabel(civ, other));
    if (text0.includes(old)) {
      const text = chronicleText(buildChronicle(c2), '编年史');
      expect(text).toContain('九嶷州');
    }
    // 改回生成时的名字 = 没改
    const same = applyNames(civ, { [regionKey(civ, r)]: old });
    if (civ.regions.name?.[r]) expect(same).toBe(civ);
  });
});

// ---------------------------------------------------------------------------
// 浏览器存储

/** 假的 localStorage:可以限制总字数(模拟配额满了) */
class FakeStorage {
  map = new Map<string, string>();
  constructor(public cap = Infinity) {}
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    let used = 0;
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length;
    if (used + k.length + v.length > this.cap) {
      const e = new Error('quota') as Error & { name: string };
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** 隐私模式:一碰就抛错 */
const throwing = {
  get length(): number {
    throw new Error('SecurityError');
  },
  key() {
    throw new Error('SecurityError');
  },
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

const g = globalThis as { localStorage?: unknown };
let stopAuto: (() => void) | null = null;

function useStorage(s: unknown) {
  g.localStorage = s;
  saveStore._resetForTest();
  clearEdits();
  stopAuto?.();
  stopAuto = saveStore.startAutoSave();
}

/** 模拟 App:换世界(先 detach 再清空),生成完 attach,有存档就套上 */
function openWorld(seed: number, file?: ReturnType<typeof makeSave>) {
  const p = { ...DEFAULT_PARAMS, seed };
  saveStore.detachWorld();
  clearEdits();
  const s = saveStore.attachWorld(p, `check${seed}`, file);
  if (s) setEdits(s.edits);
  return worldKey(p);
}

describe('浏览器存储(saveStore)', () => {
  beforeEach(() => useStorage(new FakeStorage()));
  afterEach(() => {
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    _resetToasts();
  });

  it('改名自动存;换个世界再回来,修改自动恢复;全改回默认就从列表里删掉', () => {
    const id7 = openWorld(7);
    expect(saveStore.listWorlds()).toEqual([]);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.persistent()).toBe(true);
    const list = saveStore.listWorlds();
    expect(list.map((w) => [w.id, w.count])).toEqual([[id7, 1]]);
    // 换世界:清空修改不算"改回默认"
    openWorld(2024);
    expect(getEdits()).toBe(EMPTY_EDITS);
    expect(saveStore.loadWorld(id7)?.count).toBe(1);
    // 回来:恢复
    openWorld(7);
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '饕餮城' });
    setName('settlement:r1#0', null);
    expect(saveStore.loadWorld(id7)).toBeNull();
  });

  it('起了名字的世界没有修改也留着;改名、删除', () => {
    const id = openWorld(7);
    saveStore.renameWorld(id, '九州大陆');
    expect(saveStore.loadWorld(id)?.save.title).toBe('九州大陆');
    expect(saveStore.currentSave()?.title).toBe('九州大陆');
    setName('region:r3', '九嶷州');
    setName('region:r3', null);
    expect(saveStore.loadWorld(id)?.save.title).toBe('九州大陆');
    // 不是当前世界的也能改名
    openWorld(8);
    saveStore.renameWorld(id, '神州');
    expect(saveStore.loadWorld(id)?.save.title).toBe('神州');
    saveStore.deleteWorld(id);
    expect(saveStore.listWorlds()).toEqual([]);
  });

  it('读档(文件)的修改覆盖浏览器里原来的;干预原样存回', () => {
    const id = openWorld(7);
    setName('settlement:r1#0', '旧名字');
    openWorld(2024);
    const file = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '九州大陆');
    openWorld(7, file);
    expect(getEdits()).toEqual(EDITS);
    const w = saveStore.loadWorld(id)!;
    expect(w.save.edits).toEqual(EDITS);
    expect(w.save.title).toBe('九州大陆');
    // 没修改、没起名的存档 = 只是打开这个世界:浏览器里存的照样读回
    openWorld(2024);
    openWorld(7, makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'check7'));
    expect(getEdits()).toEqual(EDITS);
  });

  it('隐私模式(localStorage 一碰就抛错):不报错,退回只在内存里', () => {
    useStorage(throwing);
    expect(() => {
      const id = openWorld(7);
      setName('settlement:r1#0', '饕餮城');
      expect(saveStore.persistent()).toBe(false);
      expect(saveStore.listWorlds().map((w) => w.id)).toEqual([id]);
      openWorld(8);
      openWorld(7);
      expect(getEdits().names).toEqual({ 'settlement:r1#0': '饕餮城' });
      saveStore.renameWorld(id, '九州');
      saveStore.deleteWorld(id);
    }).not.toThrow();
    // 第一次存的时候提示一句"浏览器不让存"(只说一次)
    expect(peekToast('storage')).toMatchObject({ kind: 'warn', text: '浏览器不让网页存数据', ttl: 10_000 });
    clearToast('storage');
    setName('settlement:r1#0', '梼杌城');
    expect(peekToast('storage')).toBe(null);
    // 没有 localStorage(Node、禁用了存储)也一样
    useStorage(undefined);
    openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.persistent()).toBe(false);
    expect(saveStore.listWorlds().length).toBe(1);
  });

  it('配额满了:删最旧的世界腾地方,当前世界存得下', () => {
    const fake = new FakeStorage(1600);
    useStorage(fake);
    const ids: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      ids.push(openWorld(seed));
      setName('settlement:r1#0', `城${seed}`);
    }
    const left = saveStore.listWorlds().map((w) => w.id);
    expect(left).toContain(ids[5]);
    expect(left.length).toBeLessThan(6);
    // 删的是最旧的;顶部提示"浏览器存储已满 · 已删掉最旧的存档……"
    expect(left).not.toContain(ids[0]);
    const t = peekToast('storage');
    expect(t?.text).toBe('浏览器存储已满');
    expect(t?.more?.[0]).toMatch(/^已删掉最旧的存档「种子 \d+」/);
  });

  it('配额满了、删光别的也存不下:提示"没能自动存档"(同一次满只说一回),腾出地方后接着存', () => {
    const fake = new FakeStorage(120);
    useStorage(fake);
    const id = openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)).toBe(null);
    expect(saveStore.storageIsFull()).toBe(true);
    expect(peekToast('storage')).toMatchObject({ kind: 'warn', text: '没能自动存档:浏览器存储已满' });
    clearToast('storage');
    setName('settlement:r1#0', '梼杌城');
    expect(peekToast('storage')).toBe(null);
    // 腾出地方:下一次改动就存下了,菜单里的"已满"也收起
    fake.cap = Infinity;
    setName('settlement:r1#0', '混沌城');
    expect(saveStore.loadWorld(id)?.save.edits.names['settlement:r1#0']).toBe('混沌城');
    expect(saveStore.storageIsFull()).toBe(false);
  });

  it('提示条上的"存成文件":同时挂着几个存档菜单时卸下其中一个,按钮还在,调的是还挂着的那个', () => {
    useStorage(new FakeStorage(120));
    const calls: string[] = [];
    const offA = saveStore.addFileSaver(() => calls.push('a'));
    const offB = saveStore.addFileSaver(() => calls.push('b'));
    offB();
    openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    const t = peekToast('storage');
    expect(t?.action?.label).toBe('存成文件');
    t?.action?.onClick();
    expect(calls).toEqual(['a']);
    expect(peekToast('storage')).toBe(null);
    offA();
    offA();
  });

  it('浏览器里存的坏条目:读不出来就当没有,不报错', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const id = worldKey({ ...DEFAULT_PARAMS, seed: 7 });
    fake.setItem(`wenming-ditu:world:${id}`, '{坏了');
    expect(saveStore.listWorlds()).toEqual([]);
    openWorld(7);
    expect(getEdits()).toBe(EMPTY_EDITS);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.count).toBe(1);
  });
});

describe('读档提示的短说法', () => {
  it('版本不同、地形对不上:缩成一行小字里的短句;认不出的原样', () => {
    expect(saveStore.briefWarning(STALE_WARNING)).toBe('来自旧版本,地形可能不同');
    expect(saveStore.briefWarning(NEWER_WARNING)).toBe('来自更新的版本,地形可能不同');
    expect(saveStore.briefWarning(CHECK_WARNING)).toBe('地形和存档时对不上');
    expect(saveStore.briefWarning('有 2 处改名格式不对,已跳过')).toBe('有 2 处改名格式不对,已跳过');
  });
  it('打不开的原因:别的 JSON、更新版本的存档、坏了的链接', () => {
    const other = parseSave(JSON.stringify({ hello: 1 }));
    const junk = parseSave('不是 JSON');
    const future = parseSave(JSON.stringify({ app: SAVE_APP, format: 99, seed: 7 }));
    expect(!other.ok && saveStore.briefError(other.error)).toBe('不是「文明与地图」的存档');
    expect(!junk.ok && saveStore.briefError(junk.error)).toBe('不是「文明与地图」的存档');
    expect(!future.ok && saveStore.briefError(future.error)).toBe('来自更新的版本,刷新页面后再打开');
    expect(saveStore.briefError('文件是空的')).toBe('文件是空的');
  });
});

describe('平面时代的存档(GENERATOR_VERSION 4 及以前)', () => {
  /** 平面世界时写的存档原文:参数里没有"形状",改名有旧的 r 格式和 c 格式,干预指向当时的国家,地形修改的坐标都在 [0, 2048] 里 */
  const OLD = JSON.stringify({
    app: '文明与地图',
    format: 1,
    generator: 4,
    seed: 7,
    params: { seed: 7, cells: 12000, landFraction: 0.33, plates: 30, mountains: 1, temperature: 0, rainfall: 1 },
    edits: {
      names: { 'settlement:r123#0': '饕餮城', 'polity:c4567#0': '秦', 'region:c890': '九嶷州', 'place:river@c11999#0': '弱水', 'culture:c3#0': '羌' },
      interventions: [
        { kind: 'protect', a: 'polity:c4567#0', from: 1200 },
        { kind: 'declare', a: 'polity:r45#0', b: 'polity:c100#0', from: 900 },
      ],
      terrain: [
        { kind: 'volcano', pts: [812, 403], r: 28, s: 1.05 },
        { kind: 'range', pts: [2000, 300, 2048, 340, 30, 380], r: 23, s: 1 },
      ],
    },
    check: '3f9a0c1d7b2e',
    title: '九州大陆',
    savedAt: '2026-09-20T08:00:00.000Z',
  });

  it('照常打开成球面世界:提示"来自旧版本";指不到的改名、干预不生效,不报错', () => {
    const r = parseSave(OLD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([STALE_WARNING]);
    // 地形修改的坐标按经纬度读:x = 2048 就是 180° 经线,跨接缝的一笔展开成连着的
    expect(r.save.edits.terrain[1].pts).toEqual([2000, 300, 2048, 340, 2078, 380]);
    const w = generateWorld(r.save.params, undefined, r.save.edits.terrain);
    expect(w.mesh.xyz.length).toBe(3 * w.mesh.n);
    expect(w.volcanoes.length).toBe(1);
    // 地形校验对不上(地形全换了一遍),但版本不同时 parseSave 已经提示过,不重复
    expect(checkWarning(r.save, worldCheck(w))).toBeNull();
    const edits = upgradeLegacyKeys(r.save.edits, generateCiv(w).regions.seat);
    const civ = generateCiv(w, { interventions: edits.interventions });
    const named = applyNames(civ, edits.names);
    expect(named.polities.length).toBeGreaterThan(0);
    // 指得到的改名套上,指不到的先留着(界面上标"暂未生效");干预逐条能判断生效没有
    for (const k of Object.keys(edits.names)) expect(() => resolveKey(civ, k)).not.toThrow();
    for (let i = 0; i < (civ.interventions ?? []).length; i++) expect(() => interventionOutcome(civ, i)).not.toThrow();
    expect(() => buildChronicle(named)).not.toThrow();
  }, 60_000);

  it('分享链接同理:照常打开,提示"来自旧版本"', async () => {
    const r0 = parseSave(OLD);
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    const r = await decodeShare(await encodeShare(JSON.parse(OLD)));
    expect(r.ok && r.warnings).toEqual([STALE_WARNING]);
    expect(r.ok && r.save.edits).toEqual(r0.save.edits);
  });
});

describe('投影和中央经线跟着世界存(view)', () => {
  beforeEach(() => useStorage(new FakeStorage()));
  afterEach(() => {
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    setProjection('equirect');
    publishMapCenter(0);
  });

  it('存档文件带上投影和中央经线;旧存档没有 = 等距圆柱、0°;格式不对的当没存', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', undefined, '2026-09-28T00:00:00.000Z', { projection: 'robinson', center: 485.123 });
    // 中央经线挪到 ±180° 以内、两位小数
    expect(save.view).toEqual({ projection: 'robinson', center: 125.12 });
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.view).toEqual({ projection: 'robinson', center: 125.12 });
    expect(r.ok && r.warnings).toEqual([]);
    // 旧存档:没有 view
    const old = JSON.parse(saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c')));
    expect(old.view).toBeUndefined();
    const ro = parseSave(JSON.stringify(old));
    expect(ro.ok && ro.save.view).toBeUndefined();
    expect(DEFAULT_VIEW).toEqual({ projection: 'equirect', center: 0 });
    // 格式不对:照常打开,view 当没存
    for (const bad of [{ projection: 3, center: 0 }, { projection: 'robinson' }, { projection: '<script>', center: 1 }, 'robinson', { projection: 'mollweide', center: Infinity }]) {
      const rb = parseSave(JSON.stringify({ ...old, view: bad }));
      expect(rb.ok).toBe(true);
      expect(rb.ok && rb.save.view).toBeUndefined();
    }
    // 认不出的投影名原样留着(以后的版本加的投影),界面按等距圆柱看
    expect(cleanView({ projection: 'azimuthal', center: -30 })).toEqual({ projection: 'azimuthal', center: -30 });
  });

  it('分享链接带上投影和中央经线', async () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', '九州', undefined, { projection: 'mollweide', center: -60 });
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok && r.save.view).toEqual({ projection: 'mollweide', center: -60 });
  });

  it('自动存按当时的投影和中心写;存着的世界换了投影 / 中心就重存,没存过的不为这个占列表', () => {
    setProjection('robinson');
    publishMapCenter(42.5);
    const id = openWorld(7);
    // 没改过的世界:换投影不存
    saveStore.viewChanged();
    expect(saveStore.loadWorld(id)).toBeNull();
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'robinson', center: 42.5 });
    expect(saveStore.currentSave()?.view).toEqual({ projection: 'robinson', center: 42.5 });
    // 换成摩尔威德、中心 −100°:重存
    setProjection('mollweide');
    publishMapCenter(-100);
    saveStore.viewChanged();
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'mollweide', center: -100 });
    // 换个世界再回来:attach 返回的存档带着它(App 按它换投影、转中心)
    openWorld(2024);
    setProjection('equirect');
    publishMapCenter(0);
    const back = saveStore.attachWorld({ ...DEFAULT_PARAMS, seed: 7 }, 'check7');
    expect(back?.view).toEqual({ projection: 'mollweide', center: -100 });
    expect(getProjection()).toBe('equirect');
    expect(getMapCenter()).toBe(0);
  });
});
