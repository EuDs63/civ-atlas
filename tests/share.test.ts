/**
 * 分享链接(阶段 4):encodeShare → decodeShare 往返不变;格式就是 raw deflate + base64url(Node 的 zlib 能解、能造);
 * 坏链接(少了一截、被改过、别的应用、压缩炸弹、未来版本)给中文错误;链接长度(10 个改名 + 2 条干预)。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/gen/world';
import { GENERATOR_VERSION, type Intervention, type TerrainOp, type WorldEdits } from '../src/gen/edits';
import {
  SHARE_BROKEN,
  SHARE_KEY,
  SHARE_WARN_LENGTH,
  STALE_WARNING,
  decodeShare,
  editsLost,
  encodeShare,
  hasShareData,
  isShareHash,
  makeSave,
  parseSave,
  saveText,
  type SaveFile,
} from '../src/gen/savefile';

const zh = /[一-鿿]/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** 真实形状的键:10 个改名(城、国家、州、地名、民族、朝代)+ 2 条干预 */
function sample(): SaveFile {
  const names: Record<string, string> = {
    'settlement:r123#0': '饕餮城',
    'settlement:r456#1': '九嶷',
    'settlement:r78#0': '长安',
    'polity:r123#0': '大昌',
    'polity:r901#0': '索拉特',
    'region:r45': '九嶷州',
    'region:r1203': '雁门郡',
    'place:mountains@c4567#0': '不周山',
    'culture:r45#0': '华胥',
    'dynasty:r123#0/2': '后秦',
  };
  const interventions: Intervention[] = [
    { kind: 'protect', a: 'polity:r123#0', from: 1200 },
    { kind: 'ally', a: 'polity:r123#0', b: 'polity:r901#0', from: 1500, until: 2100 },
  ];
  // 地形修改:链接里带着,打开后地形在
  const terrain: TerrainOp[] = [
    { kind: 'volcano', pts: [819, 585], r: 28, s: 1.05 },
    { kind: 'range', pts: [1156, 380, 1215, 430, 1273, 483], r: 23, s: 1 },
  ];
  return makeSave({ ...DEFAULT_PARAMS, seed: 7, landFraction: 0.41 }, { names, interventions, terrain }, '3f9a0c1d7b2e', '九州大陆', '2026-09-27T08:00:00.000Z');
}

const payload = (hash: string) => hash.slice(`#${SHARE_KEY}=`.length);

describe('分享链接:编码 / 解码', () => {
  it('往返不变,得到和 parseSave 读存档文件一样的结果', async () => {
    const save = sample();
    const hash = await encodeShare(save);
    expect(hash.startsWith(`#${SHARE_KEY}=`)).toBe(true);
    expect(payload(hash)).toMatch(B64URL);
    expect(isShareHash(hash)).toBe(true);
    const r = await decodeShare(hash);
    expect(r).toEqual(parseSave(saveText(save)));
    expect(r.ok && r.save).toEqual(save);
    expect(r.ok && r.warnings).toEqual([]);
  });

  it('同一份存档编出同一个链接;不带 #、折了行、被转义过的也认', async () => {
    const save = sample();
    const hash = await encodeShare(save);
    expect(await encodeShare(save)).toBe(hash);
    const p = payload(hash);
    for (const variant of [hash.slice(1), p, `  ${hash}\n`, `#${SHARE_KEY}=${p.slice(0, 40)}\n${p.slice(40)}`, `#${SHARE_KEY}=${p}==`, `#${SHARE_KEY}=${encodeURIComponent(p)}`]) {
      const r = await decodeShare(variant);
      expect(r.ok && r.save.title).toBe('九州大陆');
    }
  });

  it('格式就是 raw deflate + base64url:Node 的 zlib 能解开浏览器编的,浏览器能解开 zlib 编的', async () => {
    const save = sample();
    const hash = await encodeShare(save);
    const json = inflateRawSync(Buffer.from(payload(hash), 'base64url')).toString('utf8');
    expect(JSON.parse(json)).toEqual(save);
    const byZlib = deflateRawSync(Buffer.from(JSON.stringify(save), 'utf8'), { level: 9 }).toString('base64url');
    const r = await decodeShare(`#${SHARE_KEY}=${byZlib}`);
    expect(r.ok && r.save).toEqual(save);
  });

  it('编码的是整个存档对象:地形修改、以后加的字段原样带上', async () => {
    const save = sample() as SaveFile & { edits: WorldEdits & { future?: unknown } };
    save.edits.future = [1, 2];
    (save as unknown as Record<string, unknown>).future = { x: 1 };
    const hash = await encodeShare(save);
    const raw = JSON.parse(inflateRawSync(Buffer.from(payload(hash), 'base64url')).toString('utf8'));
    expect(raw.edits.terrain).toEqual(sample().edits.terrain);
    expect(raw.edits.future).toEqual([1, 2]);
    expect(raw.future).toEqual({ x: 1 });
    // 解开以后地形修改在(读档流程照样清理)
    const r = await decodeShare(hash);
    expect(r.ok && r.save.edits.terrain).toEqual(sample().edits.terrain);
    // 只有地形修改(没改名、没干预、没起名)也算有修改
    const onlyTerrain = makeSave(DEFAULT_PARAMS, { names: {}, interventions: [], terrain: [] }, '');
    expect(hasShareData(onlyTerrain)).toBe(false);
    onlyTerrain.edits.terrain = [{ kind: 'lake', pts: [300, 400], r: 16, s: 1 }];
    expect(hasShareData(onlyTerrain)).toBe(true);
  });

  it('旧版本生成器的链接照样打开,附提示', async () => {
    const save = { ...sample(), generator: GENERATOR_VERSION - 1 };
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings).toContain(STALE_WARNING);
  });
});

describe('分享链接:坏链接给中文错误', () => {
  const bad = async (hash: string) => {
    const r = await decodeShare(hash);
    expect(r.ok).toBe(false);
    const e = r.ok ? '' : r.error;
    expect(e).toMatch(zh);
    return e;
  };

  it('空的、不是分享数据的', async () => {
    expect(await bad('')).toContain('没有世界数据');
    expect(await bad('#share=')).toContain('没有世界数据');
    expect(await bad('#foo=bar')).toContain('没有世界数据');
    expect(isShareHash('#foo=bar')).toBe(false);
    expect(isShareHash('')).toBe(false);
  });

  it('少了一截、被改过、有不认识的字符', async () => {
    const p = payload(await encodeShare(sample()));
    expect(await bad(`#share=${p.slice(0, Math.floor(p.length / 2))}`)).toBe(SHARE_BROKEN);
    expect(await bad(`#share=${p.slice(0, -3)}`)).toMatch(/链接/);
    expect(await bad(`#share=${p.slice(0, 20)}@@${p.slice(22)}`)).toBe(SHARE_BROKEN);
    expect(await bad('#share=你好')).toBe(SHARE_BROKEN);
    expect(await bad('#share=%E0%A4%A')).toBe(SHARE_BROKEN);
    // 中间改了几个字:要么解不开,要么解出来不是 JSON
    const mid = Math.floor(p.length / 2);
    const flipped = p.slice(0, mid) + (p[mid] === 'A' ? 'B' : 'A') + (p[mid + 1] === 'A' ? 'B' : 'A') + p.slice(mid + 2);
    expect(await bad(`#share=${flipped}`)).toMatch(/链接/);
  });

  it('解得开但不是本应用的世界、是更新版本的', async () => {
    const pack = (text: string) => `#share=${deflateRawSync(Buffer.from(text, 'utf8')).toString('base64url')}`;
    expect(await bad(pack('hello world'))).toContain('不是「文明与地图」的世界');
    expect(await bad(pack(JSON.stringify({ app: 'other', seed: 1 })))).toContain('不是「文明与地图」的世界');
    expect(await bad(pack(JSON.stringify({ ...sample(), format: 99 })))).toContain('这个链接来自更新版本');
  });

  it('压缩炸弹(解开几十 MB)不会撑爆页面', async () => {
    const huge = deflateRawSync(Buffer.alloc(20 * 1024 * 1024, 32)).toString('base64url');
    expect(huge.length).toBeLessThan(40000);
    expect(await bad(`#share=${huge}`)).toContain('太大');
  });
});

describe('分享链接:长度、要不要带数据、会覆盖几处', () => {
  it('10 个改名 + 2 条干预:链接一千字以内', async () => {
    const hash = await encodeShare(sample());
    const url = `https://example.com/?seed=7&landFraction=0.41&style=fantasy${hash}`;
    console.log(`分享链接:10 个改名 + 2 条干预 + 世界名,# 那段 ${hash.length} 字,整条(example.com)${url.length} 字;存档 JSON ${JSON.stringify(sample()).length} 字`);
    expect(url.length).toBeLessThan(1000);
  });

  it('改名很多时会超过提示长度(还能正常往返)', async () => {
    const names: Record<string, string> = {};
    // 名字不重复(随机汉字),压缩不掉
    let x = 12345;
    const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 8) % 20000;
    for (let i = 0; i < 1500; i++) names[`settlement:r${i}#${i % 3}`] = String.fromCharCode(0x4e00 + rnd(), 0x4e00 + rnd(), 0x4e00 + rnd());
    const save = makeSave(DEFAULT_PARAMS, { names, interventions: [], terrain: [] }, 'abc');
    const hash = await encodeShare(save);
    expect(hash.length).toBeGreaterThan(SHARE_WARN_LENGTH);
    const r = await decodeShare(hash);
    expect(r.ok && Object.keys(r.save.edits.names).length).toBe(1500);
  });

  it('没有任何修改、也没起名 = 不带数据(普通网址)', () => {
    expect(hasShareData(makeSave(DEFAULT_PARAMS, { names: {}, interventions: [], terrain: [] }, 'abc'))).toBe(false);
    expect(hasShareData(makeSave(DEFAULT_PARAMS, { names: {}, interventions: [], terrain: [] }, 'abc', '九州大陆'))).toBe(true);
    expect(hasShareData(makeSave(DEFAULT_PARAMS, { names: { 'region:r1': '甲' }, interventions: [], terrain: [] }, 'abc'))).toBe(true);
    expect(hasShareData(makeSave(DEFAULT_PARAMS, { names: {}, interventions: [{ kind: 'unity', a: 'polity:r1#0', from: 3 }], terrain: [] }, 'abc'))).toBe(true);
  });

  it('换成链接里的修改会丢掉本地几处', () => {
    const link = sample();
    const e = (names: Record<string, string>, interventions: Intervention[] = [], title?: string, terrain: TerrainOp[] = []) =>
      makeSave(DEFAULT_PARAMS, { names, interventions, terrain }, 'abc', title);
    // 本地和链接一样 / 本地是链接的一部分:什么都不丢
    expect(editsLost(link, link)).toBe(0);
    expect(editsLost(e({ 'region:r45': '九嶷州' }, [link.edits.interventions[0]]), link)).toBe(0);
    // 同一个城改成了别的名字、链接里没有的改名、链接里没有的干预、世界名不同
    expect(editsLost(e({ 'settlement:r123#0': '混沌城' }), link)).toBe(1);
    expect(editsLost(e({ 'settlement:r1#0': '甲', 'settlement:r2#0': '乙' }), link)).toBe(2);
    expect(editsLost(e({}, [{ kind: 'unity', a: 'polity:r1#0', from: 3 }]), link)).toBe(1);
    expect(editsLost(e({}, [], '别的名字'), link)).toBe(1);
    expect(editsLost(e({}, [], '别的名字'), e({ a: 'b' }))).toBe(0);
    // 地形修改也逐处比:链接里有的不算丢,链接里没有的算
    const mine: TerrainOp = { kind: 'lake', pts: [300, 400], r: 16, s: 1 };
    expect(editsLost(e({}, [], undefined, [link.edits.terrain[0], mine]), link)).toBe(1);
    expect(editsLost(e({}, [], undefined, [mine, { ...mine, pts: [310, 400] }]), link)).toBe(2);
  });
});
