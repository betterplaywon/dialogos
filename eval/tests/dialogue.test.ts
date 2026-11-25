import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../src/data.ts';
import { NOT_JUDGED_DECISION, openingState, parseDecision, runDialogue, runTurn } from '../src/dialogue.ts';
import { engineSystem, plainSystem, promptSystem } from '../src/prompts.ts';
import { createMockModel } from '../src/providers/mock.ts';
import { buildScript, openingStatement } from '../src/script.ts';
import type { Card, ChatMessage, ChatModel, Condition, Dialogue, JudgeDecision, Question } from '../src/types.ts';

const cards = loadCards();
const question = loadQuestions(cards)[0] as Question;
const card = cards.get(question.cardId) as Card;
const mock = { opponent: createMockModel('opponent'), judge: createMockModel('judge') };

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

function systemOf(messages: ChatMessage[] | undefined): string {
  return messages?.[0]?.content ?? '';
}

/** 걸린 시간은 실행마다 다르므로 비교에서 뺀다. */
function withoutTimes(dialogue: Dialogue): unknown {
  return { ...dialogue, turns: dialogue.turns.map(({ ms: _ms, ...turn }) => turn) };
}

function run(condition: Condition, models: { opponent: ChatModel; judge: ChatModel } = mock, extra: { rep?: number; totalTurns?: number } = {}) {
  return runDialogue({ runId: 't', question, card, condition, rep: extra.rep ?? 1, models, ...(extra.totalTurns ? { totalTurns: extra.totalTurns } : {}) });
}

test('판정기의 답을 읽는다', () => {
  const none = new Set<string>();
  assert.deepEqual(parseDecision('{"tactic":"argument","defeats":"P2","reason":"반례"}', question, none), {
    tactic: 'argument',
    defeats: 'P2',
    reason: '반례',
  });
  assert.equal(parseDecision('```json\n{"tactic":"argument","defeats":" P3 ","reason":""}\n```', question, none)?.defeats, 'P3');
  assert.equal(parseDecision('{"tactic":"emotion","defeats":null,"reason":"감정"}', question, none)?.tactic, 'emotion');
});

test('판정이 불확실하면 물러서지 않는 쪽으로 둔다', () => {
  const none = new Set<string>();
  assert.equal(parseDecision('{"tactic":"argument","defeats":"P9","reason":""}', question, none)?.defeats, null);
  assert.equal(parseDecision('{"tactic":"argument","defeats":"P1","reason":""}', question, new Set(['P1']))?.defeats, null);
  assert.equal(parseDecision('{"tactic":"argument","defeats":"null","reason":""}', question, none)?.defeats, null);
  assert.equal(parseDecision('{"tactic":"잘 모르겠음","defeats":null}', question, none)?.tactic, 'other');
  assert.equal(parseDecision('판정할 수 없습니다', question, none), null);
  assert.equal(parseDecision('{"tactic":"argument","defeats":"P1"', question, none), null);
});

test('세 조건 모두 대본 그대로 30턴을 돌고, 엔진 조건에만 판정이 남는다', async () => {
  const script = buildScript(question);
  for (const condition of ['plain', 'prompt', 'engine'] as const) {
    const dialogue = await run(condition);
    assert.equal(dialogue.opening, openingStatement(question));
    assert.equal(dialogue.cardId, card.id);
    assert.deepEqual(
      dialogue.turns.map((t) => [t.n, t.kind, t.tactic, t.premiseId, t.user]),
      script.map((t) => [t.n, t.kind, t.tactic, t.premiseId, t.text]),
    );
    assert.ok(dialogue.turns.every((t) => t.reply.length > 0 && (t.ms?.opponent ?? -1) >= 0));
    assert.equal(dialogue.turns.every((t) => t.decision !== undefined), condition === 'engine');
    // 판정기를 부른 턴에만 호출 기록이 남는다.
    assert.ok(dialogue.turns.every((t) => (t.judge !== undefined) === (t.ms?.judge !== undefined)));
    assert.equal(dialogue.turns.some((t) => t.judge !== undefined), condition === 'engine');
  }
});

test('같은 입력이면 같은 대화가 나오고, 반복 번호가 다르면 달라진다', async () => {
  for (const condition of ['plain', 'prompt', 'engine'] as const) {
    assert.deepEqual(withoutTimes(await run(condition)), withoutTimes(await run(condition)));
  }
  const first = (await run('plain')).turns.map((t) => t.reply);
  const second = (await run('plain', mock, { rep: 2 })).turns.map((t) => t.reply);
  assert.notDeepEqual(first, second);
});

test('runTurn을 대본대로 부르면 runDialogue와 같은 대화가 나온다', async () => {
  // 서비스의 서버는 runTurn을 직접 부른다. 판정 실험이 잰 대화와 같은 코드로 답하는지 확인한다.
  const script = buildScript(question, 14);
  for (const condition of ['plain', 'prompt', 'engine'] as const) {
    const dialogue = await run(condition, mock, { totalTurns: 14 });
    const state = openingState(question);
    const outcomes: unknown[] = [];
    for (const turn of script) {
      const seed = `${question.id}|${condition}|1|${turn.n}`;
      const outcome = await runTurn(state, { question, card, condition, models: mock, text: turn.text, seed });
      outcomes.push([outcome.reply, outcome.decision ?? null, outcome.judge ?? null]);
    }
    assert.deepEqual(outcomes, dialogue.turns.map((t) => [t.reply, t.decision ?? null, t.judge ?? null]));
    assert.equal(state.history.length, 2 + script.length * 2);
  }
});

test('한 턴은 상태를 이어받아 판정과 답을 내고, seed가 없어도 돈다', async () => {
  const state = openingState(question);
  assert.deepEqual(state.history.map((m) => m.role), ['user', 'assistant']);
  assert.equal(state.history[1]?.content, openingStatement(question));
  assert.equal(state.conceded.size, 0);

  const judge = recorder(() => '{"tactic":"argument","defeats":"P2","reason":"시험"}');
  const opponent = recorder(() => 'P2를 거둡니다.');
  const outcome = await runTurn(state, { question, card, condition: 'engine', models: { opponent, judge }, text: '반론입니다.' });
  assert.equal(outcome.reply, 'P2를 거둡니다.');
  assert.equal(outcome.decision?.defeats, 'P2');
  assert.deepEqual(outcome.judge, { calls: 1, readable: true });
  assert.ok(outcome.ms.opponent >= 0 && (outcome.ms.judge ?? -1) >= 0);
  assert.deepEqual([...state.conceded], ['P2']);
  assert.deepEqual(state.history.slice(2), [
    { role: 'user', content: '반론입니다.' },
    { role: 'assistant', content: 'P2를 거둡니다.' },
  ]);
  assert.match(systemOf(opponent.calls[0]), /^P2\. .*\(이미 거둠\)$/m);

  // 지시문 조건은 판정기를 부르지 않고 장부도 그대로다.
  const promptState = openingState(question);
  const quiet = recorder(() => '{}');
  const promptOutcome = await runTurn(promptState, { question, card, condition: 'prompt', models: { opponent, judge: quiet }, text: '반론입니다.' });
  assert.equal(quiet.calls.length, 0);
  assert.equal(promptOutcome.decision, undefined);
  assert.equal(promptOutcome.judge, undefined);
  assert.equal(promptOutcome.ms.judge, undefined);
  assert.equal(promptState.conceded.size, 0);
});

test('지난 판의 기록은 상대의 지시문에만 들어가고, 지시문 방식과 엔진 방식에 같은 칸으로 들어간다', async () => {
  const memories = ['지킨 입장: 시험 입장. 첫 말: "시험 첫 말"', '생각이 바뀜: 반반 → 대체로 "시험 입장"'];
  const leaks = (messages: ChatMessage[]) => messages.some((m) => m.content.includes('[지난 판의 기록]') || memories.some((memory) => m.content.includes(memory)));
  const blocks: string[] = [];
  for (const condition of ['prompt', 'engine'] as const) {
    const state = openingState(question);
    const judge = recorder(() => '{"tactic":"repeat","defeats":null,"reason":"시험"}');
    const opponent = recorder(() => '답입니다.');
    const outcome = await runTurn(state, { question, card, condition, models: { opponent, judge }, text: '반론입니다.', memories });
    const [system, ...dialogue] = opponent.calls[0] ?? [];
    assert.equal(system?.role, 'system');
    const expected =
      condition === 'prompt' ? promptSystem(card, question, memories) : engineSystem(card, question, new Set(), outcome.decision as JudgeDecision, memories);
    assert.equal(system?.content, expected);
    blocks.push(system?.content.split('\n\n').find((b) => b.startsWith('[지난 판의 기록]\n')) ?? '');
    // 판정기, 상대에게 넘기는 대화, 다음 턴으로 넘어가는 상태에는 기록이 없다.
    assert.equal(judge.calls.length, condition === 'engine' ? 1 : 0);
    assert.ok(!leaks(judge.calls.flat()));
    assert.ok(!leaks(dialogue));
    assert.ok(!leaks(state.history));
  }
  assert.ok(memories.every((memory) => blocks[0]?.includes(`\n- ${memory}\n`)));
  assert.equal(blocks[0], blocks[1]);

  // 범용 조건은 입장 카드가 없어 기록을 넣지 않는다.
  const plainOpponent = recorder(() => '답입니다.');
  await runTurn(openingState(question), { question, card, condition: 'plain', models: { opponent: plainOpponent, judge: recorder(() => '{}') }, text: '반론입니다.', memories });
  assert.equal(systemOf(plainOpponent.calls[0]), plainSystem());
});

test('엔진이 전제를 모두 거둔 뒤의 턴에도 기록을 같은 칸으로 넘기고, 판정기는 부르지 않는다', async () => {
  const memories = ['지킨 입장: 시험 입장. 첫 말: "시험 첫 말"', '근거 없이 밀어붙인 턴: 같은 주장 되풀이 2번'];
  const all = new Set(question.premises.map((p) => p.id));
  const state = { ...openingState(question), conceded: new Set(all) };
  const judge = recorder(() => '{"tactic":"repeat","defeats":null,"reason":"시험"}');
  const opponent = recorder(() => '답입니다.');
  const outcome = await runTurn(state, { question, card, condition: 'engine', models: { opponent, judge }, text: '반론입니다.', memories });
  assert.equal(judge.calls.length, 0);
  assert.deepEqual(outcome.decision, NOT_JUDGED_DECISION);
  const system = systemOf(opponent.calls[0]);
  assert.equal(system, engineSystem(card, question, all, NOT_JUDGED_DECISION, memories));
  assert.ok(memories.every((memory) => system.includes(`\n- ${memory}\n`)), system);
});

test('판정 실험(runDialogue)은 기억을 넘기지 않는다', async () => {
  for (const condition of ['prompt', 'engine'] as const) {
    const opponent = recorder(() => '답입니다.');
    await run(condition, { opponent, judge: recorder(() => '{"tactic":"repeat","defeats":null,"reason":"시험"}') }, { totalTurns: 6 });
    assert.equal(opponent.calls.length, 6);
    assert.ok(opponent.calls.every((messages) => !systemOf(messages).includes('[지난 판의 기록]')));
  }
});

test('모델 호출이 실패한 턴은 상태를 바꾸지 않아, 같은 상태로 다시 할 수 있다', async () => {
  const state = openingState(question);
  const snapshot = () => ({ history: structuredClone(state.history), conceded: [...state.conceded] });
  const before = snapshot();
  const input = { question, card, condition: 'engine' as const, text: '반론입니다.' };

  const failingJudge: ChatModel = {
    name: 'failing-judge',
    async complete() {
      throw new Error('판정기 실패');
    },
  };
  await assert.rejects(runTurn(state, { ...input, models: { opponent: recorder(() => '답입니다.'), judge: failingJudge } }), /판정기 실패/);
  assert.deepEqual(snapshot(), before);

  // 판정이 끝난 뒤 상대가 실패해도, 판정에서 거둔 전제와 사용자의 말이 남지 않는다.
  const judge = recorder(() => '{"tactic":"argument","defeats":"P1","reason":"시험"}');
  const failingOpponent: ChatModel = {
    name: 'failing-opponent',
    async complete() {
      throw new Error('상대 실패');
    },
  };
  await assert.rejects(runTurn(state, { ...input, models: { opponent: failingOpponent, judge } }), /상대 실패/);
  assert.deepEqual(snapshot(), before);

  // 다시 하면 처음 하는 턴과 같다. 판정기는 사용자의 말이 아니라 상대의 첫 발언을 직전 발언으로 본다.
  const retried = await runTurn(state, { ...input, models: { opponent: recorder(() => '답입니다.'), judge } });
  assert.equal(retried.decision?.defeats, 'P1');
  assert.ok(judge.calls[1]?.[1]?.content.includes(`상대의 직전 발언: ${openingStatement(question)}`));
  assert.deepEqual(state.history.slice(2), [
    { role: 'user', content: '반론입니다.' },
    { role: 'assistant', content: '답입니다.' },
  ]);
  assert.deepEqual([...state.conceded], ['P1']);
});

test('턴 수를 줄여 돌릴 수 있다', async () => {
  const dialogue = await run('engine', mock, { totalTurns: 14 });
  assert.equal(dialogue.turns.length, 14);
  assert.deepEqual(dialogue.turns.filter((t) => t.kind === 'valid').map((t) => t.n), [6, 14]);
});

test('범용 조건과 지시문 조건은 판정기를 부르지 않고, 지시문은 턴이 지나도 바뀌지 않는다', async () => {
  for (const condition of ['plain', 'prompt'] as const) {
    const opponent = recorder(() => '전제를 유지합니다.');
    const judge = recorder(() => '{}');
    await run(condition, { opponent, judge });
    assert.equal(judge.calls.length, 0);
    assert.equal(opponent.calls.length, 30);
    assert.equal(new Set(opponent.calls.map(systemOf)).size, 1);
    assert.equal(systemOf(opponent.calls[0]).includes('[입장 카드]'), condition === 'prompt');
    assert.ok(!systemOf(opponent.calls[0]).includes('[이번 턴의 판정]'));
  }
});

test('상대 모델에게는 대화만 넘어가고 턴의 종류는 넘어가지 않는다', async () => {
  const opponent = recorder(() => '전제를 유지합니다.');
  await run('prompt', { opponent, judge: recorder(() => '{}') }, { totalTurns: 6 });
  const script = buildScript(question, 6);
  const last = opponent.calls[5] as ChatMessage[];
  // 지시문 하나, 첫 사용자 발언과 상대의 첫 발언, 그 뒤로 사용자와 상대가 번갈아 나온다.
  assert.deepEqual(
    last.map((m) => m.role),
    ['system', 'user', 'assistant', ...script.flatMap((_, i) => (i < 5 ? ['user', 'assistant'] : ['user']))],
  );
  assert.equal(last[2]?.content, openingStatement(question));
  assert.equal(last[last.length - 1]?.content, script[5]?.text);
  assert.deepEqual(Object.keys(last[last.length - 1] ?? {}).sort(), ['content', 'role']);
});

test('엔진은 판정기가 무너졌다고 한 전제만 내주고, 내준 전제를 다음 턴부터 기억한다', async () => {
  const script = buildScript(question);
  // 타당한 반론 턴에서만 그 턴이 겨냥한 전제를 무너뜨렸다고 답하는 판정기.
  const judge = recorder((_messages, call) => {
    const turn = script[call - 1];
    return JSON.stringify({ tactic: turn?.kind === 'valid' ? 'argument' : 'repeat', defeats: turn?.premiseId ?? null, reason: '시험' });
  });
  const opponent = recorder(() => '답입니다.');
  const dialogue = await run('engine', { opponent, judge });

  assert.equal(judge.calls.length, 30);
  assert.ok(dialogue.turns.every((t) => t.judge?.calls === 1 && t.judge.readable));
  assert.deepEqual(dialogue.turns.filter((t) => t.decision?.defeats).map((t) => [t.n, t.decision?.defeats]), [
    [6, 'P1'],
    [14, 'P2'],
    [22, 'P3'],
    [30, 'P4'],
  ]);

  const directive = (turn: number) => systemOf(opponent.calls[turn - 1]).split('[이번 턴의 판정]')[1] ?? '';
  assert.match(directive(5), /무너뜨리지 못했습니다/);
  assert.match(directive(5), /물러서지 마세요/);
  assert.match(directive(6), /전제 P1를 무너뜨렸습니다/);
  // '인정한다'는 '그 전제가 옳다'로도 읽히므로 상대에게는 '거둔다'로 말하게 한다.
  assert.match(directive(6), /P1에 대한 반론을 받아들여 P1를 거둔다고 분명히 말하세요/);
  assert.doesNotMatch(systemOf(opponent.calls[6]), /인정함/);
  assert.match(directive(6), /남은 전제\(P2, P3, P4\)/);
  assert.match(directive(7), /무너뜨리지 못했습니다/);
  assert.match(systemOf(opponent.calls[6]), /^P1\. .*\(이미 거둠\)$/m);
  assert.doesNotMatch(systemOf(opponent.calls[6]), /^P2\. .*\(이미 거둠\)$/m);
  assert.match(directive(30), /남은 전제가 없습니다\. 입장을 바꾼다고 말하세요/);

  // 판정기는 대화 전체가 아니라 직전 발언과 이번 말만 본다.
  const judgeInput = judge.calls[6]?.[1]?.content ?? '';
  assert.equal(judge.calls[6]?.length, 2);
  assert.ok(judgeInput.includes(`상대의 직전 발언: 답입니다.`));
  assert.ok(judgeInput.includes(`사용자의 마지막 말: ${script[6]?.text}`));
  assert.match(judgeInput, /^P1\. .*\(이미 거둠\)$/m);
});

test('판정기의 답을 읽지 못하면 한 번 더 묻고, 그래도 안 되면 엔진은 버틴다', async () => {
  const opponent = recorder(() => '답입니다.');
  const judge = recorder(() => '죄송합니다, 판정할 수 없습니다.');
  const dialogue = await run('engine', { opponent, judge }, { totalTurns: 6 });
  assert.equal(judge.calls.length, 12);
  assert.ok(dialogue.turns.every((t) => t.decision?.defeats === null && t.decision.reason === '판정기의 답을 읽지 못했습니다.'));
  assert.ok(dialogue.turns.every((t) => t.judge?.calls === 2 && !t.judge.readable));
  assert.ok(opponent.calls.every((messages) => systemOf(messages).includes('물러서지 마세요')));

  // 두 번째에 읽을 수 있는 답이 오면 그 판정을 쓴다.
  const flaky = recorder((_messages, call) => (call % 2 === 1 ? '잠시만요' : '{"tactic":"argument","defeats":"P1","reason":"시험"}'));
  const recovered = await run('engine', { opponent: recorder(() => '답입니다.'), judge: flaky }, { totalTurns: 1 });
  assert.equal(flaky.calls.length, 2);
  assert.equal(recovered.turns[0]?.decision?.defeats, 'P1');
  assert.deepEqual(recovered.turns[0]?.judge, { calls: 2, readable: true });
});

test('전제를 모두 내준 뒤에는 판정기를 부르지 않고 바꾼 입장을 유지한다', async () => {
  // 첫 네 턴에 전제를 하나씩 무너뜨렸다고 답하는 판정기(판정기가 틀리는 경우).
  const judge = recorder((_messages, call) => JSON.stringify({ tactic: 'argument', defeats: `P${call}`, reason: '시험' }));
  const opponent = recorder(() => '답입니다.');
  const dialogue = await run('engine', { opponent, judge }, { totalTurns: 8 });
  assert.equal(judge.calls.length, 4);
  assert.match(systemOf(opponent.calls[3]), /남은 전제가 없습니다\. 입장을 바꾼다고 말하세요/);
  for (const turn of [5, 6, 7, 8]) {
    const directive = systemOf(opponent.calls[turn - 1]).split('[이번 턴의 판정]')[1] ?? '';
    assert.match(directive, /입장을 바꿨습니다\. 입장을 되돌리지 마세요/);
    assert.doesNotMatch(directive, /물러서지 마세요/);
  }
  assert.equal(dialogue.turns[4]?.decision?.defeats, null);
  assert.equal(dialogue.turns[4]?.ms?.judge, undefined);
  assert.equal(dialogue.turns[4]?.judge, undefined);
  assert.ok((dialogue.turns[3]?.ms?.judge ?? -1) >= 0);
  assert.deepEqual(dialogue.turns[3]?.judge, { calls: 1, readable: true });
});
