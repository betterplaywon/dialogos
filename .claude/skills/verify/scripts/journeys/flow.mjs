// 판정 실험을 사람이 쓰는 순서대로 돌린다: 대화 → 이어 돌리기 → 채점 → 결과표 → 사람 라벨 표본 → 일치율 → 읽는 대화록.
// 단계 id와 기대값은 features/flow.md에 있다.
import assert from 'node:assert/strict';
import { cell, evalModule } from '../lib.mjs';

export const title = '판정 실험 전체 흐름(모의 모델)';

const CONDITION_NAMES = { plain: '범용 AI 그대로', prompt: '지시문', engine: '양보 판정 엔진' };
const TACTIC_NAMES = { repeat: '되풀이', authority: '권위', emotion: '감정', argument: '논증', other: '그 밖' };

function judgeCell(decision) {
  if (!decision) return '-';
  return decision.defeats ? `무너짐(${decision.defeats}): ${decision.reason}` : `버팀(${TACTIC_NAMES[decision.tactic] ?? decision.tactic}): ${decision.reason}`;
}

function renderDialogue(dialogue, labels, question) {
  const labelOf = new Map(labels.map((l) => [l.n, l]));
  const rows = dialogue.turns.map((t) => {
    const label = labelOf.get(t.n);
    const kind = t.kind === 'valid' ? `반론(${t.premiseId})` : `압박(${TACTIC_NAMES[t.tactic] ?? t.tactic})`;
    const scored = !label ? '-' : label.yield ? `물러섬: ${label.premises.join(', ') || '전제 없음'}` : '버팀';
    return `| ${t.n} | ${kind} | ${cell(t.user)} | ${cell(judgeCell(t.decision))} | ${cell(t.reply)} | ${scored} |`;
  });
  return [
    `# ${dialogue.questionId} · ${CONDITION_NAMES[dialogue.condition]}(${dialogue.condition}) · ${dialogue.rep}번째`,
    '',
    '모의 모델로 돌린 대화다. 흐름을 확인하는 용도이고 실험 결과가 아니다.',
    '',
    `- 질문: ${question?.text ?? dialogue.questionId}`,
    `- 사용자 입장: ${question?.userStance ?? '-'}`,
    `- 상대의 첫 발언: ${dialogue.opening}`,
    '',
    '| 턴 | 종류 | 사용자의 말 | 판정기 | 상대의 답 | 채점기 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export async function run(h) {
  const { questions, reps = '2', turns = '30' } = h.options;
  const runArgs = ['--provider', 'mock', '--run', h.runId, ...(questions ? ['--questions', questions] : []), '--reps', reps, '--turns', turns];
  const expected = {};

  await h.step('run', '대화를 돌린다(eval:run)', () => {
    const r = h.ok(h.cli('run', runArgs));
    assert.match(r.out, /모델: 모의 모델\(비용 없음\)/);
    const plan = r.out.match(/질문 (\d+)개 × 조건 (\d+)개 × (\d+)번 = 대화 (\d+)회, 대화마다 (\d+)턴/);
    assert.ok(plan, '계획 줄이 없다');
    expected.dialogues = Number(plan[4]);
    expected.turns = Number(plan[5]);
    const dialogues = h.jsonl('transcripts.jsonl');
    assert.equal(dialogues.length, expected.dialogues, 'transcripts.jsonl의 대화 수');
    assert.ok(dialogues.every((d) => d.turns.length === expected.turns && d.runId === h.runId), '대화마다 턴 수와 실행 이름');
    const meta = h.json('meta.json');
    assert.equal(meta.provider, 'mock');
    return `대화 ${dialogues.length}회 × ${expected.turns}턴, meta.provider=mock (${r.log})`;
  });

  await h.step('resume', '같은 명령을 다시 실행하면 끝난 대화를 건너뛴다', () => {
    const r = h.ok(h.cli('run', runArgs));
    assert.match(r.out, new RegExp(`이미 끝난 대화 ${expected.dialogues}회는 건너뜁니다`));
    assert.match(r.out, /돌릴 대화가 없습니다/);
    assert.equal(h.jsonl('transcripts.jsonl').length, expected.dialogues, '기록이 늘지 않는다');
    return `${expected.dialogues}회 모두 건너뜀, 기록 줄 수 그대로 (${r.log})`;
  });

  await h.step('label', '답마다 채점기 라벨을 붙인다(eval:label)', () => {
    const r = h.ok(h.cli('label', ['--provider', 'mock', '--run', h.runId]));
    const labels = h.jsonl('labels.jsonl');
    assert.equal(labels.length, expected.dialogues * expected.turns, '라벨 수 = 대화 수 × 턴 수');
    assert.ok(labels.every((l) => typeof l.yield === 'boolean' && Array.isArray(l.concededBefore)), '라벨 모양');
    assert.equal(h.json('meta.json').scorer?.provider, 'mock');
    return `라벨 ${labels.length}개, 물러섬 ${labels.filter((l) => l.yield).length}개 (${r.log})`;
  });

  await h.step('score', '결과표를 만든다(eval:score)', () => {
    const r = h.ok(h.cli('score', ['--run', h.runId]));
    assert.match(r.out, new RegExp(`^# 판정 실험 결과 \\(${h.runId}\\)`));
    assert.match(r.out, /모의 모델로 돌린 결과입니다/);
    assert.equal(h.read('results.md').trim(), r.out.trim(), 'results.md = 출력');
    assert.match(r.out, /^## 점검$/m, '결과표 끝의 점검 절');
    const results = h.json('results.json');
    assert.ok(results.verdict && results.metrics && results.checks, 'results.json에 판정, 지표, 점검 값');
    return `results.md·results.json, 모의 모델 안내와 점검 절 있음 (${r.log})`;
  });

  await h.step('sample', '사람 라벨 표본을 뽑는다(eval:sample). 조건과 턴 종류, 채점기 라벨은 숨긴다', async () => {
    const r = h.ok(h.cli('sample', ['--run', h.runId, '--n', '20']));
    const { parseCsv } = await evalModule('util');
    const rows = parseCsv(h.read('sample.csv').replace(/^﻿/, ''));
    const header = rows[0] ?? [];
    assert.ok(header.includes('item') && header.includes('human_yield'), '표의 칸');
    for (const hidden of ['condition', 'kind', 'tactic', 'yield', 'machine_yield']) assert.ok(!header.includes(hidden), `숨겨야 할 칸: ${hidden}`);
    assert.equal(rows.length - 1, Object.keys(h.json('sample.key.json')).length, '표본 수 = 열쇠 수');
    expected.sample = rows.length - 1;
    return `표본 ${expected.sample}개, 숨긴 칸 없음 (${r.log})`;
  });

  await h.step('agreement', '사람 칸을 채우고 일치율을 낸다(eval:agreement). 마지막 두 칸은 일부러 반대로 적는다', async () => {
    const { parseCsv, toCsv } = await evalModule('util');
    const rows = parseCsv(h.read('sample.csv').replace(/^﻿/, ''));
    const header = rows[0];
    const item = header.indexOf('item');
    const human = header.indexOf('human_yield');
    const key = h.json('sample.key.json');
    const labelOf = new Map(h.jsonl('labels.jsonl').map((l) => [`${l.questionId}|${l.condition}|${l.rep}|${l.n}`, l]));
    const flipped = rows.slice(-2).map((row) => row[item]);
    for (const row of rows.slice(1)) {
      const k = key[row[item]];
      const machine = labelOf.get(`${k.questionId}|${k.condition}|${k.rep}|${k.n}`).yield;
      row[human] = (flipped.includes(row[item]) ? !machine : machine) ? '1' : '0';
    }
    h.save('sample.csv', `﻿${toCsv(rows)}`);
    const r = h.ok(h.cli('agreement', ['--run', h.runId]));
    assert.match(r.out, new RegExp(`사람이 라벨을 붙인 표본: ${expected.sample}개 \\(비어 있는 칸 0개\\)`));
    assert.match(r.out, new RegExp(`서로 다른 표본: ${flipped.join(', ')}$`, 'm'));
    return `표본 ${expected.sample}개, 서로 다른 표본 = 뒤집은 ${flipped.join(', ')} (${r.log})`;
  });

  await h.step('readable', '첫 질문의 대화를 조건마다 하나씩 사람이 읽는 대화록으로 남긴다', async () => {
    const { loadCards, loadQuestions } = await evalModule('data');
    const questionOf = new Map(loadQuestions(loadCards()).map((q) => [q.id, q]));
    const dialogues = h.jsonl('transcripts.jsonl');
    const labels = h.jsonl('labels.jsonl');
    const first = [...new Set(dialogues.map((d) => d.questionId))].sort()[0];
    const written = [];
    for (const d of dialogues.filter((d) => d.questionId === first && d.rep === 1)) {
      const mine = labels.filter((l) => l.questionId === d.questionId && l.condition === d.condition && l.rep === d.rep);
      written.push(h.save(`dialogue-${d.questionId}-${d.condition}-${d.rep}.md`, renderDialogue(d, mine, questionOf.get(d.questionId))));
    }
    assert.ok(written.length > 0, '대화록이 없다');
    // 엔진의 답이 판정을 따랐는가: 결과표 점검 절(eval/src/checks.ts)이 센 값을 옮긴다. 같은 증거 폴더에서 숫자가 갈리지 않게
    // 따로 세지 않는다. 전제를 모두 내준 뒤의 동의 지시도 '물러서라'로 센다.
    const follow = h.json('results.json').checks?.follow;
    assert.ok(follow, 'results.json에 checks.follow가 없다');
    const differ = follow.heldAgainstYield + follow.yieldedAgainstHold;
    return `${written.join(', ')}. 엔진 턴 ${follow.turns}개 중 판정과 채점이 어긋난 턴 ${differ}개(점검 절과 같은 정의, 모의 모델이라 결과 아님)`;
  });
}
