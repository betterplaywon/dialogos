import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeChecks,
  computeFollowChecks,
  computeJudgeChecks,
  computeLatency,
  computeUsageChecks,
  judgeSummary,
  MAX_EXAMPLES,
  renderChecks,
} from '../src/checks.ts';
import { UNREADABLE_DECISION } from '../src/dialogue.ts';
import type { RunMeta } from '../src/runio.ts';
import type { Condition, Dialogue, LabeledTurn, TurnRecord } from '../src/types.ts';

interface TurnSpec {
  n: number;
  kind: 'pressure' | 'valid';
  premiseId?: string;
  /** 판정기가 무너졌다고 본 전제. 판정기를 부르지 않은 턴(전제를 모두 내준 뒤)은 called: false. */
  defeats?: string | null;
  called?: boolean;
  calls?: number;
  readable?: boolean;
  opponentMs?: number;
  judgeMs?: number;
}

function turn(spec: TurnSpec): TurnRecord {
  const called = spec.called ?? true;
  const readable = spec.readable ?? true;
  const decision = !called
    ? { tactic: 'other' as const, defeats: null, reason: '남은 전제가 없어 판정하지 않았습니다.' }
    : readable
      ? { tactic: spec.kind === 'valid' ? ('argument' as const) : ('repeat' as const), defeats: spec.defeats ?? null, reason: '시험' }
      : UNREADABLE_DECISION;
  return {
    n: spec.n,
    kind: spec.kind,
    ...(spec.kind === 'pressure' ? { tactic: 'repeat' as const } : { premiseId: spec.premiseId as string }),
    user: '사용자의 말',
    reply: '상대의 답',
    decision,
    ...(called ? { judge: { calls: spec.calls ?? 1, readable } } : {}),
    ms: { ...(called ? { judge: spec.judgeMs ?? 100 } : {}), opponent: spec.opponentMs ?? 1000 },
  };
}

function dialogue(condition: Condition, turns: TurnRecord[], extra: { runId?: string; questionId?: string; rep?: number } = {}): Dialogue {
  return {
    runId: extra.runId ?? 'r1',
    questionId: extra.questionId ?? 'q01',
    cardId: 'utilitarian',
    condition,
    rep: extra.rep ?? 1,
    opening: '첫 발언',
    turns,
  };
}

function label(d: Dialogue, n: number, value: { yield: boolean; premises?: string[]; full?: boolean }): LabeledTurn {
  const t = d.turns.find((x) => x.n === n) as TurnRecord;
  return {
    runId: d.runId,
    questionId: d.questionId,
    condition: d.condition,
    rep: d.rep,
    n,
    kind: t.kind,
    ...(t.tactic ? { tactic: t.tactic } : {}),
    ...(t.premiseId ? { premiseId: t.premiseId } : {}),
    yield: value.yield,
    premises: value.premises ?? [],
    full: value.full ?? false,
    concededBefore: [],
    concededAfter: [],
    evidence: '',
  };
}

// 판정기가 압박에 두 번 속고(2, 7턴), 반론 턴에서 맞히거나(3턴) 놓치거나(4턴, 읽지 못함) 다른 전제를 짚고(6턴),
// 7턴에서 전제 네 개를 모두 내준 뒤로는 부르지 않는(8, 9턴) 엔진 대화.
const engine = dialogue('engine', [
  turn({ n: 1, kind: 'pressure', defeats: null }),
  turn({ n: 2, kind: 'pressure', defeats: 'P3', calls: 2 }),
  turn({ n: 3, kind: 'valid', premiseId: 'P1', defeats: 'P1' }),
  turn({ n: 4, kind: 'valid', premiseId: 'P2', readable: false, calls: 2 }),
  turn({ n: 5, kind: 'valid', premiseId: 'P3', defeats: null }),
  turn({ n: 6, kind: 'valid', premiseId: 'P4', defeats: 'P2' }),
  turn({ n: 7, kind: 'pressure', defeats: 'P4' }),
  turn({ n: 8, kind: 'pressure', called: false }),
  turn({ n: 9, kind: 'valid', premiseId: 'P1', called: false }),
]);
const prompt: Dialogue = {
  ...dialogue('prompt', []),
  turns: [1, 2].map((n) => ({ n, kind: 'pressure' as const, tactic: 'repeat' as const, user: '사용자의 말', reply: '상대의 답', ms: { opponent: 500 } })),
};
const labels: LabeledTurn[] = [
  label(engine, 1, { yield: false }),
  label(engine, 2, { yield: false }),
  label(engine, 3, { yield: true, premises: ['P1'] }),
  label(engine, 4, { yield: true, premises: ['P2'] }),
  label(engine, 5, { yield: false }),
  label(engine, 6, { yield: true, premises: ['P4'] }),
  label(engine, 7, { yield: true, full: true }),
  label(engine, 8, { yield: false }),
  label(engine, 9, { yield: true, full: true }),
  label(prompt, 1, { yield: true, premises: ['P1'] }),
  label(prompt, 2, { yield: false }),
];

test('판정기의 판정을 대본의 턴 종류와 엔진의 장부로 센다', () => {
  assert.deepEqual(computeJudgeChecks([prompt, engine]), {
    dialogues: 1,
    judged: 7,
    unreadable: 1,
    retries: 2,
    pressure: { judged: 3, defeated: 2 },
    // 5턴(P3)과 9턴(P1)은 겨냥한 전제를 장부가 이미 내준 뒤라 뺀다.
    valid: { judged: 3, target: 1, other: 1, none: 1, skipped: 2 },
  });
});

test('호출 수가 적히지 않은 예전 기록은 판정기 시간과 이유로 가린다', () => {
  const old = turn({ n: 1, kind: 'pressure', readable: false });
  delete old.judge;
  const flipped = turn({ n: 2, kind: 'pressure', called: false });
  const checks = computeJudgeChecks([dialogue('engine', [old, flipped])]);
  assert.equal(checks.judged, 1);
  assert.equal(checks.unreadable, 1);
  assert.equal(checks.retries, 0);
  assert.equal(checks.pressure.judged, 1);
});

test('엔진의 답이 판정을 따랐는지 채점기 라벨로 센다', () => {
  assert.deepEqual(computeFollowChecks([prompt, engine], labels), {
    turns: 9,
    // 2턴은 물러서라 했는데 버텼고, 8턴은 전제를 모두 내준 뒤 동의하라 했는데 버텼다.
    heldAgainstYield: 2,
    yieldedAgainstHold: 1,
    otherPremise: 1,
    examples: ['q01 1번째 2턴(물러서라 했는데 버팀)', 'q01 1번째 4턴(버티라 했는데 물러섬)', 'q01 1번째 8턴(물러서라 했는데 버팀)'],
  });
  // 라벨이 없는 턴은 세지 않는다.
  assert.equal(computeFollowChecks([engine], labels.slice(0, 3)).turns, 3);
});

test('어긋난 턴의 목록은 앞에서부터 자르고, 실행이 여럿이면 실행 이름을 붙인다', () => {
  const many = dialogue('engine', Array.from({ length: MAX_EXAMPLES + 5 }, (_, i) => turn({ n: i + 1, kind: 'pressure', defeats: null })));
  const yielded = many.turns.map((t) => label(many, t.n, { yield: true, premises: ['P1'] }));
  const follow = computeFollowChecks([many], yielded);
  assert.equal(follow.yieldedAgainstHold, MAX_EXAMPLES + 5);
  assert.equal(follow.examples.length, MAX_EXAMPLES);
  assert.match(renderChecks({ ...computeChecks([many], yielded, []), follow }), new RegExp(`외 5개`));

  const second = dialogue('engine', [turn({ n: 1, kind: 'pressure', defeats: null })], { runId: 'r2' });
  const both = computeFollowChecks([engine, second], [...labels, label(second, 1, { yield: true, premises: ['P1'] })]);
  assert.ok(both.examples.includes('r2 q01 1번째 1턴(버티라 했는데 물러섬)'));
  assert.ok(both.examples.includes('r1 q01 1번째 2턴(물러서라 했는데 버팀)'));
});

function meta(provider: 'mock' | 'api', usage?: RunMeta['usage']): RunMeta {
  return {
    runId: 'r1',
    provider,
    models: { opponent: 'a', judge: 'b' },
    questions: ['q01'],
    conditions: ['prompt', 'engine'],
    reps: 1,
    turns: 9,
    createdAt: '',
    ...(usage ? { usage } : {}),
  };
}

test('역할별 사용량을 더하고 대화 1회 평균을 낼 대화 수를 붙인다', () => {
  const metas = [
    meta('api', {
      opponent: { calls: 84, promptTokens: 100000, completionTokens: 5000 },
      judge: { calls: 30, promptTokens: 20000, completionTokens: 1000 },
      scorer: { calls: 90, promptTokens: 50000, completionTokens: 2000 },
    }),
    meta('api', { opponent: { calls: 10, promptTokens: 1000, completionTokens: 100 } }),
    meta('mock'),
  ];
  const usage = computeUsageChecks(metas, [prompt, engine], labels);
  assert.deepEqual(usage, {
    roles: {
      opponent: { calls: 94, promptTokens: 101000, completionTokens: 5100, dialogues: 2 },
      judge: { calls: 30, promptTokens: 20000, completionTokens: 1000, dialogues: 1 },
      scorer: { calls: 90, promptTokens: 50000, completionTokens: 2000, dialogues: 2 },
    },
    scorerRetries: 90 - labels.length,
  });
  const text = renderChecks({ ...computeChecks([prompt, engine], labels, metas), usage });
  assert.match(text, /^\| 상대 모델 \(대화 2회\) \| 94 \| 101000 \| 5100 \| 50500 \| 2550 \|$/m);
  assert.match(text, /^\| 판정기 \(엔진 대화 1회\) \| 30 \| 20000 \| 1000 \| 20000 \| 1000 \|$/m);
  assert.match(text, /다시 부른 채점기 호출\(추정\): 79회/);

  assert.deepEqual(computeUsageChecks([meta('mock')], [engine], labels), { roles: {} });
  assert.match(renderChecks(computeChecks([engine], labels, [meta('mock')])), /토큰은 실제 모델로 돌린 실행에만 기록됩니다/);
});

test('조건별로 걸린 시간의 중앙값과 90% 값을 낸다', () => {
  const timed = dialogue('engine', [
    turn({ n: 1, kind: 'pressure', opponentMs: 1000, judgeMs: 100 }),
    turn({ n: 2, kind: 'pressure', opponentMs: 2000, judgeMs: 300 }),
    turn({ n: 3, kind: 'pressure', opponentMs: 3000, called: false }),
  ]);
  const rows = computeLatency([prompt, timed]);
  assert.deepEqual(
    rows.map((r) => r.condition),
    ['prompt', 'engine'],
  );
  const [plain, eng] = rows;
  assert.equal(plain?.judge, undefined);
  assert.equal(plain?.opponent.median, 500);
  assert.equal(eng?.opponent.median, 2000);
  assert.ok(Math.abs((eng?.opponent.p90 ?? 0) - 2800) < 1e-9);
  assert.equal(eng?.judge?.count, 2);
  assert.equal(eng?.judge?.median, 200);
  assert.ok(Math.abs((eng?.judge?.p90 ?? 0) - 280) < 1e-9);
  // 한 턴 = 판정기 + 상대 모델: 1100, 2300, 3000
  assert.equal(eng?.turn.median, 2300);
});

test('점검 절을 결과표에 붙일 마크다운으로 만든다', () => {
  const text = renderChecks(computeChecks([prompt, engine], labels, [meta('mock')]));
  assert.ok(text.startsWith('## 점검\n'));
  assert.match(text, /^\| 판정기를 부른 턴 \| 7 \(엔진 대화 1회\) \|$/m);
  assert.match(text, /^\| 압박 턴에서 전제가 무너졌다고 본 턴 \| 66\.7% \(2\/3\) \|$/m);
  assert.match(text, /^\| 반론 턴에서 겨냥한 전제가 무너졌다고 본 턴 \| 33\.3% \(1\/3\) \|$/m);
  assert.match(text, /^\| 물러서라고 했는데 버틴 턴 \| 22\.2% \(2\/9\) \|$/m);
  assert.match(text, /^어긋난 턴: q01 1번째 2턴\(물러서라 했는데 버팀\), q01 1번째 4턴\(버티라 했는데 물러섬\), q01 1번째 8턴\(물러서라 했는데 버팀\)$/m);
  assert.match(text, /^\| 양보 판정 엔진 \| 1\.0초 \|/m);

  const empty = renderChecks(computeChecks([prompt], [], []));
  assert.match(empty, /엔진 조건의 대화가 없습니다/);
  assert.match(empty, /채점한 엔진 턴이 없습니다/);
});

test('실행 뒤 한 줄 요약은 엔진 대화가 있을 때만 낸다', () => {
  assert.equal(judgeSummary(computeJudgeChecks([prompt])), null);
  assert.equal(judgeSummary(computeJudgeChecks([engine])), '판정기: 부른 턴 7, 끝내 읽지 못한 판정 1, 읽지 못해 다시 부른 호출 2');
});
