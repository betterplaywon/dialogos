// 서버 주소를 부르는 함수. 실패하면 서버가 보낸 한국어 메시지를 담은 ApiError를 던진다.

import type {
  EndRecordRequest,
  ErrorResponse,
  GamesResponse,
  GameView,
  Lean,
  SideIndex,
  StartGameRequest,
  TopicsResponse,
  TurnEntry,
  TurnRequest,
  TurnResponse,
  Verdict,
} from '../../server/contract.ts';

/** 서버 요청의 실패. status가 없으면 서버에 닿지 못한 것이다. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  /** 서버가 요청을 받아 보고 거절한 것(4xx)이면 true. 이때는 서버에 바뀐 것이 없다. */
  get rejected(): boolean {
    return this.status !== undefined && this.status >= 400 && this.status < 500;
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('서버에 닿지 못했습니다. 개발 서버가 켜져 있는지 확인해 주세요.');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as Partial<ErrorResponse> | null)?.error;
    throw new ApiError(message ?? `서버가 ${response.status}로 답했습니다.`, response.status);
  }
  return data as T;
}

const gamePath = (gameId: string) => `/api/games/${encodeURIComponent(gameId)}`;

export const api = {
  topics: () => call<TopicsResponse>('/api/topics'),
  list: () => call<GamesResponse>('/api/games'),
  start: (topicId: string, side: SideIndex, lean: Lean) =>
    call<GameView>('/api/games', { topicId, side, lean } satisfies StartGameRequest),
  get: (gameId: string) => call<GameView>(gamePath(gameId)),
  turn: (gameId: string, text: string, entry: TurnEntry) =>
    call<TurnResponse>(`${gamePath(gameId)}/turns`, { text, input: entry.input, redone: entry.redone } satisfies TurnRequest),
  end: (gameId: string) => call<GameView>(`${gamePath(gameId)}/end`, {}),
  record: (gameId: string, lean: Lean, verdict: Verdict) =>
    call<GameView>(`${gamePath(gameId)}/record`, { lean, verdict } satisfies EndRecordRequest),
};
