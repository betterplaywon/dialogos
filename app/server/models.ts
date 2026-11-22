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
}

/**
 * 로컬 모델의 설정을 환경 변수에서 읽는다. 비어 있으면 기본값이다.
 * 주소의 기본값은 Ollama가 처음부터 여는 주소(127.0.0.1의 11434번)의 OpenAI 호환 경로다.
 * 판정기 모델을 따로 적지 않으면 상대와 같은 모델을 쓴다. 메모리(16GB)에 모델 둘을 함께 올리지 않으려는 것이다.
 */
export function localConfigFromEnv(env: Env): LocalConfig {
  const opponent = env.APP_LOCAL_MODEL?.trim() || 'exaone3.5:7.8b';
  return {
    url: env.APP_LOCAL_URL?.trim() || 'http://127.0.0.1:11434/v1',
    models: { opponent, judge: env.APP_LOCAL_JUDGE_MODEL?.trim() || opponent },
  };
}

/** 이 컴퓨터를 가리키는 호스트. URL이 고쳐 쓴 꼴(소문자, IPv6는 대괄호 안)로 견준다. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 로컬 모델은 이 컴퓨터에서 돌아 청구될 곳이 없다. 그래서 두 역할의 단가가 0이다. */
const FREE: Price = { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };

/**
 * 로컬 모델 한 호출의 시간 제한과 다시 부르기. 로컬 모델은 느리고, 쉬던 모델을 메모리에 다시 올리는 호출은 더 걸린다고 보고
 * 넉넉히 잡은 값이다(추정, 재지 않음). 설치 뒤 재서 고친다.
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

function isLoopback(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return (protocol === 'http:' || protocol === 'https:') && LOOPBACK_HOSTS.has(hostname);
}

/**
 * 로컬 모델의 출처. 주소가 이 컴퓨터(http나 https, 호스트는 127.0.0.1, localhost, [::1])가 아니면 만들지 않는다.
 * 주소 검사는 로컬 출처를 만드는 이 함수에만 둔다. 그래서 요금이 드는 원격 주소로 가는 로컬 출처는 생기지 않는다.
 * 실제 모델처럼 부를 때마다 사용량을 원장에 남기지만, 단가가 0이라 비용은 0이고 서비스 비용 상한에 닿지 않는다.
 */
export function localSource(config: LocalConfig, fetchImpl: FetchLike = fetch): ModelSource {
  if (!isLoopback(config.url)) {
    throw new Error(
      'APP_LOCAL_URL에는 이 컴퓨터의 주소만 적습니다(http나 https, 호스트는 127.0.0.1, localhost, [::1]). 원격 주소와 사설망 주소로는 띄우지 않습니다.',
    );
  }
  return {
    provider: 'api',
    prices: { opponent: FREE, judge: FREE },
    create: (role) => metered(createApiModel({ baseUrl: config.url, apiKey: NO_KEY, model: config.models[role] }, fetchImpl, LOCAL_CALL)),
  };
}

/** 띄울 때 모델 목록을 기다리는 시간. 목록을 읽는 데는 모델을 올리지 않아 금방 끝난다고 보고 정했다(추정). */
const CHECK_TIMEOUT_MS = 5_000;

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
 * 띄울 때의 확인. OpenAI 호환 모델 목록(GET {주소}/models)으로 로컬 모델 서버에 닿는지와 두 역할의 모델이 있는지 본다.
 * 문제가 없으면 null이고, 있으면 사람이 할 일을 알리는 말이다. 모델은 부르지 않는다.
 * 주소는 localSource가 검사한 것을 받는다. 개발 서버(dev.ts)는 출처를 만든 뒤에 이 확인을 부른다.
 */
export async function localProblem(config: LocalConfig, fetchImpl: FetchLike = fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.url.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch {
    return [
      '로컬 모델 서버에 닿지 못했습니다. Ollama 앱을 켠 뒤 다시 띄워 주세요.',
      'APP_LOCAL_URL로 주소를 바꿨다면 그 주소에서 도는지도 확인해 주세요.',
    ].join('\n');
  }
  const listed = response.ok ? modelNames(await response.json().catch(() => null)) : null;
  if (!listed) {
    return [
      `로컬 모델 서버가 모델 목록을 알려 주지 않았습니다(상태 ${response.status}).`,
      'APP_LOCAL_URL에는 OpenAI 호환 주소를 /v1까지 적습니다(기본값 http://127.0.0.1:11434/v1).',
    ].join('\n');
  }
  const missing = [...new Set(Object.values(config.models))].filter((name) => !listed.has(name));
  if (missing.length === 0) return null;
  return [
    `로컬 모델 서버에 이 모델이 없습니다: ${missing.join(', ')}`,
    '터미널에서 받은 뒤 다시 띄워 주세요.',
    ...missing.map((name) => `  ollama pull ${name}`),
  ].join('\n');
}
