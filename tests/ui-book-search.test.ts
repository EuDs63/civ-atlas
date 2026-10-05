/**
 * 成书(bookStore:后台写、没设置 AI、失败重试)和搜索(searchIndex:按名字找国家、城、民族、山河)。
 * 用假 AI,不联网。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { applyNames, polityKey, settlementKey } from '../src/gen/edits';
import { polityAlive } from '../src/gen/civ/growth';
import { ownersAt } from '../src/gen/civ/timeline';
import { setActiveProvider, setMockResponder } from '../src/ai/client';
import { AiError } from '../src/ai/types';
import { listHistoryNotes } from '../src/ai/history';
import { HISTORY_LENGTHS, buildHistoryPrompts } from '../src/ai/prompts/history';
import {
  _resetBook,
  bookProgress,
  bookTitleText,
  getBook,
  openBookReader,
  openHistoryBook,
  setBookContext,
  startBook,
  stopBook,
} from '../src/ui/bookStore';
import { _resetToasts, getToast } from '../src/ui/toastStore';
import { cultureRegion, polityNameAt, searchCiv, SEARCH_LIMIT } from '../src/ui/searchIndex';
import { layout, lifeName, parseChapter } from '../src/ui/BookReader';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const civ = generateCiv(world);
const END = civ.endYear;

/** 等 bookStore 里正在写的那部写完(或停下 / 失败) */
async function settle(ms = 5000) {
  const t0 = Date.now();
  while (getBook().job?.status === 'writing') {
    if (Date.now() - t0 > ms) throw new Error('写太久了');
    await new Promise((r) => setTimeout(r, 5));
  }
  return getBook().job!;
}

describe('成书:后台写作', () => {
  afterEach(() => {
    _resetBook();
    _resetToasts();
    setMockResponder(null);
    setActiveProvider(null);
  });

  it('开始生成:窗口关上、后台写、写完存进已写的史书;右上"已完成 · 打开"读过就收起', async () => {
    setActiveProvider('mock');
    setBookContext(civ, 'w-book-1');
    openHistoryBook();
    expect(getBook().dialog.open).toBe(true);
    const ok = startBook({ scope: { kind: 'world' }, style: 'biography', length: 'k3' });
    expect(ok).toBe(true);
    expect(getBook().dialog.open).toBe(false);
    expect(getBook().job?.status).toBe('writing');
    // AI 还没回第一个字:进度 0(右上画成来回滑动的一小段,不停在最左)
    expect(bookProgress(getBook().job!)).toBe(0);
    // 同一时间只写一部
    expect(startBook({ scope: { kind: 'world' }, style: 'annals', length: 'k3' })).toBe(false);
    const j = await settle();
    expect(j.status).toBe('done');
    expect(j.title).toBe('世界通史');
    expect(j.seen).toBeFalsy();
    expect(bookProgress(j)).toBe(1);
    const notes = listHistoryNotes('w-book-1');
    expect(notes).toHaveLength(1);
    expect(notes[0].key).toBe(j.key);
    expect(notes[0].text).toContain('测试用假 AI');
    // 下次打开窗口还是这次选的文体、篇幅
    expect(getBook().prefs).toEqual({ style: 'biography', length: 'k3' });
    openBookReader(null);
    expect(getBook().reader).toMatchObject({ open: true, key: j.key });
    expect(getBook().job?.seen).toBe(true);
  });

  it('国史:国家面板进来默认那一国;史料不够时自动缩短(比所选篇幅少)', async () => {
    setActiveProvider('mock');
    setBookContext(civ, 'w-book-2');
    const p = civ.polities.find((x) => x.ended !== undefined && x.ended - x.founded < 200)!;
    openHistoryBook({ polity: p.id });
    expect(getBook().dialog.polity).toBe(p.id);
    const pr = buildHistoryPrompts(civ, { scope: { kind: 'polity', polity: p.id }, style: 'plain', length: 'k30' });
    expect(pr.chars).toBeLessThan(HISTORY_LENGTHS.k30.chars);
    expect(startBook({ scope: { kind: 'polity', polity: p.id }, style: 'plain', length: 'k30' })).toBe(true);
    expect(getBook().job?.chars).toBe(pr.chars);
    const j = await settle();
    expect(j.status).toBe('done');
    expect(j.title).toMatch(/史$/);
  });

  it('没设置 AI:不开始,窗口关上,提示条"还没有设置 AI" + 去设置;下次打开窗口照这次选的', () => {
    setActiveProvider(null);
    setBookContext(civ, 'w-book-3');
    openHistoryBook();
    const opts = { scope: { kind: 'polity' as const, polity: 1 }, style: 'annals' as const, length: 'k10' as const };
    expect(startBook(opts)).toBe(false);
    expect(getBook().job).toBe(null);
    expect(getBook().dialog.open).toBe(false);
    expect(getBook().pending).toEqual(opts);
    const t = getToast();
    expect(t?.text).toBe('还没有设置 AI');
    expect(t?.action?.label).toBe('去设置');
  });

  it('失败:提示条报错 + 重试(重试就重新写);内容审核拦下时给一句能看懂的话', async () => {
    setActiveProvider('mock');
    setBookContext(civ, 'w-book-4');
    setMockResponder(() => {
      throw new AiError('content-filter', '阿里云的内容安全审核拦下了 AI 写出来的内容');
    });
    startBook({ scope: { kind: 'world' }, style: 'biography', length: 'k3' });
    const j = await settle();
    expect(j.status).toBe('error');
    let t = getToast();
    expect(t?.text).toBe('《世界通史》没写完');
    expect(t?.more?.[0]).toContain('审核拦下了');
    expect(t?.action?.label).toBe('重试');
    // 别的错误:原话放在第二行
    setMockResponder(() => {
      throw new AiError('network', '连不上 阿里云百炼:请检查网络(代理、防火墙)后再试');
    });
    t!.action!.onClick();
    expect(getBook().job?.status).toBe('writing');
    await settle();
    t = getToast();
    expect(t?.kind).toBe('error');
    expect(t?.text).toBe('《世界通史》没写完');
    expect(t?.more?.[0]).toContain('连不上');
    // 再重试,这次写成了
    setMockResponder(null);
    t!.action!.onClick();
    expect((await settle()).status).toBe('done');
    expect(listHistoryNotes('w-book-4')).toHaveLength(1);
  });

  it('停止:写到一半的不存', async () => {
    setActiveProvider('mock');
    setBookContext(civ, 'w-book-5');
    startBook({ scope: { kind: 'world' }, style: 'plain', length: 'k3' });
    stopBook();
    const j = await settle();
    expect(j.status).toBe('stopped');
    expect(getToast()).toBe(null);
    expect(listHistoryNotes('w-book-5')).toHaveLength(0);
  });

  it('书名:世界起了名字时通史写成"某某通史"', () => {
    expect(bookTitleText('世界通史', { kind: 'world' })).toBe('《世界通史》');
    expect(bookTitleText('世界通史', { kind: 'world' }, '澜灵')).toBe('《澜灵通史》');
    expect(bookTitleText('大昌史', { kind: 'polity' }, '澜灵')).toBe('《大昌史》');
  });

  it('阅读页的章名:卷次、章名、起止年份', () => {
    expect(parseChapter('卷一 诸部初立(第 0—1045 年)')).toEqual({ n: '卷一', t: '诸部初立', y: '0–1045' });
    expect(parseChapter('第三章 三朝鼎立(1536—2349)')).toEqual({ n: '第三章', t: '三朝鼎立', y: '1536–2349' });
    expect(parseChapter('本纪·大澜王朝')).toEqual({ n: '本纪', t: '大澜王朝', y: '' });
    expect(parseChapter('列传')).toEqual({ n: '', t: '列传', y: '' });
    // 全角括号、全角冒号
    expect(parseChapter('卷一 诸部初立\uff08第 0—1045 年\uff09')).toEqual({ n: '卷一', t: '诸部初立', y: '0–1045' });
    expect(parseChapter('本纪\uff1a大澜王朝')).toEqual({ n: '本纪', t: '大澜王朝', y: '' });
  });

  it('列传在目录里写这一篇写了谁(从"### 某某传"取)', () => {
    expect(lifeName('司空弈传')).toBe('司空弈');
    expect(lifeName('二、顾珏传(第 1200—1260 年)')).toBe('顾珏');
    expect(lifeName('司空弈、顾珏合传')).toBe('司空弈、顾珏');
    expect(lifeName('顾珏传\uff08第 1200—1260 年\uff09')).toBe('顾珏');
    expect(lifeName('列传')).toBe('');
    expect(lifeName('史臣曰')).toBe('');
    const text = ['## 本纪·大渊王朝', '正文。', '### 太祖起兵', '## 列传', '### 司空弈传', '甲。', '### 顾珏传', '乙。', '### 史臣曰', '## 列传·二', '### 萨利尔传'].join('\n');
    const { chapters } = layout(text, '世界通史');
    expect(chapters.map((c) => [c.n, c.t, c.who])).toEqual([
      ['本纪', '大渊王朝', undefined],
      ['', '列传', ['司空弈', '顾珏']],
      ['列传', '二', ['萨利尔']],
    ]);
  });
});

describe('搜索', () => {
  it('什么都没输:这一年最大的几个国家(最多 8 个,州多的在前)', () => {
    const r = searchCiv(civ, '', END);
    expect(r.length).toBe(Math.min(SEARCH_LIMIT, civ.polities.filter((p) => polityAlive(p, END)).length));
    expect(r.every((h) => h.kind === 'polity' && /^\d+ 州$/.test(h.sub))).toBe(true);
    const n = r.map((h) => Number(h.sub.split(' ')[0]));
    expect([...n].sort((a, b) => b - a)).toEqual(n);
  });

  it('国家(含已亡)、城、民族、山河都搜得到;完全相同的排最前;点了选中什么', () => {
    const dead = civ.polities.find((p) => p.ended !== undefined)!;
    const deadName = polityNameAt(dead, END);
    const r1 = searchCiv(civ, deadName, END);
    expect(r1[0]).toMatchObject({ kind: 'polity', id: dead.id, name: deadName, sub: '已亡', select: { kind: 'polity', id: dead.id } });

    const s = civ.settlements.find((x) => x.founded < 1000 && x.ended === undefined)!;
    const r2 = searchCiv(civ, s.name, END);
    const hit = r2.find((h) => h.kind === 'settlement' && h.id === s.id)!;
    expect(hit.select).toEqual({ kind: 'settlement', id: s.id });
    expect(hit.sub).toMatch(/^(城|国都)/);

    const cu = civ.cultures[0];
    const r3 = searchCiv(civ, cu.name, END);
    const ch = r3.find((h) => h.kind === 'culture' && h.id === cu.id)!;
    expect(ch).toMatchObject({ name: `${cu.name}族`, sub: '民族' });
    // 民族 → 选中它人口最多的那个州(那一州住的是这个民族)
    expect(ch.select.kind).toBe('region');
    const owners = ownersAt(civ, END);
    if (cu.ended === undefined) expect(owners.culture[ch.select.id]).toBe(cu.id);
    expect(cultureRegion(civ, cu.id, END, owners)).toBe(ch.select.id);

    const pl = civ.places.findIndex((x) => x.kind === 'mountains');
    const r4 = searchCiv(civ, civ.places[pl].name, END);
    expect(r4.find((h) => h.kind === 'place' && h.id === pl)?.sub).toBe('山脉');
    for (const r of [r1, r2, r3, r4]) expect(r.length).toBeLessThanOrEqual(SEARCH_LIMIT);
  });

  it('用改过的名字搜', () => {
    const p = civ.polities.find((x) => polityAlive(x, END))!;
    const s = civ.settlements.find((x) => x.ended === undefined)!;
    const renamed = applyNames(civ, { [polityKey(civ, p.id)]: '饕餮', [settlementKey(civ, s.id)]: '不夜城' });
    expect(searchCiv(renamed, '饕餮', END)[0]).toMatchObject({ kind: 'polity', id: p.id });
    expect(searchCiv(renamed, '不夜城', END)[0]).toMatchObject({ kind: 'settlement', id: s.id, name: '不夜城' });
    expect(searchCiv(civ, '不夜城', END).some((h) => h.kind === 'settlement' && h.id === s.id)).toBe(false);
  });

  it('按用过的国号也找得到(改朝换代前的),右边写"曾称"', () => {
    const p = civ.polities.find((x) => x.eastern && (x.dynasties?.length ?? 0) >= 2 && x.dynasties![1].name)!;
    if (!p) return;
    const first = polityNameAt(p, p.dynasties![1].year - 1);
    const now = polityNameAt(p, END);
    if (now.includes(first)) return;
    const hit = searchCiv(civ, first, END).find((h) => h.kind === 'polity' && h.id === p.id);
    expect(hit?.sub).toBe(`曾称${first}`);
  });
});
