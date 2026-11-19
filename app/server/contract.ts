// 화면과 서버가 주고받는 모양. 화면은 이 파일에서 타입만 가져간다.
// 서버는 판의 방식(지시문, 엔진)과 판정, 장부를 화면에 보내지 않는다.
// 사람 비교에서 어느 쪽 상대인지 모른 채 토론하게 하려는 것이다.

/** 서버가 어떤 모델로 답하는지. 모의 모델이면 화면이 그 사실을 알린다. */
export type Provider = 'mock' | 'api';

/** 주제의 두 입장 가운데 하나(sides의 번호). */
export type SideIndex = 0 | 1;

/**
 * 다섯 칸 척도로 고른 생각. 음수는 sides[0], 양수는 sides[1]의 입장 쪽이다.
 * 크기 2는 '확실히', 1은 '대체로', 0은 '반반'이다.
 */
export type Lean = -2 | -1 | 0 | 1 | 2;

/** 훈계 문항("이번 판은 토론이었습니까, 훈계였습니까")의 답. */
export type Verdict = 'debate' | 'lecture';

/** 판이 끝난 방식. 턴을 모두 썼거나(max-turns), 사용자가 끝내기를 눌렀다(user). */
export type EndReason = 'max-turns' | 'user';

export interface CharacterView {
  id: string;
  name: string;
}

export interface SideView {
  /** 이 쪽의 입장. */
  stance: string;
  /** 사용자가 이 입장을 지키면 맞설 상대. null이면 아직 이 쪽은 고를 수 없다. */
  opponent: CharacterView | null;
}

export interface TopicView {
  id: string;
  /** 질문. */
  question: string;
  /** 두 입장. 척도의 왼쪽 끝이 sides[0], 오른쪽 끝이 sides[1]이다. */
  sides: [SideView, SideView];
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

/** 판이 끝난 뒤 사용자가 남기는 기록: 지금의 생각(사후 입장)과 훈계 문항의 답. */
export interface EndRecordView {
  lean: Lean;
  verdict: Verdict;
}

export interface GameView {
  id: string;
  topic: TopicView;
  /** 사용자가 지키는 입장. 상대는 반대쪽 입장에서 시작한다. */
  side: SideIndex;
  /** 판을 시작할 때 고른 생각. 이 기록을 받기 전에 시작한 판은 null이다. */
  startLean: Lean | null;
  /** 사용자의 첫 말과 상대의 첫 발언부터 지금까지. */
  messages: MessageView[];
  /** 사용자가 지금까지 보낸 턴 수. 주제에서 나온 첫 말은 세지 않는다. */
  turn: number;
  maxTurns: number;
  maxTextLength: number;
  ended: boolean;
  /** 끝난 방식. 끝나지 않았거나, 이 기록을 받기 전에 끝난 판은 null이다. */
  endReason: EndReason | null;
  /** 끝난 판에 남긴 기록. 남기기 전에는 null이고, 화면은 남길 때까지 판을 닫지 않는다. */
  record: EndRecordView | null;
}

/** 지난 판 목록의 한 줄. */
export interface GameSummaryView {
  id: string;
  topic: TopicView;
  side: SideIndex;
  startLean: Lean | null;
  turn: number;
  maxTurns: number;
  ended: boolean;
  record: EndRecordView | null;
  startedAt: string;
}

export interface GamesResponse {
  games: GameSummaryView[];
}

export interface StartGameRequest {
  topicId: string;
  /** 지킬 입장. lean이 0이 아니면 lean이 가리키는 쪽이어야 한다. */
  side: SideIndex;
  lean: Lean;
}

export interface TurnRequest {
  text: string;
}

export interface TurnResponse {
  turn: number;
  reply: string;
  /** 이 턴으로 판이 끝났으면 true. */
  ended: boolean;
  /** 이 턴으로 판이 끝났으면 끝난 방식(턴을 모두 씀), 아니면 null. */
  endReason: EndReason | null;
}

export interface EndRecordRequest {
  lean: Lean;
  verdict: Verdict;
}

export interface ErrorResponse {
  error: string;
}
