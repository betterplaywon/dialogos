// 라벨에서 결과표를 만든다. runs/<실행 이름>/results.md와 results.json을 쓴다.
//
// 사용법: npm run eval:score -- --run 이름
//         npm run eval:score -- --run 첫실행,재실행   (3번 기준의 재실행을 합쳐 판정할 때)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeMetrics, evaluateCriteria, renderMarkdown } from './metrics.ts';
import { dialogueKey, readJsonl, readMeta, runDir } from './runio.ts';
import type { LabeledTurn } from './types.ts';
import { argList, parseArgs } from './util.ts';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runIds = argList(args, 'run') ?? [];
  if (runIds.length === 0) throw new Error('--run에 실행 이름을 적어 주세요.');
  if (new Set(runIds).size !== runIds.length) throw new Error('같은 실행 이름을 두 번 적었습니다.');

  const labels: LabeledTurn[] = [];
  const notes: string[] = [];
  for (const runId of runIds) {
    const dir = runDir(runId);
    const rows = readJsonl<LabeledTurn>(join(dir, 'labels.jsonl'));
    labels.push(...rows);

    const meta = readMeta(dir);
    if (!meta) continue;
    if (meta.provider === 'mock') {
      notes.push(`${runId}: 모의 모델로 돌린 결과입니다. 흐름을 확인하는 용도이고 실험 결과가 아닙니다.`);
    } else {
      notes.push(`${runId}: 상대 모델 ${meta.models.opponent}, 판정기 ${meta.models.judge}, 채점기 ${meta.scorer?.model ?? '기록 없음'}`);
    }
    const expected = meta.questions.length * meta.conditions.length * meta.reps;
    const labeled = new Set(rows.map(dialogueKey)).size;
    if (labeled < expected) {
      notes.push(`${runId}: 대화 ${expected}회 가운데 ${labeled}회만 채점되어 있습니다. 빠진 대화를 마저 돌리고 채점한 뒤 다시 계산하세요.`);
    }
  }

  const merged = runIds.length > 1;
  const metrics = computeMetrics(labels);
  const verdict = evaluateCriteria(metrics, { merged });
  const markdown = renderMarkdown(metrics, verdict, `판정 실험 결과 (${runIds.join(' + ')})`, notes);

  const dir = runDir(runIds[0] as string);
  const name = merged ? 'results-merged' : 'results';
  writeFileSync(join(dir, `${name}.md`), markdown);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ runIds, metrics, verdict, notes }, null, 2) + '\n');
  console.log(markdown);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
