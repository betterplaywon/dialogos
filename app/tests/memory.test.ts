import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_JUDGED_DECISION, UNREADABLE_DECISION } from '../../eval/src/dialogue.ts';
import type { JudgeDecision } from '../../eval/src/types.ts';
import type { Lean } from '../server/contract.ts';
import type { Topic } from '../server/games.ts';
import { memoriesOf } from '../server/memory.ts';
import type { EndRecord, GameRecord, TurnLog } from '../server/store.ts';
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
  const premises = [{ id: 'P1', flaw: 'overgeneralization' as const, text: '줄이\n나뉜\t전제입니다.' }];
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
        turn(1, '첫 줄입니다.\r\n\t둘째 줄입니다.', argument('P1')),
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
  for (const [, text] of texts) assert.doesNotMatch(String(text), /[^\S ]|\s{2}|^\s|\s$/);
});

test('긴 입장과 말은 정한 글자 수로 자르고 끝에 말줄임표를 붙인다(이모지도 한 자로 센다)', () => {
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
