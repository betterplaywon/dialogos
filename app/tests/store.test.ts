import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MemoryRecord } from '../server/memory.ts';
import { MIGRATIONS, SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type GameRecord, type GameStore, type SpendEntry, type TurnLog } from '../server/store.ts';

/** 같은 검사를 두 저장소에 돌린다. 배포처의 저장소를 붙일 때도 여기에 더한다. */
const stores: [string, () => GameStore & { close?: () => void }][] = [
  ['메모리', () => new MemoryGameStore()],
  ['SQLite', () => new SqliteGameStore(':memory:')],
];

function sample(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: 'g1',
    userId: 'local',
    topicId: 'q01',
    side: 0,
    cardId: 'utilitarian',
    mode: 'engine',
    startLean: -1,
    history: [
      { role: 'user', content: '첫 말' },
      { role: 'assistant', content: '첫 발언' },
    ],
    conceded: [],
    turns: [],
    startedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

const engineTurn: TurnLog = {
  n: 1,
  user: '반론입니다.',
  input: 'text',
  redone: 0,
  reply: 'P1을 거둡니다.',
  decision: { tactic: 'argument', defeats: 'P1', reason: '반례' },
  judge: { calls: 2, readable: true },
  ms: { judge: 12, opponent: 34 },
  at: '2026-11-19T00:01:00.000Z',
};
const unreadableTurn: TurnLog = {
  n: 2,
  user: '같은 말입니다.',
  input: 'text',
  redone: 0,
  reply: '물러서지 않습니다.',
  decision: { tactic: 'other', defeats: null, reason: '판정기의 답을 읽지 못했습니다.' },
  judge: { calls: 2, readable: false },
  ms: { judge: 5, opponent: 6 },
  at: '2026-11-19T00:02:00.000Z',
};
/** 지시문 방식의 턴. 판정도 판정기 기록도 없다. */
const promptTurn: TurnLog = {
  n: 1,
  user: '반론입니다.',
  input: 'text',
  redone: 0,
  reply: '답입니다.',
  ms: { opponent: 7 },
  at: '2026-11-19T00:01:00.000Z',
};

/** 넣은 방식과 다시 말한 횟수만 다른 턴 넷: 글, 말 그대로(두 번 다시 말함), 말을 고쳐서, 말 그대로. */
const mixedInputTurns: TurnLog[] = (['text', 'voice', 'voice-edited', 'voice'] as const).map((input, index) => ({
  ...promptTurn,
  n: index + 1,
  input,
  redone: index === 1 ? 2 : 0,
}));

/** 저장한 시각만 다른 지시문 방식의 턴. */
const turnAt = (n: number, at: string): TurnLog => ({ ...promptTurn, n, at });

/** 끝 기록을 남긴 판 g1의 기억 하나. */
function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    userId: 'local',
    gameId: 'g1',
    topicId: 'q01',
    side: 0,
    kind: 'claim',
    text: '지킨 입장: 검사용 입장입니다. 첫 말: "검사용 말입니다."',
    createdAt: '2026-11-19T00:04:00.000Z',
    ...overrides,
  };
}

/** 끝내고 기록을 남긴 판. 기억의 만든 시각은 끝 기록의 시각과 같다. */
const recordedAt = (id: string, at: string, overrides: Partial<GameRecord> = {}): GameRecord =>
  sample({ id, endedAt: at, endReason: 'user', record: { lean: 1, verdict: 'debate', at }, ...overrides });

/** 판 하나의 기억들. id는 `${판}-${글자}`이고, 글자 차례(z, y, x)가 넣는 차례와 반대다. */
const memoriesFor = (game: GameRecord, kinds: readonly MemoryRecord['kind'][]): MemoryRecord[] =>
  kinds.map((kind, i) =>
    memory({
      id: `${game.id}-${'zyx'[i]}`,
      userId: game.userId,
      gameId: game.id,
      topicId: game.topicId,
      side: game.side,
      kind,
      text: `${game.id} ${kind}`,
      createdAt: game.record?.at ?? '',
    }),
  );

/**
 * 끝 기록과 기억을 넣은 판 넷. 넣는 차례(g1, g2, g3)와 만든 시각의 차례(g2, g3, g1)가 다르다.
 * g3은 다른 주제, g4는 남의 판이다.
 */
async function seedMemories(store: GameStore): Promise<void> {
  const games: [GameRecord, MemoryRecord['kind'][]][] = [
    [recordedAt('g1', '2026-11-19T01:00:00.000Z'), ['claim', 'ground', 'shift']],
    [recordedAt('g2', '2026-11-19T03:00:00.000Z'), ['claim', 'weakness']],
    [recordedAt('g3', '2026-11-19T02:00:00.000Z', { topicId: 'x01', side: 1 }), ['claim']],
    [recordedAt('g4', '2026-11-19T04:00:00.000Z', { userId: 'someone-else' }), ['claim']],
  ];
  for (const [game, kinds] of games) {
    await store.create({ ...game, endedAt: undefined, endReason: undefined, record: undefined });
    await store.save(game, memoriesFor(game, kinds));
  }
}

const idsOf = (memories: readonly MemoryRecord[]) => memories.map((m) => m.id);

/** seedMemories가 넣은 local의 기억 전체의 차례. */
const SEEDED = ['g2-z', 'g2-y', 'g3-z', 'g1-z', 'g1-y', 'g1-x'];

/** 판정기를 한 번 부른 원장 한 줄. */
function spend(overrides: Partial<SpendEntry> = {}): SpendEntry {
  return {
    at: '2026-11-19T00:01:00.000Z',
    userId: 'local',
    gameId: 'g1',
    role: 'judge',
    model: 'fake-judge',
    calls: 1,
    inputTokens: 1000,
    outputTokens: 240,
    costMicroUsd: 850,
    ...overrides,
  };
}

for (const [name, open] of stores) {
  test(`${name} 저장소: 만든 판을 그대로 돌려주고, 밖에서 고쳐도 저장된 판은 그대로다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    const game = sample();
    await store.create(game);
    game.history.push({ role: 'user', content: '밖에서 고침' });
    assert.deepEqual(await store.get('g1'), sample());
    const loaded = await store.get('g1');
    loaded?.conceded.push('P1');
    assert.deepEqual(await store.get('g1'), sample());
    assert.equal(await store.get('없는판'), undefined);
  });

  test(`${name} 저장소: 저장하면 대화, 장부, 끝난 시각, 새 턴이 남는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample());
    const history = [
      ...sample().history,
      { role: 'user' as const, content: engineTurn.user },
      { role: 'assistant' as const, content: engineTurn.reply },
    ];
    await store.save(sample({ history, conceded: ['P1'], turns: [engineTurn] }));
    assert.deepEqual(await store.get('g1'), sample({ history, conceded: ['P1'], turns: [engineTurn] }));

    const ended = sample({ history, conceded: ['P1'], turns: [engineTurn, unreadableTurn], endedAt: '2026-11-19T00:03:00.000Z' });
    await store.save(ended);
    assert.deepEqual(await store.get('g1'), ended);
  });

  test(`${name} 저장소: 지킨 입장, 시작할 때의 생각, 끝난 방식, 끝 기록이 남고 목록에도 실린다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample({ side: 1, startLean: 0 }));
    const ended = sample({ side: 1, startLean: 0, endedAt: '2026-11-19T00:03:00.000Z', endReason: 'user' });
    await store.save(ended);
    assert.deepEqual(await store.get('g1'), ended);
    const recorded: GameRecord = { ...ended, record: { lean: 2, verdict: 'lecture', at: '2026-11-19T00:04:00.000Z' } };
    await store.save(recorded);
    assert.deepEqual(await store.get('g1'), recorded);
    const [summary] = await store.list('local', 1);
    assert.deepEqual([summary?.side, summary?.startLean, summary?.endedAt, summary?.record], [1, 0, ended.endedAt, recorded.record]);
  });

  test(`${name} 저장소: 끝난 시각, 끝난 방식, 끝 기록은 한 번 채우면 다른 값으로 저장해도 바뀌지 않는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample());
    const first = sample({
      endedAt: '2026-11-19T00:03:00.000Z',
      endReason: 'max-turns',
      record: { lean: 1, verdict: 'debate', at: '2026-11-19T00:04:00.000Z' },
    });
    await store.save(first);
    await store.save({
      ...first,
      endedAt: '2026-11-19T00:09:00.000Z',
      endReason: 'user',
      record: { lean: -2, verdict: 'lecture', at: '2026-11-19T00:05:00.000Z' },
    });
    assert.deepEqual(await store.get('g1'), first);
    // 끝난 판을 끝나지 않은 판으로 되돌려 저장해도 끝난 채로 남는다.
    const { endedAt: _endedAt, endReason: _endReason, record: _record, ...reopened } = first;
    await store.save(reopened);
    assert.deepEqual(await store.get('g1'), first);
  });

  test(`${name} 저장소: 판정이 없는 턴(지시문 방식)도 그대로 남는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample({ mode: 'prompt' }));
    await store.save(sample({ mode: 'prompt', turns: [promptTurn] }));
    const loaded = await store.get('g1');
    assert.deepEqual(loaded?.turns, [promptTurn]);
    assert.equal(loaded?.mode, 'prompt');
  });

  test(`${name} 저장소: 턴마다 말을 넣은 방식과 다시 말한 횟수가 남고, 목록은 말로 넣은 턴, 고쳐 보낸 턴, 다시 말한 턴을 센다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample({ mode: 'prompt' }));
    assert.deepEqual((await store.list('local', 1))[0]?.voice, { turns: 0, edited: 0, redone: 0 });
    // 턴은 한 번에 하나씩 덧붙는다. 덧붙일 때마다 센 값이 따라온다.
    await store.save(sample({ mode: 'prompt', turns: mixedInputTurns.slice(0, 2) }));
    assert.deepEqual((await store.list('local', 1))[0]?.voice, { turns: 1, edited: 0, redone: 1 });
    await store.save(sample({ mode: 'prompt', turns: mixedInputTurns }));
    assert.deepEqual(
      (await store.get('g1'))?.turns.map((turn) => [turn.input, turn.redone]),
      [
        ['text', 0],
        ['voice', 2],
        ['voice-edited', 0],
        ['voice', 0],
      ],
    );
    const [summary] = await store.list('local', 1);
    assert.deepEqual([summary?.turns, summary?.voice], [4, { turns: 3, edited: 1, redone: 1 }]);
  });

  test(`${name} 저장소: 같은 판을 두 번 만들거나 없는 판을 저장하면 실패한다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample());
    await assert.rejects(store.create(sample()));
    await assert.rejects(store.save(sample({ id: 'g2' })));
    assert.equal(await store.get('g2'), undefined);
  });

  test(`${name} 저장소: 목록은 그 사용자의 판만, 최근에 시작한 판부터 limit개까지 나온다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample({ id: 'old', startedAt: '2026-11-18T00:00:00.000Z' }));
    await store.create(sample({ id: 'new', startedAt: '2026-11-19T09:00:00.000Z', turns: [engineTurn] }));
    // 시작 시각이 같으면 나중에 만든 판이 먼저다.
    await store.create(sample({ id: 'tie-1', startedAt: '2026-11-19T08:00:00.000Z' }));
    await store.create(sample({ id: 'tie-2', startedAt: '2026-11-19T08:00:00.000Z', endedAt: '2026-11-19T08:30:00.000Z' }));
    await store.create(sample({ id: 'other', userId: 'someone-else', startedAt: '2026-11-19T10:00:00.000Z' }));

    const all = await store.list('local', 10);
    assert.deepEqual(
      all.map((g) => g.id),
      ['new', 'tie-2', 'tie-1', 'old'],
    );
    assert.deepEqual(all[0], {
      id: 'new',
      topicId: 'q01',
      side: 0,
      cardId: 'utilitarian',
      startLean: -1,
      turns: 1,
      voice: { turns: 0, edited: 0, redone: 0 },
      startedAt: '2026-11-19T09:00:00.000Z',
    });
    assert.equal(all[1]?.endedAt, '2026-11-19T08:30:00.000Z');
    assert.deepEqual(
      (await store.list('local', 2)).map((g) => g.id),
      ['new', 'tie-2'],
    );
    assert.deepEqual(
      (await store.list('someone-else', 10)).map((g) => g.id),
      ['other'],
    );
    assert.deepEqual(await store.list('nobody', 10), []);
  });

  test(`${name} 저장소: 턴 수는 그 사용자가 since 이후에 저장한 턴만 센다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    const since = '2026-11-18T15:00:00.000Z';
    // since 1ms 전의 턴은 세지 않고, since와 같은 시각의 턴부터 센다.
    await store.create(
      sample({ id: 'a', mode: 'prompt', turns: [turnAt(1, '2026-11-18T14:59:59.999Z'), turnAt(2, since), turnAt(3, '2026-11-19T01:00:00.000Z')] }),
    );
    // 끝난 판의 턴도 센다.
    await store.create(
      sample({ id: 'b', mode: 'prompt', turns: [turnAt(1, '2026-11-19T02:00:00.000Z')], endedAt: '2026-11-19T02:10:00.000Z', endReason: 'user' }),
    );
    await store.create(sample({ id: 'c', userId: 'someone-else', mode: 'prompt', turns: [turnAt(1, '2026-11-19T03:00:00.000Z')] }));
    assert.equal(await store.countTurnsSince('local', since), 3);
    assert.equal(await store.countTurnsSince('someone-else', since), 1);
    assert.equal(await store.countTurnsSince('nobody', since), 0);
    // 새 턴을 저장하면 바로 센다.
    const game = await store.get('a');
    await store.save({ ...game!, turns: [...game!.turns, turnAt(4, '2026-11-19T04:00:00.000Z')] });
    assert.equal(await store.countTurnsSince('local', since), 4);
  });

  test(`${name} 저장소: 원장은 덧붙인 비용을 모두 더하고, 없는 판의 비용도 받는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    assert.equal(await store.totalSpendMicroUsd(), 0);
    await store.addSpend(spend());
    await store.addSpend(spend({ role: 'opponent', model: 'fake-opponent', inputTokens: 2000, outputTokens: 100, costMicroUsd: 1875 }));
    // 판이 없어져도 쓴 돈은 남아야 하므로, 원장은 판이 있는지 따지지 않는다.
    await store.addSpend(spend({ userId: 'someone-else', gameId: '없는판', costMicroUsd: 1 }));
    assert.equal(await store.totalSpendMicroUsd(), 850 + 1875 + 1);
  });

  test(`${name} 저장소: 끝 기록과 기억을 함께 남기고, 기억은 그 사용자의 것만 만든 시각이 늦은 것부터, 같은 시각이면 넣은 차례로 나온다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await seedMemories(store);
    assert.deepEqual((await store.get('g1'))?.record, { lean: 1, verdict: 'debate', at: '2026-11-19T01:00:00.000Z' });
    assert.deepEqual(idsOf(await store.listMemories('local', { limit: 10 })), SEEDED);
    assert.deepEqual(idsOf(await store.listMemories('local', { limit: 3 })), ['g2-z', 'g2-y', 'g3-z']);
    assert.deepEqual(idsOf(await store.listMemories('local', { topicId: 'q01', limit: 10 })), ['g2-z', 'g2-y', 'g1-z', 'g1-y', 'g1-x']);
    assert.deepEqual(idsOf(await store.listMemories('local', { topicId: 'x01', limit: 10 })), ['g3-z']);
    assert.deepEqual(await store.listMemories('local', { topicId: '없는주제', limit: 10 }), []);
    assert.deepEqual(idsOf(await store.listMemories('someone-else', { limit: 10 })), ['g4-z']);
    assert.deepEqual(await store.listMemories('nobody', { limit: 10 }), []);
    // 넣은 그대로 돌려준다. 고친 적이 없으면 고친 시각이 없다.
    assert.deepEqual(await store.listMemories('local', { topicId: 'x01', limit: 1 }), [
      memory({ id: 'g3-z', gameId: 'g3', topicId: 'x01', side: 1, text: 'g3 claim', createdAt: '2026-11-19T02:00:00.000Z' }),
    ]);
  });

  test(`${name} 저장소: 기억 글을 고치면 고친 시각이 남고 차례는 그대로이며, 남의 기억이나 없는 기억은 고치지 않는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await seedMemories(store);
    const edited = await store.editMemory('local', 'g1-y', '고친 글입니다.', '2026-11-20T00:00:00.000Z');
    const expected = memory({
      id: 'g1-y',
      kind: 'ground',
      text: '고친 글입니다.',
      createdAt: '2026-11-19T01:00:00.000Z',
      editedAt: '2026-11-20T00:00:00.000Z',
    });
    assert.deepEqual(edited, expected);
    const listed = await store.listMemories('local', { limit: 10 });
    assert.deepEqual(idsOf(listed), SEEDED);
    assert.deepEqual(listed[4], expected);
    // 돌려받은 것을 밖에서 고쳐도 저장된 기억은 그대로다.
    if (edited) edited.text = '밖에서 고침';
    assert.deepEqual((await store.listMemories('local', { limit: 10 }))[4], expected);

    assert.equal(await store.editMemory('someone-else', 'g1-y', '남이 고침', '2026-11-20T00:01:00.000Z'), undefined);
    assert.equal(await store.editMemory('local', 'g4-z', '남의 것을 고침', '2026-11-20T00:01:00.000Z'), undefined);
    assert.equal(await store.editMemory('local', '없는기억', '고침', '2026-11-20T00:01:00.000Z'), undefined);
    assert.deepEqual((await store.listMemories('local', { limit: 10 }))[4], expected);
    assert.equal((await store.listMemories('someone-else', { limit: 10 }))[0]?.text, 'g4 claim');
  });

  test(`${name} 저장소: 기억을 지우면 목록에서 빠지고 판 기록은 남으며, 남의 기억이나 없는 기억은 지우지 않는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await seedMemories(store);
    const before = await store.get('g1');
    assert.equal(await store.deleteMemory('someone-else', 'g1-y'), false);
    assert.equal(await store.deleteMemory('local', 'g4-z'), false);
    assert.equal(await store.deleteMemory('local', '없는기억'), false);
    assert.deepEqual(idsOf(await store.listMemories('local', { limit: 10 })), SEEDED);

    assert.equal(await store.deleteMemory('local', 'g1-y'), true);
    assert.deepEqual(idsOf(await store.listMemories('local', { limit: 10 })), ['g2-z', 'g2-y', 'g3-z', 'g1-z', 'g1-x']);
    assert.equal(await store.deleteMemory('local', 'g1-y'), false);
    assert.equal(await store.editMemory('local', 'g1-y', '지운 뒤 고침', '2026-11-20T00:00:00.000Z'), undefined);
    assert.deepEqual(await store.get('g1'), before);
    assert.deepEqual(idsOf(await store.listMemories('someone-else', { limit: 10 })), ['g4-z']);
  });

  test(`${name} 저장소: 기억을 넣지 못하면 끝 기록과 판의 변경도 남지 않는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await seedMemories(store);
    await store.create(sample({ id: 'g5' }));
    const recorded = recordedAt('g5', '2026-11-19T05:00:00.000Z', { turns: [promptTurn] });
    const [fresh] = memoriesFor(recorded, ['claim']);
    if (!fresh) throw new Error('기억을 만들지 못했습니다.');
    // 이미 있는 기억과 id가 겹치거나, 한 번에 넣는 기억끼리 id가 겹친다.
    for (const memories of [
      [fresh, { ...fresh, id: 'g1-z' }],
      [fresh, { ...fresh }],
    ]) {
      await assert.rejects(store.save(recorded, memories));
      assert.deepEqual(await store.get('g5'), sample({ id: 'g5' }));
      const listed = await store.listMemories('local', { limit: 10 });
      assert.deepEqual(idsOf(listed), SEEDED);
      assert.equal(listed.find((m) => m.id === 'g1-z')?.gameId, 'g1');
    }
    // 겹치지 않으면 남긴다.
    await store.save(recorded, [fresh]);
    assert.deepEqual(await store.get('g5'), recorded);
    assert.deepEqual(idsOf(await store.listMemories('local', { limit: 1 })), ['g5-z']);
  });
}

test('메모리 저장소와 SQLite 저장소는 같은 기억과 고치기, 지우기에 같은 목록을 같은 차례로 낸다', async (t) => {
  const inMemory = new MemoryGameStore();
  const sqlite = new SqliteGameStore(':memory:');
  t.after(() => sqlite.close());
  const lists = async (store: GameStore) => [
    await store.listMemories('local', { limit: 100 }),
    await store.listMemories('local', { topicId: 'q01', limit: 4 }),
    await store.listMemories('someone-else', { limit: 100 }),
  ];
  for (const store of [inMemory, sqlite]) {
    await seedMemories(store);
    await store.editMemory('local', 'g2-y', '고친 약점입니다.', '2026-11-20T00:00:00.000Z');
    await store.deleteMemory('local', 'g1-z');
  }
  const fromMemory = await lists(inMemory);
  assert.deepEqual(fromMemory, await lists(sqlite));
  assert.deepEqual(fromMemory.map(idsOf), [
    ['g2-z', 'g2-y', 'g3-z', 'g1-y', 'g1-x'],
    ['g2-z', 'g2-y', 'g1-y', 'g1-x'],
    ['g4-z'],
  ]);
  assert.equal(fromMemory[0]?.[1]?.text, '고친 약점입니다.');
});

test('SQLite 저장소: 기억 글이 비었거나 200자를 넘거나, 종류나 지킨 쪽이 정한 값 밖이면 넣지 않고 끝 기록도 남기지 않는다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  await store.create(sample());
  const recorded = recordedAt('g1', '2026-11-19T00:04:00.000Z');
  for (const bad of [
    memory({ text: '' }),
    memory({ text: '가'.repeat(201) }),
    memory({ kind: 'habit' as MemoryRecord['kind'] }),
    memory({ side: 2 as MemoryRecord['side'] }),
  ]) {
    await assert.rejects(store.save(recorded, [memory({ id: 'ok' }), { ...bad, id: 'bad' }]));
    assert.deepEqual(await store.get('g1'), sample());
    assert.deepEqual(await store.listMemories('local', { limit: 10 }), []);
  }
  // 200자까지는 받는다. 고칠 때도 같은 상한이다.
  await store.save(recorded, [memory({ text: '가'.repeat(200) })]);
  await assert.rejects(store.editMemory('local', 'm1', '가'.repeat(201), '2026-11-20T00:00:00.000Z'));
  await assert.rejects(store.editMemory('local', 'm1', '', '2026-11-20T00:00:00.000Z'));
  assert.deepEqual(await store.listMemories('local', { limit: 10 }), [memory({ text: '가'.repeat(200) })]);
});

test('SQLite 저장소: 스키마 5의 파일을 열면 기억 표를 더하고, 예전 판과 턴은 그대로 읽는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  // 스키마 5까지만 적용한 파일(기억을 붙이기 전의 서버가 만든 파일)을 흉내 낸다. 그때는 기억 표가 없다.
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  for (const sql of MIGRATIONS.slice(0, 5)) old.exec(sql);
  old.exec('INSERT INTO schema_version (version) VALUES (1), (2), (3), (4), (5)');
  old
    .prepare(
      `INSERT INTO games (id, user_id, topic_id, side, card_id, mode, history, conceded, start_lean, started_at,
                          ended_at, end_reason, end_lean, verdict, recorded_at)
       VALUES ('old', 'local', 'q01', 1, 'utilitarian', 'engine', '[]', '["P1"]', 0, '2026-11-24T00:00:00.000Z',
               '2026-11-24T00:10:00.000Z', 'user', 2, 'debate', '2026-11-24T00:11:00.000Z')`,
    )
    .run();
  old
    .prepare(
      `INSERT INTO turns (game_id, n, user_text, input, redone, reply, decision, judge_calls, judge_readable, ms_judge, ms_opponent, at)
       VALUES ('old', 1, '반론입니다.', 'voice', 2, 'P1을 거둡니다.', '{"tactic":"argument","defeats":"P1","reason":"반례"}', 1, 1, 12, 34,
               '2026-11-24T00:01:00.000Z')`,
    )
    .run();
  old.close();

  const store = new SqliteGameStore(path);
  t.after(() => store.close());
  assert.equal(store.schemaVersion, 6);
  const game = await store.get('old');
  assert.deepEqual(game, {
    id: 'old',
    userId: 'local',
    topicId: 'q01',
    side: 1,
    cardId: 'utilitarian',
    mode: 'engine',
    startLean: 0,
    history: [],
    conceded: ['P1'],
    turns: [{ ...engineTurn, input: 'voice', redone: 2, judge: { calls: 1, readable: true }, at: '2026-11-24T00:01:00.000Z' }],
    startedAt: '2026-11-24T00:00:00.000Z',
    endedAt: '2026-11-24T00:10:00.000Z',
    endReason: 'user',
    record: { lean: 2, verdict: 'debate', at: '2026-11-24T00:11:00.000Z' },
  });
  // 예전 판에는 기억이 없다. 기억 표는 비어서 시작하고, 판을 바꾸지 않고 기억을 더할 수 있다.
  assert.deepEqual(await store.listMemories('local', { limit: 10 }), []);
  const added = memory({ gameId: 'old', side: 1 });
  await store.save(game!, [added]);
  assert.deepEqual(await store.listMemories('local', { limit: 10 }), [added]);
  assert.deepEqual(await store.get('old'), game);
});

test('SQLite 저장소: 파일을 다시 열면 판이 남고, 스키마는 한 번만 적용한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');

  const first = new SqliteGameStore(path);
  assert.equal(first.schemaVersion, MIGRATIONS.length);
  await first.create(sample({ turns: [engineTurn] }));
  first.close();

  const second = new SqliteGameStore(path);
  t.after(() => second.close());
  assert.equal(second.schemaVersion, MIGRATIONS.length);
  assert.deepEqual(await second.get('g1'), sample({ turns: [engineTurn] }));
});

test('메모리 저장소와 SQLite 저장소는 같은 판들에 같은 요약을 낸다', async (t) => {
  const memory = new MemoryGameStore();
  const sqlite = new SqliteGameStore(':memory:');
  t.after(() => sqlite.close());
  const games = [
    sample({ id: 'typed', startedAt: '2026-11-19T01:00:00.000Z', turns: [engineTurn] }),
    sample({ id: 'spoken', startedAt: '2026-11-19T02:00:00.000Z', mode: 'prompt', turns: mixedInputTurns }),
    sample({
      id: 'all-edited',
      startedAt: '2026-11-19T03:00:00.000Z',
      mode: 'prompt',
      turns: [{ ...promptTurn, input: 'voice-edited' }],
      endedAt: '2026-11-19T03:10:00.000Z',
      endReason: 'user',
      record: { lean: 1, verdict: 'debate', at: '2026-11-19T03:11:00.000Z' },
    }),
  ];
  for (const game of games) {
    await memory.create(game);
    await sqlite.create(game);
  }
  const fromMemory = await memory.list('local', 10);
  assert.deepEqual(fromMemory, await sqlite.list('local', 10));
  assert.deepEqual(
    fromMemory.map((summary) => [summary.id, summary.voice]),
    [
      ['all-edited', { turns: 1, edited: 1, redone: 0 }],
      ['spoken', { turns: 3, edited: 1, redone: 1 }],
      ['typed', { turns: 0, edited: 0, redone: 0 }],
    ],
  );
});

test('SQLite 저장소: 스키마 1의 파일을 열면 남은 스키마를 모두 더하고, 예전 판은 첫째 입장과 빈 기록으로 읽는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  // 스키마 1까지만 적용한 파일(이 PR 전의 서버가 만든 파일)을 흉내 낸다.
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  old.exec(MIGRATIONS[0] ?? '');
  old.exec('INSERT INTO schema_version (version) VALUES (1)');
  old
    .prepare(
      `INSERT INTO games (id, user_id, topic_id, card_id, mode, history, conceded, started_at, ended_at)
       VALUES ('old', 'local', 'q01', 'utilitarian', 'engine', '[]', '[]', '2026-11-18T00:00:00.000Z', '2026-11-18T00:10:00.000Z')`,
    )
    .run();
  old.close();

  const store = new SqliteGameStore(path);
  t.after(() => store.close());
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  const game = await store.get('old');
  assert.deepEqual(
    [game?.side, game?.startLean, game?.endedAt, game?.endReason, game?.record],
    [0, null, '2026-11-18T00:10:00.000Z', undefined, undefined],
  );
  // 예전 판에도 끝 기록을 남길 수 있다.
  await store.save({ ...game!, record: { lean: 0, verdict: 'debate', at: '2026-11-19T00:00:00.000Z' } });
  assert.deepEqual((await store.get('old'))?.record, { lean: 0, verdict: 'debate', at: '2026-11-19T00:00:00.000Z' });
});

test('SQLite 저장소: 스키마 2의 파일을 열면 남은 스키마를 더하고, 예전 턴은 글로 넣은 턴으로 읽는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  // 스키마 2까지만 적용한 파일(음성을 붙이기 전의 서버가 만든 파일)을 흉내 낸다. 그때의 턴에는 넣은 방식 칸이 없다.
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  old.exec(MIGRATIONS[0] ?? '');
  old.exec(MIGRATIONS[1] ?? '');
  old.exec('INSERT INTO schema_version (version) VALUES (1), (2)');
  old
    .prepare(
      `INSERT INTO games (id, user_id, topic_id, side, card_id, mode, history, conceded, start_lean, started_at)
       VALUES ('old', 'local', 'q01', 1, 'utilitarian', 'prompt', '[]', '[]', 2, '2026-11-20T00:00:00.000Z')`,
    )
    .run();
  const insertTurn = old.prepare(
    `INSERT INTO turns (game_id, n, user_text, reply, ms_opponent, at) VALUES ('old', ?, ?, '답입니다.', 7, '2026-11-20T00:01:00.000Z')`,
  );
  insertTurn.run(1, '첫 반론입니다.');
  insertTurn.run(2, '둘째 반론입니다.');
  old.close();

  const store = new SqliteGameStore(path);
  t.after(() => store.close());
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  const game = await store.get('old');
  // 예전 턴은 글로 넣었고 다시 말한 횟수는 0으로 읽는다.
  assert.deepEqual(
    game?.turns.map((turn) => [turn.n, turn.user, turn.input, turn.redone]),
    [
      [1, '첫 반론입니다.', 'text', 0],
      [2, '둘째 반론입니다.', 'text', 0],
    ],
  );
  assert.deepEqual((await store.list('local', 1))[0]?.voice, { turns: 0, edited: 0, redone: 0 });
  // 예전 판을 말로 이어 가면 새 턴부터 센다.
  await store.save({ ...game!, turns: [...game!.turns, { ...promptTurn, n: 3, input: 'voice-edited', redone: 1 }] });
  assert.deepEqual((await store.get('old'))?.turns.map((turn) => turn.input), ['text', 'text', 'voice-edited']);
  assert.deepEqual((await store.list('local', 1))[0]?.voice, { turns: 1, edited: 1, redone: 1 });
});

test('SQLite 저장소: 정해지지 않은 방식의 턴은 저장하지 않는다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  await store.create(sample({ mode: 'prompt' }));
  const unknown = { ...promptTurn, input: 'dictated' as TurnLog['input'] };
  await assert.rejects(store.save(sample({ mode: 'prompt', turns: [unknown] })));
  assert.deepEqual((await store.get('g1'))?.turns, []);
});

test('SQLite 저장소: 다시 말한 횟수가 음수인 턴은 저장하지 않는다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  await store.create(sample({ mode: 'prompt' }));
  await assert.rejects(store.save(sample({ mode: 'prompt', turns: [{ ...promptTurn, input: 'voice', redone: -1 }] })));
  assert.deepEqual((await store.get('g1'))?.turns, []);
});

test('SQLite 저장소: 원장은 정한 역할, 1 이상의 호출 수, 음수가 아닌 양만 받는다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  for (const bad of [
    spend({ role: 'scorer' as SpendEntry['role'] }),
    spend({ calls: 0 }),
    spend({ inputTokens: -1 }),
    spend({ outputTokens: -1 }),
    spend({ costMicroUsd: -1 }),
  ]) {
    await assert.rejects(store.addSpend(bad), JSON.stringify(bad));
  }
  assert.equal(await store.totalSpendMicroUsd(), 0);
});

test('SQLite 저장소: 원장은 파일을 다시 열어도 남는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  const first = new SqliteGameStore(path);
  await first.addSpend(spend());
  await first.addSpend(spend({ role: 'opponent', model: 'fake-opponent', costMicroUsd: 1875 }));
  first.close();

  const second = new SqliteGameStore(path);
  t.after(() => second.close());
  assert.equal(await second.totalSpendMicroUsd(), 850 + 1875);
});

test('SQLite 저장소: 스키마 3의 파일을 열면 원장을 더하고, 예전 판과 턴은 그대로 읽고 센다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  // 스키마 3까지만 적용한 파일(비용 상한을 붙이기 전의 서버가 만든 파일)을 흉내 낸다. 그때는 원장 표가 없다.
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
  old.exec('INSERT INTO schema_version (version) VALUES (1), (2), (3)');
  old
    .prepare(
      `INSERT INTO games (id, user_id, topic_id, side, card_id, mode, history, conceded, start_lean, started_at)
       VALUES ('old', 'local', 'q01', 0, 'utilitarian', 'prompt', '[]', '[]', -1, '2026-11-21T00:00:00.000Z')`,
    )
    .run();
  const insertTurn = old.prepare(
    `INSERT INTO turns (game_id, n, user_text, input, reply, ms_opponent, at) VALUES ('old', ?, ?, ?, '답입니다.', 7, ?)`,
  );
  insertTurn.run(1, '첫 반론입니다.', 'voice', '2026-11-21T00:01:00.000Z');
  insertTurn.run(2, '둘째 반론입니다.', 'text', '2026-11-21T00:02:00.000Z');
  old.close();

  const store = new SqliteGameStore(path);
  t.after(() => store.close());
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  const oldTurn = { reply: '답입니다.', ms: { opponent: 7 } };
  assert.deepEqual(await store.get('old'), {
    id: 'old',
    userId: 'local',
    topicId: 'q01',
    side: 0,
    cardId: 'utilitarian',
    mode: 'prompt',
    startLean: -1,
    history: [],
    conceded: [],
    turns: [
      // 다시 말한 횟수는 남기지 않던 때의 턴이라 0이다.
      { n: 1, user: '첫 반론입니다.', input: 'voice', redone: 0, ...oldTurn, at: '2026-11-21T00:01:00.000Z' },
      { n: 2, user: '둘째 반론입니다.', input: 'text', redone: 0, ...oldTurn, at: '2026-11-21T00:02:00.000Z' },
    ],
    startedAt: '2026-11-21T00:00:00.000Z',
  });
  // 예전 턴도 턴 수에 든다. 원장은 비어서 시작하고 이어서 쓸 수 있다.
  assert.equal(await store.countTurnsSince('local', '2026-11-21T00:00:00.000Z'), 2);
  assert.equal(await store.totalSpendMicroUsd(), 0);
  await store.addSpend(spend({ gameId: 'old' }));
  assert.equal(await store.totalSpendMicroUsd(), 850);
});



test('SQLite 저장소: 다른 프로세스가 쓰는 중이면 바로 실패하지 않고 기다렸다가 저장한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  const store = new SqliteGameStore(path);
  t.after(() => store.close());
  await store.create(sample());

  // 다른 프로세스가 쓰기 잠금을 0.3초 잡았다가 놓는다.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  await new Promise((resolve) => holder.stdout.once('data', resolve));

  const started = performance.now();
  await store.save(sample({ conceded: ['P1'] }));
  const waited = performance.now() - started;
  assert.ok(waited >= 100, `기다린 시간 ${Math.round(waited)}ms`);
  assert.deepEqual((await store.get('g1'))?.conceded, ['P1']);
  await exited;
});

test('SQLite 저장소: 스키마를 다 적용한 파일은 다른 프로세스가 쓰는 중이어도 기다리지 않고 열린다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-open-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');
  new SqliteGameStore(path).close();

  // 다른 프로세스가 쓰기 잠금을 1초 잡는다. 여는 데 쓰기 잠금이 필요하면 그만큼 기다리게 된다.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec('BEGIN IMMEDIATE');
       process.stdout.write('locked\\n');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
       db.exec('COMMIT');
       db.close();`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  await new Promise((resolve) => holder.stdout.once('data', resolve));

  const started = performance.now();
  const store = new SqliteGameStore(path);
  const took = performance.now() - started;
  store.close();
  assert.ok(took < 500, `여는 데 걸린 시간 ${Math.round(took)}ms`);
  await exited;
});

test('SQLite 저장소: 저장 중에 실패하면 판이 반쯤 바뀌지 않는다', async (t) => {
  const store = new SqliteGameStore(':memory:');
  t.after(() => store.close());
  await store.create(sample());
  // 대화는 바뀌었지만 턴의 기록이 깨진(상대 시간이 없는) 판. 턴을 넣다가 실패한다.
  const broken = sample({
    history: [...sample().history, { role: 'user', content: '반론입니다.' }],
    conceded: ['P1'],
    turns: [{ ...engineTurn, ms: {} as TurnLog['ms'] }],
  });
  await assert.rejects(store.save(broken));
  assert.deepEqual(await store.get('g1'), sample());
});
