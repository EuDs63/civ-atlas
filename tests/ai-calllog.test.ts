/**
 * AI 调用记录的本地存储(src/ai/callLog.ts):记录、读回、裁剪、删除、清空、导出;存储坏了退回内存。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CALLS,
  callLogSettled,
  clearCalls,
  deleteCall,
  exportCallsJson,
  getCallLog,
  initCallLog,
  recordCall,
  type CallLogBackend,
} from '../src/ai/callLog';
import { aiChat, setActiveProvider } from '../src/ai/client';
import type { AiCallRecord } from '../src/ai/types';

/** 假的"浏览器存储":一个 Map,可以设成写入失败 */
function fakeBackend(initial: AiCallRecord[] = [], opts: { failLoad?: boolean; failPut?: boolean } = {}) {
  const db = new Map(initial.map((r) => [r.id, r]));
  const b: CallLogBackend & { db: Map<string, AiCallRecord>; opts: typeof opts } = {
    db,
    opts,
    load: async () => {
      if (opts.failLoad) throw new Error('打不开');
      return [...db.values()];
    },
    put: async (r) => {
      if (opts.failPut) throw new Error('QuotaExceededError');
      db.set(r.id, r);
    },
    remove: async (ids) => {
      for (const id of ids) db.delete(id);
    },
    clear: async () => db.clear(),
  };
  return b;
}

let seq = 0;
function rec(p: Partial<AiCallRecord> = {}): AiCallRecord {
  const i = seq++;
  return {
    id: `r${i}`,
    at: new Date(Date.UTC(2026, 8, 28, 0, 0, i)).toISOString(),
    feature: '史书',
    provider: 'mock',
    model: 'mock',
    ok: true,
    ms: 10,
    messages: [{ role: 'user', content: `第 ${i} 次` }],
    text: '回复',
    ...p,
  };
}

describe('AI 调用记录(本地存储)', () => {
  it('启动时读回存过的(新的在前),新记录同时进内存和存储;删除、清空都同步到存储', async () => {
    const old = [rec(), rec(), rec()];
    const b = fakeBackend(old);
    await initCallLog(b);
    let s = getCallLog();
    expect(s.loaded).toBe(true);
    expect(s.persistent).toBe(true);
    expect(s.calls.map((r) => r.id)).toEqual([old[2].id, old[1].id, old[0].id]);

    const r = rec();
    recordCall(r);
    expect(getCallLog().calls[0].id).toBe(r.id);
    await callLogSettled();
    expect(b.db.has(r.id)).toBe(true);

    deleteCall(old[1].id);
    await callLogSettled();
    expect(getCallLog().calls.some((x) => x.id === old[1].id)).toBe(false);
    expect(b.db.has(old[1].id)).toBe(false);

    const json = JSON.parse(exportCallsJson());
    expect(json.kind).toBe('AI 调用记录');
    expect(json.count).toBe(3);
    expect(json.calls[0].id).toBe(r.id);

    clearCalls();
    await callLogSettled();
    expect(getCallLog().calls).toHaveLength(0);
    expect(b.db.size).toBe(0);
  });

  it('读回之前就记下的也不丢(合并、去重)', async () => {
    clearCalls();
    const b = fakeBackend([rec()]);
    const p = initCallLog(b);
    const early = rec();
    recordCall(early);
    await p;
    await callLogSettled();
    expect(getCallLog().calls.map((r) => r.id)).toContain(early.id);
    expect(getCallLog().calls).toHaveLength(2);
    expect(b.db.has(early.id)).toBe(true);
  });

  it(`最多留 ${MAX_CALLS} 条,多了从最旧的删起(存储里也删)`, async () => {
    clearCalls();
    const b = fakeBackend();
    await initCallLog(b);
    const all: AiCallRecord[] = [];
    for (let i = 0; i < MAX_CALLS + 20; i++) {
      const r = rec();
      all.push(r);
      recordCall(r);
    }
    await callLogSettled();
    await new Promise((r) => setTimeout(r, 20));
    const s = getCallLog();
    expect(s.calls).toHaveLength(MAX_CALLS);
    expect(s.calls[0].id).toBe(all.at(-1)!.id);
    expect(s.calls.some((r) => r.id === all[0].id)).toBe(false);
    expect(b.db.size).toBe(MAX_CALLS);
    expect(b.db.has(all[0].id)).toBe(false);
  });

  it('体积太大时也从最旧的删起', async () => {
    clearCalls();
    await initCallLog(null);
    const big = 'x'.repeat(900_000);
    for (let i = 0; i < 8; i++) recordCall(rec({ text: big }));
    const s = getCallLog();
    expect(s.calls.length).toBeLessThan(8);
    expect(s.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('存储打不开 → 只在内存里(persistent = false),照样能记能看', async () => {
    clearCalls();
    await initCallLog(fakeBackend([], { failLoad: true }));
    expect(getCallLog().persistent).toBe(false);
    recordCall(rec());
    expect(getCallLog().calls).toHaveLength(1);
  });

  it('存储写不进(满了)→ 删掉一批旧的再试;还不行就退回内存', async () => {
    clearCalls();
    const b = fakeBackend();
    await initCallLog(b);
    b.opts.failPut = true;
    recordCall(rec());
    await callLogSettled();
    await new Promise((r) => setTimeout(r, 10));
    expect(getCallLog().persistent).toBe(false);
    expect(getCallLog().calls.length).toBeGreaterThanOrEqual(1);
  });

  it('aiChat 的每次调用都记到这里(成功和失败)', async () => {
    clearCalls();
    await initCallLog(null);
    setActiveProvider('mock');
    await aiChat({ feature: '释名', title: '碧溪城', messages: [{ role: 'user', content: '这名字什么意思' }] });
    setActiveProvider(null);
    await aiChat({ feature: '释名', messages: [{ role: 'user', content: 'x' }] }).catch(() => {});
    const s = getCallLog();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]).toMatchObject({ ok: false, error: { code: 'not-configured' } });
    expect(s.calls[1]).toMatchObject({ ok: true, feature: '释名', title: '碧溪城', provider: 'mock' });
    expect(s.calls[1].messages[0].content).toBe('这名字什么意思');
    expect(s.calls[1].text).toContain('碧溪城');
  });
});
