/**
 * 开发用的假网站服务器:照 src/ai/providers/official.ts(登录、AI)和 src/account/cloud.ts(世界、分享)文件头的接口约定实现,
 * 不联网、不调真 AI,只用来跑通"登录 → 看积分 → 调用扣积分 → 积分不够报错"和"世界存进账号、同步、分享短链接"整条流程。
 *
 * - 开发时(pnpm dev)vite.config.ts 把它挂在 /__fake-ai 下;网址加 `aiServer=fake` 让页面用它
 * - 单测里直接调 handle(Request) → Response(不开端口)
 * - 状态都在内存里:重启 dev server 就清空
 *
 * 规则:验证码固定 246810(发验证码时也在 devCode 里返回);新账户 10 积分;每次调用扣 3 积分,"连接测试"扣 1 积分;
 * POST /v1/dev/credits { credits } 直接改余额(测"积分不够")。
 * 邀请制(inviteOnly,开发服务器里开着):新邮箱要邀请码 K7QM-2XPA(大小写、横线不计较;假服务器里用不完)。
 * 世界、最近删除、分享都在内存里;最近删除不会过期。
 * 带工具的请求(助手):最后一条不是工具结果时,回一个对第一个工具的调用(参数为空,done.tool_calls);是工具结果时正常回话。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const FAKE_CODE = '246810';
/** 开发服务器的邀请码 */
export const FAKE_INVITE = 'K7QM-2XPA';

interface World {
  rev: number;
  save: unknown;
  meta: unknown;
  thumb: string | null;
  notes: unknown;
  updatedAt: number;
  deletedAt: number | null;
}

interface User {
  id: string;
  account: string;
  credits: number;
  worlds: Map<string, World>;
}

interface Share {
  user: User;
  worldId: string;
  createdAt: number;
  stopped: boolean;
  opens: number;
}

export interface FakeAiOptions {
  startCredits?: number;
  /** 每段流式回复之间等多久(毫秒);单测里设 0 */
  chunkDelayMs?: number;
  /** 邀请制:新邮箱要邀请码 */
  inviteOnly?: boolean;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

const WORLD_ID = /^w[0-9a-z]{6,24}$/;
const iso = (t: number) => new Date(t).toISOString();
const normInvite = (v: unknown) => (typeof v === 'string' ? v.toUpperCase().replace(/[\s-]/g, '') : '');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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
  const inviteOnly = !!opts.inviteOnly;
  const users = new Map<string, User>();
  const tokens = new Map<string, string>();
  const shares = new Map<string, Share>();
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

    if (req.method === 'GET' && path === '/v1/auth/options') {
      return json(200, { accountKinds: ['email'], inviteOnly, codeTtlSec: 600 });
    }

    // 邀请制下的新邮箱:没带邀请码 = 403 need-invite;带了不对 = 400 bad-invite
    const inviteCheck = (account: string, invite: unknown): Response | null => {
      if (!inviteOnly || users.has(account)) return null;
      if (!normInvite(invite)) return fail(403, 'need-invite', '这个邮箱还没有账号。现在只开放给收到邀请的人，填上邀请码就能注册');
      if (normInvite(invite) !== normInvite(FAKE_INVITE)) return fail(400, 'bad-invite', '邀请码不对，或者已经用完了');
      return null;
    };

    if (req.method === 'POST' && path === '/v1/auth/code') {
      const b = await body(req);
      const account = typeof b?.account === 'string' ? b.account.trim() : '';
      if (!/^\S+@\S+\.\S+$/.test(account) && !/^1\d{10}$/.test(account)) return fail(400, 'bad-request', '请填邮箱或 11 位手机号');
      const bad = inviteCheck(account, b?.invite);
      if (bad) return bad;
      return json(200, { ok: true, resendAfter: 60, expiresIn: 600, devCode: FAKE_CODE });
    }

    if (req.method === 'POST' && path === '/v1/auth/login') {
      const b = await body(req);
      const account = typeof b?.account === 'string' ? b.account.trim() : '';
      if (!account || b?.code !== FAKE_CODE) return fail(400, 'bad-code', '验证码不对或已过期');
      const bad = inviteCheck(account, b?.invite);
      if (bad) return bad;
      let u = users.get(account);
      if (!u) users.set(account, (u = { id: `u${++seq}`, account, credits: start, worlds: new Map() }));
      const token = `fake-${crypto.randomUUID()}`;
      tokens.set(token, account);
      return json(200, { token, user: { id: u.id, account, name: account.split('@')[0] }, credits: u.credits });
    }

    const open = /^\/v1\/s\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && open) {
      const sh = shares.get(decodeURIComponent(open[1]));
      const w = sh && !sh.stopped && users.get(sh.user.account) === sh.user ? sh.user.worlds.get(sh.worldId) : undefined;
      if (!sh || !w || w.deletedAt !== null) return fail(404, 'share-gone', '这个分享已经停止了');
      sh.opens++;
      return json(200, { save: w.save, updatedAt: iso(w.updatedAt) });
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
      // 带工具的请求(助手):还没交回过工具结果 = 调用第一个工具(参数为空);交回过 = 正常回话
      const tool = Array.isArray(b.tools) && b.toolChoice !== 'none' && messages[messages.length - 1]?.role !== 'tool' ? b.tools[0]?.function?.name : undefined;
      const toolCalls = typeof tool === 'string' && tool ? [{ id: 'call_fake_0', type: 'function', function: { name: tool, arguments: '{}' } }] : undefined;
      const reply = toolCalls
        ? ''
        : b.json
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
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          });
          ctl.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }

    if (req.method === 'POST' && path === '/v1/account/delete') {
      const b = await body(req);
      if (b?.code !== FAKE_CODE) return fail(400, 'bad-code', '验证码不对或已过期');
      users.delete(u.account);
      for (const [t, a] of tokens) if (a === u.account) tokens.delete(t);
      for (const sh of shares.values()) if (sh.user === u) sh.stopped = true;
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---- 账号里的世界(src/account/cloud.ts) ----
    const now = Date.now();
    if (req.method === 'GET' && path === '/v1/worlds') {
      return json(200, {
        worlds: [...u.worlds].map(([id, w]) => ({ id, rev: w.rev, updatedAt: iso(w.updatedAt), ...(w.deletedAt !== null ? { deleted: true } : {}) })),
      });
    }
    if (req.method === 'GET' && path === '/v1/trash') {
      const list = [...u.worlds].filter(([, w]) => w.deletedAt !== null).sort((a, b) => b[1].deletedAt! - a[1].deletedAt!);
      return json(200, {
        worlds: list.map(([id, w]) => {
          const s = (w.save ?? {}) as { title?: string; seed?: number };
          return { id, title: s.title || '未命名世界', seed: s.seed, meta: w.meta, thumb: w.thumb, deletedAt: iso(w.deletedAt!), purgeAt: iso(w.deletedAt! + 30 * 86400_000) };
        }),
      });
    }
    if (req.method === 'GET' && path === '/v1/shares') {
      const list = [...shares].filter(([, sh]) => sh.user === u && !sh.stopped && u.worlds.get(sh.worldId)?.deletedAt === null);
      return json(200, {
        shares: list
          .sort((a, b) => b[1].createdAt - a[1].createdAt)
          .map(([code, sh]) => ({ code, worldId: sh.worldId, title: ((u.worlds.get(sh.worldId)!.save ?? {}) as { title?: string }).title || '未命名世界', createdAt: iso(sh.createdAt), opens: sh.opens })),
      });
    }
    const restore = /^\/v1\/trash\/([^/]+)\/restore$/.exec(path);
    if (req.method === 'POST' && restore) {
      const w = u.worlds.get(restore[1]);
      if (!w || w.deletedAt === null) return fail(404, 'not-found', '最近删除里没有这个世界');
      w.deletedAt = null;
      w.rev++;
      w.updatedAt = now;
      return json(200, { rev: w.rev, updatedAt: iso(now) });
    }
    const one = /^\/v1\/worlds\/([^/]+)(\/share)?$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (!WORLD_ID.test(id)) return fail(400, 'bad-request', '世界编号不对');
      const w = u.worlds.get(id);
      if (one[2]) {
        const active = [...shares].find(([, sh]) => sh.user === u && sh.worldId === id && !sh.stopped);
        if (req.method === 'POST') {
          if (!w || w.deletedAt !== null) return fail(404, 'not-found', '账号里还没有这个世界,等同步好了再分享');
          if (active) return json(200, { code: active[0], worldId: id, createdAt: iso(active[1].createdAt), opens: active[1].opens });
          let code = '';
          while (!code || shares.has(code)) code = Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
          shares.set(code, { user: u, worldId: id, createdAt: now, stopped: false, opens: 0 });
          return json(200, { code, worldId: id, createdAt: iso(now), opens: 0 });
        }
        if (req.method === 'DELETE') {
          if (active) active[1].stopped = true;
          return new Response(null, { status: 204, headers: CORS });
        }
      } else if (req.method === 'GET') {
        if (!w || w.deletedAt !== null) return fail(404, 'not-found', '账号里没有这个世界');
        return json(200, { id, rev: w.rev, updatedAt: iso(w.updatedAt), save: w.save, meta: w.meta, thumb: w.thumb, notes: w.notes });
      } else if (req.method === 'PUT') {
        const b = await body(req);
        if (!b || typeof b.baseRev !== 'number' || b.baseRev < 0 || !b.save || typeof b.save !== 'object') return fail(400, 'bad-request', '存档不对');
        const cur = w?.rev ?? 0;
        const deleted = !!w && w.deletedAt !== null;
        if (b.baseRev !== cur || (deleted && !b.revive)) return fail(409, 'conflict', '别的设备先改过了', { rev: cur, deleted });
        const next: World = w ?? { rev: 0, save: null, meta: null, thumb: null, notes: null, updatedAt: now, deletedAt: null };
        next.save = b.save;
        if (b.meta !== undefined) next.meta = b.meta;
        if (b.thumb !== undefined) next.thumb = b.thumb;
        if (b.notes !== undefined) next.notes = Array.isArray(b.notes) && b.notes.length ? b.notes : null;
        next.rev = cur + 1;
        next.updatedAt = now;
        next.deletedAt = null;
        u.worlds.set(id, next);
        return json(200, { rev: next.rev, updatedAt: iso(now) });
      } else if (req.method === 'DELETE') {
        const base = new URL(req.url).searchParams.get('baseRev');
        if (!w || w.deletedAt !== null) return json(200, { rev: w?.rev ?? 0, deleted: true });
        if (base !== null && Number(base) !== w.rev) return fail(409, 'conflict', '别的设备之后又改过', { rev: w.rev, deleted: false });
        w.rev++;
        w.deletedAt = now;
        w.updatedAt = now;
        for (const sh of shares.values()) if (sh.user === u && sh.worldId === id) sh.stopped = true;
        return json(200, { rev: w.rev, deleted: true });
      }
    }

    return fail(404, 'bad-request', '没有这个接口');
  }

  return { handle, users, shares };
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
