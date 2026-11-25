// 개발용: 서버(Hono)와 화면(Vite)을 한 명령으로 띄운다.
// 모델과 판의 방식은 환경 변수로 고른다(server/dev-setup.ts). 모델은 APP_MODEL이 없으면 모의 모델이고, local이면 이 컴퓨터에서 도는 로컬 모델(Ollama)이다.
// 판은 APP_MODE가 없으면 모두 엔진 방식이고, random이면 판마다 지시문 방식과 엔진 방식을 반씩 고른다(눈가림 비교).
// 끝 기록을 남길 때 만드는 기억은 엔진 방식에서 켜고, 눈가림 비교에서는 끈다.
// .env를 읽지 않는다. 로컬 모델은 이 컴퓨터 안의 주소로만 부르고 단가가 0이라 돈이 들지 않는다.
// 판은 data/app.sqlite에 남는다. 토론 기록이 들어 있으므로 data/는 커밋하지 않는다.
// APP_DB_PATH로 다른 파일을 쓰거나, ':memory:'로 파일 없이 메모리에만 둘 수 있다.
// 포트는 APP_PORT(서버, 기본 8787)와 APP_WEB_PORT(화면, 기본 5173)로 바꾼다(server/port.ts).

import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createApp } from './server/app.ts';
import { LIMITS } from './server/budget.ts';
import { devSetup } from './server/dev-setup.ts';
import { SqliteGameStore } from './server/sqlite-store.ts';
import { loadTopics } from './server/topics.ts';

/** 서버를 띄우지 않고 까닭을 알린다. */
function stop(reason: string): never {
  console.error(reason);
  process.exit(1);
}

// 설정을 고르지 못하면 판 파일을 만들지 않고 멈추도록, 저장소보다 먼저 고른다.
const { models, pickMode, memory, label, ports } = await devSetup(process.env).catch((error: unknown) =>
  stop(error instanceof Error ? error.message : String(error)),
);

const dbPath = process.env.APP_DB_PATH || fileURLToPath(new URL('../data/app.sqlite', import.meta.url));
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const where = dbPath === ':memory:' ? '메모리에만' : relative(process.cwd(), dbPath);

const app = createApp({
  topics: loadTopics(),
  store: new SqliteGameStore(dbPath),
  models,
  // 모의 모델은 원장에 남지 않고 로컬 모델은 비용이 0이라 비용 상한에 닿지 않는다. 하루 턴 수는 어느 모델에도 센다.
  limits: LIMITS,
  pickMode,
  memory,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
  // 화면 서버는 /api를 넘길 때 주소를 이 서버의 것으로 바꾼다(vite.config.ts의 changeOrigin).
  allowedHosts: [`127.0.0.1:${ports.api}`, `localhost:${ports.api}`],
});

serve({ fetch: app.fetch, port: ports.api, hostname: '127.0.0.1' }, (info) => {
  console.log(`서버: http://127.0.0.1:${info.port}/api (${label}, 판 저장: ${where})`);
});

const vite = await createServer({ configFile: fileURLToPath(new URL('./web/vite.config.ts', import.meta.url)) });
await vite.listen();
vite.printUrls();
