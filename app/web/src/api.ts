// 서버 주소를 부르는 함수. 실패하면 서버가 보낸 한국어 메시지를 담은 Error를 던진다.

import type { ErrorResponse, GameView, TopicsResponse, TurnResponse } from '../../server/contract.ts';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('서버에 닿지 못했습니다. 개발 서버가 켜져 있는지 확인해 주세요.');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as Partial<ErrorResponse> | null)?.error;
    throw new Error(message ?? `서버가 ${response.status}로 답했습니다.`);
  }
  return data as T;
}

export const api = {
  topics: () => call<TopicsResponse>('/api/topics'),
  start: (topicId: string) => call<GameView>('/api/games', { topicId }),
  turn: (gameId: string, text: string) => call<TurnResponse>(`/api/games/${encodeURIComponent(gameId)}/turns`, { text }),
  end: (gameId: string) => call<GameView>(`/api/games/${encodeURIComponent(gameId)}/end`, {}),
};
