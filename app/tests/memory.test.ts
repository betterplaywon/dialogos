import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_JUDGED_DECISION, UNREADABLE_DECISION } from '../../eval/src/dialogue.ts';
import type { ChatModel, JudgeDecision } from '../../eval/src/types.ts';
import { createApp, type AppDeps } from '../server/app.ts';
import type { ModelSource } from '../server/budget.ts';
import type { GameView, GamesResponse, Lean, MemoriesResponse, MemoryView, PassedMemoryView, TurnResponse } from '../server/contract.ts';
import { devSetup } from '../server/dev-setup.ts';
import type { Topic } from '../server/games.ts';
import { memoriesOf } from '../server/memory.ts';
import { SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type EndRecord, type GameRecord, type TurnLog } from '../server/store.ts';
import { loadFixtureTopics } from './topic-fixtures.ts';

const topics = loadFixtureTopics();
const x01 = topics.get('x01');
if (!x01) throw new Error('x01이 없습니다.');
// x01: 첫째 입장 '그렇게 해도 됩니다.', 둘째 입장 '그렇게 해서는 안 됩니다.'.
// 첫째 입장을 지키면 상대는 둘째 쪽 카드의 전제(P1, P2)를 민다.

/** 부를 때마다 m1, m2, …를 내는 id. */
function counter(): () => string {
  let next = 0;
  return () => `m${++next}`;
}

const argument = (defeats: string): JudgeDecision => ({ tactic: 'argument', defeats, reason: '검사' });
const push = (tactic: 'repeat' | 'authority' | 'emotion'): JudgeDecision => ({ tactic, defeats: null, reason: '검사' });

function turn(n: number, user: string, decision?: JudgeDecision): TurnLog {
  return {
    n,
    user,
    input: 'text',
    redone: 0,
    memoryIds: [],
    reply: '답입니다.',
    ...(decision ? { decision } : {}),
    ms: { opponent: 1 },
    at: '2026-11-25T00:01:00.000Z',
  };
}

/** x01의 첫째 입장을 '대체로'로 시작해 끝 기록까지 남긴 판. */
function recorded(overrides: Partial<GameRecord>, lean: Lean): GameRecord & { record: EndRecord } {
  return {
    id: 'g1',
    userId: 'local',
    topicId: 'x01',
    side: 0,
    cardId: 'deontologist',
    mode: 'engine',
    startLean: -1,
    history: [],
    conceded: [],
    turns: [],
    startedAt: '2026-11-25T00:00:00.000Z',
    endedAt: '2026-11-25T00:10:00.000Z',
    endReason: 'user',
    ...overrides,
    record: { lean, verdict: 'debate', at: '2026-11-25T00:11:00.000Z' },
  };
}

const kindsAndTexts = (game: GameRecord & { record: EndRecord }, topic: Topic = x01) =>
  memoriesOf(game, topic, counter()).map((memory) => [memory.kind, memory.text]);

test('엔진 판의 기억: 주장, 전제를 거둔 턴마다 근거, 바뀐 생각, 두 번 이상 되풀이한 밀어붙이기를 이 순서와 글로 만든다', () => {
  const game = recorded(
    {
      turns: [
        turn(1, '처음 하는 말입니다.', argument('P1')),
        turn(2, '모두가 그렇게 말합니다.', push('authority')),
        turn(3, '같은 말을 또 합니다.', push('repeat')),
        turn(4, '정말 화가 납니다.', push('emotion')),
        turn(5, '둘째 전제를 짚습니다.', argument('P2')),
        turn(6, '전문가도 그렇게 봅니다.', push('authority')),
        turn(7, '또 같은 말입니다.', push('repeat')),
        // 주제 카드가 바뀌어 전제를 찾지 못하면 전제 id를 쓴다.
        turn(8, '없어진 전제를 짚습니다.', argument('P9')),
      ],
    },
    2,
  );
  const memories = memoriesOf(game, x01, counter());
  assert.deepEqual(
    memories.map((memory) => [memory.id, memory.kind, memory.text]),
    [
      ['m1', 'claim', '지킨 입장: 그렇게 해도 됩니다. 첫 말: "처음 하는 말입니다."'],
      ['m2', 'ground', '상대가 전제를 거둔 말: "처음 하는 말입니다." (거둔 전제: x01 둘째 쪽 검사용 첫째 전제입니다.)'],
      ['m3', 'ground', '상대가 전제를 거둔 말: "둘째 전제를 짚습니다." (거둔 전제: x01 둘째 쪽 검사용 둘째 전제입니다.)'],
      ['m4', 'ground', '상대가 전제를 거둔 말: "없어진 전제를 짚습니다." (거둔 전제: P9)'],
      ['m5', 'shift', '생각이 바뀜: 대체로 "그렇게 해도 됩니다." → 확실히 "그렇게 해서는 안 됩니다."'],
      // 감정 호소는 한 번뿐이라 약점이 아니다. 항목은 나온 차례가 아니라 되풀이, 권위, 감정 차례다.
      ['m6', 'weakness', '근거 없이 밀어붙인 턴: 같은 주장 되풀이 2번, 권위·다수에 호소 2번'],
    ],
  );
  // 기억은 판의 사용자, 판, 주제, 지킨 쪽을 싣고, 끝 기록의 시각에 만든 것이며, 고친 적이 없다.
  assert.deepEqual(memories[0], {
    id: 'm1',
    userId: 'local',
    gameId: 'g1',
    topicId: 'x01',
    side: 0,
    kind: 'claim',
    text: '지킨 입장: 그렇게 해도 됩니다. 첫 말: "처음 하는 말입니다."',
    createdAt: '2026-11-25T00:11:00.000Z',
  });
});

test('지시문 방식 판에는 판정이 없어 주장과 바뀐 생각만 만든다', () => {
  const game = recorded(
    { side: 1, mode: 'prompt', startLean: 0, turns: [turn(1, '첫 반론입니다.'), turn(2, '둘째 반론입니다.')] },
    -2,
  );
  assert.deepEqual(kindsAndTexts(game), [
    ['claim', '지킨 입장: 그렇게 해서는 안 됩니다. 첫 말: "첫 반론입니다."'],
    ['shift', '생각이 바뀜: 반반 → 확실히 "그렇게 해도 됩니다."'],
  ]);
});

test('생각이 같거나 시작할 때의 생각이 없으면 바뀐 생각을 만들지 않는다', () => {
  const turns = [turn(1, '첫 반론입니다.')];
  const claim = ['claim', '지킨 입장: 그렇게 해도 됩니다. 첫 말: "첫 반론입니다."'];
  assert.deepEqual(kindsAndTexts(recorded({ turns }, -1)), [claim]);
  // 시작할 때의 생각을 받기 전에 만든 판.
  assert.deepEqual(kindsAndTexts(recorded({ turns, startLean: null }, 2)), [claim]);
  // 크기만 바뀌어도 바뀐 생각이다.
  assert.deepEqual(kindsAndTexts(recorded({ turns }, -2)), [
    claim,
    ['shift', '생각이 바뀜: 대체로 "그렇게 해도 됩니다." → 확실히 "그렇게 해도 됩니다."'],
  ]);
});

test('사용자의 턴이 없는 판은 생각이 바뀌었어도 기억을 만들지 않는다', () => {
  let called = 0;
  assert.deepEqual(
    memoriesOf(recorded({ turns: [] }, 2), x01, () => `m${++called}`),
    [],
  );
  assert.equal(called, 0);
});

test('밀어붙이기는 두 번부터 약점이고, 판정기를 읽지 못한 턴과 판정하지 않은 턴은 세지 않는다', () => {
  const unread = [
    turn(1, '첫 말입니다.', push('repeat')),
    turn(2, '읽지 못한 턴입니다.', UNREADABLE_DECISION),
    turn(3, '또 읽지 못한 턴입니다.', UNREADABLE_DECISION),
    turn(4, '판정하지 않은 턴입니다.', NOT_JUDGED_DECISION),
    turn(5, '권위에 기댑니다.', push('authority')),
    turn(6, '감정에 기댑니다.', push('emotion')),
    // 되풀이로 보였어도 전제를 무너뜨린 턴은 근거이고, 밀어붙이기로 세지 않는다.
    turn(7, '되풀이지만 전제를 짚습니다.', { tactic: 'repeat', defeats: 'P1', reason: '검사' }),
  ];
  assert.deepEqual(
    kindsAndTexts(recorded({ turns: unread }, -1)).map(([kind]) => kind),
    ['claim', 'ground'],
  );
  // 같은 판에 되풀이가 한 번 더 있으면 약점이 된다.
  assert.deepEqual(kindsAndTexts(recorded({ turns: [...unread, turn(8, '되풀이합니다.', push('repeat'))] }, -1)).at(-1), [
    'weakness',
    '근거 없이 밀어붙인 턴: 같은 주장 되풀이 2번',
  ]);
});

test('기억 글은 늘 한 줄이다: 말, 전제, 입장의 줄바꿈과 탭은 공백 하나가 된다', () => {
  const matchup = x01.sides[0].matchup;
  if (!matchup) throw new Error('x01 첫째 쪽의 상대가 없습니다.');
  const premises = [{ id: 'P1', flaw: 'overgeneralization' as const, text: '줄이 나뉜\t전제입니다.' }];
  const topic: Topic = {
    ...x01,
    sides: [
      { stance: '그렇게\n해도   됩니다.\n', matchup: { ...matchup, question: { ...matchup.question, premises } } },
      { ...x01.sides[1], stance: '그렇게\t해서는\r\n안 됩니다.' },
    ],
  };
  const game = recorded(
    {
      turns: [
        turn(1, '첫 줄입니다.\r\n\u0085\t둘째 줄입니다.', argument('P1')),
        turn(2, '\n되풀이\n\n합니다.', push('repeat')),
        turn(3, '되풀이 합니다.', push('repeat')),
      ],
    },
    2,
  );
  const texts = kindsAndTexts(game, topic);
  assert.deepEqual(texts, [
    ['claim', '지킨 입장: 그렇게 해도 됩니다. 첫 말: "첫 줄입니다. 둘째 줄입니다."'],
    ['ground', '상대가 전제를 거둔 말: "첫 줄입니다. 둘째 줄입니다." (거둔 전제: 줄이 나뉜 전제입니다.)'],
    ['shift', '생각이 바뀜: 대체로 "그렇게 해도 됩니다." → 확실히 "그렇게 해서는 안 됩니다."'],
    ['weakness', '근거 없이 밀어붙인 턴: 같은 주장 되풀이 2번'],
  ]);
  for (const [, text] of texts) assert.doesNotMatch(String(text), /[^\S ]|\u0085|\s{2}|^\s|\s$/);
});

test('긴 입장과 말은 정한 글자 수로 자르고 끝에 말줄임표를 붙인다(😀 같은 이모지도 한 자로 센다)', () => {
  const longStance = `${'가'.repeat(70)}.`;
  const topic: Topic = { ...x01, sides: [{ ...x01.sides[0], stance: longStance }, x01.sides[1]] };
  const longPremise = '전'.repeat(60);
  const matchup = x01.sides[0].matchup;
  if (!matchup) throw new Error('x01 첫째 쪽의 상대가 없습니다.');
  const withPremise: Topic = {
    ...topic,
    sides: [
      { ...topic.sides[0], matchup: { ...matchup, question: { ...matchup.question, premises: [{ id: 'P1', flaw: 'overgeneralization', text: longPremise }] } } },
      topic.sides[1],
    ],
  };
  const game = recorded({ turns: [turn(1, '😀'.repeat(130), argument('P1'))] }, 1);
  assert.deepEqual(kindsAndTexts(game, withPremise), [
    ['claim', `지킨 입장: ${'가'.repeat(59)}…. 첫 말: "${'😀'.repeat(109)}…"`],
    ['ground', `상대가 전제를 거둔 말: "${'😀'.repeat(119)}…" (거둔 전제: ${'전'.repeat(49)}…)`],
    ['shift', `생각이 바뀜: 대체로 "${'가'.repeat(39)}…" → 대체로 "그렇게 해서는 안 됩니다."`],
  ]);
  // 한 줄로 만든 뒤에 센다. 줄바꿈을 공백 하나로 바꾸면 110자 안에 든다.
  const folded = recorded({ turns: [turn(1, '나\n\n'.repeat(55))] }, -1);
  assert.deepEqual(kindsAndTexts(folded)[0], ['claim', `지킨 입장: 그렇게 해도 됩니다. 첫 말: "${'나 '.repeat(54)}나"`]);
  // 정한 글자 수까지는 자르지 않는다.
  const exact = recorded({ turns: [turn(1, '나'.repeat(110))] }, -1);
  assert.deepEqual(kindsAndTexts(exact)[0], ['claim', `지킨 입장: 그렇게 해도 됩니다. 첫 말: "${'나'.repeat(110)}"`]);
});

// ---- 서버: 끝 기록과 함께 만드는 기억, 기억 API ----

const q01 = topics.get('q01');
if (!q01) throw new Error('q01이 없습니다.');
const [keep, other] = [q01.sides[0].stance, q01.sides[1].stance];

/** '첫 반론'이 든 말은 P1을 무너뜨린 반론으로, 다른 말은 되풀이로 판정하는 판정기. */
const judge: ChatModel = {
  name: 'fixed-judge',
  async complete(messages) {
    const asked = messages.at(-1)?.content ?? '';
    const decision: JudgeDecision = asked.includes('첫 반론')
      ? { tactic: 'argument', defeats: 'P1', reason: '검사' }
      : { tactic: 'repeat', defeats: null, reason: '검사' };
    return JSON.stringify(decision);
  },
};
const opponent: ChatModel = { name: 'fixed-opponent', complete: async () => '답입니다.' };

function server(overrides: Partial<AppDeps> = {}) {
  let next = 0;
  const store = overrides.store ?? new MemoryGameStore();
  const models: ModelSource = { provider: 'mock', create: (role) => (role === 'judge' ? judge : opponent) };
  const app = createApp({
    topics,
    models,
    limits: { totalWon: Infinity, userTurnsPerDay: Infinity },
    pickMode: () => 'engine',
    memory: true,
    newId: () => `id${++next}`,
    now: () => new Date('2026-11-25T00:00:00Z'),
    // 로그인을 붙이면 userOf가 사람을 가린다. 여기서는 머리글로 사용자를 흉내 낸다.
    userOf: (request) => request.headers.get('x-test-user') ?? 'local',
    ...overrides,
    store,
  });
  async function call<T = { error: string }>(method: 'GET' | 'POST', path: string, body: unknown = {}, user = 'local') {
    const response = await app.request(path, {
      method,
      headers: { 'x-test-user': user, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  /** q01의 첫째 입장을 '대체로'로 시작해 세 턴을 하고 끝낸다. 기록은 남기지 않는다. */
  async function playQ01(user = 'local'): Promise<string> {
    const started = await call<GameView>('POST', '/api/games', { topicId: 'q01', side: 0, lean: -1 }, user);
    assert.equal(started.status, 201);
    for (const text of ['첫 반론입니다.\n둘째 줄입니다.', '같은 말입니다.', '또 같은 말입니다.']) {
      assert.equal((await call('POST', `/api/games/${started.data.id}/turns`, { text }, user)).status, 200);
    }
    assert.equal((await call('POST', `/api/games/${started.data.id}/end`, {}, user)).status, 200);
    return started.data.id;
  }
  const memoriesOfUser = async (user = 'local', query = '') => (await call<MemoriesResponse>('GET', `/api/memories${query}`, undefined, user)).data.memories;
  return { app, store, call, playQ01, memoriesOfUser };
}

test('끝 기록을 남기면 그 판의 기억을 함께 저장하고, 기억 목록에 그 주제의 기억으로 나온다', async () => {
  const { call, playQ01, memoriesOfUser } = server();
  const id = await playQ01();
  // 끝내기만 하고 기록을 남기기 전에는 기억이 없다.
  assert.deepEqual(await memoriesOfUser(), []);
  const recorded = await call<GameView>('POST', `/api/games/${id}/record`, { lean: 1, verdict: 'debate' });
  assert.deepEqual([recorded.status, recorded.data.record], [200, { lean: 1, verdict: 'debate' }]);

  const memories = await memoriesOfUser();
  assert.deepEqual(
    memories.map((m) => m.kind),
    ['claim', 'ground', 'shift', 'weakness'],
  );
  const view: MemoryView = {
    id: 'id2',
    gameId: id,
    topicId: 'q01',
    side: 0,
    kind: 'claim',
    text: `지킨 입장: ${keep.replace(/\.$/, '')}. 첫 말: "첫 반론입니다. 둘째 줄입니다."`,
    createdAt: '2026-11-25T00:00:00.000Z',
    edited: false,
  };
  assert.deepEqual(memories[0], view);
  assert.ok(memories[1]?.text.startsWith('상대가 전제를 거둔 말: "첫 반론입니다. 둘째 줄입니다." (거둔 전제: '), memories[1]?.text);
  assert.equal(memories[2]?.text, `생각이 바뀜: 대체로 "${keep}" → 대체로 "${other}"`);
  assert.equal(memories[3]?.text, '근거 없이 밀어붙인 턴: 같은 주장 되풀이 2번');
  assert.deepEqual(await memoriesOfUser('local', '?topicId=q01'), memories);
  assert.deepEqual(await memoriesOfUser('local', '?topicId=x01'), []);
  // 기억 목록에도 판의 방식과 판정은 싣지 않는다.
  for (const hidden of ['"mode"', '"engine"', '"decision"', '"tactic"']) assert.ok(!JSON.stringify(memories).includes(hidden), hidden);
});

test('APP_MODE=random(눈가림 비교)의 설정이면 끝 기록만 남기고 기억을 만들지 않는다', async () => {
  for (const [env, expected] of [
    [{ APP_MODE: 'random' }, 0],
    [{}, 4],
  ] as const) {
    const setup = await devSetup(env);
    const { call, playQ01, memoriesOfUser } = server({ pickMode: setup.pickMode, memory: setup.memory });
    const id = await playQ01();
    assert.equal((await call('POST', `/api/games/${id}/record`, { lean: 1, verdict: 'lecture' })).status, 200);
    assert.deepEqual((await call<GameView>('GET', `/api/games/${id}`)).data.record, { lean: 1, verdict: 'lecture' });
    // 지시문 방식으로 뽑혀도 판정이 없을 뿐 주장과 바뀐 생각은 생기므로, 기억이 0개인 것은 기억을 껐기 때문이다.
    assert.equal((await memoriesOfUser()).length, expected, JSON.stringify(env));
  }
});

test('기억을 넣지 못하면 끝 기록도 남지 않고, 다시 남길 수 있다', async (t) => {
  for (const store of [new MemoryGameStore(), new SqliteGameStore(':memory:')]) {
    t.after(() => (store instanceof SqliteGameStore ? store.close() : undefined));
    let next = 0;
    let collide = false;
    // 기억의 id가 서로 겹치게 만들어, 기억 넣기를 실패시킨다.
    const { call, playQ01, memoriesOfUser } = server({ store, newId: () => (collide ? 'same' : `id${++next}`) });
    const id = await playQ01();
    collide = true;
    const original = console.error;
    const logged: string[] = [];
    console.error = (message: string) => logged.push(message);
    try {
      assert.equal((await call('POST', `/api/games/${id}/record`, { lean: 1, verdict: 'debate' })).status, 500);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.equal((await call<GameView>('GET', `/api/games/${id}`)).data.record, null);
    assert.equal((await store.get(id))?.record, undefined);
    assert.deepEqual(await memoriesOfUser(), []);

    collide = false;
    const again = await call<GameView>('POST', `/api/games/${id}/record`, { lean: 1, verdict: 'debate' });
    assert.deepEqual([again.status, again.data.record], [200, { lean: 1, verdict: 'debate' }]);
    assert.equal((await memoriesOfUser()).length, 4);
  }
});

test('기억 고치기는 제어 문자를 지우고 한 줄로 만든 뒤 1~200자만 받고, 거절한 글은 남기지 않는다', async () => {
  const { app, call, playQ01, memoriesOfUser } = server({ now: () => new Date('2026-11-25T01:00:00Z') });
  await call('POST', `/api/games/${await playQ01()}/record`, { lean: 1, verdict: 'debate' });
  const [first] = await memoriesOfUser();
  if (!first) throw new Error('기억이 없습니다.');
  const edit = `/api/memories/${first.id}/edit`;

  const rejected = [
    {},
    { text: 42 },
    { text: null },
    { text: '' },
    { text: '   ' },
    // 줄바꿈과 탭만 있는 글은 한 줄로 만들면 빈 글이다. JS의 \s에 없는 유니코드 줄바꿈(NEL, U+0085)도 줄바꿈으로 본다.
    { text: '\n\r\n\t' },
    { text: '\u0085  ' },
    { text: '\u0000\u0001' },
    { text: '가'.repeat(201) },
    { text: `${'가'.repeat(200)}\u0000나` },
  ];
  for (const body of rejected) {
    const { status, data } = await call('POST', edit, body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(data.error, /[가-힣]/);
  }
  // 다른 사이트가 보내는 단순 요청(text/plain)은 받지 않는다.
  const crossSite = await app.request(edit, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"고침"}' });
  assert.equal(crossSite.status, 415);
  assert.deepEqual((await memoriesOfUser())[0], first);

  const edited = await call<MemoryView>('POST', edit, { text: '  고친\u0000 글\r\n\t\u0085입니다.  ' });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.data, { ...first, text: '고친 글 입니다.', edited: true });
  assert.deepEqual((await memoriesOfUser())[0], edited.data);
  // 한 줄로 만든 뒤에 센다. 줄바꿈을 공백 하나로 바꾸면 200자 안에 든다.
  const folded = await call<MemoryView>('POST', edit, { text: '가\n\n\n'.repeat(100) });
  assert.deepEqual([folded.status, folded.data.text], [200, `${'가 '.repeat(99)}가`]);
  assert.equal((await call<MemoryView>('POST', edit, { text: '가'.repeat(200) })).status, 200);
});

test('남의 기억은 목록에 나오지 않고, 고치거나 지우면 없는 기록(404)이다', async () => {
  const { call, playQ01, memoriesOfUser } = server();
  await call('POST', `/api/games/${await playQ01('a')}/record`, { lean: 1, verdict: 'debate' }, 'a');
  const mine = await memoriesOfUser('a');
  const [first] = mine;
  if (!first) throw new Error('기억이 없습니다.');
  assert.deepEqual(await memoriesOfUser('b'), []);
  for (const [path, body] of [
    [`/api/memories/${first.id}/edit`, { text: '남이 고침' }],
    [`/api/memories/${first.id}/delete`, {}],
    ['/api/memories/없는기억/edit', { text: '고침' }],
    ['/api/memories/없는기억/delete', {}],
  ] as const) {
    const response = await call('POST', path, body, 'b');
    assert.deepEqual([response.status, response.data], [404, { error: '없는 기록입니다.' }], path);
  }
  assert.deepEqual(await memoriesOfUser('a'), mine);
});

test('기억을 지우면 목록과 다음 조회에서 빠지고, 판 기록과 턴 원문은 남는다', async () => {
  const { call, store, playQ01, memoriesOfUser } = server();
  const id = await playQ01();
  await call('POST', `/api/games/${id}/record`, { lean: 1, verdict: 'debate' });
  const before = await memoriesOfUser();
  const game = await store.get(id);
  const target = before[1];
  if (!target) throw new Error('기억이 없습니다.');

  const deleted = await call('POST', `/api/memories/${target.id}/delete`);
  assert.deepEqual([deleted.status, deleted.data], [200, { deleted: true }]);
  assert.deepEqual(await memoriesOfUser(), before.filter((m) => m.id !== target.id));
  assert.deepEqual(await memoriesOfUser('local', '?topicId=q01'), before.filter((m) => m.id !== target.id));
  // 지운 기억은 다시 지우거나 고칠 수 없다.
  assert.equal((await call('POST', `/api/memories/${target.id}/delete`)).status, 404);
  assert.equal((await call('POST', `/api/memories/${target.id}/edit`, { text: '고침' })).status, 404);
  // 판 기록과 턴 원문은 그대로다.
  assert.deepEqual(await store.get(id), game);
  const view = await call<GameView>('GET', `/api/games/${id}`);
  assert.deepEqual([view.data.record, view.data.turn, view.data.messages[2]?.text], [{ lean: 1, verdict: 'debate' }, 3, '첫 반론입니다.\n둘째 줄입니다.']);
  const listed = await call<GamesResponse>('GET', '/api/games');
  assert.deepEqual(listed.data.games[0]?.record, { lean: 1, verdict: 'debate' });
});

// ---- 서버: 턴마다 같은 주제의 기억을 상대에게 넘기기 ----

/** 부를 때마다 1분씩 가는 시계. 판마다 끝 기록의 시각이 달라야 '최근 기억'의 차례가 판의 차례와 같다. */
function ticking(): () => Date {
  let minute = 0;
  return () => new Date(Date.UTC(2026, 10, 25, 0, minute++));
}

/** 상대가 받은 지시문(system)과 판정기가 받은 글을 부를 때마다 적어 두는 모델 출처. 판정은 위의 judge와 같다. */
function recording() {
  const systems: string[] = [];
  const judged: string[] = [];
  const models: ModelSource = {
    provider: 'mock',
    create: (role) =>
      role === 'judge'
        ? {
            name: 'recording-judge',
            async complete(messages) {
              judged.push(messages.map((m) => m.content).join('\n'));
              return judge.complete(messages);
            },
          }
        : {
            name: 'recording-opponent',
            async complete(messages) {
              systems.push(messages[0]?.role === 'system' ? messages[0].content : '');
              return '답입니다.';
            },
          },
  };
  return { models, systems, judged };
}

/** 상대의 지시문에서 '지난 판의 기록' 칸에 든 기억 글들. 칸이 없으면 null이다(eval/src/prompts.ts의 칸 모양). */
function passedTexts(system: string | undefined): string[] | null {
  const block = system?.split('\n\n').find((part) => part.startsWith('[지난 판의 기록]\n'));
  return block ? block.split('\n').flatMap((line) => (line.startsWith('- ') ? [line.slice(2)] : [])) : null;
}

test('같은 주제의 다음 판에서는 턴마다 최근 기억 3개를 상대의 지시문에 넘기고 그 id를 턴에 남기며, 판정기에는 넘기지 않는다', async () => {
  const { models, systems, judged } = recording();
  const { call, store, playQ01, memoriesOfUser } = server({ models, now: ticking() });
  const first = await playQ01();
  // 기억이 아직 없으면 기록 칸 없이 기억이 생기기 전의 지시문 그대로다.
  assert.deepEqual(systems.map(passedTexts), [null, null, null]);
  assert.deepEqual((await store.get(first))?.turns.map((turn) => turn.memoryIds), [[], [], []]);
  await call('POST', `/api/games/${first}/record`, { lean: 1, verdict: 'debate' });
  const memories = await memoriesOfUser();
  assert.deepEqual(
    memories.map((m) => m.kind),
    ['claim', 'ground', 'shift', 'weakness'],
  );
  // 한 판의 기억은 만든 시각이 같아 넣은 차례(claim, ground, shift, weakness)로 앞의 3개를 넘긴다.
  const recent = memories.slice(0, 3);

  // 지킨 쪽이 달라도 같은 주제면 넘긴다.
  const second = await call<GameView>('POST', '/api/games', { topicId: 'q01', side: 1, lean: 1 });
  for (const text of ['새 판의 첫 말입니다.', '새 판의 둘째 말입니다.']) {
    assert.equal((await call('POST', `/api/games/${second.data.id}/turns`, { text })).status, 200);
  }
  assert.deepEqual(systems.slice(3).map(passedTexts), [recent.map((m) => m.text), recent.map((m) => m.text)]);
  assert.deepEqual(
    (await store.get(second.data.id))?.turns.map((turn) => turn.memoryIds),
    [recent.map((m) => m.id), recent.map((m) => m.id)],
  );
  // 판정기가 받은 글에는 기록 칸도 기억 글도 없다.
  assert.equal(judged.length, 5);
  for (const text of judged) {
    assert.ok(!text.includes('[지난 판의 기록]') && memories.every((m) => !text.includes(m.text)), text);
  }
});

test('판 도중에 지운 기억은 다음 턴부터 넘기지 않고, 고친 기억은 고친 글로 넘긴다', async () => {
  const { models, systems } = recording();
  const { call, store, playQ01, memoriesOfUser } = server({ models, now: ticking() });
  await call('POST', `/api/games/${await playQ01()}/record`, { lean: 1, verdict: 'debate' });
  const [claim, ground, shift, weakness] = await memoriesOfUser();
  if (!claim || !ground || !shift || !weakness) throw new Error('기억이 넷이 아닙니다.');

  const game = await call<GameView>('POST', '/api/games', { topicId: 'q01', side: 0, lean: -1 });
  const turns = `/api/games/${game.data.id}/turns`;
  await call('POST', turns, { text: '둘째 판의 첫 말입니다.' });
  assert.deepEqual(passedTexts(systems.at(-1)), [claim.text, ground.text, shift.text]);

  assert.equal((await call('POST', `/api/memories/${ground.id}/delete`)).status, 200);
  assert.equal((await call('POST', `/api/memories/${claim.id}/edit`, { text: '고친 주장입니다.' })).status, 200);
  await call('POST', turns, { text: '둘째 판의 둘째 말입니다.' });
  // 지운 기억 자리에는 그다음으로 최근인 기억이 들어온다.
  assert.deepEqual(passedTexts(systems.at(-1)), ['고친 주장입니다.', shift.text, weakness.text]);
  assert.ok(!systems.at(-1)?.includes(ground.text));
  assert.deepEqual(
    (await store.get(game.data.id))?.turns.map((turn) => turn.memoryIds),
    [
      [claim.id, ground.id, shift.id],
      [claim.id, shift.id, weakness.id],
    ],
  );
});

test('기억을 끈 서버는 저장된 기억이 있어도 넘기지 않고, 턴에 빈 목록을 남긴다', async () => {
  const store = new MemoryGameStore();
  const on = server({ store, now: ticking() });
  await on.call('POST', `/api/games/${await on.playQ01()}/record`, { lean: 1, verdict: 'debate' });
  assert.equal((await on.memoriesOfUser()).length, 4);

  const { models, systems } = recording();
  // 같은 저장소를 쓰는 둘째 서버. 판 id가 첫째 서버의 것과 겹치지 않게 한다.
  let next = 0;
  const off = server({ store, models, memory: false, now: ticking(), newId: () => `off${++next}` });
  const game = await off.call<GameView>('POST', '/api/games', { topicId: 'q01', side: 0, lean: -1 });
  assert.equal((await off.call('POST', `/api/games/${game.data.id}/turns`, { text: '기억을 끈 판입니다.' })).status, 200);
  assert.deepEqual(systems.map(passedTexts), [null]);
  assert.deepEqual((await store.get(game.data.id))?.turns.map((turn) => turn.memoryIds), [[]]);
});

test('다른 주제의 기억과 남의 기억은 넘기지 않는다', async () => {
  const { models, systems } = recording();
  const { call, store, playQ01, memoriesOfUser } = server({ models, now: ticking() });
  await call('POST', `/api/games/${await playQ01('a')}/record`, { lean: 1, verdict: 'debate' }, 'a');
  assert.equal((await memoriesOfUser('a')).length, 4);
  const before = systems.length;

  // 같은 주제라도 남(b)의 판에는 a의 기억이 가지 않는다.
  const others = await call<GameView>('POST', '/api/games', { topicId: 'q01', side: 0, lean: -1 }, 'b');
  assert.equal((await call('POST', `/api/games/${others.data.id}/turns`, { text: 'b의 말입니다.' }, 'b')).status, 200);
  // a의 판이라도 다른 주제(x01)에는 q01의 기억이 가지 않는다.
  const elsewhere = await call<GameView>('POST', '/api/games', { topicId: 'x01', side: 0, lean: -1 }, 'a');
  assert.equal((await call('POST', `/api/games/${elsewhere.data.id}/turns`, { text: 'a의 다른 주제 말입니다.' }, 'a')).status, 200);

  assert.deepEqual(systems.slice(before).map(passedTexts), [null, null]);
  for (const id of [others.data.id, elsewhere.data.id]) {
    assert.deepEqual((await store.get(id))?.turns.map((turn) => turn.memoryIds), [[]]);
  }
});

// ---- 서버: 넘긴 기억을 화면에 싣기 ----

const kept = (memory: MemoryView, text = memory.text, edited = memory.edited): PassedMemoryView => ({
  id: memory.id,
  state: 'kept',
  kind: memory.kind,
  text,
  edited,
});

test('턴 응답과 판은 넘긴 기억을 싣고, 지운 기억은 글 없이 지운 기록으로, 고친 기억은 지금 글과 고침 표시로 보인다', async (t) => {
  for (const store of [new MemoryGameStore(), new SqliteGameStore(':memory:')]) {
    t.after(() => (store instanceof SqliteGameStore ? store.close() : undefined));
    const { call, playQ01, memoriesOfUser } = server({ store, now: ticking() });
    const first = await playQ01();
    // 기억이 없던 판은 넘긴 기록이 없다.
    assert.deepEqual((await call<GameView>('GET', `/api/games/${first}`)).data.passed, []);
    await call('POST', `/api/games/${first}/record`, { lean: 1, verdict: 'debate' });
    const [claim, ground, shift, weakness] = await memoriesOfUser();
    if (!claim || !ground || !shift || !weakness) throw new Error('기억이 넷이 아닙니다.');

    const started = await call<GameView>('POST', '/api/games', { topicId: 'q01', side: 0, lean: -1 });
    assert.deepEqual(started.data.passed, []);
    const turns = `/api/games/${started.data.id}/turns`;
    const one = await call<TurnResponse>('POST', turns, { text: '둘째 판의 첫 말입니다.' });
    assert.deepEqual(one.data.memories, [kept(claim), kept(ground), kept(shift)]);

    assert.equal((await call('POST', `/api/memories/${ground.id}/delete`)).status, 200);
    assert.equal((await call('POST', `/api/memories/${claim.id}/edit`, { text: '고친 주장입니다.' })).status, 200);
    const two = await call<TurnResponse>('POST', turns, { text: '둘째 판의 둘째 말입니다.' });
    assert.deepEqual(two.data.memories, [kept(claim, '고친 주장입니다.', true), kept(shift), kept(weakness)]);

    const view = await call<GameView>('GET', `/api/games/${started.data.id}`);
    assert.deepEqual(view.data.passed, [
      { turn: 1, memories: [kept(claim, '고친 주장입니다.', true), { id: ground.id, state: 'deleted' }, kept(shift)] },
      { turn: 2, memories: [kept(claim, '고친 주장입니다.', true), kept(shift), kept(weakness)] },
    ]);
    // 지운 기억의 글과, 상대가 받았던 고치기 전 글은 판 화면에 다시 나오지 않는다.
    for (const gone of [ground.text, claim.text]) assert.ok(!JSON.stringify(view.data).includes(gone), gone);
    // 끝내기와 끝 기록의 응답도 같은 판이다.
    const ended = await call<GameView>('POST', `/api/games/${started.data.id}/end`);
    assert.deepEqual(ended.data.passed, view.data.passed);
    const recorded = await call<GameView>('POST', `/api/games/${started.data.id}/record`, { lean: -1, verdict: 'debate' });
    assert.deepEqual(recorded.data.passed, view.data.passed);
  }
});
