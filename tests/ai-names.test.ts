/**
 * AI 释名 / 起名(阶段 5):材料里有语感 / 地理 / 历史;起名 JSON 的解析与兜底;选一个后 setName 生效。
 * 全程用测试用假 AI,不联网。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { rasterize } from '../src/gen/raster';
import { NAME_STYLES } from '../src/gen/names';
import { worldNameStyle } from '../src/gen/civ/places';
import { applyNames } from '../src/gen/edits';
import { polityName } from '../src/gen/civ/growth';
import { aiChat, setActiveProvider, setMockResponder } from '../src/ai/client';
import { AiError, type AiRequest } from '../src/ai/types';
import {
  STYLE_GUIDES,
  cleanExplanation,
  defaultName,
  explainRequest,
  isMockReply,
  mockSuggestions,
  nameInfo,
  nameMaterial,
  nameStamp,
  parseSuggestions,
  styleGuide,
  suggestRequest,
  suggestionEdit,
  suggestionPreview,
  takenNames,
  worldStyleId,
  type NameInfo,
  type NameTarget,
} from '../src/ai/prompts/names';
import { clearEdits, getEdits, setName } from '../src/ui/editsStore';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const raw = generateCiv(world);
const raster = rasterize(world, 1);

const eastPolity = raw.polities.filter((p) => p.eastern).sort((a, b) => (b.dynasties?.length ?? 0) - (a.dynasties?.length ?? 0))[0];
const westCity = raw.settlements.find((s) => styleGuide(raw.cultures[s.culture]?.style)?.family === 'western' && s.capitalSpans?.length)!;
const riverId = raw.places.findIndex((p) => p.kind === 'river');
/** 测试用的新国号:挑一个这个世界里没人用、也不是它现在国号的字(换了世界也不会碰巧撞名被丢掉) */
const FRESH = ['澜', '瀚', '沅', '湘', '汾', '洹'].find(
  (s) => !takenNames(raw, { kind: 'polity', id: eastPolity.id }).has(s) && s !== nameInfo(raw, { kind: 'polity', id: eastPolity.id })!.name,
)!;
const userText = (req: AiRequest) => req.messages.find((m) => m.role === 'user')!.content;
const systemText = (req: AiRequest) => req.messages.find((m) => m.role === 'system')!.content;

afterEach(() => {
  setMockResponder(null);
  setActiveProvider(null);
  clearEdits();
});

describe('语感说明', () => {
  it('12 种语感和起名器一一对应(顺序、名字、说明一致);没人住的地方的语感和 places.ts 一样', () => {
    expect(STYLE_GUIDES.map((s) => [s.id, s.label, s.family, s.desc])).toEqual(NAME_STYLES.map((s) => [s.id, s.label, s.family, s.desc]));
    for (const s of STYLE_GUIDES) {
      expect(s.explain.length).toBeGreaterThan(30);
      expect(s.suggest.length).toBeGreaterThan(10);
    }
    for (const seed of [1, 7, 2024, 99999]) expect(worldStyleId(seed)).toBe(worldNameStyle(seed));
  });
});

describe('释名 / 起名的材料(seed 7)', () => {
  it('seed 7 里有东方国家、西幻城、河', () => {
    expect(eastPolity).toBeTruthy();
    expect(westCity).toBeTruthy();
    expect(riverId).toBeGreaterThanOrEqual(0);
  });

  it('东方国家:国名本身 + 国号规则、语感、民族、国都的地理、立国年份、国号变迁、编年史', () => {
    const m = nameMaterial(raw, { kind: 'polity', id: eastPolity.id }, raster)!;
    const u = userText(explainRequest(m));
    const style = styleGuide(raw.cultures[eastPolity.culture].style)!;
    expect(style.family).toBe('eastern');
    expect(u).toContain(`"${eastPolity.name}"是国名本身`);
    expect(u).toContain(`语感:${style.label}`);
    expect(u).toContain(style.explain);
    expect(u).toContain('主体民族:');
    expect(u).toContain('【地理】');
    expect(u).toContain(`立国时的国都 ${raw.settlements[eastPolity.capital].name}`);
    expect(u).toMatch(/年均温 -?\d+°C、年降水 \d+ mm/);
    expect(u).toContain('【历史】');
    expect(u).toContain(`第 ${Math.floor(eastPolity.founded)} 年立国`);
    expect(u).toContain('国号变迁:');
    expect(u).toContain('【编年史里和它有关的几条】');
    // 中式讲字义典故
    expect(systemText(explainRequest(m))).toContain('逐字讲字义');
    // 起名:东方国号单字或双字、不带"大"和国号
    const s = userText(suggestRequest(m, '要带水字旁'));
    expect(s).toContain('单字为主');
    expect(s).toContain('作者的额外要求:要带水字旁');
    expect(suggestRequest(m).json).toBe(true);
  });

  it('改朝换代过的东方国家:指定第几朝时,释 / 改的是那一朝的国号,材料里写上那次改朝换代', () => {
    const d = eastPolity.dynasties;
    if (!d || d.length < 2) return;
    const t: NameTarget = { kind: 'polity', id: eastPolity.id, dynasty: 1 };
    const info = nameInfo(raw, t)!;
    expect(info.keyKind).toBe('dynasty');
    expect(info.name).toBe(d[1].name);
    expect(info.key).toMatch(/^dynasty:c\d+#\d+\/1$/);
    const u = userText(explainRequest(nameMaterial(raw, t, raster)!));
    expect(u).toContain('第 2 朝的国号');
    expect(u).toContain(`第 ${Math.floor(d[1].year)} 年`);
  });

  it('西幻城:语感(拟造词源)、建城年份、做过国都、地理', () => {
    const m = nameMaterial(raw, { kind: 'settlement', id: westCity.id }, raster)!;
    const u = userText(explainRequest(m));
    const style = styleGuide(raw.cultures[westCity.culture].style)!;
    expect(style.family).toBe('western');
    expect(u).toContain(`名字:${westCity.name}`);
    expect(u).toContain(`语感:${style.label}`);
    expect(u).toContain(`第 ${Math.floor(westCity.founded)} 年建城`);
    expect(u).toContain('做过国都:');
    expect(u).toMatch(/位于地图.*部/);
    expect(u).toContain('同一语感的其他名字');
    expect(systemText(explainRequest(m))).toContain('拟造的原文拼写');
    expect(userText(suggestRequest(m))).toContain('名字格式:城名');
  });

  it('河:起名的民族、流经之地的归属变迁、沿河的城', () => {
    const m = nameMaterial(raw, { kind: 'place', id: riverId }, raster)!;
    const u = userText(explainRequest(m));
    expect(m.info.kindLabel).toBe('河流');
    expect(u).toContain('种类:河流');
    expect(u).toMatch(/按.+族.+民族.的语感起名|无人居住/);
    expect(u).toContain('【地理】');
    expect(m.geography.join('\n') + m.history.join('\n')).toMatch(/沿河的城|流经之地归属变迁/);
    expect(userText(suggestRequest(m))).toContain('河名');
  });

  it('民族、州、海也能整理材料;没有 raster 时少写地理但不出错', () => {
    const cu = raw.cultures[0];
    const mc = nameMaterial(raw, { kind: 'culture', id: cu.id }, raster)!;
    expect(userText(explainRequest(mc))).toContain(`${cu.name}族`);
    expect(mc.history.join('\n')).toContain('兴起于');
    const r = raw.regions.name!.findIndex((x) => !!x);
    const mr = nameMaterial(raw, { kind: 'region', id: r }, null)!;
    expect(mr.info.kindLabel).toBe('州');
    expect(userText(explainRequest(mr))).toContain('宜居度');
    const sea = raw.places.findIndex((p) => p.kind === 'sea');
    const ms = nameMaterial(raw, { kind: 'place', id: sea }, raster)!;
    expect(ms.people).toContain('不带哪个民族的语感');
    expect(ms.format).toMatch(/结尾/);
    expect(nameMaterial(raw, { kind: 'settlement', id: 1e6 }, raster)).toBeNull();
  });

  it('材料和时间轴无关、不太长;改名不改 stamp,历史变了 stamp 才变', () => {
    const t: NameTarget = { kind: 'settlement', id: westCity.id };
    const m = nameMaterial(raw, t, raster)!;
    expect(userText(explainRequest(m)).length).toBeLessThan(2500);
    const renamed = applyNames(raw, { [nameInfo(raw, t)!.key]: '饕餮城' });
    expect(nameInfo(renamed, t)!.name).toBe('饕餮城');
    expect(nameStamp(renamed, t)).toBe(nameStamp(raw, t));
    const moved = { ...raw, settlements: raw.settlements.map((s) => (s.id === westCity.id ? { ...s, founded: s.founded + 50 } : s)) };
    expect(nameStamp(moved, t)).not.toBe(nameStamp(raw, t));
    const pt: NameTarget = { kind: 'polity', id: eastPolity.id };
    const renamedP = applyNames(raw, { [nameInfo(raw, pt)!.key]: '秦' });
    expect(nameStamp(renamedP, pt)).toBe(nameStamp(raw, pt));
  });
});

describe('起名 JSON 的解析与兜底', () => {
  const cityInfo = (): NameInfo => nameInfo(raw, { kind: 'settlement', id: westCity.id })!;
  const polInfo = (): NameInfo => nameInfo(raw, { kind: 'polity', id: eastPolity.id })!;

  it('约定的格式:5 个名字 + 含义 + 拉丁原形', () => {
    const text = JSON.stringify({
      names: [
        { name: '阿尔瑟维尔', meaning: 'Alsaville:高地上的城镇', latin: 'Alsaville' },
        { name: '洛兰堡', meaning: '洛兰人的堡寨' },
        { name: '塞伦福德', meaning: '塞伦河上的渡口' },
        { name: '维斯特港', meaning: '西边的港口' },
        { name: '卡雷诺纳', meaning: '古语"卡雷"是岩石' },
      ],
    });
    const r = parseSuggestions(text, cityInfo());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.list.map((x) => x.name)).toEqual(['阿尔瑟维尔', '洛兰堡', '塞伦福德', '维斯特港', '卡雷诺纳']);
    expect(r.list[0].latin).toBe('Alsaville');
    expect(r.list[1].meaning).toBe('洛兰人的堡寨');
  });

  it('宽松:代码围栏、直接一个数组、别的键名、"名字:含义"字符串', () => {
    const fenced = '好的,给你:\n```json\n{"candidates":[{"名字":"洛兰堡","含义":"堡寨"}]}\n```';
    const a = parseSuggestions(fenced, cityInfo());
    expect(a.ok && a.list[0].name).toBe('洛兰堡');
    const arr = parseSuggestions('[{"name":"「塞伦福德」","desc":"渡口"}]', cityInfo());
    expect(arr.ok && arr.list[0]).toEqual({ name: '塞伦福德', meaning: '渡口' });
    const strs = parseSuggestions('{"names":["维斯特港:西边的港口","卡雷诺纳 —— 岩石之城"]}', cityInfo());
    expect(strs.ok && strs.list.map((x) => [x.name, x.meaning])).toEqual([
      ['维斯特港', '西边的港口'],
      ['卡雷诺纳', '岩石之城'],
    ]);
  });

  it('JSON 坏了(收尾引号写成中文引号、后面跟一大段废话)也能一条条捞出来', () => {
    // 某个模型回过的样子(名字换成了测试用的)
    const broken =
      '{"names":[{"name":"洛兰堡","latin":"Lorenburg","meaning":"洛兰人的堡寨"},{"name":"塞伦福德","meaning":"塞伦河上的渡口"},' +
      '{"name":"维斯特港","meaning":"西边的港口”}]}   按要求生成5个名字。已完成。 ```json {"  }';
    const r = parseSuggestions(broken, cityInfo());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.list.map((x) => x.name)).toEqual(['洛兰堡', '塞伦福德', '维斯特港']);
    expect(r.list[0]).toMatchObject({ latin: 'Lorenburg', meaning: '洛兰人的堡寨' });
    expect(r.list[2].meaning).toBe('西边的港口');
  });

  it('中式名字不留拉丁字母(模型常顺手给拼音)', () => {
    const r = parseSuggestions(JSON.stringify({ names: [{ name: FRESH, latin: 'Fresh', meaning: '新' }] }), polInfo());
    expect(r.ok && r.list[0].latin).toBeUndefined();
  });

  it('东方国号:去掉顺手打上的"国""王朝",超过两个字、带拉丁字母、重名、和现在一样的丢掉', () => {
    const info = polInfo();
    const taken = takenNames(raw, { kind: 'polity', id: eastPolity.id });
    const someTaken = [...taken][0];
    const text = JSON.stringify({
      names: [
        { name: `${FRESH}国`, meaning: '' },
        { name: '昭王朝', meaning: '' },
        { name: '大衡', meaning: '' },
        { name: '天水之国度', meaning: '太长' },
        { name: 'Qin', meaning: '拉丁字母' },
        { name: someTaken, meaning: '重名' },
        { name: info.name, meaning: '和现在一样' },
        { name: FRESH, meaning: '重复' },
      ],
    });
    const r = parseSuggestions(text, info, taken);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.list.map((x) => x.name)).toEqual([FRESH, '昭', '大衡']);
    expect(r.dropped).toBe(5);
    // 预览:国号怎么变
    expect(suggestionPreview(raw, { kind: 'polity', id: eastPolity.id }, info, FRESH)).toBe(`${FRESH}部 → ${FRESH}国 → 大${FRESH} → 大${FRESH}王朝`);
  });

  it('不合格式 / 全都不合要求时给中文提示', () => {
    const bad = parseSuggestions('抱歉,我不能帮你起名。', cityInfo());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/格式.*换一批/);
    const empty = parseSuggestions('{"names":[]}', cityInfo());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain('没给出候选名字');
    const allBad = parseSuggestions('{"names":[{"name":"Aldoria"},{"name":""},{"name":"一二三四五六七八九十一二"}]}', cityInfo());
    expect(allBad.ok).toBe(false);
    if (!allBad.ok) expect(allBad.message).toContain('都不合要求');
  });

  it('测试用假 AI 的默认回复 → 占位候选', () => {
    expect(isMockReply('{"mock":true,"feature":"起名"}')).toBe(true);
    expect(isMockReply('{"names":[{"name":"洛兰堡"}]}')).toBe(false);
    const list = mockSuggestions(raw, { kind: 'settlement', id: westCity.id }, cityInfo());
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const c of list) expect(raw.settlements.some((s) => s.name === c.name)).toBe(false);
  });
});

describe('经 aiChat 走一遍(测试用假 AI)', () => {
  it('起名:json 请求 → 解析 → 选第一个 → setName → 套上改名后城名变了;选回生成时的名字 = 恢复默认', async () => {
    setActiveProvider('mock');
    let seen: AiRequest | null = null;
    setMockResponder((req) => {
      seen = req;
      return JSON.stringify({ names: [{ name: '洛兰堡', meaning: '洛兰人的堡寨' }, { name: '塞伦福德', meaning: '渡口' }] });
    });
    const t: NameTarget = { kind: 'settlement', id: westCity.id };
    const m = nameMaterial(raw, t, raster)!;
    const res = await aiChat(suggestRequest(m, '听起来威严一点'));
    expect(seen!.feature).toBe('起名');
    expect(seen!.json).toBe(true);
    expect(userText(seen!)).toContain('作者的额外要求:听起来威严一点');
    const p = parseSuggestions(res.text, m.info, takenNames(raw, t));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const e = suggestionEdit(m.info, p.list[0].name, defaultName(raw, t, m.info));
    setName(e.key, e.value);
    const civ = applyNames(raw, getEdits().names);
    expect(civ.settlements[westCity.id].name).toBe('洛兰堡');
    // 选回生成时的名字 = 从改名表里去掉
    const back = suggestionEdit(nameInfo(civ, t)!, westCity.name, defaultName(raw, t, m.info));
    expect(back.value).toBeNull();
    setName(back.key, back.value);
    expect(getEdits().names[e.key]).toBeUndefined();
  });

  it('起名:东方国家改的是国名词根,地图上的全称跟着变', async () => {
    setActiveProvider('mock');
    setMockResponder(() => `{"names":[{"name":"${FRESH}国","meaning":"水波"}]}`);
    const t: NameTarget = { kind: 'polity', id: eastPolity.id };
    const m = nameMaterial(raw, t, raster)!;
    const p = parseSuggestions((await aiChat(suggestRequest(m))).text, m.info, takenNames(raw, t));
    expect(p.ok && p.list[0].name).toBe(FRESH);
    if (!p.ok) return;
    const e = suggestionEdit(m.info, p.list[0].name, defaultName(raw, t, m.info));
    setName(e.key, e.value);
    const civ = applyNames(raw, getEdits().names);
    expect(civ.polities[eastPolity.id].name).toBe(FRESH);
    expect(polityName(civ.polities[eastPolity.id], eastPolity.founded)).toBe(`${FRESH}部`);
  });

  it('释名:流式拼出全文;没设置 AI 时抛中文的 not-configured', async () => {
    setActiveProvider('mock');
    setMockResponder((req) => `**${req.title}**:取"凌霄"之意。\n\n相传……`);
    const m = nameMaterial(raw, { kind: 'polity', id: eastPolity.id }, raster)!;
    const chunks: string[] = [];
    const r = await aiChat(explainRequest(m), { onDelta: (c) => chunks.push(c) });
    expect(chunks.join('')).toBe(r.text);
    expect(cleanExplanation(r.text)).toBe(`${m.info.shown} · 国家:取"凌霄"之意。\n相传……`);
    setActiveProvider(null);
    const err = await aiChat(explainRequest(m)).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('not-configured');
    expect(err.message).toMatch(/[一-龥]/);
  });
});
