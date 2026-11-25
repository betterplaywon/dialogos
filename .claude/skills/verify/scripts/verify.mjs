#!/usr/bin/env node
// verify 스킬의 입구. 판정 실험의 명령이나 화면을 모의 모델로 사용 순서대로 돌리고, 증거를 runs/verify/<시각>-<기능>/에 남긴다.
// 사용법: node .claude/skills/verify/scripts/verify.mjs <기능> [--questions q01,q02] [--reps 2] [--turns 30]
// 모델과 --confirm은 옵션으로 받지 않는다. 실제 모델 실행은 이 스킬의 일이 아니다.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness, StepFailed } from './lib.mjs';

const JOURNEYS = path.join(import.meta.dirname, 'journeys');
const OPTIONS = ['questions', 'reps', 'turns'];

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!OPTIONS.includes(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`알 수 없는 옵션: ${argv[i]}. 쓸 수 있는 옵션은 ${OPTIONS.map((o) => `--${o} <값>`).join(', ')}뿐이다.`);
    }
    options[name] = value;
  }
  return options;
}

const features = readdirSync(JOURNEYS)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -'.mjs'.length))
  .sort();
const feature = process.argv[2];
if (!features.includes(feature)) {
  console.error(`사용법: node .claude/skills/verify/scripts/verify.mjs <기능> [옵션]\n기능: ${features.join(' | ')}`);
  process.exit(1);
}

let options;
try {
  options = parseOptions(process.argv.slice(3));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const journey = await import(pathToFileURL(path.join(JOURNEYS, `${feature}.mjs`)).href);
const h = createHarness(feature, journey.title, options);
console.log(`verify ${feature}: ${journey.title}\n증거: ${h.rel}/`);

// Ctrl+C나 종료 신호로 멈춰도 여정이 띄운 앱과 Chrome을 닫고 끝낸다.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`\n${signal}: 띄운 앱과 Chrome을 닫는다.`);
    void h
      .close()
      .then(() => h.finish(false, `${signal}로 도중에 멈췄다.`))
      .finally(() => process.exit(130));
  });
}

let error;
try {
  await journey.run(h);
} catch (e) {
  error = e;
}
// 실패해도 띄운 것을 먼저 닫는다. 앱의 출력(cmd-NN-app.txt)이 닫을 때 쓰이므로 finish보다 앞이다.
await h.close();
const passed = error === undefined;
h.finish(passed, error instanceof StepFailed ? undefined : error);
if (error && !(error instanceof StepFailed)) console.error(error);
console.log(`${passed ? 'VERIFY PASS' : 'VERIFY FAIL'} ${feature} — ${h.rel}/steps.md`);
process.exitCode = passed ? 0 : 1;
