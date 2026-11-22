// 서버가 쓰는 모델의 출처. 모의 모델과, 이 컴퓨터에서 도는 로컬 모델(Ollama의 OpenAI 호환 주소)이 있다.
// 로컬 모델은 이 컴퓨터 안의 주소로만 부르고 단가가 0이라 돈이 들지 않는다.
// 요금이 드는 모델은 아직 붙이지 않았고, 붙이는 때는 사용자가 정한다.

import { createApiModel, type ApiOptions } from '../../eval/src/providers/api.ts';
import { createMockModel } from '../../eval/src/providers/mock.ts';
import type { ChatModel } from '../../eval/src/types.ts';
import type { MeteredModel, ModelSource, Price } from './budget.ts';
import type { ModelRole } from './store.ts';

type Env = Readonly<Record<string, string | undefined>>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 모의 모델. 돈이 들지 않아 원장에 남기지 않지만, 하루 턴 수에는 든다. */
export function mockSource(): ModelSource {
  return { provider: 'mock', create: (role) => createMockModel(role) };
}

/** 로컬 모델의 설정. */
export interface LocalConfig {
  /** 로컬 모델 서버의 OpenAI 호환 주소(…/v1). 이 컴퓨터의 주소인지는 localSource가 검사한다. */
  url: string;
  /** 역할별 모델 이름. */
  models: Readonly<Record<ModelRole, string>>;
  /** 모델이 답하기 전에 생각(추론)하게 둘지. 두지 않으면 요청마다 생각을 끈다. */
  think: boolean;
}

/**
 * 로컬 모델의 설정을 환경 변수에서 읽는다. 비어 있으면 기본값이다.
 * 주소의 기본값은 Ollama가 처음부터 여는 주소(127.0.0.1의 11434번)의 OpenAI 호환 경로이고, 모델의 기본값은 qwen3:8b다.
 * 판정기 모델을 따로 적지 않으면 상대와 같은 모델을 쓴다. 메모리(16GB)에 모델 둘을 함께 올리지 않으려는 것이다.
 * 생각은 기본으로 끄고, APP_LOCAL_THINK=1이면 모델의 기본대로 생각하게 둔다(느리다). 그 밖의 값이면 까닭을 알리는 오류를 던진다.
 */
export function localConfigFromEnv(env: Env): LocalConfig {
  const opponent = env.APP_LOCAL_MODEL?.trim() || 'qwen3:8b';
  const think = env.APP_LOCAL_THINK?.trim() || '';
  if (think !== '' && think !== '1') {
    throw new Error('APP_LOCAL_THINK에는 1만 적습니다. 1이면 모델이 생각한 뒤 답하고(느립니다), 적지 않으면 생각을 끕니다.');
  }
  return {
    url: env.APP_LOCAL_URL?.trim() || 'http://127.0.0.1:11434/v1',
    models: { opponent, judge: env.APP_LOCAL_JUDGE_MODEL?.trim() || opponent },
    think: think === '1',
  };
}

/** 이 컴퓨터를 가리키는 호스트. URL이 고쳐 쓴 꼴(소문자, IPv6는 대괄호 안)로 견준다. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 로컬 모델은 이 컴퓨터에서 돌아 청구될 곳이 없다. 그래서 두 역할의 단가가 0이다. */
const FREE: Price = { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };

/**
 * 로컬 모델 한 호출의 시간 제한과 다시 부르기. 실측(2026-11-22, Apple M1 16GB, 엔진 방식 6턴)에서 한 호출은 길어야
 * qwen3:8b가 생각을 끄면 19초, 켜면 79초, exaone3.5:7.8b가 45초였다. 쉬던 모델을 메모리에 다시 올리는 호출은 더 걸린다고 보고
 * (추정, 따로 재지 않음) 넉넉히 잡은 값이다.
 */
const LOCAL_CALL: ApiOptions = { timeoutMs: 3 * 60_000, maxRetries: 1 };

/**
 * 키 자리에 넣는 값. Ollama는 키를 보지 않는다(공식 문서). createApiModel은 오류 글에서 키와 같은 글자를 '[가림]'으로 바꾸므로,
 * 오류 글의 다른 낱말에 들어가지 않을 값을 둔다. 'local'이면 오류 글의 'localhost'가 망가진다.
 */
const NO_KEY = 'dialogos-no-key';

/** createApiModel의 모델은 언제나 사용량을 센다. 타입에는 드러나지 않아 여기서 확인한다. */
function metered(model: ChatModel): MeteredModel {
  const { usage } = model;
  if (!usage) throw new Error(`${model.name}는 사용량을 세지 않습니다.`);
  return { ...model, usage };
}

/** APP_LOCAL_URL이 로컬 출처의 주소가 될 수 없으면 사람이 고칠 것을 알리는 말이고, 될 수 있으면 null이다. */
function urlProblem(url: string): string | null {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || !(parsed.protocol === 'http:' || parsed.protocol === 'https:') || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return 'APP_LOCAL_URL에는 이 컴퓨터의 주소만 적습니다(http나 https, 호스트는 127.0.0.1, localhost, [::1]). 원격 주소와 사설망 주소로는 띄우지 않습니다.';
  }
  // fetch는 사용자 정보가 든 주소로 요청을 만들지 않는다. 받아 두면 띄울 때 확인이 닿지 못했다며 Ollama 앱을 켜라고 틀리게 알린다.
  if (parsed.username || parsed.password) {
    return 'APP_LOCAL_URL에서 @ 앞의 사용자 정보(이름과 비밀번호)를 빼 주세요. 사용자 정보가 든 주소로는 요청을 보낼 수 없습니다(예: http://127.0.0.1:11434/v1).';
  }
  return null;
}

/**
 * 로컬 모델 서버로 가는 요청은 모두 이 fetch로 보낸다(localSource와 localProblem). 넘김(redirect) 응답은 따라가지 않고 그 요청을 실패로 둔다.
 * 주소 검사는 처음 주소만 본다. fetch의 기본값대로 넘김을 따라가면, 이 컴퓨터의 프로그램이 넘긴 검사하지 않은 곳으로
 * 지시문과 사용자의 글이 나간다(307과 308은 본문을 그대로 넘긴다).
 */
function noRedirects(fetchImpl: FetchLike): FetchLike {
  return (url, init) => fetchImpl(url, { ...init, redirect: 'error' });
}

/**
 * 로컬 모델의 출처. 주소가 이 컴퓨터(http나 https, 호스트는 127.0.0.1, localhost, [::1])가 아니거나 사용자 정보가 들어 있으면 만들지 않는다.
 * 주소 검사는 로컬 출처를 만드는 이 함수에만 둔다. 요청은 넘김을 따라가지 않으므로(noRedirects) 검사한 주소 밖으로 나가지 않는다.
 * 그래서 요금이 드는 원격 주소로 가는 로컬 출처는 생기지 않는다.
 * 실제 모델처럼 부를 때마다 사용량을 원장에 남기지만, 단가가 0이라 비용은 0이고 서비스 비용 상한에 닿지 않는다.
 */
export function localSource(config: LocalConfig, fetchImpl: FetchLike = fetch): ModelSource {
  const problem = urlProblem(config.url);
  if (problem) throw new Error(problem);
  const send = noRedirects(fetchImpl);
  // 생각을 끌 때는 reasoning_effort "none"을 보낸다. Ollama는 생각을 켜고 끄기만 하는 모델(qwen3 등)에서 "none"을 생각 끔으로 받는다
  // (Ollama 문서 'OpenAI compatibility'). 보내지 않으면 모델의 기본대로 한다.
  const effort = config.think ? {} : { reasoningEffort: 'none' };
  return {
    provider: 'api',
    prices: { opponent: FREE, judge: FREE },
    create: (role) =>
      metered(createApiModel({ baseUrl: config.url, apiKey: NO_KEY, model: config.models[role], ...effort }, send, LOCAL_CALL)),
  };
}

/** 띄울 때 목록 하나를 기다리는 시간. 목록을 읽는 데는 모델을 올리지 않아 금방 끝난다고 보고 정했다(추정). */
const CHECK_TIMEOUT_MS = 5_000;

/** 띄울 때 로컬 모델 서버에 닿지 못했거나 넘김(redirect)을 받았을 때의 안내. */
const UNREACHABLE = [
  '로컬 모델 서버에 닿지 못했습니다. Ollama 앱을 켠 뒤 다시 띄워 주세요.',
  'APP_LOCAL_URL로 주소를 바꿨다면 그 주소에서 도는지도 확인해 주세요.',
].join('\n');

/** OpenAI 호환 모델 목록({ data: [{ id }] })에서 모델 이름을 꺼낸다. 그 꼴이 아니면 null이다. */
function modelNames(body: unknown): Set<string> | null {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) return null;
  return new Set(
    body.data.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? [item.id] : [],
    ),
  );
}

/**
 * Ollama의 모델 목록({ models: [{ name, model, remote_host, remote_model }] })에서 원격 모델의 이름을 꺼낸다. 그 꼴이 아니면 null이다.
 * Ollama 문서('List models')는 remote_host와 remote_model을 원격 모델일 때 있는 칸(모델이 실제로 도는 Ollama 호스트의 주소와 그곳의 모델 이름)으로 적는다.
 */
function remoteModelNames(body: unknown): Set<string> | null {
  if (typeof body !== 'object' || body === null || !('models' in body) || !Array.isArray(body.models)) return null;
  return new Set(
    body.models.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return [];
      const { name, model, remote_host: host, remote_model: upstream } = item as Record<string, unknown>;
      return host || upstream ? [name, model].filter((value) => typeof value === 'string') : [];
    }),
  );
}

/**
 * 띄울 때의 확인. 문제가 없으면 null이고, 있으면 사람이 할 일을 알리는 말이다. 목록만 읽고 모델은 부르지 않는다.
 * 1. OpenAI 호환 모델 목록(GET {주소}/models)으로 로컬 모델 서버에 닿는지와 두 역할의 모델이 있는지 본다.
 * 2. Ollama의 모델 목록(GET /api/tags)이 두 역할의 모델을 원격 모델로 적으면 띄우지 않는다.
 * 주소는 localSource가 검사한 것을 받는다. 개발 서버(dev.ts)는 출처를 만든 뒤에 이 확인을 부른다.
 */
export async function localProblem(config: LocalConfig, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const send = noRedirects(fetchImpl);
  /** 목록 하나를 GET한다. 닿지 못했거나 넘김을 받았으면 null이다. */
  const get = (url: string) => send(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }).catch(() => null);

  const listing = await get(`${config.url.replace(/\/+$/, '')}/models`);
  if (!listing) return UNREACHABLE;
  const listed = listing.ok ? modelNames(await listing.json().catch(() => null)) : null;
  if (!listed) {
    return [
      `로컬 모델 서버가 모델 목록을 알려 주지 않았습니다(상태 ${listing.status}).`,
      'APP_LOCAL_URL에는 OpenAI 호환 주소를 /v1까지 적습니다(기본값 http://127.0.0.1:11434/v1).',
    ].join('\n');
  }
  const wanted = [...new Set(Object.values(config.models))];
  const missing = wanted.filter((name) => !listed.has(name));
  if (missing.length > 0) {
    return [
      `로컬 모델 서버에 이 모델이 없습니다: ${missing.join(', ')}`,
      '터미널에서 받은 뒤 다시 띄워 주세요.',
      ...missing.map((name) => `  ollama pull ${name}`),
    ].join('\n');
  }

  // Ollama의 클라우드 모델은 로컬 API로 불러도 Ollama의 클라우드에서 돈다(Ollama 문서 'Cloud'). 클라우드 모델이 이 목록에
  // 원격 모델로 나오는지는 문서에 적혀 있지 않고 확인하지 못했다(추정). 확실히 막는 길은 Ollama의 클라우드 기능을 끄는 것이다(Ollama FAQ).
  // 이 목록이 없는 서버(404 등)는 Ollama가 아니어서 Ollama의 클라우드 모델도 없으므로, 이 확인을 건너뛴다.
  const tags = await get(new URL('/api/tags', config.url).href);
  if (!tags) return UNREACHABLE;
  const remote = tags.ok ? remoteModelNames(await tags.json().catch(() => null)) : null;
  const elsewhere = wanted.filter((name) => remote?.has(name));
  if (elsewhere.length === 0) return null;
  return [
    `로컬 모델 서버의 목록에 이 모델이 원격 모델로 나옵니다: ${elsewhere.join(', ')}`,
    '원격 모델은 다른 Ollama 호스트(Ollama의 클라우드 등)에서 돌아 대화가 이 컴퓨터 밖으로 나가므로 띄우지 않습니다.',
    '이 컴퓨터에서 도는 모델을 받아 APP_LOCAL_MODEL(판정기는 APP_LOCAL_JUDGE_MODEL)에 적어 주세요.',
  ].join('\n');
}
