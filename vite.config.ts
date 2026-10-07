import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fakeAiMiddleware } from './scripts/lib/fakeAiServer';
import { SOURCE_URL } from './src/ui/links';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; license: string };

/** 构建时的代码提交号(短);不在 git 仓库里构建时取 GITHUB_SHA,都没有就空着 */
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 7) ?? '';
  }
}

/**
 * 打包出来的每个 JS 文件开头的署名:作品名、版本、版权、许可证、源代码地址(`/*!` 开头的注释压缩时会保留)。
 * 主程序另带代码提交号,对得上是哪一版;后台计算的几个文件不带,不然每次发布它们的文件名都会变,浏览器得重新下载没改过的代码
 */
function banner(commit = ''): string {
  return `/*! 文明与地图 v${pkg.version}${commit ? ` (${commit})` : ''} | Copyright (C) 2026 guaner-334 | ${pkg.license} | ${SOURCE_URL} */`;
}

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
  build: { rollupOptions: { output: { banner: () => banner(buildCommit()) } } },
  worker: { format: 'es', rollupOptions: { output: { banner: () => banner() } } },
  server: { port: 5188, strictPort: true },
  // 只跑 tests/ 下的单测;本地工具目录(.claude/)里的不算
  test: { include: ['tests/**/*.test.ts'], exclude: ['**/node_modules/**', '.claude/**'] },
});
