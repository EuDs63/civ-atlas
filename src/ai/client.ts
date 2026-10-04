/**
 * AI 调用的唯一入口(阶段 5):各功能只调 aiChat(),不直接碰服务商。
 *
 * - 服务商(provider)在这里登记:setup.ts 启动时登记 official / deepseek / bailian,本文件自带 mock(测试用假 AI,不联网)
 * - 当前用哪家 = setActiveProvider(...)(设置面板改);网址带 `ai=mock` 时一律用假 AI(冒烟测试、开发用)
 * - 每次调用(成功或失败)都交给"调用记录器"(setCallRecorder,启动时换成 callLog.ts 里存本地的那个);默认只在内存里留最近 50 条
 * - 失败一律抛 AiError(中文说明),功能里 catch 了直接给用户看
 *
 * 类型见 types.ts。
 */
import { useSyncExternalStore } from 'react';
import { currentWorld } from '../ui/saveStore';
import { AiError, type AiCallOptions, type AiCallRecord, type AiProviderKind, type AiRequest, type AiResult } from './types';

export interface AiProviderStatus {
  ready: boolean;
  /** 当前用的模型名(显示用) */
  model: string;
  /** 不可用时给用户看的原因("还没填 DeepSeek 的 API 密钥") */
  reason?: string;
}

export interface AiProvider {
  kind: AiProviderKind;
  /** 界面上的名字:"我们的 AI(积分)""DeepSeek""阿里云百炼""测试用假 AI" */
  label: string;
  status(): AiProviderStatus;
  /** 这家现在开没开放(我们的 AI 没配置服务器时 = false);不写 = 开放 */
  offered?(): boolean;
  /** 真正去调;provider / ms / 记录由 aiChat 统一补 */
  chat(req: AiRequest, opts: AiCallOptions): Promise<Omit<AiResult, 'provider' | 'ms'>>;
}

// ---------------------------------------------------------------------------
// 登记与切换

const providers = new Map<AiProviderKind, AiProvider>();
let active: AiProviderKind | null = null;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
};

export function registerProvider(p: AiProvider): void {
  providers.set(p.kind, p);
  emit();
}

export function getProvider(kind: AiProviderKind): AiProvider | undefined {
  return providers.get(kind);
}

export function listProviders(): AiProvider[] {
  return [...providers.values()];
}

function mockForced(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai') === 'mock';
}

/** 当前用哪家(网址带 ai=mock 时一律是 mock) */
export function getActiveProvider(): AiProviderKind | null {
  return mockForced() ? 'mock' : active;
}

export function setActiveProvider(kind: AiProviderKind | null): void {
  if (kind === active) return;
  active = kind;
  emit();
}

/** 服务商的状态变了(比如填了密钥、积分变了)时,设置面板调一下,让界面刷新 */
export function notifyAiChanged(): void {
  emit();
}

export interface AiStatus extends AiProviderStatus {
  provider: AiProviderKind | null;
  label: string;
}

export function getAiStatus(): AiStatus {
  const kind = getActiveProvider();
  const p = kind ? providers.get(kind) : undefined;
  if (!p) return { provider: kind, label: '未设置', ready: false, model: '', reason: unsetReason() };
  return { provider: p.kind, label: p.label, ...p.status() };
}

/** 没选 AI 时的说明:我们的 AI 开放了才提它 */
function unsetReason(): string {
  const own = '填上自己的 DeepSeek / 阿里云百炼密钥';
  return providers.get('official')?.offered?.() ? `还没有设置 AI:可以用我们提供的 AI(消耗积分),或${own}` : `还没有设置 AI:可以${own}`;
}

let statusCache: { v: number; s: AiStatus } | null = null;
function statusSnapshot(): AiStatus {
  if (!statusCache || statusCache.v !== version) statusCache = { v: version, s: getAiStatus() };
  return statusCache.s;
}

/** React:当前 AI 状态(没配置时 ready = false、reason 是中文原因) */
export function useAiStatus(): AiStatus {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    statusSnapshot,
    statusSnapshot,
  );
}

// ---------------------------------------------------------------------------
// 打开设置面板(面板在 src/ui/AiSettings.tsx;功能里"还没设置 AI"时调它)

type Opener = () => void;
let settingsOpener: Opener | null = null;
export function setAiSettingsOpener(f: Opener | null): void {
  settingsOpener = f;
}
export function openAiSettings(): void {
  settingsOpener?.();
}

// ---------------------------------------------------------------------------
// 调用记录

type Recorder = (rec: AiCallRecord) => void;
const memory: AiCallRecord[] = [];
let recorder: Recorder = (rec) => {
  memory.unshift(rec);
  if (memory.length > 50) memory.length = 50;
};
/** 换成"存本地"的记录器(启动时 callLog.ts 调) */
export function setCallRecorder(f: Recorder): void {
  recorder = f;
}
/** 默认记录器里的最近几条(测试用) */
export function recentCallsInMemory(): readonly AiCallRecord[] {
  return memory;
}

let seq = 0;
const MAX_KEEP = 20000;
const clip = (s: string) => (s.length > MAX_KEEP ? s.slice(0, MAX_KEEP) + '……(已截断)' : s);

// ---------------------------------------------------------------------------
// 调用

/** 调一次 AI。没配置 / 失败抛 AiError(中文说明);成功返回全文。每次调用都记一条记录 */
export async function aiChat(req: AiRequest, opts: AiCallOptions = {}): Promise<AiResult> {
  const kind = getActiveProvider();
  const p = kind ? providers.get(kind) : undefined;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const base = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    at: new Date().toISOString(),
    feature: req.feature,
    title: req.title,
    messages: req.messages.map((m) => ({ role: m.role, content: clip(m.content) })),
    world: currentWorld()?.id,
  };
  if (!p) {
    const err = new AiError('not-configured', getAiStatus().reason ?? '还没有设置 AI');
    recorder({ ...base, provider: kind ?? 'none', model: '', ok: false, error: { code: err.code, message: err.message }, ms: 0 });
    throw err;
  }
  const st = p.status();
  if (!st.ready) {
    const err = new AiError('not-configured', st.reason ?? `${p.label} 还没设置好`);
    recorder({ ...base, provider: p.kind, model: st.model, ok: false, error: { code: err.code, message: err.message }, ms: 0 });
    throw err;
  }
  // 记下已经收到的部分:停止 / 中途断线时也写进记录(这部分服务商照样计费,用户能看到写到了哪)
  let partial = '';
  const tracked: AiCallOptions = {
    ...opts,
    onDelta: (chunk, full) => {
      partial = full;
      opts.onDelta?.(chunk, full);
    },
  };
  try {
    const r = await p.chat(req, tracked);
    const res: AiResult = { ...r, provider: p.kind, ms: Math.round(now()) };
    recorder({ ...base, provider: p.kind, model: r.model, ok: true, usage: r.usage, credits: r.credits, ms: res.ms, text: clip(r.text) });
    return res;
  } catch (e) {
    const err =
      e instanceof AiError
        ? e
        : opts.signal?.aborted
          ? new AiError('aborted', '已取消')
          : new AiError('other', `AI 调用失败:${e instanceof Error ? e.message : String(e)}`);
    recorder({
      ...base,
      provider: p.kind,
      model: st.model,
      ok: false,
      error: { code: err.code, message: err.message },
      ms: Math.round(now()),
      ...(partial ? { text: clip(partial) } : {}),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 测试用假 AI(不联网):网址带 ai=mock 时启用;单测里可以 setMockResponder 定制回复

type MockResponder = (req: AiRequest) => string;
const defaultMockResponder: MockResponder = (req) => {
  if (req.json) return JSON.stringify({ mock: true, feature: req.feature });
  const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return `【测试用假 AI · ${req.feature}】${req.title ? `「${req.title}」` : ''}这是一段假的回复,用来检查界面和流程,不代表真实效果。收到的请求约 ${last.length} 字。`;
};
let mockResponder: MockResponder = defaultMockResponder;
/** 假 AI 每段回复之间等多久(网址 mockms=N,最多 5 秒;不给 = 0) */
function mockDelay(): number {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('mockms'));
  return Number.isFinite(n) && n > 0 ? Math.min(5000, n) : 0;
}
/** 定制假 AI 的回复;传 null 恢复默认 */
export function setMockResponder(f: MockResponder | null): void {
  mockResponder = f ?? defaultMockResponder;
}

registerProvider({
  kind: 'mock',
  label: '测试用假 AI',
  status: () => ({ ready: true, model: 'mock' }),
  async chat(req, opts) {
    const text = mockResponder(req);
    // 模拟流式:切成几段,每段让出一次事件循环(网址带 mockms=N 时每段等 N 毫秒:冒烟、截图看"正在写"用)
    let full = '';
    const step = Math.max(8, Math.ceil(text.length / 6));
    const wait = mockDelay();
    for (let i = 0; i < text.length; i += step) {
      if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
      const chunk = text.slice(i, i + step);
      full += chunk;
      opts.onDelta?.(chunk, full);
      await new Promise((r) => setTimeout(r, wait));
    }
    const input = req.messages.reduce((s, m) => s + m.content.length, 0);
    return { text: full, model: 'mock', usage: { inputTokens: input, outputTokens: full.length } };
  },
});
