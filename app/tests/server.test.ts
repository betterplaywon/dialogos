import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { firstUserMessage, openingStatement } from '../../eval/src/script.ts';
import type { ChatMessage, ChatModel } from '../../eval/src/types.ts';
import { createApp, type AppDeps } from '../server/app.ts';
import type { GamesResponse, GameView, TopicsResponse, TurnResponse } from '../server/contract.ts';
import { MAX_TEXT_LENGTH, MAX_TURNS } from '../server/games.ts';
import { mockModels } from '../server/models.ts';
import { SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type GameRecord, type GameStore, type Mode } from '../server/store.ts';
import { loadTopics } from '../server/topics.ts';

const topics = loadTopics();
const q01 = topics.get('q01');
if (!q01) throw new Error('q01이 없습니다.');

/** 받은 메시지를 모두 적어 두는 가짜 모델. */
function recorder(reply: (messages: ChatMessage[], call: number) => string): ChatModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: 'recorder',
    calls,
    async complete(messages) {
      calls.push(messages);
      return reply(messages, calls.length);
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(overrides: Partial<AppDeps> = {}) {
  let next = 0;
  const store = new MemoryGameStore();
  const app = createApp({
    provider: 'mock',
    topics,
    store,
    models: mockModels(),
    pickMode: (): Mode => 'engine',
    newId: () => `g${++next}`,
    now: () => new Date('2026-11-19T00:00:00Z'),
    ...overrides,
  });
  return { app, store };
}

type App = ReturnType<typeof setup>['app'];

interface CallOptions {
  /** POST 본문. 주지 않으면 빈 객체를 보낸다. */
  body?: unknown;
  /** JSON으로 바꾸지 않고 그대로 보낼 본문. */
  raw?: string;
  contentType?: string;
}

async function call<T>(app: App, method: 'GET' | 'POST', path: string, options: CallOptions = {}) {
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'content-type': options.contentType ?? 'application/json' };
    init.body = options.raw ?? JSON.stringify(options.body ?? {});
  }
  const response = await app.request(path, init);
  return { status: response.status, data: (await response.json()) as T };
}

async function startQ01(app: App): Promise<GameView> {
  const { status, data } = await call<GameView>(app, 'POST', '/api/games', { body: { topicId: 'q01' } });
  assert.equal(status, 201);
  return data;
}

test('주제 목록은 판정 실험의 질문과 입장 카드에서 오고, 모의 모델임을 알린다', async () => {
  const { app } = setup();
  const { status, data } = await call<TopicsResponse>(app, 'GET', '/api/topics');
  assert.equal(status, 200);
  assert.equal(data.provider, 'mock');
  assert.equal(data.topics.length, topics.size);
  assert.deepEqual(data.topics[0], {
    id: 'q01',
    question: q01.question.text,
    userStance: q01.question.userStance,
    character: { id: q01.card.id, name: q01.card.name },
  });
  // 상대의 전제와 반론은 목록에 싣지 않는다.
  assert.ok(!JSON.stringify(data).includes(q01.question.rebuttals[0]?.text ?? '없는 글'));
});

test('판을 시작하면 판정 실험과 같은 첫 말과 첫 발언이 나오고, 방식은 화면에 가지 않는다', async () => {
  const { app, store } = setup({ pickMode: () => 'prompt' });
  const game = await startQ01(app);
  assert.deepEqual(game.messages, [
    { speaker: 'user', text: firstUserMessage(q01.question) },
    { speaker: 'opponent', text: openingStatement(q01.question) },
  ]);
  assert.equal(game.turn, 0);
  assert.equal(game.maxTurns, MAX_TURNS);
  assert.equal(game.ended, false);
  assert.ok(!('mode' in game));
  assert.equal((await store.get(game.id))?.mode, 'prompt');
});

test('엔진 방식이면 판정기가 먼저 판정하고, 판정과 장부는 서버에만 남는다', async () => {
  const judge = recorder(() => '{"tactic":"argument","defeats":"P1","reason":"시험"}');
  const opponent = recorder(() => 'P1을 거둡니다. 다른 근거는 어떻습니까?');
  const { app, store } = setup({ models: { opponent, judge } });
  const game = await startQ01(app);

  const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '  반론입니다.  ' } });
  assert.equal(status, 200);
  assert.deepEqual(data, { turn: 1, reply: 'P1을 거둡니다. 다른 근거는 어떻습니까?', ended: false });

  const saved = await store.get(game.id);
  assert.deepEqual(saved?.conceded, ['P1']);
  assert.equal(saved?.turns[0]?.decision?.defeats, 'P1');
  assert.deepEqual(saved?.turns[0]?.judge, { calls: 1, readable: true });
  assert.equal(saved?.turns[0]?.user, '반론입니다.');
  // 판정기는 직전 발언과 이번 말만 보고, 상대는 판정 실험과 같은 지시문(입장 카드, 거둔 전제 표시)을 받는다.
  assert.equal(judge.calls[0]?.length, 2);
  const system = opponent.calls[0]?.[0]?.content ?? '';
  assert.ok(system.includes('[입장 카드]'));
  assert.ok(system.includes(q01.question.text));
  assert.match(system, /^P1\. .*\(이미 거둠\)$/m);

  const view = await call<GameView>(app, 'GET', `/api/games/${game.id}`);
  assert.equal(view.data.turn, 1);
  assert.equal(view.data.messages.length, 4);
  const shown = JSON.stringify(view.data) + JSON.stringify(data);
  for (const hidden of ['"mode"', '"decision"', '"conceded"', '"judge"', '"engine"']) assert.ok(!shown.includes(hidden), hidden);
});

test('지시문 방식이면 판정기를 부르지 않는다', async () => {
  const judge = recorder(() => '{}');
  const opponent = recorder(() => '답입니다.');
  const { app, store } = setup({ models: { opponent, judge }, pickMode: () => 'prompt' });
  const game = await startQ01(app);
  await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } });
  assert.equal(judge.calls.length, 0);
  assert.equal(opponent.calls.length, 1);
  const saved = await store.get(game.id);
  assert.deepEqual(saved?.conceded, []);
  assert.equal(saved?.turns[0]?.decision, undefined);
});

test('잘못된 요청은 알맞은 상태와 한국어 메시지로 막는다', async () => {
  const { app } = setup();
  const game = await startQ01(app);
  const turns = `/api/games/${game.id}/turns`;
  const cases: [number, Promise<{ status: number; data: unknown }>][] = [
    [400, call(app, 'POST', '/api/games', { body: {} })],
    [400, call(app, 'POST', '/api/games', { raw: '{깨진 JSON' })],
    [404, call(app, 'POST', '/api/games', { body: { topicId: 'q99' } })],
    [400, call(app, 'POST', turns, { body: { text: '   ' } })],
    [400, call(app, 'POST', turns, { body: { text: 42 } })],
    [400, call(app, 'POST', turns, { body: { text: '가'.repeat(MAX_TEXT_LENGTH + 1) } })],
    [404, call(app, 'POST', '/api/games/없는판/turns', { body: { text: '반론입니다.' } })],
    [404, call(app, 'GET', '/api/games/없는판')],
    [404, call(app, 'GET', '/api/없는주소')],
    [413, call(app, 'POST', turns, { body: { text: '가'.repeat(20_000) } })],
    // 다른 사이트의 폼이나 text/plain 같은 단순 요청은 받지 않는다.
    [415, call(app, 'POST', turns, { raw: '{"text":"반론입니다."}', contentType: 'text/plain' })],
    [415, call(app, 'POST', '/api/games', { raw: 'topicId=q01', contentType: 'application/x-www-form-urlencoded' })],
  ];
  for (const [index, [expected, pending]] of cases.entries()) {
    const { status, data } = await pending;
    assert.equal(status, expected, `경우 ${index}`);
    assert.match((data as { error: string }).error, /[가-힣]/, `경우 ${index}`);
  }
  // 글자 수 상한까지는 받고, 막힌 요청은 판에 남지 않는다.
  assert.equal((await call(app, 'POST', turns, { body: { text: '가'.repeat(MAX_TEXT_LENGTH) } })).status, 200);
  assert.equal((await call<GameView>(app, 'GET', `/api/games/${game.id}`)).data.turn, 1);
});

test('끝낸 판과 턴을 모두 쓴 판에는 더 보낼 수 없다', async () => {
  const { app, store } = setup();
  const game = await startQ01(app);
  const ended = await call<GameView>(app, 'POST', `/api/games/${game.id}/end`);
  assert.equal(ended.data.ended, true);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/end`)).status, 200);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } })).status, 409);

  const full = await startQ01(app);
  let last: TurnResponse | undefined;
  for (let n = 1; n <= MAX_TURNS; n++) {
    const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${full.id}/turns`, { body: { text: `${n}번째 말입니다.` } });
    assert.equal(status, 200);
    last = data;
  }
  assert.deepEqual([last?.turn, last?.ended], [MAX_TURNS, true]);
  assert.equal((await call(app, 'POST', `/api/games/${full.id}/turns`, { body: { text: '한 번 더' } })).status, 409);
  const saved = await store.get(full.id);
  assert.equal(saved?.turns.length, MAX_TURNS);
  assert.equal(saved?.history.length, 2 + MAX_TURNS * 2);
});

test('한 판에서 앞의 턴이 끝나기 전에 온 턴과 끝내기는 막는다', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: ChatModel = {
    name: 'slow',
    async complete() {
      await gate;
      return '답입니다.';
    },
  };
  const { app, store } = setup({ models: { opponent: slow, judge: recorder(() => '{}') }, pickMode: () => 'prompt' });
  const game = await startQ01(app);
  const first = call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '첫 말' } });
  await delay(20);
  const second = await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '두 번째 말' } });
  assert.equal(second.status, 409);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/end`)).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await store.get(game.id))?.turns.length, 1);
});

test('저장이 느려도 같은 판의 턴과 끝내기가 서로의 저장을 지우지 않는다', async () => {
  // 다음 단계의 저장소(SQLite)처럼 읽고 쓰는 데 시간이 걸리는 저장소.
  const inner = new MemoryGameStore();
  const slowStore: GameStore = {
    create: (game: GameRecord) => inner.create(game),
    async get(id: string) {
      await delay(10);
      return inner.get(id);
    },
    async save(game: GameRecord) {
      await delay(10);
      return inner.save(game);
    },
    list: (userId: string, limit: number) => inner.list(userId, limit),
  };
  const { app } = setup({ store: slowStore, pickMode: () => 'prompt' });
  for (let round = 0; round < 5; round++) {
    const game = await startQ01(app);
    const [turn, end] = await Promise.all([
      call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } }),
      call<GameView>(app, 'POST', `/api/games/${game.id}/end`),
    ]);
    // 하나만 받아들여지고, 저장된 판은 받아들여진 쪽과 맞는다.
    assert.deepEqual([turn.status, end.status].sort(), [200, 409]);
    const saved = await inner.get(game.id);
    if (end.status === 200) assert.deepEqual([saved?.endedAt !== undefined, saved?.turns.length], [true, 0]);
    else assert.deepEqual([saved?.endedAt, saved?.turns.length], [undefined, 1]);
  }
});

test('받을 주소를 정하면 다른 주소(Host)로 들어온 요청을 막는다', async () => {
  // 악성 사이트가 자기 주소를 127.0.0.1로 바꿔 부르는 경우(DNS 리바인딩)에는 Host가 그 사이트의 주소다.
  const { app, store } = setup({ allowedHosts: ['127.0.0.1:8787', 'localhost:8787'] });
  const post = (host: string) =>
    app.request(`http://${host}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: 'q01' }),
    });
  assert.equal((await app.request('http://127.0.0.1:8787/api/topics')).status, 200);
  assert.equal((await app.request('http://localhost:8787/api/topics')).status, 200);
  const evil = await app.request('http://evil.example:8787/api/topics');
  assert.equal(evil.status, 403);
  assert.match(((await evil.json()) as { error: string }).error, /[가-힣]/);
  assert.equal((await post('evil.example:8787')).status, 403);
  assert.equal((await post('127.0.0.1:9999')).status, 403);
  assert.equal(await store.get('g1'), undefined);
  assert.equal((await post('127.0.0.1:8787')).status, 201);
});

test('지난 판 목록은 최근에 시작한 판부터 나오고, 방식은 싣지 않는다', async () => {
  const { app } = setup();
  assert.deepEqual((await call<GamesResponse>(app, 'GET', '/api/games')).data, { games: [] });
  const first = await startQ01(app);
  const second = (await call<GameView>(app, 'POST', '/api/games', { body: { topicId: 'q02' } })).data;
  await call(app, 'POST', `/api/games/${first.id}/turns`, { body: { text: '반론입니다.' } });
  await call(app, 'POST', `/api/games/${first.id}/end`);

  const { status, data } = await call<GamesResponse>(app, 'GET', '/api/games');
  assert.equal(status, 200);
  assert.deepEqual(
    data.games.map((g) => [g.id, g.topic.id, g.turn, g.ended]),
    [
      [second.id, 'q02', 0, false],
      [first.id, 'q01', 1, true],
    ],
  );
  assert.equal(data.games[0]?.maxTurns, MAX_TURNS);
  for (const hidden of ['"mode"', '"engine"', '"prompt"', '"decision"']) assert.ok(!JSON.stringify(data).includes(hidden), hidden);
});

test('남의 판은 보거나 이어 하거나 끝낼 수 없고, 목록에도 나오지 않는다', async () => {
  // 로그인을 붙이면 userOf가 사람을 가린다. 여기서는 머리글로 사용자를 흉내 낸다.
  const { app, store } = setup({ userOf: (request) => request.headers.get('x-test-user') ?? 'local' });
  const as = (user: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'x-test-user': user, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  const mine = (await (await as('a', 'POST', '/api/games', { topicId: 'q01' })).json()) as GameView;
  assert.equal((await store.get(mine.id))?.userId, 'a');

  for (const [method, path, body] of [
    ['GET', `/api/games/${mine.id}`, undefined],
    ['POST', `/api/games/${mine.id}/turns`, { text: '반론입니다.' }],
    ['POST', `/api/games/${mine.id}/end`, {}],
  ] as const) {
    const response = await as('b', method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: '없는 판입니다.' });
  }
  assert.deepEqual(((await (await as('b', 'GET', '/api/games')).json()) as GamesResponse).games, []);
  assert.equal(((await (await as('a', 'GET', '/api/games')).json()) as GamesResponse).games.length, 1);
  // 남이 보낸 요청은 판을 바꾸지 않았다.
  const saved = await store.get(mine.id);
  assert.deepEqual([saved?.turns.length, saved?.endedAt], [0, undefined]);
});

test('SQLite 저장소면 서버를 다시 띄워도 판이 남고 이어서 할 수 있다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');

  const firstStore = new SqliteGameStore(path);
  const first = setup({ store: firstStore }).app;
  const game = await startQ01(first);
  await call(first, 'POST', `/api/games/${game.id}/turns`, { body: { text: '첫 반론입니다.' } });
  firstStore.close();

  // 다시 띄운 서버(새 저장소 객체)에서 같은 판을 불러 이어 간다.
  const secondStore = new SqliteGameStore(path);
  t.after(() => secondStore.close());
  const second = setup({ store: secondStore }).app;
  const reopened = await call<GameView>(second, 'GET', `/api/games/${game.id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.turn, 1);
  assert.equal(reopened.data.messages.length, 4);
  const next = await call<TurnResponse>(second, 'POST', `/api/games/${game.id}/turns`, { body: { text: '둘째 반론입니다.' } });
  assert.deepEqual([next.status, next.data.turn], [200, 2]);
  const saved = await secondStore.get(game.id);
  assert.deepEqual(
    saved?.turns.map((turn) => [turn.n, turn.user]),
    [
      [1, '첫 반론입니다.'],
      [2, '둘째 반론입니다.'],
    ],
  );
  assert.equal(saved?.history.length, 6);
});

test('메모리 저장소는 상한을 넘으면 가장 먼저 만든 판부터 지운다', async () => {
  const store = new MemoryGameStore(2);
  const { app } = setup({ store });
  const [a, b, c] = [await startQ01(app), await startQ01(app), await startQ01(app)];
  assert.equal(await store.get(a.id), undefined);
  assert.ok(await store.get(b.id));
  assert.ok(await store.get(c.id));
  assert.equal((await call(app, 'GET', `/api/games/${a.id}`)).status, 404);
});

test('모델이 실패하면 판을 바꾸지 않고, 오류의 자세한 내용은 화면에 보내지 않는다', async () => {
  const broken: ChatModel = {
    name: 'broken',
    async complete() {
      throw new Error('모델 연결 실패: 시험용 오류');
    },
  };
  const { app, store } = setup({ models: { opponent: broken, judge: recorder(() => '{}') }, pickMode: () => 'prompt' });
  const game = await startQ01(app);
  const original = console.error;
  const logged: string[] = [];
  console.error = (message: string) => logged.push(message);
  try {
    const { status, data } = await call<{ error: string }>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } });
    assert.equal(status, 500);
    assert.ok(!data.error.includes('시험용 오류'));
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ['서버 오류: 모델 연결 실패: 시험용 오류']);
  const saved = await store.get(game.id);
  assert.equal(saved?.turns.length, 0);
  assert.equal(saved?.history.length, 2);
});
