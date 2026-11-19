import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteGameStore } from '../server/sqlite-store.ts';
import { MemoryGameStore, type GameRecord, type GameStore, type TurnLog } from '../server/store.ts';

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
    cardId: 'utilitarian',
    mode: 'engine',
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
  reply: 'P1을 거둡니다.',
  decision: { tactic: 'argument', defeats: 'P1', reason: '반례' },
  judge: { calls: 2, readable: true },
  ms: { judge: 12, opponent: 34 },
  at: '2026-11-19T00:01:00.000Z',
};
const unreadableTurn: TurnLog = {
  n: 2,
  user: '같은 말입니다.',
  reply: '물러서지 않습니다.',
  decision: { tactic: 'other', defeats: null, reason: '판정기의 답을 읽지 못했습니다.' },
  judge: { calls: 2, readable: false },
  ms: { judge: 5, opponent: 6 },
  at: '2026-11-19T00:02:00.000Z',
};
/** 지시문 방식의 턴. 판정도 판정기 기록도 없다. */
const promptTurn: TurnLog = { n: 1, user: '반론입니다.', reply: '답입니다.', ms: { opponent: 7 }, at: '2026-11-19T00:01:00.000Z' };

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

  test(`${name} 저장소: 판정이 없는 턴(지시문 방식)도 그대로 남는다`, async (t) => {
    const store = open();
    t.after(() => store.close?.());
    await store.create(sample({ mode: 'prompt' }));
    await store.save(sample({ mode: 'prompt', turns: [promptTurn] }));
    const loaded = await store.get('g1');
    assert.deepEqual(loaded?.turns, [promptTurn]);
    assert.equal(loaded?.mode, 'prompt');
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
    assert.deepEqual(all[0], { id: 'new', topicId: 'q01', cardId: 'utilitarian', turns: 1, startedAt: '2026-11-19T09:00:00.000Z' });
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
}

test('SQLite 저장소: 파일을 다시 열면 판이 남고, 스키마는 한 번만 적용한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite');

  const first = new SqliteGameStore(path);
  assert.equal(first.schemaVersion, 1);
  await first.create(sample({ turns: [engineTurn] }));
  first.close();

  const second = new SqliteGameStore(path);
  t.after(() => second.close());
  assert.equal(second.schemaVersion, 1);
  assert.deepEqual(await second.get('g1'), sample({ turns: [engineTurn] }));
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
