import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiConfigFromEnv, createApiModel } from '../src/providers/api.ts';

// 검사용으로 지어낸 값이다. 실제 키의 모양을 닮지 않게 둔다.
const FAKE_KEY = 'FAKE-KEY-FOR-TESTS-ONLY';
const config = { baseUrl: 'https://llm.test/v1/', apiKey: FAKE_KEY, model: 'test-model' };
const fast = { baseDelayMs: 0, maxRetries: 2 };

type Step = () => Response | Promise<Response>;

function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (!step) throw new Error('준비한 응답이 없습니다');
    return step();
  };
  return { impl, calls };
}

function ok(content: unknown, usage?: Record<string, unknown>): Step {
  return () => new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), { status: 200 });
}

function status(code: number, body = '', headers: Record<string, string> = {}): Step {
  return () => new Response(body, { status: code, headers });
}

test('환경 변수에서 연결 정보를 읽고, 역할별 변수가 공통 변수보다 앞선다', () => {
  const env = { LLM_BASE_URL: 'https://common.test/v1', LLM_API_KEY: FAKE_KEY, OPPONENT_MODEL: 'm-opponent', JUDGE_MODEL: 'm-judge' };
  assert.deepEqual(apiConfigFromEnv('opponent', env), { baseUrl: 'https://common.test/v1', apiKey: FAKE_KEY, model: 'm-opponent' });
  const judge = apiConfigFromEnv('judge', { ...env, JUDGE_BASE_URL: 'https://judge.test/v1', JUDGE_API_KEY: 'OTHER-FAKE-KEY' });
  assert.deepEqual(judge, { baseUrl: 'https://judge.test/v1', apiKey: 'OTHER-FAKE-KEY', model: 'm-judge' });
});

test('빠진 변수는 이름만 알려 주고 값은 내보내지 않는다', () => {
  const env = { LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: '', SCORER_MODEL: undefined };
  assert.throws(
    () => apiConfigFromEnv('scorer', env),
    (error: Error) => {
      assert.match(error.message, /SCORER_BASE_URL 또는 LLM_BASE_URL/);
      assert.match(error.message, /SCORER_MODEL/);
      assert.doesNotMatch(error.message, /API_KEY/);
      assert.ok(!error.message.includes(FAKE_KEY));
      return true;
    },
  );
});

test('요청은 chat completions 주소로 가고, 본문에는 모델과 대화만 든다', async () => {
  const { impl, calls } = fakeFetch([ok('답입니다.')]);
  const model = createApiModel(config, impl, fast);
  const messages = [
    { role: 'system' as const, content: '지시문' },
    { role: 'user' as const, content: '질문' },
  ];
  assert.equal(await model.complete(messages, { seed: 'q01|engine|1|3' }), '답입니다.');
  assert.equal(model.name, 'test-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://llm.test/v1/chat/completions');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(calls[0]?.init.headers, { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` });
  // temperature는 Gemini 3.6 이후 모델이 무시하고 앞으로는 오류를 낸다고 예고했으므로 기본으로 보내지 않는다. seed도 보내지 않는다.
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { model: 'test-model', messages });
});

test('온도와 생각 수준은 설정에 적었을 때만 보낸다', async () => {
  const { impl, calls } = fakeFetch([ok('답')]);
  await createApiModel({ ...config, temperature: 0, reasoningEffort: 'low' }, impl, fast).complete([{ role: 'user', content: '질문' }]);
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.temperature, 0);
  assert.equal(body.reasoning_effort, 'low');
});

test('쓴 토큰을 호출마다 더해 둔다', async () => {
  const { impl } = fakeFetch([ok('하나', { prompt_tokens: 100, completion_tokens: 20 }), ok('둘', { prompt_tokens: 150, completion_tokens: 30 }), ok('셋')]);
  const model = createApiModel(config, impl, fast);
  for (let i = 0; i < 3; i++) await model.complete([{ role: 'user', content: '질문' }]);
  assert.deepEqual(model.usage, { calls: 3, promptTokens: 250, completionTokens: 50, totalTokens: 0, reasoningTokens: 0 });
});

test('응답이 알려 주면 전체 토큰과 생각 토큰도 더해 둔다', async () => {
  // 생각 토큰을 출력에 넣지 않고 따로 알려 주는 응답(전체 = 입력 + 출력 + 생각).
  const thinking = { prompt_tokens: 27, completion_tokens: 45, total_tokens: 576, completion_tokens_details: { reasoning_tokens: 504 } };
  const { impl } = fakeFetch([ok('하나', thinking), ok('둘', { prompt_tokens: 10, completion_tokens: 5, total_tokens: '깨진 값' })]);
  const model = createApiModel(config, impl, fast);
  for (let i = 0; i < 2; i++) await model.complete([{ role: 'user', content: '질문' }]);
  assert.deepEqual(model.usage, { calls: 2, promptTokens: 37, completionTokens: 50, totalTokens: 576, reasoningTokens: 504 });
});

test('역할별 온도와 생각 수준을 환경 변수에서 읽고, 잘못된 값은 이유를 알린다', () => {
  const env = { LLM_BASE_URL: 'https://common.test/v1', LLM_API_KEY: FAKE_KEY, JUDGE_MODEL: 'm-judge' };
  assert.deepEqual(apiConfigFromEnv('judge', { ...env, JUDGE_TEMPERATURE: '0', JUDGE_REASONING_EFFORT: 'low' }), {
    baseUrl: 'https://common.test/v1',
    apiKey: FAKE_KEY,
    model: 'm-judge',
    temperature: 0,
    reasoningEffort: 'low',
  });
  // 비워 두면 보내지 않는다.
  assert.deepEqual(Object.keys(apiConfigFromEnv('judge', { ...env, JUDGE_TEMPERATURE: ' ', JUDGE_REASONING_EFFORT: '' })).sort(), ['apiKey', 'baseUrl', 'model']);
  assert.throws(() => apiConfigFromEnv('judge', { ...env, JUDGE_TEMPERATURE: '뜨겁게' }), /JUDGE_TEMPERATURE에는 0에서 2 사이의 숫자/);
  assert.throws(() => apiConfigFromEnv('judge', { ...env, JUDGE_TEMPERATURE: '3' }), /JUDGE_TEMPERATURE/);
  assert.throws(() => apiConfigFromEnv('judge', { ...env, JUDGE_REASONING_EFFORT: 'LOW; x' }), /JUDGE_REASONING_EFFORT에는/);
});

test('잠깐의 오류(429, 5xx, 연결 실패, 빈 답, 깨진 답)는 다시 시도한다', async () => {
  const transient: Step[] = [
    status(429, 'slow down', { 'retry-after': '0.01' }),
    status(503),
    () => {
      throw new TypeError('fetch failed');
    },
    ok('   '),
    ok(null),
    () => new Response('<html>오류</html>', { status: 200 }),
  ];
  for (const step of transient) {
    const { impl, calls } = fakeFetch([step, ok('답입니다.')]);
    assert.equal(await createApiModel(config, impl, fast).complete([{ role: 'user', content: '질문' }]), '답입니다.');
    assert.equal(calls.length, 2);
  }
});

test('다시 시도해도 안 되면 정해진 횟수에서 멈춘다', async () => {
  const { impl, calls } = fakeFetch([status(500, 'server error')]);
  await assert.rejects(createApiModel(config, impl, fast).complete([{ role: 'user', content: '질문' }]), /모델 호출 실패 \(test-model\): 상태 500: server error/);
  assert.equal(calls.length, 3);
});

test('잘못된 요청이나 인증 실패는 다시 시도하지 않는다', async () => {
  for (const code of [400, 401, 403, 404]) {
    const { impl, calls } = fakeFetch([status(code, 'no'), ok('답')]);
    await assert.rejects(createApiModel(config, impl, fast).complete([{ role: 'user', content: '질문' }]), new RegExp(`상태 ${code}`));
    assert.equal(calls.length, 1);
  }
});

test('오류 글에 키가 섞여 있어도 내보내지 않는다', async () => {
  const bodies = [
    `Incorrect API key provided: ${FAKE_KEY}. Check your settings.`,
    // 200자에서 자를 때 키의 앞부분이 남지 않아야 한다.
    'x'.repeat(190) + FAKE_KEY,
    `${FAKE_KEY}${FAKE_KEY}`,
  ];
  for (const body of bodies) {
    const { impl } = fakeFetch([status(401, body)]);
    await assert.rejects(
      createApiModel(config, impl, fast).complete([{ role: 'user', content: '질문' }]),
      (error: Error) => {
        assert.ok(!error.message.includes(FAKE_KEY));
        assert.ok(!error.message.includes(FAKE_KEY.slice(0, 8)));
        assert.ok(error.message.includes('[가림]'));
        assert.ok(error.message.length < 300);
        return true;
      },
    );
  }
});

test('연결 실패 메시지에는 주소와 키가 들어가지 않는다', async () => {
  const { impl } = fakeFetch([
    () => {
      throw new TypeError(`connect failed https://llm.test/v1 with ${FAKE_KEY}`);
    },
  ]);
  await assert.rejects(
    createApiModel(config, impl, fast).complete([{ role: 'user', content: '질문' }]),
    (error: Error) => {
      assert.match(error.message, /연결 실패 \(TypeError\)/);
      assert.ok(!error.message.includes(FAKE_KEY));
      assert.ok(!error.message.includes('llm.test'));
      return true;
    },
  );
});
