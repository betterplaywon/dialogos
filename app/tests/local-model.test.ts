// 로컬 모델(Ollama의 OpenAI 호환 주소) 출처와 개발 서버의 검사.
// 바깥으로는 나가지 않는다. 이 컴퓨터 안에 띄운 가짜 서버와만 주고받거나, 보낸 요청을 남기기만 하는 fetch를 쓴다.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { KRW_PER_USD, LIMITS, type Limits, type ModelSource } from '../server/budget.ts';
import type { GameView, TopicsResponse, TurnResponse } from '../server/contract.ts';
import { localConfigFromEnv, localProblem, localSource } from '../server/models.ts';
import { MemoryGameStore, type SpendEntry } from '../server/store.ts';
import { loadFixtureTopics } from './topic-fixtures.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const topics = loadFixtureTopics();
/** q01을 질문의 사용자 입장에서 '대체로'로 시작하는 요청. */
const START_Q01 = { topicId: 'q01', side: 0, lean: -1 };
const OPPONENT = 'fake-opponent:7b';
const JUDGE = 'fake-judge:2b';
/** 판정기가 전제 P1이 무너졌다고 보는 답. */
const DECISION = '{"tactic":"argument","defeats":"P1","reason":"시험"}';
/** 응답마다 알려 주는 사용량. Ollama처럼 전체 토큰이 입력과 출력의 합이다. */
const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
const HELLO = [{ role: 'user' as const, content: '안녕하세요' }];

/** 보낸 요청의 주소와 모델 이름을 남기고 OpenAI 호환 답을 돌려주는 fetch. 네트워크로 나가지 않는다. */
function recordingFetch() {
  const sent: { url: string; model?: string }[] = [];
  async function fetchImpl(url: string, init: RequestInit): Promise<Response> {
    const model = init.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined;
    sent.push({ url, ...(model ? { model } : {}) });
    return Response.json({ choices: [{ message: { role: 'assistant', content: '답입니다.' } }], usage: USAGE });
  }
  return { sent, fetchImpl };
}

/** 가짜 서버가 답 대신 넘김(redirect)으로 답할 경로와, 넘길 상태와 주소. */
type Redirects = Readonly<Record<string, { status: number; location: string }>>;

/**
 * Ollama처럼 OpenAI 호환 주소(/v1)로 답하는 가짜 서버. 이 컴퓨터(127.0.0.1)에만 열린다.
 * 모델 목록에는 listed만 있다. chat completions는 판정기 모델이면 판정을, 아니면 정해 둔 답을 낸다.
 * redirects에 적은 경로로 온 요청은 받아 적은 뒤 답 대신 넘긴다.
 */
async function fakeOllama(t: TestContext, listed: readonly string[], { redirects = {} }: { redirects?: Redirects } = {}) {
  const received: { method?: string; path?: string; model?: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const model = body ? (JSON.parse(body) as { model: string }).model : undefined;
      received.push({ method: req.method, path: req.url, ...(model ? { model } : {}) });
      const redirect = redirects[req.url ?? ''];
      if (redirect) return res.writeHead(redirect.status, { location: redirect.location }).end();
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(200, { object: 'list', data: listed.map((id) => ({ id, object: 'model', created: 0, owned_by: 'library' })) });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        return json(200, { choices: [{ message: { role: 'assistant', content: model === JUDGE ? DECISION : '답입니다.' } }], usage: USAGE });
      }
      return json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  t.after(close);
  return { url: `http://127.0.0.1:${address.port}/v1`, received, close };
}

/** 원장에 남긴 줄을 모아 두는 저장소. 나머지는 메모리 저장소가 맡는다. */
class LedgerRecordingStore extends MemoryGameStore {
  readonly spent: SpendEntry[] = [];

  override async addSpend(entry: SpendEntry): Promise<void> {
    this.spent.push(entry);
    return super.addSpend(entry);
  }
}

function serverWith(models: ModelSource, limits: Limits) {
  const store = new LedgerRecordingStore();
  let next = 0;
  const app = createApp({
    topics,
    store,
    models,
    limits,
    pickMode: () => 'engine',
    newId: () => `g${++next}`,
    now: () => new Date('2026-11-22T00:00:00Z'),
  });
  async function call<T = { error: string }>(method: 'GET' | 'POST', path: string, body: unknown = {}) {
    const response = await app.request(path, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  return { store, call };
}

/** 개발 서버(app/dev.ts)를 env로 띄운다. 스스로 끝나면 종료 코드와 출력을 낸다. 서버가 떠 버리면 10초 뒤 끄고 그 결과를 낸다. */
function devServer(env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  // 이 컴퓨터의 APP_ 설정과 중계 설정이 섞이지 않게 지운다.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^APP_/.test(name) && !/proxy/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('app', 'dev.ts')], {
      cwd: ROOT,
      env: { ...inherited, APP_DB_PATH: ':memory:', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test('로컬 출처는 이 컴퓨터의 주소(http나 https, 127.0.0.1, localhost, [::1])로만 만들고, 그 밖의 주소로는 만들지 않아 요청도 보내지 않는다', async () => {
  const { sent, fetchImpl } = recordingFetch();
  const local = (url: string) => localSource(localConfigFromEnv({ APP_LOCAL_URL: url }), fetchImpl);
  const accepted = ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1', 'https://localhost/v1'];
  for (const url of accepted) await local(url).create('opponent').complete(HELLO);
  assert.deepEqual(
    sent.map((request) => request.url),
    accepted.map((url) => `${url}/chat/completions`),
  );

  for (const url of [
    'http://127.0.0.1.example.com/v1',
    'http://localhost.example.com/v1',
    'http://127.0.0.1@example.com/v1',
    'http://192.168.0.10:11434/v1',
    'http://10.0.0.5:11434/v1',
    'http://0.0.0.0:11434/v1',
    'https://api.openai.com/v1',
    'ftp://127.0.0.1/v1',
    '127.0.0.1:11434/v1',
  ]) {
    assert.throws(() => local(url), /이 컴퓨터의 주소만/, url);
  }

  // 호스트가 이 컴퓨터여도 사용자 정보(이름@, 이름:비밀번호@)가 든 주소는 받지 않는다. fetch는 이런 주소로 요청을 만들지 않으므로,
  // 안내는 주소가 아니라 사용자 정보를 빼라고 한다.
  for (const url of ['http://a@127.0.0.1:11434/v1', 'http://a:b@localhost:11434/v1', 'http://:b@[::1]:11434/v1']) {
    assert.throws(
      () => local(url),
      (error: Error) => /사용자 정보/.test(error.message) && !/이 컴퓨터의 주소만/.test(error.message),
      url,
    );
  }
  assert.equal(sent.length, accepted.length);
});

test('기본값: 주소는 Ollama가 처음부터 여는 http://127.0.0.1:11434/v1, 모델은 exaone3.5:7.8b이고, 판정기는 따로 적지 않으면 상대와 같은 모델이다', async () => {
  const modelsOf = async (env: Record<string, string>) => {
    const { sent, fetchImpl } = recordingFetch();
    const source = localSource(localConfigFromEnv(env), fetchImpl);
    await source.create('opponent').complete(HELLO);
    await source.create('judge').complete(HELLO);
    return sent;
  };
  const defaultCall = { url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'exaone3.5:7.8b' };
  assert.deepEqual(await modelsOf({}), [defaultCall, defaultCall]);
  // 빈 값은 적지 않은 것과 같다.
  assert.deepEqual(await modelsOf({ APP_LOCAL_URL: ' ', APP_LOCAL_MODEL: '', APP_LOCAL_JUDGE_MODEL: '' }), [defaultCall, defaultCall]);
  // 상대 모델만 바꾸면 판정기도 따라가고, 판정기 모델을 적으면 그 모델을 쓴다.
  assert.deepEqual(
    (await modelsOf({ APP_LOCAL_MODEL: 'qwen3:8b' })).map((request) => request.model),
    ['qwen3:8b', 'qwen3:8b'],
  );
  assert.deepEqual(
    (await modelsOf({ APP_LOCAL_MODEL: 'qwen3:8b', APP_LOCAL_JUDGE_MODEL: 'qwen3:1.7b' })).map((request) => request.model),
    ['qwen3:8b', 'qwen3:1.7b'],
  );
});

test('로컬 출처로 한 턴을 하면 200이고, 가짜 서버가 역할별 모델 이름으로 요청을 받으며, 원장에는 그 호출의 토큰이 남고 비용은 0이다', async (t) => {
  const ollama = await fakeOllama(t, [OPPONENT, JUDGE]);
  const source = localSource(localConfigFromEnv({ APP_LOCAL_URL: ollama.url, APP_LOCAL_MODEL: OPPONENT, APP_LOCAL_JUDGE_MODEL: JUDGE }));
  // 서비스 상한은 비용이 조금이라도 남으면 닿는 값(100만분의 1달러로 1)이고, 하루 턴 수는 2턴이다.
  const { store, call } = serverWith(source, { totalWon: KRW_PER_USD / 1_000_000, userTurnsPerDay: 2 });

  assert.equal((await call<TopicsResponse>('GET', '/api/topics')).data.provider, 'api');
  const game = await call<GameView>('POST', '/api/games', START_Q01);
  assert.equal(game.status, 201);
  const turn = await call<TurnResponse>('POST', `/api/games/${game.data.id}/turns`, { text: '첫 반론입니다.' });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.reply, '답입니다.');

  // 엔진 방식은 판정기를 부른 뒤 상대를 부른다. 둘 다 설정한 주소의 chat completions로 간다.
  assert.deepEqual(ollama.received, [
    { method: 'POST', path: '/v1/chat/completions', model: JUDGE },
    { method: 'POST', path: '/v1/chat/completions', model: OPPONENT },
  ]);
  assert.deepEqual(
    store.spent.map(({ role, model, calls, inputTokens, outputTokens, costMicroUsd }) => ({ role, model, calls, inputTokens, outputTokens, costMicroUsd })),
    [
      { role: 'judge', model: JUDGE, calls: 1, inputTokens: 120, outputTokens: 30, costMicroUsd: 0 },
      { role: 'opponent', model: OPPONENT, calls: 1, inputTokens: 120, outputTokens: 30, costMicroUsd: 0 },
    ],
  );
  assert.equal(await store.totalSpendMicroUsd(), 0);

  // 비용이 0이라 서비스 상한에는 닿지 않고, 하루 턴 수는 그대로 걸린다.
  assert.equal((await call('POST', `/api/games/${game.data.id}/turns`, { text: '둘째 반론입니다.' })).status, 200);
  const refused = await call('POST', `/api/games/${game.data.id}/turns`, { text: '셋째 반론입니다.' });
  assert.equal(refused.status, 429);
  assert.equal(ollama.received.length, 4);
});

test('로컬 모델 서버가 넘김(redirect)으로 답해도 따라가지 않는다: 넘긴 곳은 요청을 받지 않고, 턴은 실패해 판이 그대로이며, 띄울 때 확인은 막힌다', async (t) => {
  // 넘긴 곳. 이 컴퓨터 밖 주소의 자리에 둔 가짜 서버이고, 받은 요청을 모두 적는다.
  const elsewhere = await fakeOllama(t, [OPPONENT, JUDGE]);
  const there = (path: string) => new URL(path, elsewhere.url).href;
  const configOf = (url: string) => localConfigFromEnv({ APP_LOCAL_URL: url, APP_LOCAL_MODEL: OPPONENT, APP_LOCAL_JUDGE_MODEL: JUDGE });

  // 지시문과 사용자의 글이 실린 chat 요청을 넘기는 경우. 307과 308은 본문을 그대로 넘긴다.
  for (const status of [307, 308]) {
    const ollama = await fakeOllama(t, [OPPONENT, JUDGE], { redirects: { '/v1/chat/completions': { status, location: there('/v1/chat/completions') } } });
    const { store, call } = serverWith(localSource(configOf(ollama.url)), LIMITS);
    const game = await call<GameView>('POST', '/api/games', START_Q01);
    const turn = await call('POST', `/api/games/${game.data.id}/turns`, { text: '이 반론은 이 컴퓨터 밖으로 나가면 안 됩니다.' });
    assert.deepEqual(elsewhere.received, [], `${status}`);
    assert.equal(turn.status, 500, `${status}`);
    assert.deepEqual((await call<GameView>('GET', `/api/games/${game.data.id}`)).data, game.data, `${status}`);
    assert.deepEqual(store.spent, [], `${status}`);
    // 로컬 모델 서버는 chat 요청을 받아 넘겼다. 넘김이 실제로 일어난 경우다.
    assert.ok(ollama.received.length > 0 && ollama.received.every((request) => request.path === '/v1/chat/completions'), `${status}`);
  }

  // 띄울 때 확인의 모델 목록 요청을 302로 넘기는 경우.
  const listMoved = await fakeOllama(t, [OPPONENT, JUDGE], { redirects: { '/v1/models': { status: 302, location: there('/v1/models') } } });
  const problem = await localProblem(configOf(listMoved.url));
  assert.deepEqual(elsewhere.received, []);
  assert.notEqual(problem, null);
  assert.deepEqual(listMoved.received, [{ method: 'GET', path: '/v1/models' }]);
});

test('띄울 때 확인: 닿지 못하면 Ollama 앱을 켜라고, 모델이 없으면 ollama pull을 알리고, 두 역할의 모델이 모두 있으면 문제가 없다', async (t) => {
  // 띄웠다 닫은 가짜 서버의 주소는 이 컴퓨터에서 아무도 듣지 않는 주소다.
  const gone = await fakeOllama(t, []);
  await gone.close();
  assert.match((await localProblem(localConfigFromEnv({ APP_LOCAL_URL: gone.url }))) ?? '', /Ollama 앱을 켠 뒤/);

  const ollama = await fakeOllama(t, ['exaone3.5:7.8b', 'other:1b']);
  assert.equal(await localProblem(localConfigFromEnv({ APP_LOCAL_URL: ollama.url })), null);
  assert.deepEqual(ollama.received, [{ method: 'GET', path: '/v1/models' }]);

  const judgeMissing = await localProblem(localConfigFromEnv({ APP_LOCAL_URL: ollama.url, APP_LOCAL_JUDGE_MODEL: 'qwen3:1.7b' }));
  assert.match(judgeMissing ?? '', /ollama pull qwen3:1\.7b/);
  assert.doesNotMatch(judgeMissing ?? '', /ollama pull exaone3\.5:7\.8b/);

  const bothMissing = await localProblem(localConfigFromEnv({ APP_LOCAL_URL: ollama.url, APP_LOCAL_MODEL: 'a:1b', APP_LOCAL_JUDGE_MODEL: 'b:1b' }));
  assert.match(bothMissing ?? '', /ollama pull a:1b\n {2}ollama pull b:1b/);

  // OpenAI 호환 경로(/v1)를 빼먹은 주소는 모델 목록을 받지 못한다.
  const wrongPath = await localProblem(localConfigFromEnv({ APP_LOCAL_URL: ollama.url.replace(/\/v1$/, '') }));
  assert.match(wrongPath ?? '', /모델 목록을 알려 주지 않았습니다\(상태 404\)/);
});

test('개발 서버는 APP_MODEL이 mock과 local 밖이거나, 로컬 주소가 이 컴퓨터가 아니거나, 로컬 모델이 없으면 까닭을 알리고 띄우지 않는다', async (t) => {
  const ollama = await fakeOllama(t, ['other:1b']);
  const unknown = await devServer({ APP_MODEL: 'openai' });
  // 원격 주소는 예약된 이름(.invalid)으로 둔다. 검사가 고장 나 목록을 물어도 바깥에 닿지 않는다.
  const remote = await devServer({ APP_MODEL: 'local', APP_LOCAL_URL: 'https://paid-provider.invalid/v1' });
  const missing = await devServer({ APP_MODEL: 'local', APP_LOCAL_URL: ollama.url });

  assert.match(unknown.err, /APP_MODEL에는 mock/);
  assert.match(remote.err, /APP_LOCAL_URL에는 이 컴퓨터의 주소만/);
  assert.match(missing.err, /ollama pull exaone3\.5:7\.8b/);
  // 로컬 모델이 없을 때는 모델 목록만 묻고 모델은 부르지 않는다.
  assert.deepEqual(ollama.received, [{ method: 'GET', path: '/v1/models' }]);
  for (const run of [unknown, remote, missing]) {
    assert.equal(run.code, 1, run.err);
    assert.doesNotMatch(run.out, /서버:/);
  }
});
