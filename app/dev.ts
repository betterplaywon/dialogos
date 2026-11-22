// 개발용: 서버(Hono)와 화면(Vite)을 한 명령으로 띄운다.
// 모의 모델만 쓴다. .env를 읽지 않으므로 실제 모델을 부르지 않는다.
// 판은 data/app.sqlite에 남는다. 토론 기록이 들어 있으므로 data/는 커밋하지 않는다.
// APP_DB_PATH로 다른 파일을 쓰거나, ':memory:'로 파일 없이 메모리에만 둘 수 있다.

import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createApp } from './server/app.ts';
import { LIMITS } from './server/budget.ts';
import { randomMode } from './server/games.ts';
import { mockSource } from './server/models.ts';
import { API_PORT } from './server/port.ts';
import { SqliteGameStore } from './server/sqlite-store.ts';
import { loadTopics } from './server/topics.ts';

const dbPath = process.env.APP_DB_PATH || fileURLToPath(new URL('../data/app.sqlite', import.meta.url));
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const where = dbPath === ':memory:' ? '메모리에만' : relative(process.cwd(), dbPath);

const app = createApp({
  topics: loadTopics(),
  store: new SqliteGameStore(dbPath),
  models: mockSource(),
  // 모의 모델은 원장에 남지 않아 비용 상한에 닿지 않지만, 하루 턴 수는 모의 모델에도 센다.
  limits: LIMITS,
  pickMode: randomMode,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
  // 화면 서버는 /api를 넘길 때 주소를 이 서버의 것으로 바꾼다(vite.config.ts의 changeOrigin).
  allowedHosts: [`127.0.0.1:${API_PORT}`, `localhost:${API_PORT}`],
});

serve({ fetch: app.fetch, port: API_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`서버: http://127.0.0.1:${info.port}/api (모의 모델, 판 저장: ${where})`);
});

const vite = await createServer({ configFile: fileURLToPath(new URL('./web/vite.config.ts', import.meta.url)) });
await vite.listen();
vite.printUrls();
