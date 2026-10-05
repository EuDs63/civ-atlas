import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fakeAiMiddleware } from './scripts/lib/fakeAiServer';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  // 界面上显示的版本号(src/ui/version.ts)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    // 开发时的假网站服务器(账号、云同步、分享、我们的 AI;接口约定见 src/ai/providers/official.ts、src/account/cloud.ts 文件头):
    // 网址加 aiServer=fake 使用;正式构建里没有。分享短链接 /s/<码> 照正式网站的做法转到 /?s=<码>(开发时带上 aiServer=fake)
    {
      name: 'fake-ai-server',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/__fake-ai', fakeAiMiddleware({ inviteOnly: true }));
        server.middlewares.use((req, res, next) => {
          const m = /^\/s\/([A-Za-z0-9]+)\/?(?:\?.*)?$/.exec(req.url ?? '');
          if (!m) return next();
          res.writeHead(302, { Location: `/?s=${m[1]}&aiServer=fake` });
          res.end();
        });
      },
    },
  ],
  worker: { format: 'es' },
  server: { port: 5188, strictPort: true },
  // 只跑 tests/ 下的单测;本地工具目录(.claude/)里的不算
  test: { include: ['tests/**/*.test.ts'], exclude: ['**/node_modules/**', '.claude/**'] },
});
