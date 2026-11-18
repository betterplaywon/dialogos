// OpenAI 호환 방식(chat completions)으로 실제 모델을 부른다.
// 주소, 키, 모델 이름은 모두 환경 변수에서 읽는다. 키는 어디에도 출력하지 않는다.

import type { ChatMessage, ChatModel, CompleteOptions, Usage } from '../types.ts';

export type ApiRole = 'opponent' | 'judge' | 'scorer';

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 적었을 때만 보낸다. Gemini 3.6 이후 모델은 temperature를 무시하고, 앞으로는 보내면 오류를 낸다고
   * 공식 문서에 예고되어 있다(2026-11 확인). 받는 모델에서 값을 고정하고 싶을 때만 적는다.
   */
  temperature?: number;
  /** 생각(thinking) 수준. OpenAI 호환 요청의 reasoning_effort로 보낸다. 비우면 모델 기본값이다. */
  reasoningEffort?: string;
}

export interface ApiOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Attempt = { ok: true; text: string } | { ok: false; retry: boolean; message: string; waitMs?: number };

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 60000;

/**
 * 역할별 변수(OPPONENT_*)가 있으면 그것을, 없으면 공통 변수(LLM_*)를 쓴다.
 * temperature와 생각 수준은 역할별 변수(<역할>_TEMPERATURE, <역할>_REASONING_EFFORT)를 적었을 때만 쓴다.
 */
export function apiConfigFromEnv(role: ApiRole, env: Env = process.env): ApiConfig {
  const prefix = role.toUpperCase();
  const baseUrl = env[`${prefix}_BASE_URL`] || env.LLM_BASE_URL;
  const apiKey = env[`${prefix}_API_KEY`] || env.LLM_API_KEY;
  const model = env[`${prefix}_MODEL`];
  const missing: string[] = [];
  if (!baseUrl) missing.push(`${prefix}_BASE_URL 또는 LLM_BASE_URL`);
  if (!apiKey) missing.push(`${prefix}_API_KEY 또는 LLM_API_KEY`);
  if (!model) missing.push(`${prefix}_MODEL`);
  if (!baseUrl || !apiKey || !model) {
    throw new Error(`환경 변수가 비어 있습니다: ${missing.join(', ')}. 값은 로컬의 .env에만 적습니다.`);
  }
  const temperatureText = env[`${prefix}_TEMPERATURE`]?.trim();
  const temperature = temperatureText ? Number(temperatureText) : undefined;
  if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) {
    throw new Error(`${prefix}_TEMPERATURE에는 0에서 2 사이의 숫자를 적습니다. 보내지 않으려면 비워 둡니다.`);
  }
  const reasoningEffort = env[`${prefix}_REASONING_EFFORT`]?.trim() || undefined;
  if (reasoningEffort !== undefined && !/^[a-z]+$/.test(reasoningEffort)) {
    throw new Error(`${prefix}_REASONING_EFFORT에는 low, medium, high처럼 소문자 낱말 하나를 적습니다.`);
  }
  return { baseUrl, apiKey, model, ...(temperature !== undefined ? { temperature } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** 오류 글에 키가 섞여 나와도 화면과 기록에 남지 않게 가린다. 가린 뒤에 자른다. */
function redact(text: string, secret: string): string {
  return (secret ? text.split(secret).join('[가림]') : text).slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 서버가 알려 준 대기 시간(초)을 읽는다. 없거나 읽을 수 없으면 undefined. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : undefined;
}

type ReportedUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
};

export function createApiModel(config: ApiConfig, fetchImpl: FetchLike = fetch, options: ApiOptions = {}): ChatModel {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60000;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const usage: Required<Usage> = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };

  function count(reported: ReportedUsage | undefined): void {
    const add = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    usage.promptTokens += add(reported?.prompt_tokens);
    usage.completionTokens += add(reported?.completion_tokens);
    usage.totalTokens += add(reported?.total_tokens);
    usage.reasoningTokens += add(reported?.completion_tokens_details?.reasoning_tokens);
  }

  async function once(messages: ChatMessage[]): Promise<Attempt> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : '알 수 없는 오류';
      return { ok: false, retry: true, message: `연결 실패 (${reason})` };
    }
    if (!response.ok) {
      const body = redact(await response.text().catch(() => ''), config.apiKey);
      const waitMs = retryAfterMs(response);
      return {
        ok: false,
        retry: RETRY_STATUS.has(response.status),
        message: `상태 ${response.status}: ${body}`,
        ...(waitMs !== undefined ? { waitMs } : {}),
      };
    }
    let data: { choices?: { message?: { content?: unknown } }[]; usage?: ReportedUsage };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      return { ok: false, retry: true, message: '답을 JSON으로 읽지 못했습니다.' };
    }
    usage.calls++;
    count(data.usage);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, retry: true, message: '답이 비어 있습니다.' };
    }
    return { ok: true, text };
  }

  return {
    name: config.model,
    usage,
    // 호출마다 넘기는 선택 값(seed)은 모의 모델용이라 실제 모델에는 보내지 않는다.
    async complete(messages: ChatMessage[], _opts?: CompleteOptions) {
      let last = '';
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const result = await once(messages);
        if (result.ok) return result.text;
        last = result.message;
        if (!result.retry || attempt === maxRetries) break;
        await sleep(result.waitMs ?? baseDelayMs * 2 ** attempt * (0.5 + Math.random() / 2));
      }
      throw new Error(`모델 호출 실패 (${config.model}): ${last}`);
    },
  };
}
