/**
 * 我们提供的 AI(按次扣积分)—— 客户端。服务器是另一个独立程序,不在本仓库里;下面是客户端依赖的接口要点,客户端照这份约定实现。
 * 开发时用本地假服务器(scripts/lib/fakeAiServer.ts,dev 模式下挂在 /__fake-ai,网址加 aiServer=fake 启用)跑通整条流程。
 *
 * ─── 服务器接口约定 v1 ─────────────────────────────────────────────────────────────
 * 基址:构建变量 VITE_AI_SERVER(如 https://ai.example.com)。没配置 = 未开放,界面显示"还在内测,暂未开放"。
 * 格式:请求、回复都是 JSON(UTF-8);登录后的接口带请求头 Authorization: Bearer <令牌>。
 * 跨域:网页直接调,服务器要回 CORS 头(允许 Authorization、Content-Type;GET / POST / OPTIONS)。
 *
 *   POST /v1/auth/code    { account }                   发验证码(account = 邮箱或手机号)
 *                         → 200 { ok: true, resendAfter?: 秒 }
 *   POST /v1/auth/login   { account, code }             登录
 *                         → 200 { token, expiresAt?: ISO 时间, user: { id, account, name? }, credits: 余额 }
 *   GET  /v1/me                                         查积分余额(令牌过期回 401)
 *                         → 200 { user, credits, pricing?: { note: 计费说明(原样显示) } }
 *   POST /v1/auth/logout                                退出(令牌作废)→ 204
 *   POST /v1/chat         { requestId, feature, title?, messages, temperature?, maxTokens?, json? }   调一次 AI
 *                         → 200 text/event-stream,依次:
 *                             event: delta  data: {"text":"这一段"}                          (多条)
 *                             event: done   data: {"model","usage":{"inputTokens","outputTokens"},"charged":本次扣的积分,"balance":剩余}
 *                           或中途出错:event: error  data: {"code","message","balance"?}
 *                         → 调用前就失败:HTTP 状态码 + { error: { code, message, balance?, need? } }
 *
 *   错误码(error.code / HTTP 状态):
 *     auth 401(没登录 / 令牌过期:客户端清掉令牌,请用户重新登录)   quota 402(积分不够;带 balance 余额、need 这次要多少)
 *     rate-limit 429(太频繁;可带 retryAfter 秒)                  bad-code 400(验证码不对或过期)
 *     bad-request 400(参数不对,比如内容太长)                     content-filter 400(内容没通过审核)
 *     unavailable 503(上游 AI 暂时不可用)                         server 500(服务器出错)
 *   message 是给用户看的中文,客户端原样显示。
 *
 *   工具调用(助手用,可选字段):请求里 tools 是 OpenAI 兼容的写法 [{ type: 'function', function: { name, description, parameters } }],
 *     toolChoice = 'auto' | 'none' | 'required';messages 里带工具调用的 assistant 写成 { role, content, tool_calls },
 *     工具结果写成 { role: 'tool', tool_call_id, content }(都和 OpenAI 兼容接口一样,服务器原样转给模型)。
 *     模型要调用工具时,done 里多一个 tool_calls: [{ id, type: 'function', function: { name, arguments } }](这时正文可能是空的)。
 *     一个助手任务会连着调好几次 /v1/chat(每轮一次)。
 *   扣积分:按次,扣多少由服务器定,每次在 done.charged 里告诉客户端,客户端记进调用记录。
 *   requestId:客户端每次调用生成一个,服务器对同一个 requestId 只扣一次(断线重试不重复扣)。
 *   隐私:服务器不保存调用正文,只留计费需要的(时间、功能、用量、扣了多少);调用记录在用户自己的浏览器里。
 * ──────────────────────────────────────────────────────────────────────────────────
 */
import { useSyncExternalStore } from 'react';
import { notifyAiChanged, type AiProvider } from '../client';
import { AiError, type AiUsage } from '../types';
import { getSecrets, scrubSecrets, setSecret } from '../settings';
import { idleTimer, readSse } from '../sse';
import { ToolCallAcc, wireMessage } from './compat';

// ---------------------------------------------------------------------------
// 服务器地址

let serverOverride: string | null | undefined;

/** 我们的服务器地址;null = 未开放 */
export function officialServer(): string | null {
  if (serverOverride !== undefined) return serverOverride;
  const env = (import.meta.env?.VITE_AI_SERVER as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  // 开发时:网址加 aiServer=fake 用本地假服务器(vite.config.ts 里挂的);正式构建里这段不生效
  if (import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('aiServer') === 'fake') return '/__fake-ai';
  return null;
}

/** 单测用:指定服务器地址(null = 未开放;undefined = 恢复按构建变量) */
export function setOfficialServerForTest(url: string | null | undefined): void {
  serverOverride = url;
  notifyAiChanged();
}

// ---------------------------------------------------------------------------
// 账户状态(登录了没、积分余额),设置面板显示

export interface OfficialAccount {
  loggedIn: boolean;
  account?: string;
  name?: string;
  credits?: number;
  /** 服务器给的计费说明 */
  pricing?: string;
  /** 最近一次用的模型 */
  model?: string;
  /** 正在查余额 */
  checking?: boolean;
  /** 查余额失败的原因 */
  error?: string;
}

let acct: OfficialAccount = { loggedIn: false };
const subs = new Set<() => void>();
function setAcct(patch: Partial<OfficialAccount>, replace = false) {
  acct = replace ? ({ loggedIn: false, ...patch } as OfficialAccount) : { ...acct, ...patch };
  for (const f of subs) f();
  notifyAiChanged();
}

function token(): string | undefined {
  return getSecrets().official?.token;
}

export function getOfficialAccount(): OfficialAccount {
  const t = getSecrets().official;
  if (!t) return { loggedIn: false };
  return { ...acct, loggedIn: true, account: acct.account ?? t.account };
}

let snap: { a: OfficialAccount; t: string | undefined; s: OfficialAccount } | null = null;
function snapshot(): OfficialAccount {
  const t = token();
  if (!snap || snap.a !== acct || snap.t !== t) snap = { a: acct, t, s: getOfficialAccount() };
  return snap.s;
}

/** React:我们的 AI 的账户状态 */
export function useOfficialAccount(): OfficialAccount {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    snapshot,
    snapshot,
  );
}

// ---------------------------------------------------------------------------
// 请求与错误

interface ServerError {
  code?: string;
  message?: string;
  balance?: number;
  need?: number;
}

function toAiError(status: number, e: ServerError | undefined): AiError {
  const code = e?.code ?? '';
  const msg = e?.message ? scrubSecrets(String(e.message)).slice(0, 200) : '';
  if (typeof e?.balance === 'number') setAcct({ credits: e.balance });
  if (status === 401 || code === 'auth') {
    // 令牌过期:清掉,请用户重新登录
    if (token()) setSecret('official', undefined);
    setAcct({}, true);
    return new AiError('auth', msg || '登录过期了,请在"AI"设置里重新登录');
  }
  if (status === 402 || code === 'quota') {
    const left = typeof e?.balance === 'number' ? `,还剩 ${e.balance} 积分` : '';
    const need = typeof e?.need === 'number' ? `(这次要 ${e.need} 积分)` : '';
    return new AiError('quota', msg || `积分不够了${need}${left}`);
  }
  if (status === 429 || code === 'rate-limit') return new AiError('rate-limit', msg || '调用太频繁,等一会儿再试');
  if (code === 'bad-code') return new AiError('auth', msg || '验证码不对或已过期');
  if (code === 'content-filter') return new AiError('content-filter', msg || '内容没通过审核,换个说法再试');
  if (status === 503 || code === 'unavailable') return new AiError('other', msg || '我们的 AI 暂时不可用,稍后再试');
  return new AiError('other', msg || `我们的服务器出错了(HTTP ${status}),稍后再试`);
}

async function api<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const base = officialServer();
  if (!base) throw new AiError('not-configured', '我们的 AI 还在内测,暂未开放');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.auth) {
    const t = token();
    if (!t) throw new AiError('not-configured', '还没登录我们的 AI');
    headers.Authorization = `Bearer ${t}`;
  }
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
    });
  } catch {
    throw new AiError('network', '连不上我们的服务器:请检查网络后再试');
  }
  const raw = await res.text().catch(() => '');
  let j: any = null;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {
    /* 不是 JSON */
  }
  if (!res.ok) throw toAiError(res.status, j?.error);
  if (res.status !== 204 && (j === null || typeof j !== 'object')) throw new AiError('bad-response', '我们的服务器返回的内容看不懂');
  return j as T;
}

interface UserInfo {
  id?: string;
  account?: string;
  name?: string;
}

/** 发验证码。开发假服务器会把验证码直接返回(devCode),正式服务器发到邮箱 / 手机 */
export async function sendLoginCode(account: string): Promise<{ devCode?: string; resendAfter?: number }> {
  const r = await api<{ devCode?: string; resendAfter?: number }>('/v1/auth/code', { method: 'POST', body: { account: account.trim() } });
  return { devCode: typeof r.devCode === 'string' ? r.devCode : undefined, resendAfter: typeof r.resendAfter === 'number' ? r.resendAfter : undefined };
}

export async function loginOfficial(account: string, code: string): Promise<void> {
  const r = await api<{ token?: string; user?: UserInfo; credits?: number }>('/v1/auth/login', {
    method: 'POST',
    body: { account: account.trim(), code: code.trim() },
  });
  if (typeof r.token !== 'string' || !r.token) throw new AiError('bad-response', '登录失败:服务器没给令牌');
  setSecret('official', { token: r.token, account: r.user?.account ?? account.trim() });
  setAcct({ loggedIn: true, account: r.user?.account ?? account.trim(), name: r.user?.name, credits: num(r.credits) }, true);
  void refreshOfficialAccount();
}

export async function logoutOfficial(): Promise<void> {
  const had = token();
  if (had) {
    // 先在本地忘掉(断网也能退出),再告诉服务器作废令牌
    const base = officialServer();
    setSecret('official', undefined);
    setAcct({}, true);
    if (base) {
      await fetch(base + '/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${had}` }, credentials: 'omit' }).catch(() => {});
    }
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 查积分余额和登录状态 */
export async function refreshOfficialAccount(): Promise<void> {
  if (!officialServer() || !token()) return;
  setAcct({ checking: true, error: undefined });
  try {
    const r = await api<{ user?: UserInfo; credits?: number; pricing?: { note?: string } }>('/v1/me', { auth: true });
    setAcct({
      checking: false,
      loggedIn: true,
      account: r.user?.account ?? acct.account,
      name: r.user?.name,
      credits: num(r.credits),
      pricing: typeof r.pricing?.note === 'string' ? r.pricing.note : undefined,
    });
  } catch (e) {
    setAcct({ checking: false, error: e instanceof AiError ? e.message : String(e) });
  }
}

function requestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  return `${Date.now().toString(36)}-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const IDLE_MS = 90_000;

export const officialProvider: AiProvider = {
  kind: 'official',
  label: '我们的 AI(积分)',
  offered() {
    return officialServer() !== null;
  },
  status() {
    if (!officialServer()) {
      return { ready: false, model: '', reason: '我们的 AI 还在内测,暂未开放;现在可以先在"AI"设置里填自己的 DeepSeek 或阿里云百炼密钥' };
    }
    if (!token()) return { ready: false, model: '', reason: '还没登录我们的 AI:到"AI"设置里登录' };
    return { ready: true, model: acct.model ?? '我们的 AI' };
  },
  async chat(req, opts) {
    const base = officialServer();
    const t = token();
    if (!base) throw new AiError('not-configured', '我们的 AI 还在内测,暂未开放');
    if (!t) throw new AiError('not-configured', '还没登录我们的 AI:到"AI"设置里登录');
    if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
    const idle = idleTimer(opts.signal, IDLE_MS);
    const fail = (e: unknown, phase: 'connect' | 'read'): AiError => {
      if (e instanceof AiError) return e;
      if (opts.signal?.aborted) return new AiError('aborted', '已取消');
      if (idle.timedOut()) return new AiError('network', `我们的 AI 超过 ${IDLE_MS / 1000} 秒没有回应,稍后再试`);
      return new AiError('network', phase === 'connect' ? '连不上我们的服务器:请检查网络后再试' : '和我们服务器的连接中途断了,请再试一次');
    };
    try {
      let res: Response;
      try {
        res = await fetch(base + '/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${t}` },
          body: JSON.stringify({
            requestId: requestId(),
            feature: req.feature,
            title: req.title,
            messages: req.messages.map(wireMessage),
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            json: req.json || undefined,
            tools: req.tools?.length
              ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
              : undefined,
            toolChoice: req.tools?.length ? req.toolChoice : undefined,
          }),
          signal: idle.signal,
          credentials: 'omit',
        });
      } catch (e) {
        throw fail(e, 'connect');
      }
      idle.arm();
      if (!res.ok || !res.body) {
        let j: any = null;
        try {
          j = JSON.parse(await res.text());
        } catch {
          /* 不是 JSON */
        }
        throw toAiError(res.status, j?.error);
      }
      let text = '';
      let done: { model?: string; usage?: AiUsage; charged?: number; balance?: number; tool_calls?: unknown } | null = null;
      try {
        for await (const ev of readSse(res.body, idle.arm)) {
          let j: any;
          try {
            j = JSON.parse(ev.data);
          } catch {
            throw new AiError('bad-response', '我们的服务器返回的内容看不懂');
          }
          if (ev.event === 'delta' && typeof j?.text === 'string') {
            text += j.text;
            if (j.text) opts.onDelta?.(j.text, text);
          } else if (ev.event === 'done') {
            done = j ?? {};
            break;
          } else if (ev.event === 'error') {
            throw toAiError(j?.code === 'quota' ? 402 : j?.code === 'auth' ? 401 : 500, j);
          }
        }
      } catch (e) {
        throw fail(e, 'read');
      }
      if (!done) throw new AiError('network', '和我们服务器的连接中途断了,请再试一次');
      const usage =
        done.usage && typeof done.usage === 'object'
          ? { inputTokens: num(done.usage.inputTokens) ?? 0, outputTokens: num(done.usage.outputTokens) ?? 0 }
          : undefined;
      const model = typeof done.model === 'string' && done.model ? done.model : '我们的 AI';
      setAcct({ credits: num(done.balance) ?? acct.credits, model });
      const acc = new ToolCallAcc();
      acc.add(done.tool_calls);
      const toolCalls = acc.calls();
      return { text, model, usage, credits: num(done.charged), ...(toolCalls.length ? { toolCalls } : {}) };
    } finally {
      idle.dispose();
      // 中途取消:服务器可能按已生成的部分扣了,重新查一次余额
      if (opts.signal?.aborted) void refreshOfficialAccount();
    }
  },
};
