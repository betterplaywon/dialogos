// 서비스의 HTTP 서버. 웹 표준(Request, Response)만 쓰므로 같은 앱을 Node와 다른 배포처에 올릴 수 있다.
// 주제, 저장소, 모델은 밖에서 받는다. 이 파일은 .env를 읽지 않는다.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ErrorResponse, Provider, TopicsResponse } from './contract.ts';
import { createGames, GameError, type GameDeps } from './games.ts';

export interface AppDeps extends GameDeps {
  provider: Provider;
  /**
   * 받을 주소(Host). 주면 다른 주소로 들어온 요청을 막는다.
   * 악성 사이트가 자기 주소를 이 컴퓨터(127.0.0.1)로 바꿔 서버를 부르는 공격(DNS 리바인딩)을 막으려는 것이다.
   */
  allowedHosts?: readonly string[];
}

/** 요청 본문 상한. 한 턴의 글(1,000자)을 담고도 남는다. */
const BODY_LIMIT_BYTES = 16 * 1024;

async function readBody(request: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createApp(deps: AppDeps): Hono {
  const games = createGames(deps);
  const app = new Hono();

  if (deps.allowedHosts) {
    const allowed = new Set(deps.allowedHosts);
    app.use('*', async (c, next) => {
      if (!allowed.has(new URL(c.req.url).host)) {
        return c.json<ErrorResponse>({ error: '허용하지 않은 주소로 들어온 요청입니다.' }, 403);
      }
      await next();
    });
  }

  // 쓰는 요청은 JSON으로만 받는다. 다른 사이트가 브라우저로 보내는 단순 요청(폼, text/plain)은
  // 여기서 막히고, JSON 요청은 브라우저가 먼저 허락을 묻는데 이 서버는 허락하지 않는다.
  app.use('/api/*', async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    if (c.req.method === 'POST' && !/^application\/json\b/i.test(type)) {
      return c.json<ErrorResponse>({ error: 'JSON으로 보내 주세요(content-type: application/json).' }, 415);
    }
    await next();
  });

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json<ErrorResponse>({ error: '요청이 너무 깁니다.' }, 413),
    }),
  );

  app.get('/api/topics', (c) => c.json<TopicsResponse>({ provider: deps.provider, topics: games.topics() }));

  app.post('/api/games', async (c) => {
    const { topicId } = await readBody(c.req);
    if (typeof topicId !== 'string') throw new GameError(400, '주제(topicId)가 필요합니다.');
    return c.json(await games.start(topicId), 201);
  });

  app.get('/api/games/:id', async (c) => c.json(await games.get(c.req.param('id'))));

  app.post('/api/games/:id/turns', async (c) => {
    const { text } = await readBody(c.req);
    if (typeof text !== 'string') throw new GameError(400, '보낼 말(text)이 필요합니다.');
    return c.json(await games.turn(c.req.param('id'), text));
  });

  app.post('/api/games/:id/end', async (c) => c.json(await games.end(c.req.param('id'))));

  app.notFound((c) => c.json<ErrorResponse>({ error: '없는 주소입니다.' }, 404));

  app.onError((err, c) => {
    if (err instanceof GameError) return c.json<ErrorResponse>({ error: err.message }, err.status);
    // 요청 헤더와 본문은 남기지 않는다(AGENTS.md 1번).
    console.error(`서버 오류: ${err.message}`);
    return c.json<ErrorResponse>({ error: '서버에서 문제가 생겼습니다. 잠시 뒤 다시 해 주세요.' }, 500);
  });

  return app;
}
