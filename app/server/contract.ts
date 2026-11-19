// 화면과 서버가 주고받는 모양. 화면은 이 파일에서 타입만 가져간다.
// 서버는 판의 방식(지시문, 엔진)과 판정, 장부를 화면에 보내지 않는다.
// 사람 비교에서 어느 쪽 상대인지 모른 채 토론하게 하려는 것이다.

/** 서버가 어떤 모델로 답하는지. 모의 모델이면 화면이 그 사실을 알린다. */
export type Provider = 'mock' | 'api';

export interface TopicView {
  id: string;
  /** 질문. */
  question: string;
  /** 이 주제에서 사용자가 맡는 입장. */
  userStance: string;
  character: { id: string; name: string };
}

export interface TopicsResponse {
  provider: Provider;
  topics: TopicView[];
}

export type Speaker = 'user' | 'opponent';

export interface MessageView {
  speaker: Speaker;
  text: string;
}

export interface GameView {
  id: string;
  topic: TopicView;
  /** 사용자의 첫 말과 상대의 첫 발언부터 지금까지. */
  messages: MessageView[];
  /** 사용자가 지금까지 보낸 턴 수. 주제에서 나온 첫 말은 세지 않는다. */
  turn: number;
  maxTurns: number;
  maxTextLength: number;
  ended: boolean;
}

/** 지난 판 목록의 한 줄. */
export interface GameSummaryView {
  id: string;
  topic: TopicView;
  turn: number;
  maxTurns: number;
  ended: boolean;
  startedAt: string;
}

export interface GamesResponse {
  games: GameSummaryView[];
}

export interface StartGameRequest {
  topicId: string;
}

export interface TurnRequest {
  text: string;
}

export interface TurnResponse {
  turn: number;
  reply: string;
  /** 이 턴으로 판이 끝났으면 true. */
  ended: boolean;
}

export interface ErrorResponse {
  error: string;
}
