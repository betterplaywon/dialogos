import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../../eval/src/data.ts';
import { buildScript, firstUserMessage, openingStatement } from '../../eval/src/script.ts';
import type { Matchup } from '../server/games.ts';
import { loadTopics, type TopicFile } from '../server/topics.ts';
import { fixtureTopicFiles, loadTopicsFrom } from './topic-fixtures.ts';

const questions = loadQuestions(loadCards());
const FLAWS = ['false-dichotomy', 'overgeneralization', 'self-contradiction', 'unsupported-fact'];

/** 검사용 카드를 고쳐 불러 보고, 실패하면 그 메시지를 돌려준다. */
function problemOf(edit: (files: TopicFile[]) => unknown[]): string {
  try {
    loadTopicsFrom(edit(structuredClone(fixtureTopicFiles())));
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

test('실제 주제 카드는 문제없이 불러오고, 판정 실험 질문은 모두 주제가 된다', () => {
  const topics = loadTopics();
  for (const question of questions) {
    const topic = topics.get(question.id);
    assert.ok(topic, question.id);
    // 판정 실험 질문의 사용자 입장을 지키는 판은 판정 실험 질문 그대로다(잰 판 = 내놓은 판).
    assert.equal(topic.sides[0].stance, question.userStance, question.id);
    assert.deepEqual(topic.sides[0].matchup?.question, question, question.id);
    assert.equal(topic.sides[1].stance, question.opponentStance, question.id);
  }
  assert.deepEqual([...topics.keys()], [...topics.keys()].sort());
});

test('실제 주제 카드의 상대는 모두 판정 실험 질문과 같은 규칙을 지킨다', () => {
  // eval/tests/script.test.ts의 질문 규칙을 카드로 만든 판마다 다시 확인한다(rubric.md '질문과 반론을 쓰는 규칙').
  const matchups: [string, Matchup][] = [];
  for (const topic of loadTopics().values()) {
    for (const [index, side] of topic.sides.entries()) if (side.matchup) matchups.push([`${topic.id} ${index}쪽`, side.matchup]);
  }
  assert.ok(matchups.length >= questions.length);
  for (const [label, { question: q, card }] of matchups) {
    assert.equal(q.cardId, card.id, label);
    assert.equal(q.premises.length, 4, label);
    assert.deepEqual(q.premises.map((p) => p.id), ['P1', 'P2', 'P3', 'P4'], label);
    assert.deepEqual(q.rebuttals.map((r) => r.premiseId), ['P1', 'P2', 'P3', 'P4'], label);
    assert.deepEqual([...new Set(q.premises.map((p) => p.flaw))].sort(), FLAWS, label);
    for (const r of q.rebuttals) assert.ok(r.why.trim(), `${label} ${r.premiseId}`);
    for (const turn of buildScript(q)) {
      if (turn.kind === 'pressure') assert.ok(turn.text.length < 120, `${label} ${turn.n}턴`);
      else assert.ok(turn.text.length >= 120, `${label} ${turn.n}턴`);
    }
    assert.ok(firstUserMessage(q).includes(q.userStance), label);
    for (const p of q.premises) assert.ok(openingStatement(q).includes(p.text), `${label} ${p.id}`);
  }
});

test('판정 실험 질문을 쓰는 카드는 그 질문 쪽을 그대로 가져오고, 반대쪽은 다른 캐릭터가 민다', () => {
  const topics = loadTopicsFrom(fixtureTopicFiles());
  const q01 = questions.find((question) => question.id === 'q01');
  const topic = topics.get('q01');
  assert.ok(q01 && topic);
  assert.equal(topic.question, q01.text);
  assert.deepEqual(topic.sides[0].matchup?.question, q01);
  const other = topic.sides[1].matchup;
  assert.ok(other);
  assert.equal(other.card.id, 'deontologist');
  assert.deepEqual(
    [other.question.id, other.question.text, other.question.userStance, other.question.opponentStance],
    ['q01-1', q01.text, q01.opponentStance, q01.userStance],
  );
  assert.equal(other.question.premises[0]?.text, 'q01 반대쪽 검사용 첫째 전제입니다.');

  const fresh = topics.get('x01');
  assert.ok(fresh);
  assert.deepEqual(
    fresh.sides.map((side) => [side.stance, side.matchup?.card.id, side.matchup?.question.opponentStance]),
    [
      ['그렇게 해도 됩니다.', 'deontologist', '그렇게 해서는 안 됩니다.'],
      ['그렇게 해서는 안 됩니다.', 'utilitarian', '그렇게 해도 됩니다.'],
    ],
  );
  // 카드가 없는 판정 실험 질문은 질문의 사용자 입장만 지킬 수 있다.
  const q02 = topics.get('q02');
  assert.ok(q02?.sides[0].matchup);
  assert.equal(q02.sides[1].matchup, undefined);
});

test('주제 카드의 잘못은 파일 이름과 함께 모아서 알린다', () => {
  const cases: [string, (files: TopicFile[]) => unknown[], RegExp][] = [
    ['질문 글이 다름', (f) => [{ ...f[0], question: '다른 질문' }], /question이 판정 실험 질문의 글과 다릅니다/],
    ['입장이 다름', (f) => [{ ...f[0], sides: [{ ...f[0]!.sides[0], stance: '다른 입장' }, f[0]!.sides[1]] }], /사용자 입장과 다릅니다/],
    ['같은 캐릭터', (f) => [{ ...f[0], sides: [{ ...f[0]!.sides[0], cardId: 'utilitarian' }, f[0]!.sides[1]] }], /같은 캐릭터/],
    ['fromEval 자리', (f) => [{ ...f[0], sides: [f[0]!.sides[1], f[0]!.sides[0]] }], /fromEval은 sides\[1\]에만/],
    ['fromEval에 다른 칸', (f) => [{ ...f[0], sides: [f[0]!.sides[0], { fromEval: 'q01', premises: [] }] }], /다른 칸을 두지 않습니다/],
    ['없는 질문', (f) => [{ ...f[0], id: 'q99', sides: [f[0]!.sides[0], { fromEval: 'q99' }] }], /'q99'이 없습니다/],
    ['id가 다름', (f) => [{ ...f[0], id: 'q01-copy' }], /id는 그 질문의 id\(q01\)와 같아야/],
    ['질문 id를 새 주제에', (f) => [{ ...f[1], id: 'q02' }], /판정 실험 질문의 id입니다/],
    ['id 형식', (f) => [{ ...f[1], id: 'X 01' }], /id는 영문 소문자/],
    ['입장이 하나', (f) => [{ ...f[1], sides: [f[1]!.sides[0]] }], /sides는 두 개/],
    ['반론의 과녁이 없음', (f) => {
      const card = f[1]!;
      const first = card.sides[0] as { rebuttals: { premiseId: string }[] };
      first.rebuttals[0]!.premiseId = 'P9';
      return [card];
    }, /없는 전제 'P9'/],
    ['없는 캐릭터', (f) => [{ ...f[1], sides: [{ ...f[1]!.sides[0], cardId: 'nobody' }, f[1]!.sides[1]] }], /입장 카드 'nobody'가 없습니다/],
    ['id가 겹침', (f) => [f[1], { ...f[1] }], /다른 카드와 겹칩니다/],
  ];
  for (const [name, edit, expected] of cases) assert.match(problemOf(edit), expected, name);
  // 문제가 여럿이면 한 번에 모두 알린다.
  const many = problemOf((f) => [{ ...f[0], question: '다른 질문' }, { ...f[1], id: 'q02' }]);
  assert.match(many, /q01\.json: .*question이/);
  assert.match(many, /q02\.json: .*판정 실험 질문의 id/);
});

test('읽을 수 없는 카드 파일은 파일 이름과 함께 알리고, 폴더가 없으면 판정 실험 질문만 쓴다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-topics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.json'), '{ 깨진');
  assert.throws(() => loadTopics({ dir }), /broken\.json을 읽지 못했습니다/);
  const topics = loadTopics({ dir: join(dir, '없는 폴더') });
  assert.deepEqual([...topics.keys()], questions.map((question) => question.id).sort());
});
