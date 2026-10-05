/**
 * AI 写史书(阶段 5):材料整理(src/ai/prompts/history.ts)+ 用假 AI 跑完整流程(src/ai/history.ts)。不联网。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { buildChronicle, entryInvolves, entryYearLabel, filterChronicle } from '../src/gen/civ/chronicle';
import { polityAlive, polityName } from '../src/gen/civ/growth';
import { applyNames, polityKey, settlementKey } from '../src/gen/edits';
import { NAME_STYLES } from '../src/gen/names';
import type { Civ } from '../src/gen/civ/types';
import { recentCallsInMemory, setActiveProvider, setMockResponder } from '../src/ai/client';
import {
  HISTORY_LENGTHS,
  NAME_FLAVOR,
  SYSTEM_PROMPT,
  buildHistoryPrompts,
  estimateTokens,
  PREV_CONTEXT,
  historyFingerprint,
  historyMessages,
  historyNoteKey,
  loadScope,
  storeScope,
  type HistoryLength,
  type HistoryOptions,
  type HistoryScope,
} from '../src/ai/prompts/history';
import { HISTORY_KIND, historyFileName, historyMarkdown, historyNoteStatus, listHistoryNotes, writeHistory } from '../src/ai/history';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const civ = generateCiv(world);
/** 改朝换代最多的东方国家(国史用它测分章、历朝) */
const east = civ.polities.filter((p) => p.eastern).sort((a, b) => (b.dynasties?.length ?? 0) - (a.dynasties?.length ?? 0))[0];
const LENGTHS: HistoryLength[] = ['short', 'medium', 'long'];
const userOf = (civ: Civ, o: HistoryOptions, i = 0) => historyMessages(buildHistoryPrompts(civ, o), i)[1].content;

describe('AI 写史书:材料', () => {
  it('世界通史(中篇):系统提示要求不改动事实;材料里有全部大事、大国、民族、山河、年份范围', () => {
    const p = buildHistoryPrompts(civ, { scope: { kind: 'world' }, style: 'classic', length: 'medium' });
    expect(p.title).toBe('世界通史');
    expect(p.calls).toHaveLength(1);
    expect(p.empty).toBe(false);
    const msgs = historyMessages(p, 0);
    expect(msgs[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(SYSTEM_PROMPT).toMatch(/不得改动/);
    expect(SYSTEM_PROMPT).toMatch(/年份、国名/);
    expect(SYSTEM_PROMPT).toMatch(/胜负/);
    const user = msgs[1].content;
    expect(user).toMatch(/第 0—3000 年/);
    expect(user).toMatch(/史书体/);
    expect(user).toMatch(/约 2000 字/);
    // 大事一条不落(★ 标出)
    for (const e of filterChronicle(buildChronicle(civ), { major: true })) expect(user).toContain(`★${entryYearLabel(e)} ${e.text}`);
    // 大国(极盛二十五州以上)写全:国号先后、国都、历朝 / 王室
    expect(user).toContain(`国号先后:`);
    expect(user).toContain(polityName(east, civ.endYear));
    expect(user).toMatch(/历朝:/);
    // 民族、地理
    for (const cu of civ.cultures.slice(0, 5)) expect(user).toContain(`${cu.name}族`);
    const bigSea = civ.places.filter((x) => x.kind === 'sea').sort((a, b) => a.rank - b.rank || (b.size ?? 0) - (a.size ?? 0))[0];
    expect(user).toContain(bigSea.name);
    // 分章:按时代分四章,材料里有四段
    expect(p.sections.length).toBe(4);
    expect(user.match(/^### 第.章 第 \d+—\d+ 年/gm)).toHaveLength(4);
  });

  it('按篇幅裁剪:每次调用的材料不超过这一档的上限;篇幅越短放进去的纪事越少,略去的条数写进材料', () => {
    for (const scope of [{ kind: 'world' }, { kind: 'polity', polity: east.id }, { kind: 'era', from: 1500, to: 2200 }] as HistoryScope[]) {
      const used: number[] = [];
      for (const length of LENGTHS) {
        const p = buildHistoryPrompts(civ, { scope, style: 'plain', length });
        const budget = HISTORY_LENGTHS[length].budget;
        for (const c of p.calls) {
          expect(c.body.length, `${scope.kind} ${length}`).toBeLessThanOrEqual(budget * 1.1);
          expect(c.maxTokens).toBeGreaterThan(0);
          if (c.used < c.total) expect(c.body).toMatch(/略去了/);
        }
        // 输入(含系统提示)按字数估算:一次调用不超过一万二千字(约七千 token),远在模型上下文之内
        for (let i = 0; i < p.calls.length; i++) expect(historyMessages(p, i, '字'.repeat(2000)).reduce((s, m) => s + m.content.length, 0)).toBeLessThan(12000);
        expect(p.inputTokens).toBeGreaterThan(0);
        used.push(p.calls.reduce((s, c) => s + c.used, 0));
      }
      expect(used[0]).toBeLessThanOrEqual(used[1]);
    }
    // 短篇的通史:大事全在,小事只放一部分
    const short = buildHistoryPrompts(civ, { scope: { kind: 'world' }, style: 'plain', length: 'short' });
    const user = historyMessages(short, 0)[1].content;
    for (const e of filterChronicle(buildChronicle(civ), { major: true })) expect(user).toContain(e.text);
    expect(short.calls[0].used).toBeLessThan(short.calls[0].total);
  });

  it('长篇分章多次调用:带全书目录;第二章起带上前文(整篇给,太长取末尾)', () => {
    const p = buildHistoryPrompts(civ, { scope: { kind: 'world' }, style: 'legend', length: 'long' });
    expect(p.calls.length).toBeGreaterThanOrEqual(3);
    expect(p.calls.map((c) => c.chapter)).toEqual(p.calls.map((_, i) => i));
    expect(p.calls.reduce((s, c) => s + c.chars, 0)).toBeGreaterThanOrEqual(4500);
    const first = historyMessages(p, 0, '')[1].content;
    expect(first).toMatch(/【全书目录】/);
    expect(first).toMatch(/这次写这一章/);
    expect(first).not.toMatch(/〔前文〕/);
    // 前文不长:整篇都带上(模型才看得见前面用过的人名、字号)
    const prev = '乙'.repeat(1000) + '上一章最后一句。';
    const second = historyMessages(p, 1, prev)[1].content;
    expect(second).toMatch(/〔前文〕/);
    expect(second).toContain('乙'.repeat(1000) + '上一章最后一句。');
    // 太长:只取最后 PREV_CONTEXT 字
    const long = historyMessages(p, 1, '甲'.repeat(PREV_CONTEXT + 500) + '末句。')[1].content;
    expect(long).toContain('末句。');
    expect(long).not.toContain('甲'.repeat(PREV_CONTEXT + 1));
    // 每章只放这一章的纪事
    expect(second).toContain(`〔编年史〕(本章:第二章 第 ${p.sections[1].from}—${p.sections[1].to} 年)`);
    const years = [...second.matchAll(/^- ★?第 (\d+)/gm)].map((m) => Number(m[1]));
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) expect(y >= p.sections[1].from && y <= p.sections[1].to).toBe(true);
  });

  it('纪传体通史:本纪、世家的篇名用这段结束时的国号(和卡片上一样;亡了的用亡国前的)', () => {
    const p = buildHistoryPrompts(civ, { scope: { kind: 'world' }, style: 'biography', length: 'medium' });
    const parts = p.sections.filter((s) => s.part === 'annal' || s.part === 'house');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const s of parts) {
      const q = civ.polities[s.polity!];
      const last = q.ended !== undefined ? Math.max(q.founded, q.ended - 1 / 512) : civ.endYear;
      expect(s.name).toBe(polityName(q, Math.min(s.to, last)) || q.name);
    }
    // 种子 7 有国家后来改了国号:篇名是后来的
    expect(parts.some((s) => s.name !== (polityName(civ.polities[s.polity!], civ.polities[s.polity!].founded) || civ.polities[s.polity!].name))).toBe(true);
    expect(userOf(civ, { scope: { kind: 'world' }, style: 'biography', length: 'medium' })).toContain(`本纪·${parts.find((s) => s.part === 'annal')!.name}`);
  });

  it('国史:主角写全(国号先后、历任国都、历朝、疆域、四邻),东方国家按朝代分章;书名用国号', () => {
    const p = buildHistoryPrompts(civ, { scope: { kind: 'polity', polity: east.id }, style: 'classic', length: 'medium' });
    const user = historyMessages(p, 0)[1].content;
    expect(p.title).toMatch(/史$/);
    expect(user).toMatch(/一国的国史/);
    expect(user).toMatch(/国号先后:/);
    expect(user).toMatch(/国都:/);
    expect(user).toMatch(/历朝:/);
    expect(user).toMatch(/疆域:极盛约/);
    expect(user).toMatch(/四邻/);
    expect(east.dynasties!.length).toBeGreaterThanOrEqual(2);
    expect(p.sections.length).toBeGreaterThanOrEqual(2);
    expect(p.sections.length).toBeLessThanOrEqual(5);
    expect(p.sections.every((s) => !!s.reign)).toBe(true);
    expect(p.sections[0].from).toBe(Math.floor(east.founded));
    // 只放和它有关的纪事
    const others = buildChronicle(civ).filter((e) => !e.polities.includes(east.id) && !e.children?.some((c) => c.polities.includes(east.id)));
    expect(others.some((e) => user.includes(e.text))).toBe(false);
    // 史事少的小国:篇幅封顶,不硬凑五千字
    const tiny = civ.polities.find((q) => buildChronicle(civ).filter((e) => e.polities.includes(q.id)).length <= 2);
    expect(tiny).toBeDefined();
    if (!tiny) return;
    const t = buildHistoryPrompts(civ, { scope: { kind: 'polity', polity: tiny.id }, style: 'classic', length: 'long' });
    expect(t.chars).toBeLessThan(HISTORY_LENGTHS.long.chars);
    expect(t.calls).toHaveLength(1);
  });

  it('国史:主角的历代君主照推演写(名字、在位年份);分章时只列这一章在位的', () => {
    const rulers = civ.people!.filter((x) => x.role === 'ruler' && x.polity === east.id).sort((a, b) => a.from! - b.from!);
    expect(rulers.length).toBeGreaterThan(2);
    const user = userOf(civ, { scope: { kind: 'polity', polity: east.id }, style: 'classic', length: 'medium' });
    const line = user.split('\n').find((l) => l.includes('历代君主('))!;
    expect(line).toBeDefined();
    expect(line).toContain(`${rulers[0].name}(第 ${Math.floor(rulers[0].from!)}`);
    expect(line).toContain(rulers[rulers.length - 1].name);
    // 系统提示:材料里的人物照写
    expect(SYSTEM_PROMPT).toMatch(/材料里写到的人物.+照材料写/);
    // 长篇分章:第二章只列第二朝起在位的君主
    const p = buildHistoryPrompts(civ, { scope: { kind: 'polity', polity: east.id }, style: 'classic', length: 'long' });
    expect(p.sections.length).toBeGreaterThanOrEqual(2);
    const s = p.sections[1];
    const second = historyMessages(p, 1)[1].content.split('\n').find((l) => l.includes('历代君主('));
    const inside = rulers.filter((x) => x.from! <= s.to && (x.until ?? Infinity) > s.from);
    if (inside.length < 2) expect(second).toBeUndefined();
    else {
      expect(second).toContain(inside[0].name);
      expect(second).not.toContain(`${rulers[0].name}(`);
    }
  });

  it('一段时代:只放这段年份的纪事,写开始和结束时的格局;没有史事的年代 = empty', () => {
    const p = buildHistoryPrompts(civ, { scope: { kind: 'era', from: 1500, to: 2000 }, style: 'plain', length: 'short' });
    const user = historyMessages(p, 0)[1].content;
    expect(p.title).toBe('第 1500—2000 年史');
    expect(user).toMatch(/- 第 1500 年:/);
    expect(user).toMatch(/- 第 2000 年:/);
    const years = [...user.matchAll(/^- ★?第 (\d+)(?:—(\d+))? 年 /gm)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])]);
    expect(years.length).toBeGreaterThan(3);
    for (const [a, b] of years) expect(b >= 1500 && a <= 2000).toBe(true);
    expect(buildHistoryPrompts(civ, { scope: { kind: 'era', from: 0, to: 200 }, style: 'plain', length: 'short' }).empty).toBe(true);
    // 起止写反了也认
    expect(buildHistoryPrompts(civ, { scope: { kind: 'era', from: 2000, to: 1500 }, style: 'plain', length: 'short' }).title).toBe('第 1500—2000 年史');
  });

  it('用户改过的名字照用(civ 已套上改名),历史指纹跟着变', () => {
    const cap = civ.settlements[east.capital];
    const renamed = applyNames(civ, { [polityKey(civ, east.id)]: '饕', [settlementKey(civ, cap.id)]: '饕餮城' });
    const o: HistoryOptions = { scope: { kind: 'polity', polity: east.id }, style: 'classic', length: 'medium' };
    const before = userOf(civ, o);
    const after = userOf(renamed, o);
    expect(before).not.toContain('饕餮城');
    expect(after).toContain('饕餮城');
    expect(after).toMatch(/饕部|饕国|大饕/);
    expect(after).not.toContain(`${east.name}部`);
    expect(historyFingerprint(renamed, o.scope)).not.toBe(historyFingerprint(civ, o.scope));
    expect(historyFingerprint(renamed, { kind: 'world' })).not.toBe(historyFingerprint(civ, { kind: 'world' }));
    // 同一份历史:指纹不变
    expect(historyFingerprint(generateCiv(world), o.scope)).toBe(historyFingerprint(civ, o.scope));
  });

  it('干预重推之后指纹变;只看这个范围:别国改名不影响这一国的国史', () => {
    const year = 2000;
    const big = civ.polities.filter((p) => polityAlive(p, year)).sort((a, b) => (b.titles?.at(-1)?.tier ?? 0) - (a.titles?.at(-1)?.tier ?? 0))[0];
    const resim = generateCiv(world, { interventions: [{ kind: 'halt', a: polityKey(civ, big.id), from: year }] });
    expect(historyFingerprint(resim, { kind: 'world' })).not.toBe(historyFingerprint(civ, { kind: 'world' }));
    // 和主角从没打过交道的国家改名:主角的国史指纹不变
    const mine = buildChronicle(civ).filter((e) => entryInvolves(e, east.id));
    const stranger = civ.polities.find((q) => q.id !== east.id && !mine.some((e) => entryInvolves(e, q.id)))!;
    expect(stranger).toBeDefined();
    const renamed = applyNames(civ, { [polityKey(civ, stranger.id)]: '饕' });
    expect(historyFingerprint(renamed, { kind: 'polity', polity: east.id })).toBe(historyFingerprint(civ, { kind: 'polity', polity: east.id }));
    expect(historyFingerprint(renamed, { kind: 'polity', polity: stranger.id })).not.toBe(historyFingerprint(civ, { kind: 'polity', polity: stranger.id }));
  });

  it('存档里记的"写什么":国家按稳定键记,换一份 civ 也找得到;笔记的键按范围 + 文体 + 篇幅', () => {
    const s = storeScope(civ, { kind: 'polity', polity: east.id });
    expect(s).toMatchObject({ kind: 'polity', key: polityKey(civ, east.id) });
    expect(loadScope(generateCiv(world), s)).toEqual({ kind: 'polity', polity: east.id });
    expect(loadScope(civ, { kind: 'polity', key: 'polity:c999999#0', name: 'x' })).toBeNull();
    expect(historyNoteKey(storeScope(civ, { kind: 'era', from: 900, to: 300 }), 'plain', 'short')).toBe('史书:era:300-900:plain:short');
    expect(historyNoteKey({ kind: 'world' }, 'classic', 'long')).toBe('史书:world:classic:long');
  });

  it('同一个 civ + 选项永远得到同样的提示词', () => {
    const o: HistoryOptions = { scope: { kind: 'world' }, style: 'classic', length: 'long' };
    const a = buildHistoryPrompts(civ, o);
    const b = buildHistoryPrompts(generateCiv(world), o);
    expect(b.calls.map((c) => c.head + c.body)).toEqual(a.calls.map((c) => c.head + c.body));
  });

  it('地名语感的说明和 gen/names 一致;字数估算', () => {
    for (const s of NAME_STYLES) expect(NAME_FLAVOR[s.id]).toEqual({ family: s.family, label: s.label });
    expect(Object.keys(NAME_FLAVOR)).toHaveLength(NAME_STYLES.length);
    expect(estimateTokens('大昌享国三百年')).toBe(Math.ceil(7 * 0.85));
    expect(estimateTokens('abc')).toBe(1);
  });
});

describe('AI 写史书:用假 AI 跑完整流程', () => {
  it('没设置 AI:抛 not-configured,不存', async () => {
    setActiveProvider(null);
    await expect(writeHistory(civ, { scope: { kind: 'world' }, style: 'classic', length: 'short' }, { world: 'w-none' })).rejects.toMatchObject({ code: 'not-configured' });
    expect(listHistoryNotes('w-none')).toHaveLength(0);
  });

  it('长篇:一章调用一次、边写边回调、写完存进本地;改名后标"历史已变";重写覆盖同一部', async () => {
    setActiveProvider('mock');
    setMockResponder((req) => `## ${req.title}\n\n这一章写了${req.messages[1].content.length}字的材料。`);
    const w = 'w-flow';
    const o: HistoryOptions = { scope: { kind: 'polity', polity: east.id }, style: 'plain', length: 'long' };
    const p = buildHistoryPrompts(civ, o);
    const n0 = recentCallsInMemory().length;
    const seen: number[] = [];
    let last = '';
    const note = await writeHistory(civ, o, { world: w, onProgress: (x) => (seen.push(x.call), (last = x.text)) });
    // 调了几次、每次记一条调用记录(功能名"史书")
    expect(recentCallsInMemory().length - n0).toBe(p.calls.length);
    const calls = recentCallsInMemory().slice(0, p.calls.length).reverse();
    expect(calls.map((r) => r.feature)).toEqual(p.calls.map(() => HISTORY_KIND));
    expect(calls.map((r) => r.title)).toEqual(p.calls.map((c) => c.title));
    expect(calls.every((r) => r.ok)).toBe(true);
    expect(new Set(seen)).toEqual(new Set(p.calls.map((_, i) => i)));
    expect(last).toBe(note.text);
    for (const c of p.calls) expect(note.text).toContain(`## ${c.title}`);
    // 第二章起发出去的消息带上了前文
    const second = calls[1];
    expect(second.messages[1].content).toContain('〔前文〕');
    expect(second.messages[1].content).toContain(`## ${p.calls[0].title}`);
    // 存好了
    const list = listHistoryNotes(w);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: '史书', provider: 'mock', key: historyNoteKey(storeScope(civ, o.scope), 'plain', 'long') });
    expect(list[0].book).toMatchObject({ title: p.title, style: 'plain', length: 'long', fp: p.fingerprint, seed: 7, calls: p.calls.length });
    expect(historyNoteStatus(civ, list[0])).toMatchObject({ stale: false, scope: o.scope });
    // 改名 → 历史已变(还能按原来的选项重写)
    const renamed = applyNames(civ, { [polityKey(civ, east.id)]: '饕' });
    expect(historyNoteStatus(renamed, list[0])).toMatchObject({ stale: true, scope: o.scope });
    // 导出 Markdown
    const md = historyMarkdown(list[0]);
    expect(md.startsWith(`# ${p.title}\n`)).toBe(true);
    expect(md).toContain('种子 7');
    expect(md).toContain(note.text);
    expect(historyFileName(list[0])).toMatch(/^[^\\/:*?"<>|\s]+\.md$/);
    // 重写:同一个键覆盖,还是一部
    setMockResponder(() => '重写的正文');
    await writeHistory(renamed, o, { world: w });
    const again = listHistoryNotes(w);
    expect(again).toHaveLength(1);
    expect(again[0].text).toBe(p.calls.map(() => '重写的正文').join('\n\n'));
    expect(historyNoteStatus(renamed, again[0]).stale).toBe(false);
    setMockResponder(() => '');
    setActiveProvider(null);
  });

  it('取消:抛 aborted,不存,已写的那部不动', async () => {
    setActiveProvider('mock');
    setMockResponder(() => '一段很长的正文'.repeat(50));
    const w = 'w-abort';
    const o: HistoryOptions = { scope: { kind: 'world' }, style: 'classic', length: 'short' };
    await writeHistory(civ, o, { world: w });
    expect(listHistoryNotes(w)).toHaveLength(1);
    const old = listHistoryNotes(w)[0].text;
    const ac = new AbortController();
    setMockResponder(() => '新的'.repeat(200));
    const job = writeHistory(civ, o, { world: w, signal: ac.signal, onProgress: (x) => x.text && ac.abort() });
    await expect(job).rejects.toMatchObject({ code: 'aborted' });
    expect(listHistoryNotes(w)[0].text).toBe(old);
    setActiveProvider(null);
  });
});
