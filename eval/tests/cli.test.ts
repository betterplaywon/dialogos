// 명령을 실제로 실행해 전체 흐름을 검사한다. 결과는 임시 폴더에 쓰고, 모의 모델만 쓴다.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Dialogue, LabeledTurn } from '../src/types.ts';
import { parseCsv, toCsv } from '../src/util.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNS = mkdtempSync(join(tmpdir(), 'dialogos-runs-'));

// 실제 모델에 연결되는 일이 없도록 연결 정보를 지운 환경에서 실행한다.
const env: NodeJS.ProcessEnv = { ...process.env, EVAL_RUNS_DIR: RUNS };
for (const name of Object.keys(env)) {
  if (/^(LLM|OPPONENT|JUDGE|SCORER)_/.test(name)) delete env[name];
}

function cli(script: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join('eval', 'src', `${script}.ts`), ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function ok(script: string, ...args: string[]): string {
  const result = cli(script, ...args);
  assert.equal(result.code, 0, `${script} ${args.join(' ')}\n${result.out}\n${result.err}`);
  return result.out;
}

function lines<T>(run: string, file: string): T[] {
  return readFileSync(join(RUNS, run, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

test('모의 실행: 대화, 채점, 결과표, 사람 라벨 대조까지 이어진다', () => {
  const run = ok('run', '--provider', 'mock', '--run', 'flow', '--questions', 'q01,q02', '--turns', '14');
  assert.match(run, /질문 2개 × 조건 3개 × 2번 = 대화 12회, 대화마다 14턴/);
  assert.match(run, /상대 모델 호출 168회, 판정기 호출 56회 \(판정을 읽지 못한 턴은 다시 불러 최대 112회\)/);
  assert.match(run, /^판정기: 부른 턴 \d+, 끝내 읽지 못한 판정 0, 읽지 못해 다시 부른 호출 0$/m);
  const dialogues = lines<Dialogue>('flow', 'transcripts.jsonl');
  assert.equal(dialogues.length, 12);
  assert.ok(dialogues.every((d) => d.turns.length === 14 && d.runId === 'flow'));
  const meta = JSON.parse(readFileSync(join(RUNS, 'flow', 'meta.json'), 'utf8'));
  assert.deepEqual([meta.provider, meta.questions, meta.conditions, meta.reps, meta.turns], ['mock', ['q01', 'q02'], ['plain', 'prompt', 'engine'], 2, 14]);

  assert.match(ok('label', '--run', 'flow', '--provider', 'mock'), /이번에 채점할 대화 12회, 채점기 호출 168회/);
  const labels = lines<LabeledTurn>('flow', 'labels.jsonl');
  assert.equal(labels.length, 168);

  const score = ok('score', '--run', 'flow');
  assert.match(score, /^# 판정 실험 결과 \(flow\)/);
  assert.match(score, /모의 모델로 돌린 결과입니다/);
  assert.match(score, /^\| 양보 판정 엔진 \| 4 \|/m);
  assert.match(score, /질문 2개 가운데 값이 같은 \d개를 빼면 \d개라 10개에 못 미쳐 판정할 수 없습니다/);
  assert.equal(readFileSync(join(RUNS, 'flow', 'results.md'), 'utf8').trim(), score.trim());
  const results = JSON.parse(readFileSync(join(RUNS, 'flow', 'results.json'), 'utf8'));
  assert.equal(results.metrics.engine.unwarranted.den, 4 * 12);
  // 결과표 끝에 통과 기준에 쓰지 않는 점검 절이 붙는다. 모의 모델은 토큰을 기록하지 않는다.
  assert.match(score, /^## 점검$/m);
  assert.match(score, /토큰은 실제 모델로 돌린 실행에만 기록됩니다/);
  assert.equal(results.checks.judge.dialogues, 4);
  assert.equal(results.checks.follow.turns, 4 * 14);
  assert.deepEqual(results.checks.usage, { roles: {} });

  assert.match(ok('sample', '--run', 'flow', '--n', '30'), /표본 30개/);
  const csvPath = join(RUNS, 'flow', 'sample.csv');
  const csv = readFileSync(csvPath, 'utf8');
  assert.ok(csv.startsWith('﻿'));
  const rows = parseCsv(csv.slice(1));
  assert.deepEqual(rows[0], ['item', 'question', 'user_stance', 'opponent_stance', 'opponent_premises', 'user', 'reply', 'human_yield', 'human_premises']);
  const yieldColumn = (rows[0] as string[]).indexOf('human_yield');
  assert.equal(rows.length, 31);
  // 사람이 볼 표에는 조건, 턴의 종류, 채점기의 라벨이 없어야 한다.
  assert.doesNotMatch(csv, /engine|prompt|plain|pressure|valid/);

  assert.match(ok('agreement', '--run', 'flow'), /사람이 라벨을 붙인 표본: 0개 \(비어 있는 칸 30개\)/);

  // 사람이 채점기와 한 곳만 다르게 붙였다고 하고 채운다.
  const key = JSON.parse(readFileSync(join(RUNS, 'flow', 'sample.key.json'), 'utf8')) as Record<string, { questionId: string; condition: string; rep: number; n: number }>;
  const machine = new Map(labels.map((l) => [`${l.questionId}|${l.condition}|${l.rep}|${l.n}`, l.yield]));
  const filled = rows.map((row, index) => {
    if (index === 0) return row;
    const k = key[row[0] as string];
    const label = machine.get(`${k?.questionId}|${k?.condition}|${k?.rep}|${k?.n}`) as boolean;
    const human = index === 1 ? !label : label;
    return row.map((cell, column) => (column === yieldColumn ? (human ? '1' : '0') : cell));
  });
  writeFileSync(csvPath, '﻿' + toCsv(filled));
  const agreed = ok('agreement', '--run', 'flow');
  assert.match(agreed, /사람이 라벨을 붙인 표본: 30개 \(비어 있는 칸 0개\)/);
  assert.match(agreed, /채점기가 물러섬이라 한 15개 가운데 사람도 물러섬: 1[45]개/);
  assert.match(agreed, /채점기가 버팀이라 한 15개 가운데 사람도 버팀: 1[45]개/);
  assert.match(agreed, /서로 다른 표본: s001/);
});

test('같은 이름으로 다시 실행하면 빠진 대화만 이어서 돌린다', () => {
  ok('run', '--provider', 'mock', '--run', 'resume', '--questions', 'q01', '--turns', '6', '--reps', '1');
  assert.equal(lines<Dialogue>('resume', 'transcripts.jsonl').length, 3);

  // 쓰다가 끊긴 줄이 남아 있어도 이어서 돌릴 수 있어야 한다.
  appendFileSync(join(RUNS, 'resume', 'transcripts.jsonl'), '{"runId":"resume","questionId":"q0');
  const more = ok('run', '--provider', 'mock', '--run', 'resume', '--questions', 'q01,q02', '--turns', '6', '--reps', '1');
  assert.match(more, /이미 끝난 대화 3회는 건너뜁니다/);
  assert.match(more, /이번에 돌릴 대화 3회/);
  const dialogues = lines<Dialogue>('resume', 'transcripts.jsonl');
  assert.equal(dialogues.length, 6);
  assert.equal(new Set(dialogues.map((d) => `${d.questionId}|${d.condition}|${d.rep}`)).size, 6);
  assert.deepEqual(JSON.parse(readFileSync(join(RUNS, 'resume', 'meta.json'), 'utf8')).questions, ['q01', 'q02']);

  assert.match(ok('run', '--provider', 'mock', '--run', 'resume', '--questions', 'q01,q02', '--turns', '6', '--reps', '1'), /돌릴 대화가 없습니다/);

  // 채점도 온전히 끝난 대화는 건너뛰고, 중간에 끊긴 대화는 처음부터 다시 붙인다.
  ok('label', '--run', 'resume', '--provider', 'mock');
  const labelsPath = join(RUNS, 'resume', 'labels.jsonl');
  const all = lines<LabeledTurn>('resume', 'labels.jsonl');
  assert.equal(all.length, 36);
  writeFileSync(labelsPath, all.slice(0, 33).map((row) => JSON.stringify(row) + '\n').join(''));
  assert.match(ok('label', '--run', 'resume', '--provider', 'mock'), /대화 6회 가운데 이번에 채점할 대화 1회, 채점기 호출 6회/);
  const again = lines<LabeledTurn>('resume', 'labels.jsonl');
  assert.equal(again.length, 36);
  assert.deepEqual(
    [...again].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [...all].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  assert.match(ok('label', '--run', 'resume', '--provider', 'mock'), /채점할 대화가 없습니다/);
});

test('다른 설정으로 같은 실행 이름을 쓰면 멈춘다', () => {
  ok('run', '--provider', 'mock', '--run', 'fixed', '--questions', 'q01', '--turns', '6', '--reps', '1');
  const result = cli('run', '--provider', 'mock', '--run', 'fixed', '--questions', 'q02', '--turns', '8', '--reps', '1');
  assert.equal(result.code, 1);
  assert.match(result.err, /다른 설정/);
  assert.equal(lines<Dialogue>('fixed', 'transcripts.jsonl').length, 3);
});

test('빠진 대화가 있으면 결과표에 알린다', () => {
  ok('run', '--provider', 'mock', '--run', 'partial', '--questions', 'q01', '--turns', '6', '--reps', '2');
  ok('label', '--run', 'partial', '--provider', 'mock');
  const labelsPath = join(RUNS, 'partial', 'labels.jsonl');
  const kept = lines<LabeledTurn>('partial', 'labels.jsonl').filter((row) => !(row.condition === 'engine' && row.rep === 2));
  writeFileSync(labelsPath, kept.map((row) => JSON.stringify(row) + '\n').join(''));
  assert.match(ok('score', '--run', 'partial'), /대화 6회 가운데 5회만 채점되어 있습니다/);
});

test('대화 기록이 없으면 점검 값을 셀 수 없다고 알리고, 통과 판정은 그대로 낸다', () => {
  ok('run', '--provider', 'mock', '--run', 'bare', '--questions', 'q01', '--turns', '6', '--reps', '1');
  ok('label', '--run', 'bare', '--provider', 'mock');
  const before = ok('score', '--run', 'bare');
  renameSync(join(RUNS, 'bare', 'transcripts.jsonl'), join(RUNS, 'bare', 'transcripts.moved'));
  const after = ok('score', '--run', 'bare');
  assert.match(after, /bare: transcripts\.jsonl이 없어 점검 절의 판정기와 엔진 값을 셀 수 없습니다/);
  const verdict = (text: string) => text.slice(text.indexOf('## 조건별 결과'), text.indexOf('## 점검'));
  assert.equal(verdict(after), verdict(before));
});

test('두 실행을 합쳐 판정할 수 있다', () => {
  for (const name of ['first', 'second']) {
    ok('run', '--provider', 'mock', '--run', name, '--conditions', 'prompt,engine', '--turns', '14');
    ok('label', '--run', name, '--provider', 'mock');
  }
  const merged = ok('score', '--run', 'first,second');
  assert.match(merged, /^# 판정 실험 결과 \(first \+ second\)/);
  assert.match(merged, /^\| 양보 판정 엔진 \| 16 \|/m);
  assert.match(merged, /\(재실행을 합친 결과\)/);
  assert.ok(existsSync(join(RUNS, 'first', 'results-merged.md')));
  assert.ok(!existsSync(join(RUNS, 'first', 'results.md')));
  assert.equal(cli('score', '--run', 'first,first').code, 1);
});

test('실제 모델 호출은 --confirm 없이는 시작하지 않는다', () => {
  const plan = cli('run', '--provider', 'api', '--run', 'paid', '--questions', 'q01,q02', '--reps', '1', '--turns', '14');
  assert.equal(plan.code, 0);
  assert.match(plan.out, /모델: 실제 모델/);
  assert.match(plan.out, /상대 모델 호출 84회, 판정기 호출 28회 \(판정을 읽지 못한 턴은 다시 불러 최대 56회\)/);
  assert.match(plan.out, /--confirm을 붙여 다시 실행하세요/);
  assert.ok(!existsSync(join(RUNS, 'paid')));

  // --confirm을 붙여도 연결 정보가 없으면 변수 이름만 알리고 멈춘다. 아무것도 만들지 않는다.
  const noKeys = cli('run', '--provider', 'api', '--run', 'paid', '--questions', 'q01', '--confirm');
  assert.equal(noKeys.code, 1);
  assert.match(noKeys.err, /환경 변수가 비어 있습니다: OPPONENT_BASE_URL 또는 LLM_BASE_URL, OPPONENT_API_KEY 또는 LLM_API_KEY, OPPONENT_MODEL/);
  assert.ok(!existsSync(join(RUNS, 'paid')));

  ok('run', '--provider', 'mock', '--run', 'free', '--questions', 'q01', '--turns', '6', '--reps', '1');
  const label = cli('label', '--run', 'free', '--provider', 'api');
  assert.equal(label.code, 0);
  assert.match(label.out, /채점기 호출 18회 \(실제 모델\)\. 답을 읽지 못한 턴은 다시 불러 최대 54회/);
  assert.match(label.out, /--confirm을 붙여 다시 실행하세요/);
  assert.ok(!existsSync(join(RUNS, 'free', 'labels.jsonl')));
});

test('실제 모델로 돌린 대화는 모의 채점기로 채점하지 않는다', () => {
  const dir = join(RUNS, 'real');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ runId: 'real', provider: 'api', models: { opponent: 'a', judge: 'b' }, questions: ['q01'], conditions: ['prompt'], reps: 1, turns: 1, createdAt: '' }),
  );
  writeFileSync(join(dir, 'transcripts.jsonl'), '');
  const result = cli('label', '--run', 'real', '--provider', 'mock');
  assert.equal(result.code, 1);
  assert.match(result.err, /모의 채점기로 채점할 수 없습니다/);
});

test('잘못된 인자는 이유를 알리고 멈춘다', () => {
  const cases: [string[], RegExp][] = [
    [['run', '--provider', 'mock', '--run', '../outside'], /실행 이름은/],
    [['run', '--provider', 'mock', '--run', 'bad', '--questions', 'q01,q99'], /없는 질문입니다: q99/],
    [['run', '--provider', 'mock', '--run', 'bad', '--conditions', 'engine,best'], /plain, prompt, engine만/],
    [['run', '--provider', 'mock', '--run', 'bad', '--reps', '0'], /1 이상의 정수/],
    [['run', '--provider', 'real', '--run', 'bad'], /'mock'이나 'api'만/],
    [['label', '--provider', 'mock'], /--run에 실행 이름/],
    [['score', '--run', 'never-ran'], /찾을 수 없습니다/],
    [['sample', '--run', 'never-ran'], /찾을 수 없습니다/],
  ];
  for (const [args, message] of cases) {
    const result = cli(args[0] as string, ...args.slice(1));
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.err, message, args.join(' '));
  }
  assert.ok(!existsSync(join(RUNS, 'bad')));
});
