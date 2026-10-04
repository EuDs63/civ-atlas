/**
 * 给脚本用的临时 dev server:每次随机挑一个空闲端口,用完关掉。
 * 同时跑好几份截图 / 检查(比如几个 git worktree 各跑各的)也不会抢端口。设置 WF_URL 则直接用现成的服务。
 */
import net from 'node:net';
import { createServer, type ViteDevServer } from 'vite';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startDevServer(): Promise<{ url: string; close: () => Promise<void> }> {
  if (process.env.WF_URL) return { url: process.env.WF_URL.replace(/\/$/, ''), close: async () => {} };
  const port = await freePort();
  const server: ViteDevServer = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  return { url: `http://localhost:${port}`, close: () => server.close() };
}
