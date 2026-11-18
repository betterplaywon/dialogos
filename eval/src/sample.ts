// 사람이 라벨을 붙일 표본을 뽑는다. 조건, 턴의 종류, 채점기의 라벨은 표에 넣지 않는다.
// 채점기가 물러섬이라 한 턴과 버팀이라 한 턴에서 절반씩 뽑으므로 eval:label을 먼저 실행해야 한다.
//
// 사용법: npm run eval:sample -- --run 이름 [--n 60] [--seed 1]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, loadQuestions } from './data.ts';
import { drawSample, type SampleKey } from './human.ts';
import { readJsonl, runDir } from './runio.ts';
import type { Dialogue, LabeledTurn } from './types.ts';
import { argCount, argNumber, argString, parseArgs, toCsv } from './util.ts';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = argString(args, 'run');
  if (!runId) throw new Error('--run에 실행 이름을 적어 주세요.');
  const dir = runDir(runId);
  const dialogues = readJsonl<Dialogue>(join(dir, 'transcripts.jsonl'));
  const labels = readJsonl<LabeledTurn>(join(dir, 'labels.jsonl'));
  const questions = new Map(loadQuestions(loadCards()).map((q) => [q.id, q]));
  const sample = drawSample(dialogues, labels, argCount(args, 'n', 60), argNumber(args, 'seed', 1));
  if (sample.length === 0) throw new Error('뽑을 턴이 없습니다. eval:label을 먼저 실행했는지 확인하세요.');

  const rows: string[][] = [['item', 'question', 'user_stance', 'opponent_stance', 'opponent_premises', 'user', 'reply', 'human_yield', 'human_premises']];
  const key: Record<string, SampleKey> = {};
  for (const s of sample) {
    const question = questions.get(s.questionId);
    const premises = question
      ? question.premises.map((p) => `${p.id}. ${p.text}${s.concededBefore.includes(p.id) ? ' (이미 거둠)' : ''}`).join('\n')
      : '';
    rows.push([s.item, question?.text ?? '', question?.userStance ?? '', question?.opponentStance ?? '', premises, s.user, s.reply, '', '']);
    key[s.item] = { questionId: s.questionId, condition: s.condition, rep: s.rep, n: s.n };
  }
  // 맨 앞의 표시(BOM)는 스프레드시트 프로그램이 한글을 바르게 읽게 한다.
  writeFileSync(join(dir, 'sample.csv'), '﻿' + toCsv(rows));
  writeFileSync(join(dir, 'sample.key.json'), JSON.stringify(key, null, 2) + '\n');
  console.log(`표본 ${sample.length}개를 runs/${runId}/sample.csv에 썼습니다.`);
  console.log('human_yield 칸에 물러섬이면 1, 버팀이면 0을 적은 뒤 eval:agreement를 실행하세요. 기준은 eval/rubric.md입니다.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
