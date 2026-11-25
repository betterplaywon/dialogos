// 서비스의 HTTP 서버. 웹 표준(Request, Response)만 쓰므로 같은 앱을 Node와 다른 배포처에 올릴 수 있다.
// 주제, 저장소, 모델은 밖에서 받는다. 이 파일은 .env를 읽지 않는다.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DeleteMemoryResponse, ErrorResponse, GamesResponse, MemoriesResponse, MemoryView, TopicsResponse } from './contract.ts';
import { createGames, GameError, isLean, isRedone, isSide, isTurnInput, isVerdict, LOCAL_USER, MAX_REDONE, type GameDeps } from './games.ts';

export interface AppDeps extends GameDeps {
  /**
   * 받을 주소(Host). 주면 다른 주소로 들어온 요청을 막는다.
   * 악성 사이트가 자기 주소를 이 컴퓨터(127.0.0.1)로 바꿔 서버를 부르는 공격(DNS 리바인딩)을 막으려는 것이다.
   */
  allowedHosts?: readonly string[];
  /** 요청한 사용자. 주지 않으면 모두 LOCAL_USER다. 로그인(3주 차)을 붙이면 여기서 사람을 가린다. */
  userOf?: (request: Request) => string;
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

  const userOf = deps.userOf ?? (() => LOCAL_USER);

  app.get('/api/topics', (c) => c.json<TopicsResponse>({ provider: deps.models.provider, topics: games.topics() }));

  app.get('/api/games', async (c) => c.json<GamesResponse>({ games: await games.list(userOf(c.req.raw)) }));

  app.post('/api/games', async (c) => {
    const { topicId, side, lean } = await readBody(c.req);
    if (typeof topicId !== 'string') throw new GameError(400, '주제(topicId)가 필요합니다.');
    if (!isSide(side)) throw new GameError(400, '지킬 입장(side)은 0이나 1입니다.');
    if (!isLean(lean)) throw new GameError(400, '지금의 생각(lean)은 -2부터 2까지의 정수입니다.');
    return c.json(await games.start(userOf(c.req.raw), topicId, side, lean), 201);
  });

  app.get('/api/games/:id', async (c) => c.json(await games.get(userOf(c.req.raw), c.req.param('id'))));

  app.post('/api/games/:id/turns', async (c) => {
    const { text, input, redone } = await readBody(c.req);
    if (typeof text !== 'string') throw new GameError(400, '보낼 말(text)이 필요합니다.');
    if (input !== undefined && !isTurnInput(input)) {
      throw new GameError(400, "말을 넣은 방식(input)은 'text', 'voice', 'voice-edited' 가운데 하나입니다.");
    }
    if (redone !== undefined && !isRedone(redone)) {
      throw new GameError(400, `다시 말한 횟수(redone)는 0부터 ${MAX_REDONE}까지의 정수입니다.`);
    }
    const entry = { input: input ?? 'text', redone: redone ?? 0 };
    // 글로만 넣은 턴에는 다시 말할 인식 글이 없다. 화면이 잘못 셌거나 손으로 만든 요청이다.
    if (entry.input === 'text' && entry.redone > 0) {
      throw new GameError(400, "글로 넣은 턴(input 'text')은 다시 말한 횟수(redone)가 0입니다.");
    }
    return c.json(await games.turn(userOf(c.req.raw), c.req.param('id'), text, entry));
  });

  app.post('/api/games/:id/end', async (c) => c.json(await games.end(userOf(c.req.raw), c.req.param('id'))));

  app.post('/api/games/:id/record', async (c) => {
    const { lean, verdict } = await readBody(c.req);
    if (!isLean(lean)) throw new GameError(400, '지금의 생각(lean)은 -2부터 2까지의 정수입니다.');
    if (!isVerdict(verdict)) throw new GameError(400, "훈계 문항의 답(verdict)은 'debate'나 'lecture'입니다.");
    return c.json(await games.record(userOf(c.req.raw), c.req.param('id'), lean, verdict));
  });

  // 기억. 고치기와 지우기도 다른 쓰는 요청처럼 POST와 JSON으로만 받아, 위의 사이트 간 요청 막기가 그대로 덮는다.
  app.get('/api/memories', async (c) =>
    c.json<MemoriesResponse>({ memories: await games.memories(userOf(c.req.raw), c.req.query('topicId')) }),
  );

  app.post('/api/memories/:id/edit', async (c) => {
    const { text } = await readBody(c.req);
    if (typeof text !== 'string') throw new GameError(400, '고칠 글(text)이 필요합니다.');
    return c.json<MemoryView>(await games.editMemory(userOf(c.req.raw), c.req.param('id'), text));
  });

  app.post('/api/memories/:id/delete', async (c) =>
    c.json<DeleteMemoryResponse>(await games.deleteMemory(userOf(c.req.raw), c.req.param('id'))),
  );

  app.notFound((c) => c.json<ErrorResponse>({ error: '없는 주소입니다.' }, 404));

  app.onError((err, c) => {
    if (err instanceof GameError) return c.json<ErrorResponse>({ error: err.message }, err.status);
    // 요청 헤더와 본문은 남기지 않는다(AGENTS.md 1번).
    console.error(`서버 오류: ${err.message}`);
    return c.json<ErrorResponse>({ error: '서버에서 문제가 생겼습니다. 잠시 뒤 다시 해 주세요.' }, 500);
  });

  return app;
}
