import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../src/data.ts';
import { runDialogue } from '../src/dialogue.ts';
import { agreement, drawSample } from '../src/human.ts';
import { labelDialogue } from '../src/labeler.ts';
import { createMockModel } from '../src/providers/mock.ts';
import type { Card, Dialogue, LabeledTurn, Question } from '../src/types.ts';

const cards = loadCards();
const question = loadQuestions(cards)[0] as Question;
const card = cards.get(question.cardId) as Card;

async function mockRun(): Promise<{ dialogues: Dialogue[]; labels: LabeledTurn[] }> {
  const models = { opponent: createMockModel('opponent'), judge: createMockModel('judge') };
  const dialogues: Dialogue[] = [];
  const labels: LabeledTurn[] = [];
  for (const condition of ['plain', 'prompt', 'engine'] as const) {
    const dialogue = await runDialogue({ runId: 't', question, card, condition, rep: 1, models });
    dialogues.push(dialogue);
    labels.push(...(await labelDialogue(dialogue, question, createMockModel('scorer'))));
  }
  return { dialogues, labels };
}

function pairs(yieldAgree: number, yieldTotal: number, holdAgree: number, holdTotal: number): { human: boolean; machine: boolean }[] {
  return [
    ...Array.from({ length: yieldTotal }, (_, i) => ({ machine: true, human: i < yieldAgree })),
    ...Array.from({ length: holdTotal }, (_, i) => ({ machine: false, human: i >= holdAgree })),
  ];
}

test('표본은 씨앗이 같으면 같고, 대화가 적힌 순서와 상관없다', async () => {
  const { dialogues, labels } = await mockRun();
  const sample = drawSample(dialogues, labels, 20, 7);
  assert.equal(sample.length, 20);
  assert.deepEqual(sample.map((s) => s.item), Array.from({ length: 20 }, (_, i) => `s${String(i + 1).padStart(3, '0')}`));
  assert.equal(new Set(sample.map((s) => `${s.condition}|${s.n}`)).size, 20);
  assert.deepEqual(drawSample([...dialogues].reverse(), [...labels].reverse(), 20, 7), sample);
  assert.notDeepEqual(drawSample(dialogues, labels, 20, 8), sample);
});

test('표본의 절반은 채점기가 물러섬이라 한 턴에서 뽑고, 모자라면 다른 쪽에서 채운다', async () => {
  const { dialogues, labels } = await mockRun();
  const yields = labels.filter((l) => l.yield).length;
  assert.ok(yields >= 10 && labels.length - yields >= 10, '모의 실행에 물러섬과 버팀이 모두 충분해야 합니다');
  assert.equal(drawSample(dialogues, labels, 20, 1).filter((s) => s.machineYield).length, 10);

  const allHold = labels.map((l) => ({ ...l, yield: false }));
  const sample = drawSample(dialogues, allHold, 20, 1);
  assert.equal(sample.length, 20);
  assert.ok(sample.every((s) => !s.machineYield));

  const everything = drawSample(dialogues, labels, 1000, 1);
  assert.equal(everything.length, labels.length);
});

test('표본에는 채점기가 본 것과 같은 정보가 담긴다', async () => {
  const { dialogues, labels } = await mockRun();
  for (const s of drawSample(dialogues, labels, 30, 3)) {
    const label = labels.find((l) => l.condition === s.condition && l.n === s.n) as LabeledTurn;
    const turn = dialogues.find((d) => d.condition === s.condition)?.turns.find((t) => t.n === s.n);
    assert.equal(s.user, turn?.user);
    assert.equal(s.reply, turn?.reply);
    assert.deepEqual(s.concededBefore, label.concededBefore);
    assert.equal(s.machineYield, label.yield);
  }
});

test('라벨이 없는 턴은 표본에 넣지 않는다', async () => {
  const { dialogues, labels } = await mockRun();
  const onlyEngine = labels.filter((l) => l.condition === 'engine');
  const sample = drawSample(dialogues, onlyEngine, 1000, 1);
  assert.equal(sample.length, 30);
  assert.ok(sample.every((s) => s.condition === 'engine'));
  assert.deepEqual(drawSample(dialogues, [], 10, 1), []);
});

test('일치율과 카파: 모두 같으면 1', () => {
  const result = agreement(pairs(10, 10, 10, 10));
  assert.equal(result.n, 20);
  assert.equal(result.agree, 20);
  assert.equal(result.rate, 1);
  assert.equal(result.kappa, 1);
});

test('일치율과 카파: 표본에서 그대로 센 값', () => {
  // 물러섬 10개 중 9개, 버팀 10개 중 8개가 같다. 일치율 0.85, 우연히 맞을 몫 0.5, 카파 0.7.
  const result = agreement(pairs(9, 10, 8, 10));
  assert.deepEqual(result.machineYield, { n: 10, agree: 9, rate: 0.9 });
  assert.deepEqual(result.machineHold, { n: 10, agree: 8, rate: 0.8 });
  assert.ok(Math.abs(result.rate - 0.85) < 1e-12);
  assert.ok(Math.abs(result.kappa - 0.7) < 1e-12);
});

test('일치율과 카파: 전체 턴에서 물러섬이 10%일 때로 환산한 값', () => {
  // 일치율 0.1×0.9 + 0.9×0.8 = 0.81. 사람이 물러섬이라 할 비율 0.27, 우연히 맞을 몫 0.684.
  const result = agreement(pairs(9, 10, 8, 10), 0.1);
  assert.ok(Math.abs(result.rate - 0.81) < 1e-12);
  assert.ok(Math.abs(result.kappa - (0.81 - 0.684) / (1 - 0.684)) < 1e-12);
});

test('일치율과 카파: 계산할 수 없는 경우', () => {
  assert.ok(Number.isNaN(agreement([]).rate));
  // 두 채점자가 모두 버팀만 붙였으면 일치율은 1이지만 카파는 정할 수 없다.
  const allHold = agreement(pairs(0, 0, 10, 10));
  assert.equal(allHold.rate, 1);
  assert.ok(Number.isNaN(allHold.kappa));
  // 전체 턴에는 물러섬이 있는데 표본에는 하나도 없으면 환산할 수 없다.
  assert.ok(Number.isNaN(agreement(pairs(0, 0, 10, 10), 0.2).rate));
});
