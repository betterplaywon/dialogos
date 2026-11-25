import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DialogueModels } from '../../eval/src/dialogue.ts';
import { firstUserMessage, openingStatement } from '../../eval/src/script.ts';
import type { ChatMessage, ChatModel } from '../../eval/src/types.ts';
import { createApp, type AppDeps } from '../server/app.ts';
import type { Limits, ModelSource } from '../server/budget.ts';
import type { GamesResponse, GameView, TopicsResponse, TurnResponse } from '../server/contract.ts';
import { MAX_TEXT_LENGTH, MAX_TURNS } from '../server/games.ts';
import { mockSource } from '../server/models.ts';
import { SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type GameRecord, type GameStore, type Mode, type SpendEntry } from '../server/store.ts';
import { loadFixtureTopics } from './topic-fixtures.ts';

const topics = loadFixtureTopics();
const q01 = topics.get('q01');
if (!q01) throw new Error('q01이 없습니다.');
/** q01에서 질문의 사용자 입장(sides[0])을 지킬 때의 상대. 판정 실험 질문 그대로다. */
const q01Keep = q01.sides[0].matchup;
/** q01에서 반대 입장(sides[1])을 지킬 때의 상대. 검사용 카드에서 왔다. */
const q01Other = q01.sides[1].matchup;
if (!q01Keep || !q01Other) throw new Error('q01의 양쪽 상대가 없습니다.');
/** q01을 질문의 사용자 입장에서 '대체로'로 시작하는 요청. */
const START_Q01 = { topicId: 'q01', side: 0, lean: -1 };

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

/** 언제나 같은 모델을 내주는 출처. 모의 모델처럼 원장에 남기지 않고, 가짜 모델이 받은 메시지를 모두 적어 두게 한다. */
function fixedSource(models: DialogueModels): ModelSource {
  return { provider: 'mock', create: (role) => models[role] };
}

/** 이 파일의 검사가 상한 값(사용자가 정할 제안값)에 묶이지 않게 한다. 상한의 검사는 budget.test.ts에 있다. */
const UNLIMITED: Limits = { totalWon: Infinity, userTurnsPerDay: Infinity };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(overrides: Partial<AppDeps> = {}) {
  let next = 0;
  const store = new MemoryGameStore();
  const app = createApp({
    topics,
    store,
    models: mockSource(),
    limits: UNLIMITED,
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
  const { status, data } = await call<GameView>(app, 'POST', '/api/games', { body: START_Q01 });
  assert.equal(status, 201);
  return data;
}

test('주제 목록은 두 입장과 입장마다 맞설 상대를 싣고, 모의 모델임을 알린다', async () => {
  const { app } = setup();
  const { status, data } = await call<TopicsResponse>(app, 'GET', '/api/topics');
  assert.equal(status, 200);
  assert.equal(data.provider, 'mock');
  assert.equal(data.topics.length, topics.size);
  assert.deepEqual(data.topics[0], {
    id: 'q01',
    question: q01Keep.question.text,
    sides: [
      { stance: q01Keep.question.userStance, opponent: { id: q01Keep.card.id, name: q01Keep.card.name } },
      { stance: q01Keep.question.opponentStance, opponent: { id: q01Other.card.id, name: q01Other.card.name } },
    ],
  });
  // 카드가 없는 판정 실험 질문은 반대 입장의 상대가 아직 없다.
  const q02 = data.topics.find((topic) => topic.id === 'q02');
  assert.equal(q02?.sides[1].opponent, null);
  assert.notEqual(q02?.sides[0].opponent, null);
  // 상대의 전제와 반론은 목록에 싣지 않는다.
  const listed = JSON.stringify(data);
  for (const hidden of [q01Keep.question.premises[0]?.text, q01Keep.question.rebuttals[0]?.text, q01Other.question.premises[0]?.text]) {
    assert.ok(hidden && !listed.includes(hidden), hidden);
  }
});

test('판을 시작하면 판정 실험과 같은 첫 말과 첫 발언이 나오고, 방식은 화면에 가지 않는다', async () => {
  const { app, store } = setup({ pickMode: () => 'prompt' });
  const game = await startQ01(app);
  assert.deepEqual(game.messages, [
    { speaker: 'user', text: firstUserMessage(q01Keep.question) },
    { speaker: 'opponent', text: openingStatement(q01Keep.question) },
  ]);
  assert.equal(q01Keep.question.id, 'q01');
  assert.deepEqual(
    [game.turn, game.maxTurns, game.ended, game.side, game.startLean, game.endReason, game.record],
    [0, MAX_TURNS, false, 0, -1, null, null],
  );
  assert.ok(!('mode' in game));
  const saved = await store.get(game.id);
  assert.deepEqual([saved?.mode, saved?.side, saved?.cardId, saved?.startLean], ['prompt', 0, q01Keep.card.id, -1]);
});

test('반대 입장을 지키면 그쪽 카드의 상대와 전제로 시작하고, 상대가 없는 입장은 막는다', async () => {
  const opponent = recorder(() => '답입니다.');
  const { app, store } = setup({ models: fixedSource({ opponent, judge: recorder(() => '{}') }), pickMode: () => 'prompt' });
  const { status, data } = await call<GameView>(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 1, lean: 2 } });
  assert.equal(status, 201);
  assert.deepEqual(data.messages, [
    { speaker: 'user', text: firstUserMessage(q01Other.question) },
    { speaker: 'opponent', text: openingStatement(q01Other.question) },
  ]);
  // 사용자는 판정 실험 질문의 상대 입장을 지키고, 상대는 다른 캐릭터가 되어 질문의 사용자 입장을 민다.
  assert.equal(q01Other.question.userStance, q01Keep.question.opponentStance);
  assert.equal(q01Other.question.opponentStance, q01Keep.question.userStance);
  assert.notEqual(q01Other.card.id, q01Keep.card.id);
  const saved = await store.get(data.id);
  assert.deepEqual([saved?.side, saved?.cardId, saved?.startLean], [1, q01Other.card.id, 2]);
  await call(app, 'POST', `/api/games/${data.id}/turns`, { body: { text: '반론입니다.' } });
  const system = opponent.calls[0]?.[0]?.content ?? '';
  assert.ok(system.includes(q01Other.question.premises[0]?.text ?? '없는 글'));
  assert.ok(!system.includes(q01Keep.question.premises[0]?.text ?? '없는 글'));

  // 반반이면 시험할 입장을 고른다. 새 주제는 두 입장 모두 고를 수 있다.
  const even = await call<GameView>(app, 'POST', '/api/games', { body: { topicId: 'x01', side: 1, lean: 0 } });
  assert.deepEqual([even.status, even.data.side, even.data.startLean], [201, 1, 0]);
  // 카드가 없는 판정 실험 질문의 반대 입장에는 아직 상대가 없다.
  const missing = await call<{ error: string }>(app, 'POST', '/api/games', { body: { topicId: 'q02', side: 1, lean: 1 } });
  assert.equal(missing.status, 409);
  assert.match(missing.data.error, /상대가 아직 없습니다/);
});

test('엔진 방식이면 판정기가 먼저 판정하고, 판정과 장부는 서버에만 남는다', async () => {
  const judge = recorder(() => '{"tactic":"argument","defeats":"P1","reason":"시험"}');
  const opponent = recorder(() => 'P1을 거둡니다. 다른 근거는 어떻습니까?');
  const { app, store } = setup({ models: fixedSource({ opponent, judge }) });
  const game = await startQ01(app);

  const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '  반론입니다.  ' } });
  assert.equal(status, 200);
  assert.deepEqual(data, { turn: 1, reply: 'P1을 거둡니다. 다른 근거는 어떻습니까?', ended: false, endReason: null });

  const saved = await store.get(game.id);
  assert.deepEqual(saved?.conceded, ['P1']);
  assert.equal(saved?.turns[0]?.decision?.defeats, 'P1');
  assert.deepEqual(saved?.turns[0]?.judge, { calls: 1, readable: true });
  assert.equal(saved?.turns[0]?.user, '반론입니다.');
  // 판정기는 직전 발언과 이번 말만 보고, 상대는 판정 실험과 같은 지시문(입장 카드, 거둔 전제 표시)을 받는다.
  assert.equal(judge.calls[0]?.length, 2);
  const system = opponent.calls[0]?.[0]?.content ?? '';
  assert.ok(system.includes('[입장 카드]'));
  assert.ok(system.includes(q01Keep.question.text));
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
  const { app, store } = setup({ models: fixedSource({ opponent, judge }), pickMode: () => 'prompt' });
  const game = await startQ01(app);
  await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } });
  assert.equal(judge.calls.length, 0);
  assert.equal(opponent.calls.length, 1);
  const saved = await store.get(game.id);
  assert.deepEqual(saved?.conceded, []);
  assert.equal(saved?.turns[0]?.decision, undefined);
});

test('턴마다 말을 넣은 방식과 다시 말한 횟수를 남기고, 판과 목록에서 말로 넣은 턴, 고쳐 보낸 턴, 다시 말한 턴을 센다', async () => {
  const { app, store } = setup({ pickMode: () => 'prompt' });
  const game = await startQ01(app);
  assert.deepEqual(game.voice, { turns: 0, edited: 0, redone: 0 });
  const turns = `/api/games/${game.id}/turns`;
  const bodies = [
    // 넣은 방식을 적지 않은 요청은 글로 넣은 턴이다. 다시 말한 횟수를 적지 않으면 0이다.
    { text: '글로 쓴 말입니다.' },
    { text: '말로 한 말입니다', input: 'voice', redone: 2 },
    { text: '말로 한 뒤 고쳐 보낸 말입니다.', input: 'voice-edited' },
    { text: '다시 글로 쓴 말입니다.', input: 'text', redone: 0 },
    { text: '또 말로 한 말입니다', input: 'voice' },
  ];
  for (const body of bodies) assert.equal((await call(app, 'POST', turns, { body })).status, 200, JSON.stringify(body));

  const saved = await store.get(game.id);
  assert.deepEqual(
    saved?.turns.map((turn) => [turn.input, turn.redone]),
    [
      ['text', 0],
      ['voice', 2],
      ['voice-edited', 0],
      ['text', 0],
      ['voice', 0],
    ],
  );
  const view = await call<GameView>(app, 'GET', `/api/games/${game.id}`);
  assert.deepEqual([view.data.turn, view.data.voice], [5, { turns: 3, edited: 1, redone: 1 }]);
  const listed = await call<GamesResponse>(app, 'GET', '/api/games');
  assert.deepEqual(
    listed.data.games.map((g) => [g.id, g.turn, g.voice]),
    [[game.id, 5, { turns: 3, edited: 1, redone: 1 }]],
  );
  // 판을 끝내고 기록을 남긴 뒤의 판에도 같은 값이 실린다(끝 화면이 이 값을 보인다).
  await call(app, 'POST', `/api/games/${game.id}/end`);
  const recorded = await call<GameView>(app, 'POST', `/api/games/${game.id}/record`, { body: { lean: 0, verdict: 'debate' } });
  assert.deepEqual(recorded.data.voice, { turns: 3, edited: 1, redone: 1 });
});

test('다시 말한 횟수는 0부터 1000까지의 정수만 받고, 글로 넣은 턴에는 받지 않는다', async () => {
  const { app, store } = setup({ pickMode: () => 'prompt' });
  const game = await startQ01(app);
  const turns = `/api/games/${game.id}/turns`;
  const rejected = [
    { text: '말입니다', input: 'voice', redone: -1 },
    { text: '말입니다', input: 'voice', redone: 1.5 },
    { text: '말입니다', input: 'voice', redone: 1001 },
    { text: '말입니다', input: 'voice', redone: '2' },
    { text: '말입니다', input: 'voice', redone: null },
    // 글로만 넣은 턴에는 다시 말할 인식 글이 없다. 넣은 방식을 적지 않으면 글로 넣은 턴이다.
    { text: '글입니다', input: 'text', redone: 1 },
    { text: '글입니다', redone: 1 },
  ];
  for (const body of rejected) assert.equal((await call(app, 'POST', turns, { body })).status, 400, JSON.stringify(body));
  // 거절한 요청은 턴을 남기지 않는다.
  assert.deepEqual((await store.get(game.id))?.turns, []);
  // 상한 값은 받는다.
  assert.equal((await call(app, 'POST', turns, { body: { text: '말입니다', input: 'voice', redone: 1000 } })).status, 200);
  assert.deepEqual((await store.get(game.id))?.turns.map((turn) => turn.redone), [1000]);
});

test('말을 넣은 방식은 상대와 판정기에게 가지 않아, 같은 말이면 같은 대화가 된다', async () => {
  const judge = recorder(() => '{"tactic":"other","defeats":null,"reason":"시험"}');
  const opponent = recorder(() => '답입니다.');
  const { app } = setup({ models: fixedSource({ opponent, judge }) });
  for (const input of [undefined, 'voice-edited']) {
    const game = await startQ01(app);
    const body = { text: '같은 반론입니다.', ...(input ? { input } : {}) };
    assert.equal((await call(app, 'POST', `/api/games/${game.id}/turns`, { body })).status, 200);
  }
  assert.equal(opponent.calls.length, 2);
  assert.deepEqual(opponent.calls[0], opponent.calls[1]);
  assert.deepEqual(judge.calls[0], judge.calls[1]);
});

test('잘못된 요청은 알맞은 상태와 한국어 메시지로 막는다', async () => {
  const { app } = setup();
  const game = await startQ01(app);
  const turns = `/api/games/${game.id}/turns`;
  const cases: [number, Promise<{ status: number; data: unknown }>][] = [
    [400, call(app, 'POST', '/api/games', { body: {} })],
    [400, call(app, 'POST', '/api/games', { raw: '{깨진 JSON' })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01' } })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 2, lean: 1 } })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 0, lean: 3 } })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 0, lean: -0.5 } })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: '0', lean: -1 } })],
    // 생각이 기운 쪽과 지킬 입장이 다르면 막는다.
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 1, lean: -1 } })],
    [400, call(app, 'POST', '/api/games', { body: { topicId: 'q01', side: 0, lean: 2 } })],
    [404, call(app, 'POST', '/api/games', { body: { topicId: 'q99', side: 0, lean: -1 } })],
    [400, call(app, 'POST', turns, { body: { text: '   ' } })],
    [400, call(app, 'POST', turns, { body: { text: 42 } })],
    [400, call(app, 'POST', turns, { body: { text: '가'.repeat(MAX_TEXT_LENGTH + 1) } })],
    // 말을 넣은 방식은 정한 세 값만 받는다. 없으면 글로 넣은 것이고, 있는데 다른 값이면 막는다.
    [400, call(app, 'POST', turns, { body: { text: '반론입니다.', input: 'speech' } })],
    [400, call(app, 'POST', turns, { body: { text: '반론입니다.', input: null } })],
    [400, call(app, 'POST', turns, { body: { text: '반론입니다.', input: 1 } })],
    [400, call(app, 'POST', turns, { body: { text: '반론입니다.', input: ['voice'] } })],
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
  assert.deepEqual([ended.data.ended, ended.data.endReason, ended.data.record], [true, 'user', null]);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/end`)).status, 200);
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '반론입니다.' } })).status, 409);

  const full = await startQ01(app);
  let last: TurnResponse | undefined;
  for (let n = 1; n <= MAX_TURNS; n++) {
    const { status, data } = await call<TurnResponse>(app, 'POST', `/api/games/${full.id}/turns`, { body: { text: `${n}번째 말입니다.` } });
    assert.equal(status, 200);
    last = data;
  }
  assert.deepEqual([last?.turn, last?.ended, last?.endReason], [MAX_TURNS, true, 'max-turns']);
  assert.equal((await call(app, 'POST', `/api/games/${full.id}/turns`, { body: { text: '한 번 더' } })).status, 409);
  // 턴을 모두 쓴 판에 끝내기를 눌러도 끝난 방식은 그대로다.
  assert.equal((await call<GameView>(app, 'POST', `/api/games/${full.id}/end`)).data.endReason, 'max-turns');
  const saved = await store.get(full.id);
  assert.equal(saved?.endReason, 'max-turns');
  assert.equal(saved?.turns.length, MAX_TURNS);
  assert.equal(saved?.history.length, 2 + MAX_TURNS * 2);
});

test('끝난 판에만 사후 입장과 훈계 문항의 답을 한 번 남기고, 끝난 방식과 함께 저장한다', async () => {
  const { app, store } = setup({ now: () => new Date('2026-11-19T01:02:03Z') });
  const game = await startQ01(app);
  const record = `/api/games/${game.id}/record`;
  // 끝나기 전에는 남길 수 없다.
  const early = await call<{ error: string }>(app, 'POST', record, { body: { lean: 1, verdict: 'debate' } });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /끝나지 않은 판/);

  await call(app, 'POST', `/api/games/${game.id}/end`);
  for (const body of [{}, { lean: 1 }, { verdict: 'debate' }, { lean: 3, verdict: 'debate' }, { lean: 1, verdict: '토론' }, { lean: '1', verdict: 'lecture' }]) {
    assert.equal((await call(app, 'POST', record, { body })).status, 400, JSON.stringify(body));
  }
  const saved = await call<GameView>(app, 'POST', record, { body: { lean: 1, verdict: 'lecture' } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.data.endReason, saved.data.record], ['user', { lean: 1, verdict: 'lecture' }]);
  assert.deepEqual((await store.get(game.id))?.record, { lean: 1, verdict: 'lecture', at: '2026-11-19T01:02:03.000Z' });

  // 한 번 남긴 기록은 바꾸지 않는다.
  const again = await call<{ error: string }>(app, 'POST', record, { body: { lean: -2, verdict: 'debate' } });
  assert.equal(again.status, 409);
  assert.deepEqual((await call<GameView>(app, 'GET', `/api/games/${game.id}`)).data.record, { lean: 1, verdict: 'lecture' });
  assert.equal((await call(app, 'POST', '/api/games/없는판/record', { body: { lean: 0, verdict: 'debate' } })).status, 404);
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
  const { app, store } = setup({ models: fixedSource({ opponent: slow, judge: recorder(() => '{}') }), pickMode: () => 'prompt' });
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
    countTurnsSince: (userId: string, since: string) => inner.countTurnsSince(userId, since),
    addSpend: (entry: SpendEntry) => inner.addSpend(entry),
    totalSpendMicroUsd: () => inner.totalSpendMicroUsd(),
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
      body: JSON.stringify(START_Q01),
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
  const second = (await call<GameView>(app, 'POST', '/api/games', { body: { topicId: 'x01', side: 1, lean: 2 } })).data;
  await call(app, 'POST', `/api/games/${first.id}/turns`, { body: { text: '반론입니다.' } });
  await call(app, 'POST', `/api/games/${first.id}/end`);
  await call(app, 'POST', `/api/games/${first.id}/record`, { body: { lean: 1, verdict: 'debate' } });

  const { status, data } = await call<GamesResponse>(app, 'GET', '/api/games');
  assert.equal(status, 200);
  assert.deepEqual(
    data.games.map((g) => [g.id, g.topic.id, g.side, g.startLean, g.turn, g.ended, g.record]),
    [
      [second.id, 'x01', 1, 2, 0, false, null],
      [first.id, 'q01', 0, -1, 1, true, { lean: 1, verdict: 'debate' }],
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
  const mine = (await (await as('a', 'POST', '/api/games', START_Q01)).json()) as GameView;
  assert.equal((await store.get(mine.id))?.userId, 'a');

  for (const [method, path, body] of [
    ['GET', `/api/games/${mine.id}`, undefined],
    ['POST', `/api/games/${mine.id}/turns`, { text: '반론입니다.' }],
    ['POST', `/api/games/${mine.id}/end`, {}],
    ['POST', `/api/games/${mine.id}/record`, { lean: 0, verdict: 'lecture' }],
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

test('남의 판이 처리 중이어도 남의 요청은 404이고, 주인의 요청을 막지 않는다', async () => {
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
  const { app } = setup({
    models: fixedSource({ opponent: slow, judge: recorder(() => '{}') }),
    pickMode: () => 'prompt',
    userOf: (request) => request.headers.get('x-test-user') ?? 'local',
  });
  const as = (user: string, path: string, body: unknown = {}) =>
    app.request(path, { method: 'POST', headers: { 'x-test-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const game = (await (await as('a', '/api/games', START_Q01)).json()) as GameView;

  // a의 턴이 답을 기다리는 동안 b가 같은 판에 보낸다. 판이 있는지 드러나지 않게 404여야 한다.
  const pending = as('a', `/api/games/${game.id}/turns`, { text: 'a의 반론입니다.' });
  await delay(20);
  for (const path of [`/api/games/${game.id}/turns`, `/api/games/${game.id}/end`]) {
    const response = await as('b', path, { text: 'b의 말입니다.' });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: '없는 판입니다.' });
  }
  release();
  assert.equal((await pending).status, 200);

  // b의 요청과 겹친 a의 끝내기는 막히지 않는다.
  const [byOther, byOwner] = await Promise.all([as('b', `/api/games/${game.id}/end`), as('a', `/api/games/${game.id}/end`)]);
  assert.deepEqual([byOther.status, byOwner.status], [404, 200]);
});

test('보이지 않는 제어 문자는 지우고, 줄바꿈은 남겨 저장한다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  const { app } = setup({ store, pickMode: () => 'prompt' });
  const game = await startQ01(app);
  const sent = await call<TurnResponse>(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '앞부분\u0000뒷부분\u0007은 반론입니다.\n둘째 줄' } });
  assert.equal(sent.status, 200);
  const saved = await store.get(game.id);
  assert.equal(saved?.turns[0]?.user, '앞부분뒷부분은 반론입니다.\n둘째 줄');
  assert.equal(saved?.history[2]?.content, '앞부분뒷부분은 반론입니다.\n둘째 줄');
  // 제어 문자만 있는 말은 빈 말로 본다.
  assert.equal((await call(app, 'POST', `/api/games/${game.id}/turns`, { body: { text: '\u0000\u0001 ' } })).status, 400);
});

test('SQLite 저장소면 서버를 다시 띄워도 판이 남고 이어서 할 수 있다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');

  const firstStore = new SqliteGameStore(path);
  const first = setup({ store: firstStore }).app;
  const game = await startQ01(first);
  await call(first, 'POST', `/api/games/${game.id}/turns`, { body: { text: '첫 반론입니다.', input: 'voice-edited' } });
  // 끝내고 기록까지 남긴 다른 판도 다시 띄운 뒤 그대로 보인다.
  const other = (await call<GameView>(first, 'POST', '/api/games', { body: { topicId: 'q01', side: 1, lean: 0 } })).data;
  await call(first, 'POST', `/api/games/${other.id}/end`);
  await call(first, 'POST', `/api/games/${other.id}/record`, { body: { lean: -1, verdict: 'debate' } });
  firstStore.close();

  // 다시 띄운 서버(새 저장소 객체)에서 같은 판을 불러 이어 간다.
  const secondStore = new SqliteGameStore(path);
  t.after(() => secondStore.close());
  const second = setup({ store: secondStore }).app;
  const reopened = await call<GameView>(second, 'GET', `/api/games/${game.id}`);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.turn, 1);
  assert.equal(reopened.data.messages.length, 4);
  assert.deepEqual(reopened.data.voice, { turns: 1, edited: 1, redone: 0 });
  const next = await call<TurnResponse>(second, 'POST', `/api/games/${game.id}/turns`, { body: { text: '둘째 반론입니다.', input: 'voice' } });
  assert.deepEqual([next.status, next.data.turn], [200, 2]);
  const saved = await secondStore.get(game.id);
  assert.deepEqual(
    saved?.turns.map((turn) => [turn.n, turn.user, turn.input]),
    [
      [1, '첫 반론입니다.', 'voice-edited'],
      [2, '둘째 반론입니다.', 'voice'],
    ],
  );
  assert.equal(saved?.history.length, 6);
  // 말로 넣은 턴과 고쳐 보낸 턴의 수도 다시 띄운 뒤의 판과 목록에 그대로 실린다.
  const listed = (await call<GamesResponse>(second, 'GET', '/api/games')).data.games.find((g) => g.id === game.id);
  assert.deepEqual([listed?.turn, listed?.voice], [2, { turns: 2, edited: 1, redone: 0 }]);
  const recorded = await call<GameView>(second, 'GET', `/api/games/${other.id}`);
  assert.deepEqual(
    [recorded.data.side, recorded.data.startLean, recorded.data.endReason, recorded.data.record],
    [1, 0, 'user', { lean: -1, verdict: 'debate' }],
  );
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
  const { app, store } = setup({ models: fixedSource({ opponent: broken, judge: recorder(() => '{}') }), pickMode: () => 'prompt' });
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
