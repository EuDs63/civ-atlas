import { describe, expect, it } from 'vitest';
import { aiChat, getAiStatus, recentCallsInMemory, setActiveProvider, setMockResponder } from '../src/ai/client';
import { AiError } from '../src/ai/types';
import { deleteNote, getNote, listNotes, putNote } from '../src/ai/library';

describe('AI 调用入口(阶段 5 地基)', () => {
  it('没设置 AI 时抛 not-configured,并记一条失败记录', async () => {
    setActiveProvider(null);
    expect(getAiStatus().ready).toBe(false);
    await expect(aiChat({ feature: '测试', messages: [{ role: 'user', content: '你好' }] })).rejects.toBeInstanceOf(AiError);
    const rec = recentCallsInMemory()[0];
    expect(rec.ok).toBe(false);
    expect(rec.error?.code).toBe('not-configured');
    expect(rec.provider).toBe('none');
  });

  it('中途停止:抛 aborted,记录里留着已经收到的那部分', async () => {
    setActiveProvider('mock');
    setMockResponder(() => '一二三四五六七八九十'.repeat(4));
    const ac = new AbortController();
    const err = (await aiChat(
      { feature: '史书', messages: [{ role: 'user', content: '写' }] },
      { signal: ac.signal, onDelta: () => ac.abort() },
    ).catch((e) => e)) as AiError;
    expect(err.code).toBe('aborted');
    const rec = recentCallsInMemory()[0];
    expect(rec.ok).toBe(false);
    expect(rec.error?.code).toBe('aborted');
    expect(rec.text && rec.text.length).toBeGreaterThan(0);
    expect('一二三四五六七八九十'.repeat(4).startsWith(rec.text!)).toBe(true);
    setMockResponder(null);
    setActiveProvider(null);
  });

  it('setMockResponder(null) 恢复默认回复', async () => {
    setActiveProvider('mock');
    setMockResponder(() => '定制');
    expect((await aiChat({ feature: '测试', messages: [{ role: 'user', content: 'x' }] })).text).toBe('定制');
    setMockResponder(null);
    expect((await aiChat({ feature: '测试', messages: [{ role: 'user', content: 'x' }] })).text).toContain('测试用假 AI');
    setActiveProvider(null);
  });

  it('假 AI:流式回调拼出全文,记一条成功记录(含发出的消息和回复)', async () => {
    setActiveProvider('mock');
    setMockResponder((req) => `回复:${req.title}`);
    const chunks: string[] = [];
    const r = await aiChat({ feature: '史书', title: '大昌', messages: [{ role: 'user', content: '写一段' }] }, { onDelta: (c) => chunks.push(c) });
    expect(r.text).toBe('回复:大昌');
    expect(chunks.join('')).toBe(r.text);
    expect(r.provider).toBe('mock');
    const rec = recentCallsInMemory()[0];
    expect(rec.ok).toBe(true);
    expect(rec.feature).toBe('史书');
    expect(rec.text).toBe('回复:大昌');
    expect(rec.messages[0].content).toBe('写一段');
    setMockResponder(null);
    setActiveProvider(null);
  });

  it('取消:signal 中止时抛 aborted', async () => {
    setActiveProvider('mock');
    const ac = new AbortController();
    ac.abort();
    await expect(aiChat({ feature: '测试', messages: [{ role: 'user', content: 'x' }] }, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    setActiveProvider(null);
  });

  it('AI 笔记按世界存取、同 key 覆盖、可删除(没有浏览器存储时只在内存)', () => {
    const w = 'test-world';
    putNote(w, { key: 'a', kind: '史书', title: 'A', text: '一', createdAt: '', provider: 'mock', model: 'mock' });
    putNote(w, { key: 'a', kind: '史书', title: 'A', text: '二', createdAt: '', provider: 'mock', model: 'mock' });
    putNote(w, { key: 'b', kind: '释名', title: 'B', text: '三', createdAt: '', provider: 'mock', model: 'mock' });
    expect(getNote(w, 'a')?.text).toBe('二');
    expect(listNotes(w, '史书')).toHaveLength(1);
    expect(listNotes(w)).toHaveLength(2);
    deleteNote(w, 'a');
    expect(getNote(w, 'a')).toBeUndefined();
  });
});
