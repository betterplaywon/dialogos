// verify 스킬의 공용 도우미: 실제 모델을 부를 수 없는 실행 환경, eval 명령 실행과 기록, 앱과 Chrome 띄우기, 단계 기록, 증거 폴더.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from './browser.mjs';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 검증 실행의 결과를 두는 곳. 실험용 실행(runs/<이름>/)과 섞이지 않게 runs/verify/ 아래에 둔다. */
export const VERIFY_RUNS = path.join(ROOT, 'runs', 'verify');

/** 실제 모델 연결 정보를 지운 환경. eval/tests/cli.test.ts와 같은 방식이다. api.ts가 읽는 변수 이름이 바뀌면 여기도 바꾼다. */
export function safeEnv() {
  const env = { ...process.env, EVAL_RUNS_DIR: VERIFY_RUNS };
  for (const name of Object.keys(env)) if (/^(LLM|OPPONENT|JUDGE|SCORER)_/.test(name)) delete env[name];
  return env;
}

/**
 * 앱(app/dev.ts)을 띄우는 환경. safeEnv에서 APP_*를 모두 지운다. 그래서 모델은 모의 모델(APP_MODEL 없음)이고,
 * 로컬 모델 설정(APP_LOCAL_*)과 판의 방식(APP_MODE)은 이 컴퓨터의 값이 섞이지 않는다. 포트와 판 파일만 여정이 정한다.
 */
function appEnv({ api, web, dbPath }) {
  const env = safeEnv();
  for (const name of Object.keys(env)) if (/^APP_/.test(name)) delete env[name];
  return { ...env, APP_PORT: String(api), APP_WEB_PORT: String(web), APP_DB_PATH: dbPath };
}

/** 사용자가 띄워 두는 개발 서버의 포트(app/server/port.ts의 기본값). 여정은 이 포트를 쓰지 않는다. */
const USER_PORTS = [8787, 5173];

/** 이 컴퓨터가 고른 빈 포트 n개. 동시에 잡았다가 놓아 서로 다르다. */
async function freePorts(n) {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    })),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  assert.ok(ports.every((port) => !USER_PORTS.includes(port)), `빈 포트로 사용자의 개발 서버 포트를 받았다: ${ports.join(', ')}`);
  return ports;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');
/** 터미널 색 코드를 뗀 글. Vite는 출력이 파이프여도 CI나 FORCE_COLOR가 있으면 색 코드를 넣는다. */
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

export function stamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 이번 실행만의 증거 폴더를 만들고 그 이름(실행 id)을 돌려준다. 시각은 초 단위라, 같은 작업 트리에서 같은 기능을 같은 초에
 * 또 띄우면 이름이 같아진다. recursive로 만들면 이미 있어도 실패하지 않아 두 실행이 한 폴더와 판 파일을 같이 쓰고,
 * 이름이 비었는지 먼저 보고 만들면 그 사이에 다른 실행이 같은 이름을 가질 수 있다. 그래서 recursive 없이 만든다.
 * 폴더 만들기는 원자적이라 이미 있으면 EEXIST로 실패하고, 그때 뒤에 -2, -3을 붙여 다시 만든다.
 */
function claimRunDir(feature) {
  mkdirSync(VERIFY_RUNS, { recursive: true });
  const base = `${stamp()}-${feature}`;
  for (let n = 1; ; n += 1) {
    const runId = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(path.join(VERIFY_RUNS, runId));
      return runId;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
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
  const runId = claimRunDir(feature);
  const dir = path.join(VERIFY_RUNS, runId);
  const env = safeEnv();
  const steps = [];
  const startedAt = new Date();
  let commands = 0;
  /** 화면 사진 번호. 여정이 띄운 Chrome 모두가 같이 쓴다. */
  let shots = 0;
  const file = (name) => path.join(dir, name);
  /** 여정이 띄우거나 만든 것(앱, Chrome, Chrome의 임시 사용자 폴더)을 닫고 지우는 함수. 여정이 어떻게 끝나든 close()가 거꾸로 차례대로 부른다. */
  const closers = [];
  /** 진행 중이거나 끝난 닫기. 한 번 시작하면 다시 부른 쪽도 같은 닫기가 끝나기를 기다린다. */
  let closing = null;
  /** 닫기가 시작된 뒤에는 새로 띄우지 않는다. 띄우면 닫기 목록에 늦게 들어가 남을 수 있다. */
  const refuseIfClosing = (what) => {
    if (closing) throw new Error(`닫는 중이라 ${what}을 띄우지 않는다.`);
  };

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

    /**
     * 앱을 npm run app:dev와 같은 진입점(app/dev.ts)으로 빈 포트 둘에 띄우고, 화면을 거친 /api가 답할 때까지 기다린다.
     * 모의 모델이고 .env를 읽지 않는다. 판 파일은 증거 폴더의 새 파일이다. 출력은 닫을 때 cmd-NN-app.txt에 남는다.
     */
    async app() {
      commands += 1;
      const log = `cmd-${pad(commands)}-app.txt`;
      const dbName = `app-${pad(commands)}.sqlite`;
      const [api, web] = await freePorts(2);
      // 여기부터 닫기 목록에 넣기까지는 기다림 없이 한 차례에 돈다. 그 사이에 닫기가 시작될 수 없다.
      refuseIfClosing('앱');
      const started = Date.now();
      const child = spawn(process.execPath, ['--import', 'tsx', path.join('app', 'dev.ts')], {
        cwd: ROOT,
        env: appEnv({ api, web, dbPath: file(dbName) }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const url = `http://127.0.0.1:${web}/`;
      let ending = null;

      const writeLog = (end) => {
        const lines = [
          `$ APP_PORT=${api} APP_WEB_PORT=${web} APP_DB_PATH=${path.relative(ROOT, file(dbName))} node --import tsx app/dev.ts`,
          '(npm run app:dev와 같은 진입점. .env를 읽지 않고, APP_*와 모델 연결 정보를 지운 환경에서 실행. 모델은 모의 모델)',
          `${end} · ${Date.now() - started}ms`,
          '',
          '--- 출력 ---',
          plain(output),
        ];
        writeFileSync(file(log), lines.join('\n'));
      };

      /** SIGTERM으로 끄고, 5초 안에 끝나지 않으면 SIGKILL로 끝낸다. 여러 번 불러도 한 번만 끈다. */
      const stop = () =>
        (ending ??= (async () => {
          const running = child.exitCode === null && child.signalCode === null;
          if (running) {
            child.kill('SIGTERM');
            let timer;
            const done = await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, 5_000, null)))]);
            clearTimeout(timer);
            if (!done) child.kill('SIGKILL');
          }
          const { code, signal } = await exited;
          writeLog(`${running ? '여정이 끔' : '스스로 끝남'}(종료 코드 ${code}, 신호 ${signal ?? '없음'})`);
        })());
      closers.push(stop);

      for (let i = 0; i < 150; i += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          if ((await fetch(`${url}api/topics`)).ok) return { url, api, web, dbPath: file(dbName), db: dbName, log };
        } catch {
          // 아직 뜨지 않았다.
        }
        await sleep(200);
      }
      await stop();
      const tail = plain(output).trim().split('\n').slice(-5).join(' / ');
      throw new Error(`앱이 30초 안에 뜨지 않았다(${log}): ${tail}`);
    },

    /**
     * 창 없는 Chrome을 이번 실행만의 새 사용자 폴더로 띄운다. 화면 사진은 증거 폴더에 남는다.
     * 사용자 폴더는 증거가 아니고 실행마다 약 17MB라, 증거 폴더(지우지 않는 runs/) 대신 OS 임시 폴더에 두고 닫을 때 지운다.
     */
    async browser() {
      refuseIfClosing('Chrome');
      const profileDir = mkdtempSync(path.join(tmpdir(), 'dialogos-verify-chrome-'));
      // 닫기는 Chrome을 띄우기 전에 하나로 등록한다. Chrome이 떴으면 끝날 때까지 닫은 뒤에 폴더를 지운다.
      // 띄우는 도중(탭에 붙기 전)에 종료 신호가 와도, Chrome을 띄우지 못해도 Chrome과 폴더가 남지 않는다.
      let closeChrome = async () => {};
      closers.push(async () => {
        try {
          await closeChrome();
        } finally {
          rmSync(profileDir, { recursive: true, force: true });
        }
      });
      return launchChrome({ profileDir, shotsDir: dir, nextShot: () => (shots += 1), onSpawn: (close) => (closeChrome = close) });
    },

    /**
     * 여정이 띄운 것을 모두 닫는다. 입구 스크립트가 여정이 끝난 뒤(실패해도), 그리고 종료 신호를 받았을 때 부른다.
     * 닫기는 한 번만 돈다. 닫는 도중에 다시 부르면(예: 여정 뒤의 닫기 중에 Ctrl+C) 같은 닫기를 돌려주어, 부른 쪽이 모두 끝나기를 기다린다.
     * 나중에 넣은 것부터 닫고, 목록이 빌 때까지 닫는다.
     */
    close() {
      closing ??= (async () => {
        while (closers.length > 0) {
          const closeOne = closers.pop();
          try {
            await closeOne();
          } catch (error) {
            console.error(`닫다가 실패: ${error instanceof Error ? error.message : error}`);
          }
        }
      })();
      return closing;
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
