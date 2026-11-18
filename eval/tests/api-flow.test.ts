// 실제 모델 경로를 끝까지 검사한다. 바깥으로는 나가지 않고, 이 컴퓨터 안에 띄운 가짜 서버와만 주고받는다.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockModel, type MockRole } from '../src/providers/mock.ts';
import type { ChatMessage } from '../src/types.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNS = mkdtempSync(join(tmpdir(), 'dialogos-api-'));
// 검사용으로 지어낸 값이다. 실제 키의 모양을 닮지 않게 둔다.
const FAKE_KEY = 'FAKE-KEY-FOR-TESTS-ONLY';
const WRONG_KEY = 'WRONG-FAKE-KEY-FOR-TESTS';

let requests = 0;
let baseUrl = '';

// chat completions 요청을 받아 모의 모델의 답을 돌려주는 서버. 키가 다르면 401로 답하고 받은 키를 오류 글에 넣는다.
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => {
    requests++;
    const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { message: 'not found' } });
    const sent = String(req.headers.authorization ?? '').replace('Bearer ', '');
    if (sent !== FAKE_KEY) return json(401, { error: { message: `Incorrect API key provided: ${sent}` } });
    const payload = JSON.parse(body) as { model: string; messages: ChatMessage[] };
    // 앞으로의 Gemini처럼 temperature를 보내면 거절한다. 기본 설정은 보내지 않아야 한다.
    if ('temperature' in payload) return json(400, { error: { message: 'temperature is not supported' } });
    const role = payload.model.replace('fake-', '') as MockRole;
    // 생각 토큰을 출력에 넣지 않고 따로 알려 주는 응답(전체 = 입력 + 출력 + 생각).
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 20 } };
    createMockModel(role)
      .complete(payload.messages)
      .then((content) => json(200, { choices: [{ message: { role: 'assistant', content } }], usage }));
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
  server.close();
});

function environment(key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    // 다른 연결 정보나 중계 설정이 섞이지 않게 지운다.
    if (/^(LLM|OPPONENT|JUDGE|SCORER)_/.test(name) || /proxy/i.test(name)) delete env[name];
  }
  return {
    ...env,
    EVAL_RUNS_DIR: RUNS,
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: key,
    OPPONENT_MODEL: 'fake-opponent',
    JUDGE_MODEL: 'fake-judge',
    SCORER_MODEL: 'fake-scorer',
  };
}

function cli(key: string, script: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('eval', 'src', `${script}.ts`), ...args], { cwd: ROOT, env: environment(key) });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function lineCount(run: string, file: string): number {
  const path = join(RUNS, run, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').length : 0;
}

function meta(run: string): Record<string, any> {
  return JSON.parse(readFileSync(join(RUNS, run, 'meta.json'), 'utf8'));
}

const SMALL = ['--questions', 'q01', '--reps', '1', '--turns', '6'];

test('--confirm이 없으면 서버에 요청을 하나도 보내지 않는다', async () => {
  const before = requests;
  const plan = await cli(FAKE_KEY, 'run', '--provider', 'api', '--run', 'http', ...SMALL);
  assert.equal(plan.code, 0);
  assert.match(plan.out, /--confirm을 붙여 다시 실행하세요/);
  assert.equal(requests, before);
  assert.ok(!existsSync(join(RUNS, 'http')));
});

test('실제 모델 경로: 대화, 채점, 결과표가 이어지고 쓴 양이 기록된다', async () => {
  const run = await cli(FAKE_KEY, 'run', '--provider', 'api', '--run', 'http', ...SMALL, '--confirm');
  assert.equal(run.code, 0, run.err);
  assert.equal(lineCount('http', 'transcripts.jsonl'), 3);
  assert.match(run.out, /상대 모델 사용량: 호출 18회, 입력 토큰 1800, 출력 토큰 180, 생각 토큰 360\(따로 알려 준 값\), 전체 토큰 2340/);
  assert.match(run.out, /판정기 사용량: 호출 \d+회/);
  assert.match(run.out, /한 턴의 답이 나오기까지 걸린 시간\(중앙값\):\n {2}plain: \d+ms\n {2}prompt: \d+ms\n {2}engine: \d+ms/);
  assert.deepEqual(meta('http').models, { opponent: 'fake-opponent', judge: 'fake-judge' });
  const used = { calls: 18, promptTokens: 1800, completionTokens: 180, totalTokens: 2340, reasoningTokens: 360 };
  assert.deepEqual(meta('http').usage.opponent, used);

  const label = await cli(FAKE_KEY, 'label', '--provider', 'api', '--run', 'http', '--confirm');
  assert.equal(label.code, 0, label.err);
  assert.equal(lineCount('http', 'labels.jsonl'), 18);
  assert.match(label.out, /채점기 사용량: 호출 18회, 입력 토큰 1800, 출력 토큰 180, 생각 토큰 360\(따로 알려 준 값\), 전체 토큰 2340/);
  assert.deepEqual(meta('http').scorer, { provider: 'api', model: 'fake-scorer' });
  assert.deepEqual(meta('http').usage.scorer, used);
  assert.deepEqual(meta('http').usage.opponent, used);

  const score = await cli(FAKE_KEY, 'score', '--run', 'http');
  assert.equal(score.code, 0, score.err);
  assert.match(score.out, /http: 상대 모델 fake-opponent, 판정기 fake-judge, 채점기 fake-scorer/);
  // 과금 기준의 출력(생각 포함)은 전체에서 입력을 뺀 값이다: 2340 - 1800 = 540. 대화 3회로 나누면 입력 600, 출력 180.
  assert.match(score.out, /^\| 상대 모델 \(대화 3회\) \| 18 \| 1800 \| 540 \| 360 \| 600 \| 180 \|$/m);
  assert.doesNotMatch(score.out, /모의 모델로 돌린 결과/);

  // 어느 출력에도 키와 서버 주소가 나오지 않아야 한다.
  for (const text of [run.out, run.err, label.out, label.err, score.out, JSON.stringify(meta('http'))]) {
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(!text.includes('127.0.0.1'));
  }
});

test('키가 틀리면 바로 멈추고, 키를 내보내지 않으며, 고친 뒤 이어서 돌릴 수 있다', async () => {
  const denied = await cli(WRONG_KEY, 'run', '--provider', 'api', '--run', 'denied', ...SMALL, '--confirm');
  assert.equal(denied.code, 1);
  assert.match(denied.err, /실패한 대화가 있어 멈췄습니다 \(남은 대화 3회\)/);
  assert.match(denied.err, /상태 401: .*\[가림\]/);
  assert.match(denied.err, /같은 명령을 다시 실행하면/);
  assert.ok(!(denied.out + denied.err).includes(WRONG_KEY));
  assert.equal(lineCount('denied', 'transcripts.jsonl'), 0);

  const fixed = await cli(FAKE_KEY, 'run', '--provider', 'api', '--run', 'denied', ...SMALL, '--confirm');
  assert.equal(fixed.code, 0, fixed.err);
  assert.equal(lineCount('denied', 'transcripts.jsonl'), 3);
});
