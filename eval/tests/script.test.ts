import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../src/data.ts';
import { buildScript, firstUserMessage, openingStatement, PRESSURE_TEMPLATES, VALID_TURN_POSITIONS } from '../src/script.ts';

const cards = loadCards();
const questions = loadQuestions(cards);

test('질문 파일은 모두 검사를 통과하고 전제와 반론이 네 개씩이다', () => {
  assert.ok(questions.length >= 4);
  for (const q of questions) {
    assert.equal(q.premises.length, 4, q.id);
    assert.equal(q.rebuttals.length, 4, q.id);
    assert.deepEqual(q.rebuttals.map((r) => r.premiseId), q.premises.map((p) => p.id), q.id);
    assert.deepEqual(
      [...new Set(q.premises.map((p) => p.flaw))].sort(),
      ['false-dichotomy', 'overgeneralization', 'self-contradiction', 'unsupported-fact'],
      q.id,
    );
  }
});

test('대본은 30턴이고 6, 14, 22, 30번째가 타당한 반론이다', () => {
  for (const q of questions) {
    const script = buildScript(q);
    assert.equal(script.length, 30);
    assert.deepEqual(script.map((t) => t.n), Array.from({ length: 30 }, (_, i) => i + 1));
    const valid = script.filter((t) => t.kind === 'valid');
    assert.deepEqual(valid.map((t) => t.n), [...VALID_TURN_POSITIONS]);
    assert.deepEqual(valid.map((t) => t.premiseId), ['P1', 'P2', 'P3', 'P4']);
    const pressure = script.filter((t) => t.kind === 'pressure');
    assert.equal(pressure.length, 26);
    assert.equal(pressure.filter((t) => t.tactic === 'repeat').length, 9);
    assert.equal(pressure.filter((t) => t.tactic === 'authority').length, 9);
    assert.equal(pressure.filter((t) => t.tactic === 'emotion').length, 8);
    assert.ok(pressure.every((t) => !t.text.includes('{stance}')));
  }
});

test('같은 질문은 언제나 같은 대본을 낸다', () => {
  const q = questions[0];
  assert.ok(q);
  assert.deepEqual(buildScript(q), buildScript(q));
});

test('턴 수를 줄이면 그 안에 든 타당한 반론만 남는다', () => {
  const q = questions[0];
  assert.ok(q);
  const script = buildScript(q, 14);
  assert.equal(script.length, 14);
  assert.deepEqual(script.filter((t) => t.kind === 'valid').map((t) => t.n), [6, 14]);
});

test('압박 문장은 짧고 타당한 반론은 길다', () => {
  // 모의 모델은 길이로 둘을 가른다. 실제 모델과 채점기는 길이를 쓰지 않는다.
  for (const q of questions) {
    for (const turn of buildScript(q)) {
      if (turn.kind === 'pressure') assert.ok(turn.text.length < 120, `${q.id} ${turn.n}턴`);
      else assert.ok(turn.text.length >= 120, `${q.id} ${turn.n}턴`);
    }
  }
  for (const templates of Object.values(PRESSURE_TEMPLATES)) assert.equal(templates.length, 9);
});

test('첫 발언에는 질문과 양쪽 입장, 전제 네 개가 모두 들어간다', () => {
  for (const q of questions) {
    assert.ok(firstUserMessage(q).includes(q.text));
    assert.ok(firstUserMessage(q).includes(q.userStance));
    const opening = openingStatement(q);
    assert.ok(opening.includes(q.opponentStance));
    for (const p of q.premises) assert.ok(opening.includes(p.text));
  }
});
