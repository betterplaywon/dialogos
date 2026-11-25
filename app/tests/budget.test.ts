import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JUDGE_ATTEMPTS } from '../../eval/src/dialogue.ts';
import { createApiModel } from '../../eval/src/providers/api.ts';
import type { ChatMessage, ChatModel } from '../../eval/src/types.ts';
import { createApp, type AppDeps } from '../server/app.ts';
import { costMicroUsd, KRW_PER_USD, kstDayStart, type Limits, type MeteredModel, type ModelSource, type Price } from '../server/budget.ts';
import type { GamesResponse, GameView, TopicsResponse } from '../server/contract.ts';
import { mockSource } from '../server/models.ts';
import { SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type GameStore, type ModelRole, type SpendEntry } from '../server/store.ts';
import { loadFixtureTopics } from './topic-fixtures.ts';

const topics = loadFixtureTopics();
/** q01을 질문의 사용자 입장에서 '대체로'로 시작하는 요청. */
const START_Q01 = { topicId: 'q01', side: 0, lean: -1 };
/** 상한 하나만 보는 검사에서 나머지 상한을 열어 둔다. */
const NO_LIMITS: Limits = { totalWon: Infinity, userTurnsPerDay: Infinity };

// 가짜 제공사가 응답 하나마다 알려 주는 사용량(OpenAI 호환 응답의 usage 칸)과 역할별 단가.
// 판정기는 전체 토큰을 알려 주고(출력 토큰에 없는 생각 토큰 200이 들어 있다), 상대는 전체 토큰을 알려 주지 않는다.
const REPORTED: Record<ModelRole, { prompt_tokens: number; completion_tokens: number; total_tokens?: number }> = {
  judge: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1240 },
  opponent: { prompt_tokens: 2000, completion_tokens: 100 },
};
const PRICES: Record<ModelRole, Price> = {
  judge: { inputUsdPerMTok: 0.25, outputUsdPerMTok: 2.5 },
  opponent: { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 },
};
// 응답 하나의 비용(100만분의 1달러)을 규칙대로 손으로 셈한 값. 100만 토큰당 달러 단가 × 토큰 수가 곧 100만분의 1달러다.
/** 판정기: 입력 1,000 × 0.25 + (전체 1,240 − 입력 1,000) × 2.5 = 250 + 600 */
const JUDGE_CALL = 850;
/** 상대: 입력 2,000 × 0.75 + 출력 100 × 3.75 = 1,500 + 375. 전체 토큰을 알려 주지 않아 출력 토큰 그대로 센다. */
const OPPONENT_CALL = 1875;
/** 서비스 상한을 0.002달러(100만분의 1달러로 2,000)로 잡는다. 엔진 턴 하나(850 + 1,875 = 2,725)로 닿는다. */
const BELOW_ONE_ENGINE_TURN: Limits = { ...NO_LIMITS, totalWon: KRW_PER_USD * 0.002 };
/** 판정기가 전제 P1이 무너졌다고 보는 답. */
const DECISION = '{"tactic":"argument","defeats":"P1","reason":"시험"}';

/** 사용량을 세는 모델만 받는다. providers/api.ts의 모델은 언제나 usage를 둔다. */
function metered(model: ChatModel): MeteredModel {
  const { usage } = model;
  if (!usage) throw new Error(`${model.name}는 사용량을 세지 않습니다.`);
  return { ...model, usage };
}

/**
 * 실제 모델의 출처를 흉내 낸다. 모델은 providers/api.ts의 것 그대로이고, 네트워크 대신 가짜 fetch가
 * OpenAI 호환 응답(답과 REPORTED의 사용량)을 돌려준다. 돈이 들지 않는다.
 * answer가 낸 글이 답이고, answer가 던지면 응답 없이 연결이 끊긴 것이다. said는 그 호출의 마지막 메시지다.
 * sent.requests는 모델이 보낸 요청 수다.
 */
function fakeProvider(answer: (role: ModelRole, said: string) => string | Promise<string>) {
  const sent = { requests: 0 };
  const source: ModelSource = {
    provider: 'api',
    prices: PRICES,
    create(role) {
      const model = createApiModel(
        { baseUrl: 'http://provider.test/v1', apiKey: 'fake-key', model: `fake-${role}` },
        async (_url, init) => {
          sent.requests++;
          const { messages } = JSON.parse(String(init.body)) as { messages: ChatMessage[] };
          const content = await answer(role, messages.at(-1)?.content ?? '');
          return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: REPORTED[role] }), {
            headers: { 'content-type': 'application/json' },
          });
        },
        { maxRetries: 1, baseDelayMs: 0 },
      );
      return metered(model);
    },
  };
  return { source, sent };
}

/** 판정기는 DECISION, 상대는 정해 둔 답을 내는 제공사. */
const steady = () => fakeProvider((role) => (role === 'judge' ? DECISION : '답입니다.'));

/** inner에 일을 넘기되, overrides로 준 함수만 바꾼 저장소. */
function storeWith(inner: GameStore, overrides: Partial<GameStore>): GameStore {
  return {
    create: (game) => inner.create(game),
    get: (id) => inner.get(id),
    save: (game, newMemories) => inner.save(game, newMemories),
    list: (userId, limit) => inner.list(userId, limit),
    countTurnsSince: (userId, since) => inner.countTurnsSince(userId, since),
    addSpend: (entry) => inner.addSpend(entry),
    totalSpendMicroUsd: () => inner.totalSpendMicroUsd(),
    listMemories: (userId, query) => inner.listMemories(userId, query),
    editMemory: (userId, id, text, at) => inner.editMemory(userId, id, text, at),
    deleteMemory: (userId, id) => inner.deleteMemory(userId, id),
    ...overrides,
  };
}

/** 원장에 바로 남기는 한 줄. 상한의 경계를 정확히 맞출 때 쓴다. */
const spent = (cost: number): SpendEntry => ({
  at: '2026-11-19T00:00:00.000Z',
  userId: 'someone-else',
  gameId: 'g0',
  role: 'opponent',
  model: 'fake-opponent',
  calls: 1,
  inputTokens: 0,
  outputTokens: 0,
  costMicroUsd: cost,
});

function setup(deps: Pick<AppDeps, 'models' | 'limits'> & Partial<AppDeps>) {
  let next = 0;
  const store = deps.store ?? new MemoryGameStore();
  const app = createApp({
    topics,
    pickMode: () => 'engine',
    newId: () => `g${++next}`,
    now: () => new Date('2026-11-19T00:00:00Z'),
    // 로그인을 붙이면 userOf가 사람을 가린다. 여기서는 머리글로 사용자를 흉내 낸다.
    userOf: (request) => request.headers.get('x-test-user') ?? 'local',
    ...deps,
    store,
  });
  return { app, store };
}

type App = ReturnType<typeof setup>['app'];

async function call<T = { error: string }>(app: App, method: 'GET' | 'POST', path: string, body: unknown = {}, user = 'local') {
  const response = await app.request(path, {
    method,
    headers: { 'x-test-user': user, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function start(app: App, user = 'local'): Promise<GameView> {
  const { status, data } = await call<GameView>(app, 'POST', '/api/games', START_Q01, user);
  assert.equal(status, 201);
  return data;
}

/** 한 턴을 보낸다. 거절되면 data.error에 화면에 보일 말이 온다. */
const turn = (app: App, id: string, text: string, user = 'local') =>
  call<{ error?: string }>(app, 'POST', `/api/games/${id}/turns`, { text }, user);

/** 열 때까지 기다리게 하는 문. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 서버가 남기는 오류 기록을 모아 두고 화면에 찍지 않는다. */
async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (message: string) => logged.push(message);
  try {
    return { result: await work(), logged };
  } finally {
    console.error = original;
  }
}

test('비용은 입력 토큰과 과금되는 출력 토큰에 100만 토큰당 단가를 곱해 더하고, 100만분의 1달러로 올림한다', () => {
  const price: Price = { inputUsdPerMTok: 0.25, outputUsdPerMTok: 2.5 };
  // 전체 토큰을 알려 주면 출력은 전체 − 입력(생각 토큰 포함): 1,000 × 0.25 + (1,240 − 1,000) × 2.5 = 250 + 600
  assert.equal(costMicroUsd({ calls: 1, promptTokens: 1000, completionTokens: 40, totalTokens: 1240 }, price), 850);
  // 전체 토큰을 알려 주지 않으면(없거나 0) 출력 토큰 그대로: 1,000 × 0.25 + 40 × 2.5 = 250 + 100
  assert.equal(costMicroUsd({ calls: 1, promptTokens: 1000, completionTokens: 40 }, price), 350);
  assert.equal(costMicroUsd({ calls: 1, promptTokens: 1000, completionTokens: 40, totalTokens: 0 }, price), 350);
  // 100만분의 1달러보다 작은 끝은 올린다: 3 × 0.25 + 1 × 2.5 = 3.25
  assert.equal(costMicroUsd({ calls: 1, promptTokens: 3, completionTokens: 1 }, price), 4);
});

test('하루는 한국 시간 0시에 바뀐다', () => {
  // 한국 시간 2026-11-22 23:59:59.999는 UTC 14:59:59.999다. 그날 0시는 UTC로 전날 15:00이다.
  assert.equal(kstDayStart(new Date('2026-11-22T14:59:59.999Z')), '2026-11-21T15:00:00.000Z');
  // 1ms 뒤가 한국 시간 2026-11-23 0시다.
  assert.equal(kstDayStart(new Date('2026-11-22T15:00:00.000Z')), '2026-11-22T15:00:00.000Z');
  // UTC로 날이 바뀌어도(UTC 2026-11-23 0시는 한국 시간 같은 날 9시) 한국 시간으로는 같은 하루다.
  assert.equal(kstDayStart(new Date('2026-11-23T00:00:00.000Z')), '2026-11-22T15:00:00.000Z');
});

test('주제 목록은 실제 모델의 출처면 그렇다고 알린다', async () => {
  const { app } = setup({ models: steady().source, limits: NO_LIMITS });
  assert.equal((await call<TopicsResponse>(app, 'GET', '/api/topics')).data.provider, 'api');
});

test('실제 모델의 턴은 응답이 알려 준 사용량의 비용을 원장에 더한다. 엔진은 판정기와 상대, 지시문은 상대만이다', async () => {
  for (const [mode, perTurn] of [
    ['engine', JUDGE_CALL + OPPONENT_CALL],
    ['prompt', OPPONENT_CALL],
  ] as const) {
    const { app, store } = setup({ models: steady().source, limits: NO_LIMITS, pickMode: () => mode });
    const game = await start(app);
    for (const n of [1, 2]) {
      assert.equal((await turn(app, game.id, `${n}번째 반론입니다.`)).status, 200);
      // 호출마다 새 모델이라, 앞 턴의 양을 다시 세지 않는다.
      assert.equal(await store.totalSpendMicroUsd(), n * perTurn, `${mode} ${n}턴`);
    }
  }
});

test('판정기의 답을 읽지 못해 다시 부르면, 부른 호출마다 원장에 남긴다', async () => {
  const { source, sent } = fakeProvider((role) => (role === 'judge' ? '읽을 수 없는 답' : '답입니다.'));
  const { app, store } = setup({ models: source, limits: NO_LIMITS });
  const game = await start(app);
  assert.equal((await turn(app, game.id, '반론입니다.')).status, 200);
  assert.equal(sent.requests, JUDGE_ATTEMPTS + 1);
  assert.equal(await store.totalSpendMicroUsd(), JUDGE_ATTEMPTS * JUDGE_CALL + OPPONENT_CALL);
});

test('서비스 상한은 원장 합이 상한과 같아지는 때부터 막는다', async () => {
  // 상한을 환율과 같은 원으로 정하면 1달러, 곧 100만분의 1달러로 1,000,000이다.
  const { app, store } = setup({ models: mockSource(), limits: { ...NO_LIMITS, totalWon: KRW_PER_USD } });
  await store.addSpend(spent(999_999));
  assert.equal((await call(app, 'POST', '/api/games', START_Q01)).status, 201);
  await store.addSpend(spent(1));
  const refused = await call(app, 'POST', '/api/games', START_Q01);
  assert.equal(refused.status, 503);
  assert.match(refused.data.error, /비용의 한도에 닿아/);
});

test('잘못된 요청은 상한에 닿았어도 400, 404, 409로 먼저 막는다', async () => {
  const { app, store } = setup({ models: mockSource(), limits: { ...NO_LIMITS, totalWon: KRW_PER_USD } });
  const game = await start(app);
  const ended = await start(app);
  assert.equal((await call(app, 'POST', `/api/games/${ended.id}/end`)).status, 200);
  // 이제부터 상한 확인까지 가는 요청은 503이다.
  await store.addSpend(spent(1_000_000));
  for (const [expected, path, body, user] of [
    [400, '/api/games', { topicId: 'q01', side: 1, lean: -1 }, 'local'],
    [404, '/api/games', { topicId: 'q99', side: 0, lean: -1 }, 'local'],
    [409, '/api/games', { topicId: 'q02', side: 1, lean: 1 }, 'local'],
    [400, `/api/games/${game.id}/turns`, { text: '   ' }, 'local'],
    [404, '/api/games/없는판/turns', { text: '반론입니다.' }, 'local'],
    [404, `/api/games/${game.id}/turns`, { text: '남의 판에 보낸 말입니다.' }, 'b'],
    [409, `/api/games/${ended.id}/turns`, { text: '끝난 판에 보낸 말입니다.' }, 'local'],
  ] as const) {
    assert.equal((await call(app, 'POST', path, body, user)).status, expected, `${user} ${path} ${JSON.stringify(body)}`);
  }
  assert.equal((await turn(app, game.id, '반론입니다.')).status, 503);
});

test('두 상한에 함께 걸리면 서비스 상한(503)으로 알린다. 내일 다시 할 수 있다고 알리지 않는다', async () => {
  const { app, store } = setup({ models: mockSource(), limits: { totalWon: KRW_PER_USD, userTurnsPerDay: 0 } });
  await store.addSpend(spent(1_000_000));
  const refused = await call(app, 'POST', '/api/games', START_Q01);
  assert.equal(refused.status, 503);
  assert.doesNotMatch(refused.data.error, /내일/);
});

test('턴의 비용으로 서비스 상한에 닿으면 다음 턴과 새 판을 503으로 막고, 모델을 부르지 않으며 판이 그대로다', async () => {
  const { source, sent } = steady();
  const { app, store } = setup({ models: source, limits: BELOW_ONE_ENGINE_TURN });
  const game = await start(app);
  assert.equal((await turn(app, game.id, '첫 반론입니다.')).status, 200);
  const requests = sent.requests;
  const before = await store.get(game.id);

  const refused = await turn(app, game.id, '둘째 반론입니다.');
  assert.equal(refused.status, 503);
  assert.match(refused.data.error ?? '', /비용의 한도에 닿아/);
  assert.equal((await call(app, 'POST', '/api/games', START_Q01)).status, 503);
  assert.equal(sent.requests, requests);
  assert.deepEqual(await store.get(game.id), before);
  assert.equal(await store.totalSpendMicroUsd(), JUDGE_CALL + OPPONENT_CALL);
  assert.equal((await call<GamesResponse>(app, 'GET', '/api/games')).data.games.length, 1);
});

test('하루 턴 수에 닿으면 새 판과 턴을 429로 막고, 한국 시간 다음 날 0시부터 다시 받는다', async () => {
  // 한국 시간 2026-11-22 23:59(UTC 14:59)에 시작한다.
  let now = new Date('2026-11-22T14:59:00.000Z');
  const { source, sent } = steady();
  const { app, store } = setup({ models: source, limits: { ...NO_LIMITS, userTurnsPerDay: 2 }, pickMode: () => 'prompt', now: () => now });
  const first = await start(app);
  const second = await start(app);
  // 판이 달라도 그 사용자의 턴으로 함께 센다.
  assert.equal((await turn(app, first.id, '첫 판의 반론입니다.')).status, 200);
  assert.equal((await turn(app, second.id, '둘째 판의 반론입니다.')).status, 200);
  const requests = sent.requests;
  const before = await store.get(first.id);

  now = new Date('2026-11-22T14:59:59.999Z');
  const refused = await turn(app, first.id, '세 번째 반론입니다.');
  assert.equal(refused.status, 429);
  assert.match(refused.data.error ?? '', /오늘\(한국 시간\) 보낼 수 있는 2턴을 모두 썼습니다/);
  assert.equal((await call(app, 'POST', '/api/games', START_Q01)).status, 429);
  assert.equal(sent.requests, requests);
  assert.deepEqual(await store.get(first.id), before);
  // 다른 사용자는 막지 않는다.
  assert.equal((await call(app, 'POST', '/api/games', START_Q01, 'b')).status, 201);

  now = new Date('2026-11-22T15:00:00.000Z');
  assert.equal((await turn(app, first.id, '다음 날의 반론입니다.')).status, 200);
});

test('같은 사용자의 다른 판 턴은 앞 턴이 저장될 때까지 409로 막아 하루 턴 수를 넘지 않고, 다른 사용자는 막지 않는다', async () => {
  const inner = new MemoryGameStore();
  const saving = gate();
  // a의 첫 판(g1) 턴은 모델의 답이 온 뒤 저장에서 멈춘다. 턴은 저장을 마칠 때까지 진행 중이다.
  const store = storeWith(inner, {
    async save(game) {
      if (game.id === 'g1') await saving.opened;
      return inner.save(game);
    },
  });
  const { source, sent } = steady();
  const { app } = setup({ store, models: source, limits: { ...NO_LIMITS, userTurnsPerDay: 1 }, pickMode: () => 'prompt' });
  const a1 = await start(app, 'a');
  const a2 = await start(app, 'a');
  const b1 = await start(app, 'b');

  const pending = turn(app, a1.id, 'a의 반론입니다.', 'a');
  await delay(20);
  const blocked = await turn(app, a2.id, 'a의 다른 판 반론입니다.', 'a');
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error ?? '', /다른 판에 보낸 말의 답을 아직 만들고 있습니다/);
  assert.equal((await turn(app, b1.id, 'b의 반론입니다.', 'b')).status, 200);
  saving.open();
  assert.equal((await pending).status, 200);
  // 막힌 턴은 모델을 부르지 않았다(a 한 번, b 한 번).
  assert.equal(sent.requests, 2);

  // 자리는 비었고, 하루 1턴을 쓴 a의 다음 턴은 429다. 함께 보낸 두 턴 가운데 하나만 저장됐다.
  assert.equal((await turn(app, a2.id, 'a의 다른 판 반론입니다.', 'a')).status, 429);
  assert.equal(await inner.countTurnsSince('a', '2026-11-18T15:00:00.000Z'), 1);
});

test('여러 사용자가 함께 보내도 서비스 상한을 넘는 양은 사용자마다 진행 중이던 한 턴의 비용까지다', async () => {
  const answering = gate();
  const { source } = fakeProvider(async (role) => {
    if (role === 'judge') return DECISION;
    await answering.opened;
    return '답입니다.';
  });
  const { app, store } = setup({ models: source, limits: BELOW_ONE_ENGINE_TURN });
  const a1 = await start(app, 'a');
  const a2 = await start(app, 'a');
  const b1 = await start(app, 'b');

  // 원장이 비어 있을 때 a와 b의 턴이 함께 상한 확인을 통과한다.
  const pendingA = turn(app, a1.id, 'a의 반론입니다.', 'a');
  const pendingB = turn(app, b1.id, 'b의 반론입니다.', 'b');
  await delay(20);
  // a의 다른 판 턴은 a의 진행 중인 턴에 막혀, 상한을 더 넘기지 못한다.
  // 막히지 않으면 이 턴도 답을 기다리므로, 문을 연 뒤에 상태를 본다(검사가 멈추지 않고 실패하게).
  const pendingA2 = turn(app, a2.id, 'a의 다른 판 반론입니다.', 'a');
  await delay(20);
  answering.open();
  assert.deepEqual([(await pendingA).status, (await pendingB).status, (await pendingA2).status], [200, 200, 409]);
  assert.equal(await store.totalSpendMicroUsd(), 2 * (JUDGE_CALL + OPPONENT_CALL));

  // 그 뒤로는 누구의 턴도 받지 않는다.
  assert.equal((await turn(app, a2.id, 'a의 다른 판 반론입니다.', 'a')).status, 503);
  assert.equal((await turn(app, b1.id, 'b의 둘째 반론입니다.', 'b')).status, 503);
});

test('판정기 뒤에 상대가 실패하면 500이고, 받은 응답의 양은 원장에 남으며 그 턴은 하루 턴 수에 들지 않는다', async (t) => {
  // 서버를 띄울 때 쓰는 SQLite 저장소에 원장을 둔다.
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  const { source } = fakeProvider((role, said) => {
    if (role === 'judge') return DECISION;
    // 응답은 오지만 답이 비어 있어, 한 번 더 부른 뒤 실패한다.
    if (said === '빈 답을 받을 반론입니다.') return '';
    // 응답이 오지 않는다.
    if (said === '연결이 끊길 반론입니다.') throw new Error('연결 끊김');
    return '답입니다.';
  });
  const { app } = setup({ store, models: source, limits: { ...NO_LIMITS, userTurnsPerDay: 1 } });
  const game = await start(app);

  const empty = await quietly(() => turn(app, game.id, '빈 답을 받을 반론입니다.'));
  assert.equal(empty.result.status, 500);
  // 판정기 한 번과, 답이 비었던 상대의 응답 둘(처음 부른 것과 다시 부른 것).
  assert.equal(await store.totalSpendMicroUsd(), JUDGE_CALL + 2 * OPPONENT_CALL);

  const cut = await quietly(() => turn(app, game.id, '연결이 끊길 반론입니다.'));
  assert.equal(cut.result.status, 500);
  // 응답을 하나도 받지 못한 상대는 원장에 남지 않는다. 판정기 한 번만 더해진다.
  assert.equal(await store.totalSpendMicroUsd(), 2 * JUDGE_CALL + 2 * OPPONENT_CALL);
  // 서버 기록에는 원장 문제가 아니라 모델의 실패가 남는다.
  for (const { logged } of [empty, cut]) assert.match(logged.join('\n'), /모델 호출 실패/);

  // 실패한 두 턴은 저장되지 않아 하루 1턴이 그대로 남아 있다.
  assert.equal((await store.get(game.id))?.turns.length, 0);
  assert.equal((await turn(app, game.id, '세 번째 반론입니다.')).status, 200);
  assert.equal((await turn(app, game.id, '네 번째 반론입니다.')).status, 429);
});

test('원장에 남기지 못하면 그 턴은 실패하고 판에 남지 않으며, 그 뒤로는 서버를 다시 띄울 때까지 누구의 새 판과 턴도 503으로 막는다', async () => {
  const inner = new MemoryGameStore();
  let ledgerDown = true;
  let ledgerUnreadable = false;
  const store = storeWith(inner, {
    async addSpend(entry) {
      if (ledgerDown) throw new Error('원장 쓰기 실패: 시험용 오류');
      return inner.addSpend(entry);
    },
    async totalSpendMicroUsd() {
      if (ledgerUnreadable) throw new Error('원장 읽기 실패: 시험용 오류');
      return inner.totalSpendMicroUsd();
    },
  });
  const { source, sent } = steady();
  const { app } = setup({ store, models: source, limits: NO_LIMITS });
  const mine = await start(app);
  const theirs = await start(app, 'b');

  const { result, logged } = await quietly(() => turn(app, mine.id, '원장에 남지 못할 반론입니다.'));
  assert.equal(result.status, 500);
  assert.match(logged.join('\n'), /원장 쓰기 실패/);
  // 닫히는 때 운영자가 알 수 있게 한 줄을 남긴다. 보낸 말은 남기지 않는다.
  assert.equal(logged.filter((line) => /서버를 다시 띄울 때까지 새 판과 턴을 막습니다/.test(line)).length, 1);
  assert.doesNotMatch(logged.join('\n'), /원장에 남지 못할 반론/);
  // 판정기는 답했지만 그 양은 원장에 없고, 상대는 부르지 않았다.
  assert.equal(sent.requests, 1);
  assert.equal(await inner.totalSpendMicroUsd(), 0);
  assert.equal((await inner.get(mine.id))?.turns.length, 0);

  // 닫혔는지를 가장 먼저 보므로, 저장소가 원장을 읽지도 못하는 동안에도 막는 까닭을 알린다.
  ledgerUnreadable = true;
  const unreadable = await turn(app, theirs.id, '저장소가 망가진 동안 b가 보낸 반론입니다.', 'b');
  assert.equal(unreadable.status, 503);
  assert.match(unreadable.data.error ?? '', /모델 사용량을 기록하지 못해/);

  // 원장 쓰기와 읽기가 다시 되어도 닫힌 채다. 같은 사용자와 다른 사용자의 턴, 새 판을 모두 막고 모델을 부르지 않는다.
  ledgerDown = false;
  ledgerUnreadable = false;
  for (const [path, body, user] of [
    [`/api/games/${mine.id}/turns`, { text: '다시 보낸 반론입니다.' }, 'local'],
    [`/api/games/${theirs.id}/turns`, { text: 'b의 반론입니다.' }, 'b'],
    ['/api/games', START_Q01, 'local'],
    ['/api/games', START_Q01, 'b'],
  ] as const) {
    const refused = await call(app, 'POST', path, body, user);
    assert.equal(refused.status, 503, `${user} ${path}`);
    assert.match(refused.data.error, /모델 사용량을 기록하지 못해/);
  }
  assert.equal(sent.requests, 1);
  assert.equal((await call<GamesResponse>(app, 'GET', '/api/games')).data.games.length, 1);

  // 끝내기와 끝 기록은 모델을 부르지 않아 막지 않는다.
  assert.equal((await call(app, 'POST', `/api/games/${mine.id}/end`)).status, 200);
  assert.equal((await call(app, 'POST', `/api/games/${mine.id}/record`, { lean: 0, verdict: 'debate' })).status, 200);

  // 같은 저장소로 새로 띄운 서버는 다시 받고, 그 턴의 양은 원장에 남는다.
  const restarted = setup({ store, models: source, limits: NO_LIMITS }).app;
  assert.equal((await turn(restarted, theirs.id, '다시 띄운 뒤 b가 보낸 반론입니다.', 'b')).status, 200);
  assert.equal(await inner.totalSpendMicroUsd(), JUDGE_CALL + OPPONENT_CALL);
});

test('상한을 확인하다 원장을 읽지 못하면 그 요청만 실패하고 닫지 않는다. 모델을 부르지 않아 기록 없이 나간 돈이 없다', async () => {
  const inner = new MemoryGameStore();
  let ledgerUnreadable = false;
  const store = storeWith(inner, {
    async totalSpendMicroUsd() {
      if (ledgerUnreadable) throw new Error('원장 읽기 실패: 시험용 오류');
      return inner.totalSpendMicroUsd();
    },
  });
  const { source, sent } = steady();
  const { app } = setup({ store, models: source, limits: NO_LIMITS });
  const game = await start(app);

  ledgerUnreadable = true;
  const { result, logged } = await quietly(() => turn(app, game.id, '원장을 읽지 못할 때 보낸 반론입니다.'));
  assert.equal(result.status, 500);
  assert.match(logged.join('\n'), /원장 읽기 실패/);
  assert.equal(sent.requests, 0);

  ledgerUnreadable = false;
  assert.equal((await turn(app, game.id, '다시 보낸 반론입니다.')).status, 200);
  assert.equal(await inner.totalSpendMicroUsd(), JUDGE_CALL + OPPONENT_CALL);
});

test('모의 모델은 원장에 남기지 않지만 하루 턴 수에는 든다', async () => {
  const { app, store } = setup({ models: mockSource(), limits: { ...NO_LIMITS, userTurnsPerDay: 1 } });
  const game = await start(app);
  assert.equal((await turn(app, game.id, '반론입니다.')).status, 200);
  assert.equal(await store.totalSpendMicroUsd(), 0);
  assert.equal((await turn(app, game.id, '한 번 더 보냅니다.')).status, 429);
});
