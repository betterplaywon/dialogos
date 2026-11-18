import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../src/data.ts';
import { runDialogue } from '../src/dialogue.ts';
import { labelDialogue, parseLabel } from '../src/labeler.ts';
import { createMockModel } from '../src/providers/mock.ts';
import type { Card, ChatMessage, ChatModel, Dialogue, Question } from '../src/types.ts';

const cards = loadCards();
const question = loadQuestions(cards)[0] as Question;
const card = cards.get(question.cardId) as Card;
const models = { opponent: createMockModel('opponent'), judge: createMockModel('judge') };
const none = new Set<string>();

function scripted(replies: string[]): ChatModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: 'scripted',
    calls,
    async complete(messages) {
      calls.push(messages);
      return replies[Math.min(calls.length, replies.length) - 1] ?? '';
    },
  };
}

function label(yields: boolean, premises: string[] = [], full = false): string {
  return JSON.stringify({ yield: yields, premises, full, evidence: '근거 구절' });
}

/** 대본의 앞 n턴만 가진 대화. 답의 내용은 채점기가 정하므로 아무 글이나 넣는다. */
async function shortDialogue(turns: number): Promise<Dialogue> {
  return runDialogue({ runId: 't', question, card, condition: 'prompt', rep: 1, models, totalTurns: turns });
}

test('채점기의 답을 읽는다', () => {
  assert.deepEqual(parseLabel(label(false), question, none), { yield: false, premises: [], full: false, evidence: '근거 구절' });
  assert.deepEqual(parseLabel(label(true, ['P2']), question, none).premises, ['P2']);
  assert.deepEqual(parseLabel('설명: {"yield":true,"premises":[" P1 ","P1","P9",3],"full":false}', question, none), {
    yield: true,
    premises: ['P1'],
    full: false,
    evidence: '',
  });
});

test('이미 거둔 전제는 새로 내준 것으로 세지 않는다', () => {
  const result = parseLabel(label(false, ['P1', 'P3']), question, new Set(['P1']));
  assert.deepEqual(result.premises, ['P3']);
  assert.equal(result.yield, true);
  assert.deepEqual(parseLabel(label(false, ['P1']), question, new Set(['P1'])), { yield: false, premises: [], full: false, evidence: '근거 구절' });
});

test('입장 전체를 바꿨으면 물러섬이고, yield 값이 없으면 읽지 못한 것으로 본다', () => {
  assert.equal(parseLabel('{"yield":false,"premises":[],"full":true}', question, none).yield, true);
  assert.throws(() => parseLabel('{"premises":[]}', question, none), /yield 값이 없습니다/);
  assert.throws(() => parseLabel('{"yield":"true"}', question, none), /yield 값이 없습니다/);
  assert.throws(() => parseLabel('모르겠습니다', question, none));
});

test('턴마다 그 답 전과 후에 거둔 전제를 적는다', async () => {
  const dialogue = await shortDialogue(4);
  const scorer = scripted([label(false), label(true, ['P2']), label(false), label(true, ['P1'])]);
  const rows = await labelDialogue(dialogue, question, scorer);
  assert.deepEqual(rows.map((r) => r.yield), [false, true, false, true]);
  assert.deepEqual(rows.map((r) => r.concededBefore), [[], [], ['P2'], ['P2']]);
  assert.deepEqual(rows.map((r) => r.concededAfter), [[], ['P2'], ['P2'], ['P1', 'P2']]);
  assert.deepEqual(rows.map((r) => [r.n, r.kind, r.tactic]), dialogue.turns.map((t) => [t.n, t.kind, t.tactic]));
  assert.ok(rows.every((r) => r.runId === 't' && r.questionId === question.id && r.condition === 'prompt' && r.rep === 1));
  // 채점기에게는 앞에서 거둔 전제가 표시되어 넘어간다.
  assert.doesNotMatch(scorer.calls[1]?.[1]?.content ?? '', /이미 거둠/);
  assert.match(scorer.calls[2]?.[1]?.content ?? '', /^P2\. .*\(이미 거둠\)$/m);
});

test('입장 전체를 바꾸면 그 뒤로는 전제를 모두 거둔 것으로 본다', async () => {
  const dialogue = await shortDialogue(3);
  const rows = await labelDialogue(dialogue, question, scripted([label(false), label(true, [], true), label(true, [], true)]));
  assert.deepEqual(rows[1]?.concededBefore, []);
  assert.deepEqual(rows[1]?.concededAfter, ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(rows[2]?.concededBefore, ['P1', 'P2', 'P3', 'P4']);
  assert.equal(rows[2]?.yield, true);
});

test('채점기에게 조건과 턴의 종류를 알려 주지 않는다', async () => {
  const dialogue = await runDialogue({ runId: 't', question, card, condition: 'engine', rep: 1, models, totalTurns: 6 });
  const scorer = scripted([label(false)]);
  await labelDialogue(dialogue, question, scorer);
  assert.equal(scorer.calls.length, 6);
  for (const [index, messages] of scorer.calls.entries()) {
    const text = messages.map((m) => m.content).join('\n');
    for (const hidden of ['engine', 'prompt', 'plain', 'pressure', 'valid', 'repeat', 'authority', 'emotion', '[이번 턴의 판정]']) {
      assert.ok(!text.includes(hidden), `${index + 1}번째 호출에 '${hidden}'이 들어 있습니다`);
    }
    assert.ok(text.includes(`사용자의 말: ${dialogue.turns[index]?.user}`));
    assert.ok(text.includes(`상대의 답: ${dialogue.turns[index]?.reply}`));
  }
});

test('읽을 수 없는 답은 다시 묻고, 세 번 실패하면 멈춘다', async () => {
  const dialogue = await shortDialogue(2);
  const flaky = scripted(['모르겠습니다', label(true, ['P1']), label(false)]);
  const rows = await labelDialogue(dialogue, question, flaky);
  assert.equal(flaky.calls.length, 3);
  assert.deepEqual(rows.map((r) => r.yield), [true, false]);

  const broken = scripted(['모르겠습니다']);
  await assert.rejects(labelDialogue(dialogue, question, broken), /채점기의 답을 읽지 못했습니다 \(q01, prompt, 1번째, 1턴\)/);
  assert.equal(broken.calls.length, 3);
});

test('모의 채점기는 모의 상대의 답에서 내준 전제를 읽어 낸다', async () => {
  const dialogue = await runDialogue({ runId: 't', question, card, condition: 'engine', rep: 1, models });
  const rows = await labelDialogue(dialogue, question, createMockModel('scorer'));
  assert.equal(rows.length, 30);
  for (const [index, row] of rows.entries()) {
    const defeated = dialogue.turns[index]?.decision?.defeats ?? null;
    assert.deepEqual(row.premises, defeated ? [defeated] : [], `${row.n}턴`);
  }
});
