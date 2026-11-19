import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstUserMessage, openingStatement } from '../../eval/src/script.ts';
import type { ChatMessage, ChatModel } from '../../eval/src/types.ts';
import { createApp } from '../server/app.ts';
import type { GameView, TopicsResponse, TurnResponse } from '../server/contract.ts';
import { MAX_TEXT_LENGTH, MAX_TURNS, type GameDeps } from '../server/games.ts';
import { mockModels } from '../server/models.ts';
import { MemoryGameStore, type Mode } from '../server/store.ts';
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

function setup(overrides: Partial<GameDeps> = {}) {
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

async function call<T>(app: App, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) {
  const init: RequestInit = { method };
  if (body !== undefined || raw !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = raw ?? JSON.stringify(body);
  }
  const response = await app.request(path, init);
  return { status: response.status, data: (await response.json()) as T };
}

async function startQ01(app: App): Promise<GameView> {
  const { status, data } = await call<GameView>(app, 'POST', '/api/games', { topicId: 'q01' });
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

  const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { text: '  반론입니다.  ' });
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
  await call(app, 'POST', `/api/games/${game.id}/turns`, { text: '반론입니다.' });
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
    [400, call(app, 'POST', '/api/games', {})],
    [400, call(app, 'POST', '/api/games', undefined, '{깨진 JSON')],
    [404, call(app, 'POST', '/api/games', { topicId: 'q99' })],
    [400, call(app, 'POST', turns, { text: '   ' })],
    [400, call(app, 'POST', turns, { text: 42 })],
    [400, call(app, 'POST', turns, { text: '가'.repeat(MAX_TEXT_LENGTH + 1) })],
    [404, call(app, 'POST', '/api/games/없는판/turns', { text: '반론입니다.' })],
    [404, call(app, 'GET', '/api/games/없는판')],
    [404, call(app, 'GET', '/api/없는주소')],
    [413, call(app, 'POST', turns, { text: '가'.repeat(20_000) })],
  ];
  for (const [index, [expected, pending]] of cases.entries()) {
    const { status, data } = await pending;
    assert.equal(status, expected, `경우 ${index}`);
    assert.match((data as { error: string }).error, /[가-힣]/, `경우 ${index}`);
  }
  // 글자 수 상한까지는 받는다.
  assert.equal((await call(app, 'POST', turns, { text: '가'.repeat(MAX_TEXT_LENGTH) })).status, 200);
});

test('끝낸 판과 턴을 모두 쓴 판에는 더 보낼 수 없다', async () => {
  const { app, store } = setup();
  const game = await startQ01(app);
  const ended = await call<GameView>(app, 'POST', `/api/games/${game.id}/end`);
  assert.equal(ended.data.ended, true);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/end`)).status, 200);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/turns`, { text: '반론입니다.' })).status, 409);

  const full = await startQ01(app);
  let last: TurnResponse | undefined;
  for (let n = 1; n <= MAX_TURNS; n++) {
    const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${full.id}/turns`, { text: `${n}번째 말입니다.` });
    assert.equal(status, 200);
    last = data;
  }
  assert.deepEqual([last?.turn, last?.ended], [MAX_TURNS, true]);
  assert.equal((await call(app, 'POST', `/api/games/${full.id}/turns`, { text: '한 번 더' })).status, 409);
  const saved = await store.get(full.id);
  assert.equal(saved?.turns.length, MAX_TURNS);
  assert.equal(saved?.history.length, 2 + MAX_TURNS * 2);
});

test('한 판에서 앞의 턴이 끝나기 전에 온 턴은 막는다', async () => {
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
  const first = call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { text: '첫 말' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await call(app, 'POST', `/api/games/${game.id}/turns`, { text: '두 번째 말' });
  assert.equal(second.status, 409);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/end`)).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await store.get(game.id))?.turns.length, 1);
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
    const { status, data } = await call<{ error: string }>(app, 'POST', `/api/games/${game.id}/turns`, { text: '반론입니다.' });
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
