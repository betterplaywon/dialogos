// 개발용: 서버(Hono)와 화면(Vite)을 한 명령으로 띄운다.
// 모의 모델만 쓴다. .env를 읽지 않으므로 실제 모델을 부르지 않는다. 판은 메모리에만 남는다.

import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createApp } from './server/app.ts';
import { randomMode } from './server/games.ts';
import { mockModels } from './server/models.ts';
import { API_PORT } from './server/port.ts';
import { MemoryGameStore } from './server/store.ts';
import { loadTopics } from './server/topics.ts';

const app = createApp({
  provider: 'mock',
  topics: loadTopics(),
  store: new MemoryGameStore(),
  models: mockModels(),
  pickMode: randomMode,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
  // 화면 서버는 /api를 넘길 때 주소를 이 서버의 것으로 바꾼다(vite.config.ts의 changeOrigin).
  allowedHosts: [`127.0.0.1:${API_PORT}`, `localhost:${API_PORT}`],
});

serve({ fetch: app.fetch, port: API_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`서버: http://127.0.0.1:${info.port}/api (모의 모델, 판은 메모리에만 저장)`);
});

const vite = await createServer({ configFile: fileURLToPath(new URL('./web/vite.config.ts', import.meta.url)) });
await vite.listen();
vite.printUrls();
