// verify 스킬의 공용 도우미: 실제 모델을 부를 수 없는 실행 환경, eval 명령 실행과 기록, 단계 기록, 증거 폴더.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 검증 실행의 결과를 두는 곳. 실험용 실행(runs/<이름>/)과 섞이지 않게 runs/verify/ 아래에 둔다. */
export const VERIFY_RUNS = path.join(ROOT, 'runs', 'verify');

/** 실제 모델 연결 정보를 지운 환경. eval/tests/cli.test.ts와 같은 방식이다. api.ts가 읽는 변수 이름이 바뀌면 여기도 바꾼다. */
export function safeEnv() {
  const env = { ...process.env, EVAL_RUNS_DIR: VERIFY_RUNS };
  for (const name of Object.keys(env)) if (/^(LLM|OPPONENT|JUDGE|SCORER)_/.test(name)) delete env[name];
  return env;
}

const pad = (n) => String(n).padStart(2, '0');

export function stamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

let tsxRegistered = false;

/** eval/src의 TypeScript 모듈을 불러온다. CSV와 질문 읽기처럼 프로젝트 코드를 그대로 쓴다. */
export async function evalModule(name) {
  if (!tsxRegistered) {
    const { register } = await import('tsx/esm/api');
    register();
    tsxRegistered = true;
  }
  return import(pathToFileURL(path.join(ROOT, 'eval', 'src', `${name}.ts`)).href);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 단계가 실패했다는 표시. 이유는 이미 단계 기록에 들어 있다. */
export class StepFailed extends Error {}

/** 표의 칸에 넣을 글. 세로줄과 줄바꿈이 표를 깨지 않게 한다. */
export const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export function createHarness(feature, title, options) {
  const runId = `${stamp()}-${feature}`;
  const dir = path.join(VERIFY_RUNS, runId);
  mkdirSync(dir, { recursive: true });
  const env = safeEnv();
  const steps = [];
  const startedAt = new Date();
  let commands = 0;
  const file = (name) => path.join(dir, name);

  return {
    feature,
    options,
    runId,
    dir,
    runsDir: VERIFY_RUNS,
    rel: path.relative(ROOT, dir),

    /** eval 명령을 npm 스크립트와 같은 진입점으로 띄운다. 다른 점은 .env를 읽지 않는다는 것 하나다. 출력은 cmd-NN-<명령>.txt에 남긴다. */
    cli(script, args) {
      commands += 1;
      const started = Date.now();
      const r = spawnSync(process.execPath, ['--import', 'tsx', path.join('eval', 'src', `${script}.ts`), ...args], { cwd: ROOT, env, encoding: 'utf8' });
      const log = `cmd-${pad(commands)}-${script}.txt`;
      const lines = [
        `$ npm run eval:${script} -- ${args.join(' ')}`,
        '(.env를 읽지 않고, 모델 연결 정보를 지운 환경에서 실행)',
        `종료 코드 ${r.status} · ${Date.now() - started}ms`,
        '',
        '--- stdout ---',
        r.stdout ?? '',
        '--- stderr ---',
        r.stderr ?? '',
      ];
      writeFileSync(file(log), lines.join('\n'));
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', log };
    },

    ok(result) {
      const tail = `${result.out}\n${result.err}`.trim().split('\n').slice(-5).join('\n');
      assert.equal(result.code, 0, `${result.log}: 종료 코드 ${result.code}\n${tail}`);
      return result;
    },

    exists: (name) => existsSync(file(name)),
    read: (name) => readFileSync(file(name), 'utf8'),
    json: (name) => JSON.parse(readFileSync(file(name), 'utf8')),
    jsonl: (name) =>
      readFileSync(file(name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line)),
    save(name, text) {
      writeFileSync(file(name), text);
      return name;
    },

    /** 사용자 행동 하나가 단계 하나다. fn은 관찰한 것을 한 줄로 돌려준다. 실패하면 거기서 멈춘다. */
    async step(id, description, fn) {
      const started = Date.now();
      try {
        const observed = await fn();
        steps.push({ id, description, passed: true, observed: String(observed ?? ''), ms: Date.now() - started });
        console.log(`  PASS ${id}: ${observed}`);
      } catch (error) {
        const observed = error instanceof Error ? error.message : String(error);
        steps.push({ id, description, passed: false, observed, ms: Date.now() - started });
        console.log(`  FAIL ${id}: ${observed}`);
        throw new StepFailed(id);
      }
    },

    /** steps.md(먼저 읽는 파일)와 result.json을 쓴다. */
    finish(passed, error) {
      const head = git(['rev-parse', '--short', 'HEAD']);
      const dirty = (git(['status', '--short']) ?? '').split('\n').filter(Boolean).length;
      const md = [
        `# verify ${feature}: ${title}`,
        '',
        `- 시각: ${startedAt.toLocaleString('ko-KR')}`,
        `- 증거 폴더: ${path.relative(ROOT, dir)}/`,
        `- 코드: ${head ? `커밋 ${head}` : '커밋 없음'}, 커밋하지 않은 변경 ${dirty}개`,
        `- 옵션: ${Object.keys(options).length ? Object.entries(options).map(([k, v]) => `--${k} ${v}`).join(' ') : '기본값'}`,
        '- 모델: 모의 모델. 실제 모델은 부르지 않았다(.env 없음, 연결 정보를 지운 환경, --confirm 없음).',
        '- 모의 모델의 숫자는 흐름을 확인하는 용도이고 실험 결과가 아니다. 공개 문서에 옮기지 않는다.',
        '',
        '| # | 단계 | 설명 | 결과 | 관찰 | 시간 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...steps.map((s, i) => `| ${i + 1} | ${s.id} | ${cell(s.description)} | ${s.passed ? 'PASS' : 'FAIL'} | ${cell(s.observed)} | ${s.ms}ms |`),
        '',
        ...(error ? ['## 단계 밖의 오류', '', '```', String(error instanceof Error ? error.stack : error), '```', ''] : []),
        `결과: ${passed ? 'PASS' : 'FAIL'}`,
        '',
      ];
      writeFileSync(file('steps.md'), md.join('\n'));
      const files = readdirSync(dir).filter((f) => f !== 'result.json').sort();
      writeFileSync(file('result.json'), `${JSON.stringify({ feature, runId, passed, options, steps, files: [...files, 'result.json'] }, null, 2)}\n`);
    },
  };
}
