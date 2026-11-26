// 실제 모델 실행의 문턱을 확인한다: --provider api는 --confirm 없이는 계획만 출력하고, 실행 폴더나 라벨을 만들지 않는다.
// --confirm은 어디에도 넘기지 않는다. 단계 id와 기대값은 features/plan-gate.md에 있다.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const title = '실제 모델 실행은 계획만 출력하고 멈춘다';

export async function run(h) {
  const apiRun = `${h.runId}-api`;

  await h.step('run-plan', 'eval:run --provider api를 --confirm 없이 실행한다', async () => {
    const r = h.ok(await h.cli('run', ['--provider', 'api', '--run', apiRun, '--questions', 'q01', '--reps', '1', '--turns', '2']));
    assert.match(r.out, /모델: 실제 모델/);
    assert.match(r.out, /상대 모델 호출 \d+회, 판정기 호출 \d+회/);
    assert.match(r.out, /--confirm을 붙여 다시 실행하세요/);
    assert.ok(!existsSync(path.join(h.runsDir, apiRun)), `실행 폴더가 생겼다: ${apiRun}`);
    return `계획만 출력하고 멈춤, 실행 폴더 없음 (${r.log})`;
  });

  await h.step('mock-seed', '채점 계획을 볼 짧은 대화를 모의 모델로 만든다', async () => {
    const r = h.ok(await h.cli('run', ['--provider', 'mock', '--run', h.runId, '--questions', 'q01', '--reps', '1', '--turns', '2']));
    return `대화 ${h.jsonl('transcripts.jsonl').length}회 (${r.log})`;
  });

  await h.step('label-plan', 'eval:label --provider api를 --confirm 없이 실행한다', async () => {
    const r = h.ok(await h.cli('label', ['--provider', 'api', '--run', h.runId]));
    assert.match(r.out, /채점기 호출 \d+회 \(실제 모델\)/);
    assert.match(r.out, /--confirm을 붙여 다시 실행하세요/);
    assert.ok(!h.exists('labels.jsonl'), 'labels.jsonl이 생겼다');
    assert.equal(h.json('meta.json').scorer, undefined, 'meta.json에 채점기가 기록됐다');
    return `계획만 출력하고 멈춤, labels.jsonl 없음, meta.json 그대로 (${r.log})`;
  });
}
