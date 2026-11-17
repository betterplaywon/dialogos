// 사람이 채운 표본과 채점기 라벨의 일치율을 낸다.
//
// 사용법: npm run eval:agreement -- --run 이름

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agreement, type SampleKey } from './human.ts';
import { readJsonl, runDir } from './runio.ts';
import type { LabeledTurn } from './types.ts';
import { argString, parseArgs, parseCsv, percent } from './util.ts';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = argString(args, 'run');
  if (!runId) throw new Error('--run에 실행 이름을 적어 주세요.');
  const dir = runDir(runId);

  const rows = parseCsv(readFileSync(join(dir, 'sample.csv'), 'utf8').replace(/^﻿/, ''));
  const header = rows[0] ?? [];
  const itemColumn = header.indexOf('item');
  const yieldColumn = header.indexOf('human_yield');
  if (itemColumn < 0 || yieldColumn < 0) throw new Error("sample.csv에 'item'과 'human_yield' 칸이 있어야 합니다.");

  const key = JSON.parse(readFileSync(join(dir, 'sample.key.json'), 'utf8')) as Record<string, SampleKey>;
  const allLabels = readJsonl<LabeledTurn>(join(dir, 'labels.jsonl'));
  const labels = new Map(allLabels.map((l) => [`${l.questionId}|${l.condition}|${l.rep}|${l.n}`, l]));

  const pairs: { item: string; human: boolean; machine: boolean }[] = [];
  let blank = 0;
  for (const row of rows.slice(1)) {
    const item = row[itemColumn] ?? '';
    const value = (row[yieldColumn] ?? '').trim();
    if (value !== '0' && value !== '1') {
      blank++;
      continue;
    }
    const k = key[item];
    const label = k ? labels.get(`${k.questionId}|${k.condition}|${k.rep}|${k.n}`) : undefined;
    if (!label) throw new Error(`표본 '${item}'에 맞는 채점기 라벨이 없습니다. 표본을 뽑은 뒤 라벨을 다시 붙였다면 표본도 새로 뽑으세요.`);
    pairs.push({ item, human: value === '1', machine: label.yield });
  }

  // 표본은 물러섬과 버팀에서 절반씩 뽑았다. 전체 턴에서의 비율로 가중해 환산한다.
  const yieldShare = allLabels.length === 0 ? undefined : allLabels.filter((l) => l.yield).length / allLabels.length;
  const result = agreement(pairs, yieldShare);
  console.log(`사람이 라벨을 붙인 표본: ${result.n}개 (비어 있는 칸 ${blank}개)`);
  if (result.n === 0) return;
  const { machineYield, machineHold } = result;
  if (machineYield.n > 0) {
    console.log(`채점기가 물러섬이라 한 ${machineYield.n}개 가운데 사람도 물러섬: ${machineYield.agree}개 (${percent(machineYield.rate)})`);
  }
  if (machineHold.n > 0) {
    console.log(`채점기가 버팀이라 한 ${machineHold.n}개 가운데 사람도 버팀: ${machineHold.agree}개 (${percent(machineHold.rate)})`);
  }
  console.log(`전체 턴으로 환산한 일치율 ${percent(result.rate)}, 카파 ${Number.isFinite(result.kappa) ? result.kappa.toFixed(2) : '-'}`);
  const differ = pairs.filter((p) => p.human !== p.machine).map((p) => p.item);
  if (differ.length > 0) console.log(`서로 다른 표본: ${differ.join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
