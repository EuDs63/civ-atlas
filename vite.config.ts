import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fakeAiMiddleware } from './scripts/lib/fakeAiServer';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // 开发时的假"我们的 AI"服务器(接口约定见 src/ai/providers/official.ts 文件头):网址加 aiServer=fake 使用;正式构建里没有
    {
      name: 'fake-ai-server',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/__fake-ai', fakeAiMiddleware());
      },
    },
  ],
  worker: { format: 'es' },
  server: { port: 5188, strictPort: true },
  // 只跑 tests/ 下的单测;本地工具目录(.claude/)里的不算
  test: { include: ['tests/**/*.test.ts'], exclude: ['**/node_modules/**', '.claude/**'] },
});
