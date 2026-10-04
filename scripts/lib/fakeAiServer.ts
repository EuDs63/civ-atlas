/**
 * 开发用的假"我们的 AI"服务器:照 src/ai/providers/official.ts 文件头的接口约定 v1 实现,不联网、不调真 AI,只用来跑通
 * "登录 → 看积分 → 调用扣积分 → 积分不够报错"整条流程。
 *
 * - 开发时(pnpm dev)vite.config.ts 把它挂在 /__fake-ai 下;网址加 `aiServer=fake` 让页面用它
 * - 单测里直接调 handle(Request) → Response(不开端口)
 * - 状态都在内存里:重启 dev server 就清空
 *
 * 规则:验证码固定 246810(发验证码时也在 devCode 里返回);新账户 10 积分;每次调用扣 3 积分,"连接测试"扣 1 积分;
 * POST /v1/dev/credits { credits } 直接改余额(测"积分不够")。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const FAKE_CODE = '246810';

interface User {
  id: string;
  account: string;
  credits: number;
}

export interface FakeAiOptions {
  startCredits?: number;
  /** 每段流式回复之间等多久(毫秒);单测里设 0 */
  chunkDelayMs?: number;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message, ...extra } });

const costOf = (feature: string) => (feature === '连接测试' ? 1 : 3);

export function createFakeAiServer(opts: FakeAiOptions = {}) {
  const start = opts.startCredits ?? 10;
  const delay = opts.chunkDelayMs ?? 60;
  const users = new Map<string, User>();
  const tokens = new Map<string, string>();
  /** 同一个 requestId 只扣一次 */
  const charged = new Set<string>();
  let seq = 0;

  const who = (req: Request): User | null => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    const acc = m ? tokens.get(m[1]) : undefined;
    return acc ? (users.get(acc) ?? null) : null;
  };

  const body = async (req: Request): Promise<any> => {
    try {
      return await req.json();
    } catch {
      return null;
    }
  };

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (req.method === 'POST' && path === '/v1/auth/code') {
      const b = await body(req);
      const account = typeof b?.account === 'string' ? b.account.trim() : '';
      if (!/^\S+@\S+\.\S+$/.test(account) && !/^1\d{10}$/.test(account)) return fail(400, 'bad-request', '请填邮箱或 11 位手机号');
      return json(200, { ok: true, resendAfter: 60, devCode: FAKE_CODE });
    }

    if (req.method === 'POST' && path === '/v1/auth/login') {
      const b = await body(req);
      const account = typeof b?.account === 'string' ? b.account.trim() : '';
      if (!account || b?.code !== FAKE_CODE) return fail(400, 'bad-code', '验证码不对或已过期');
      let u = users.get(account);
      if (!u) users.set(account, (u = { id: `u${++seq}`, account, credits: start }));
      const token = `fake-${crypto.randomUUID()}`;
      tokens.set(token, account);
      return json(200, { token, user: { id: u.id, account, name: account.split('@')[0] }, credits: u.credits });
    }

    const u = who(req);
    if (path.startsWith('/v1/') && !u) return fail(401, 'auth', '登录过期了,请重新登录');
    if (!u) return fail(404, 'bad-request', '没有这个接口');

    if (req.method === 'GET' && path === '/v1/me') {
      return json(200, {
        user: { id: u.id, account: u.account, name: u.account.split('@')[0] },
        credits: u.credits,
        pricing: { note: '每次调用扣 3 积分,连接测试扣 1 积分(开发用假服务器)' },
      });
    }

    if (req.method === 'POST' && path === '/v1/auth/logout') {
      const t = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
      if (t) tokens.delete(t);
      return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method === 'POST' && path === '/v1/dev/credits') {
      const b = await body(req);
      if (typeof b?.credits === 'number' && b.credits >= 0) u.credits = Math.floor(b.credits);
      return json(200, { credits: u.credits });
    }

    if (req.method === 'POST' && path === '/v1/chat') {
      const b = await body(req);
      const messages = Array.isArray(b?.messages) ? b.messages : null;
      if (!messages?.length || typeof b?.feature !== 'string') return fail(400, 'bad-request', '请求缺少 feature 或 messages');
      const cost = costOf(b.feature);
      const dup = typeof b.requestId === 'string' && charged.has(b.requestId);
      if (!dup && u.credits < cost) {
        return fail(402, 'quota', `积分不够了:这次要 ${cost} 积分,还剩 ${u.credits} 积分`, { balance: u.credits, need: cost });
      }
      const input = messages.reduce((s: number, m: any) => s + String(m?.content ?? '').length, 0);
      const reply = b.json
        ? JSON.stringify({ fake: true, feature: b.feature })
        : b.feature === '连接测试'
          ? '你好'
          : `【开发用假服务器 · ${b.feature}】${b.title ? `「${b.title}」` : ''}这是一段假的回复,用来检查登录、扣积分和流式显示,不代表真实效果。`;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          const send = (event: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          ctl.enqueue(enc.encode(': 开发用假服务器\n\n'));
          const step = Math.max(4, Math.ceil(reply.length / 6));
          for (let i = 0; i < reply.length; i += step) {
            send('delta', { text: reply.slice(i, i + step) });
            if (delay) await new Promise((r) => setTimeout(r, delay));
          }
          if (!dup) {
            u.credits -= cost;
            if (typeof b.requestId === 'string') charged.add(b.requestId);
          }
          send('done', {
            model: 'fake-ai-1',
            usage: { inputTokens: input, outputTokens: reply.length },
            charged: dup ? 0 : cost,
            balance: u.credits,
          });
          ctl.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }

    return fail(404, 'bad-request', '没有这个接口');
  }

  return { handle, users };
}

/** 挂到 Vite 开发服务器上用(connect 中间件;挂载前缀已被去掉,req.url 是 /v1/...) */
export function fakeAiMiddleware(opts?: FakeAiOptions) {
  const server = createFakeAiServer(opts);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await server.handle(
        new Request(`http://fake-ai${req.url ?? '/'}`, {
          method: req.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) return void res.end();
      const reader = r.body.getReader();
      res.on('close', () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'server', message: `假服务器出错:${e instanceof Error ? e.message : String(e)}` } }));
    }
  };
}
