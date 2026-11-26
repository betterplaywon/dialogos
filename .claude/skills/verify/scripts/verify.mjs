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

// 화면 출력은 덤이고 증거는 파일에 남는다. 출력을 받는 쪽이 먼저 사라지면(`| head`, 터미널 닫기) 다음 쓰기의 오류(EPIPE, EIO)가
// 비동기 'error' 이벤트로 오는데, 받는 곳이 없으면 node가 닫기 없이 그 자리에서 끝나 앱과 Chrome, 임시 폴더가 남는다. 받아서 버린다.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

// Ctrl+C, Ctrl+\, 끄기, 터미널 닫기, 잡히지 않은 오류로 멈춰도 여정이 띄운 앱과 Chrome을 닫은 뒤에 끝낸다.
// 닫기는 한 번만 돌고(h.close()가 같은 닫기를 돌려준다), 닫는 동안 온 신호와 오류는 기다리라고만 알린다.
// 그것으로 바로 끝내면 닫기가 끊겨 앱과 Chrome, 임시 폴더가 남는다. 닫기는 eval 명령, 앱, Chrome마다 많아야 5초 기다린다.
// SIGKILL처럼 잡을 수 없는 신호로 끝나면 닫지 못한다(SKILL.md의 '아직 못 하는 것').
/** steps.md에 적은 결과의 줄(`VERIFY PASS/FAIL <기능> — <steps.md>`). 결과를 적기 전에는 null. */
let verdict = null;
let stopping = null;
/**
 * failure가 있으면 결과를 FAIL로 적고(이미 적었으면 덮어쓴다) 그 종료 코드로, 없으면 적어 둔 결과의 종료 코드로 끝낸다.
 * 어느 쪽이든 닫은 뒤에 결과 줄을 찍는다. 결과를 적은 뒤에 온 신호면 같은 줄을 다시 찍어, 처리기의 줄 대신 결과 줄이 마지막에 온다.
 */
function stop(reason, failure) {
  if (stopping) {
    console.log(`\n${reason}: 띄운 앱과 Chrome을 닫는 중이다. 끝날 때까지 기다린다.`);
    return;
  }
  stopping = reason;
  console.log(`\n${reason}: 띄운 앱과 Chrome을 닫는다.`);
  void h
    .close()
    .then(() => {
      if (failure) {
        h.finish(false, failure.error ?? `${reason}로 도중에 멈췄다.`);
        verdict = `VERIFY FAIL ${feature} — ${h.rel}/steps.md`;
      }
      console.log(verdict);
    })
    .finally(() => process.exit(failure ? failure.exitCode : (process.exitCode ?? 0)));
}
// 결과를 적은 뒤에 온 신호는 결과를 바꾸지 않는다.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => stop(signal, verdict ? null : { exitCode: 130 }));
}
// 이벤트에서 던진 오류는 아래 여정의 try에 잡히지 않는다. 언제 오든 이 실행은 실패다.
process.on('uncaughtException', (error) => {
  console.error(error);
  stop('잡히지 않은 오류', { exitCode: 1, error });
});

let error;
try {
  await journey.run(h);
} catch (e) {
  error = e;
}
// 실패해도 띄운 것을 먼저 닫는다. 앱의 출력(cmd-NN-app.txt)이 닫을 때 쓰이므로 finish보다 앞이다.
await h.close();
// 닫는 동안 신호가 왔으면 신호 쪽이 결과를 적고 끝낸다.
if (!stopping) {
  const passed = error === undefined;
  h.finish(passed, error instanceof StepFailed ? undefined : error);
  verdict = `${passed ? 'VERIFY PASS' : 'VERIFY FAIL'} ${feature} — ${h.rel}/steps.md`;
  if (error && !(error instanceof StepFailed)) console.error(error);
  console.log(verdict);
  process.exitCode = passed ? 0 : 1;
}
