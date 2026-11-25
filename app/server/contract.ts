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

/**
 * 한 턴의 말을 넣은 방식. 'voice'는 음성 인식이 적은 글 그대로, 'voice-edited'는 인식된 글을 고쳐서 보냈다.
 * 한 값으로 두어 '글로 넣었는데 고친 음성' 같은 있을 수 없는 조합을 만들 수 없게 한다.
 */
export type TurnInput = 'text' | 'voice' | 'voice-edited';

/**
 * 한 턴을 넣은 방식과, 그 턴에서 앞서 인식된 글을 다시 말해 바꾼 횟수.
 * 고친 턴(input)은 마지막 인식 글로 세고, 다시 말한 일은 redone에 따로 남는다. 글로 넣은 턴의 redone은 0이다.
 */
export interface TurnEntry {
  input: TurnInput;
  redone: number;
}

/** 말로 넣은 턴의 수, 그 가운데 고쳐 보낸 턴의 수, 다시 말한 적이 있는 턴의 수. */
export interface VoiceTally {
  turns: number;
  edited: number;
  redone: number;
}

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
  /** 이 판에서 말로 넣은 턴과 그 가운데 고쳐 보낸 턴. 음성 인식을 올릴지 정하는 기준을 잰다. */
  voice: VoiceTally;
  /** 상대에게 기억을 넘긴 턴만, 턴 번호 차례로. 기억을 쓰지 않는 판(눈가림 비교로 시작한 판, 스키마 7 전에 시작한 판)과 넘길 기억이 없던 판은 빈 목록이다. */
  passed: PassedTurnView[];
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
  voice: VoiceTally;
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
  /** 말을 넣은 방식. 없으면 'text'다. */
  input?: TurnInput;
  /** 앞서 인식된 글을 다시 말해 바꾼 횟수. 없으면 0이다. 'text'로 넣은 턴은 0이어야 한다. */
  redone?: number;
}

export interface TurnResponse {
  turn: number;
  reply: string;
  /** 이 턴으로 판이 끝났으면 true. */
  ended: boolean;
  /** 이 턴으로 판이 끝났으면 끝난 방식(턴을 모두 씀), 아니면 null. */
  endReason: EndReason | null;
  /** 이 턴의 답을 만들 때 상대에게 넘긴 기억(넘긴 차례대로). 넘기지 않았으면 빈 목록이다. */
  memories: PassedMemoryView[];
}

export interface EndRecordRequest {
  lean: Lean;
  verdict: Verdict;
}

/**
 * 기억의 종류. claim은 지킨 입장과 첫 말, ground는 상대가 전제를 거둔 말, shift는 판 앞뒤로 바뀐 생각,
 * weakness는 근거 없이 되풀이해 밀어붙인 방식이다(app/server/memory.ts).
 */
export type MemoryKind = 'claim' | 'ground' | 'shift' | 'weakness';

/** 사용자의 기억 하나. 판이 끝나고 기록을 남길 때 서버가 규칙으로 만들고, 사용자가 고치거나 지운다. */
export interface MemoryView {
  id: string;
  /** 기억이 나온 판. 기억을 지워도 판은 남는다. */
  gameId: string;
  topicId: string;
  /** 그 판에서 사용자가 지킨 입장. */
  side: SideIndex;
  kind: MemoryKind;
  /** 한 줄 글. 상대에게 넘기는 글과 같다. */
  text: string;
  createdAt: string;
  /** 사용자가 고친 적이 있으면 true. */
  edited: boolean;
}

/**
 * 한 턴에 상대에게 넘긴 기억 하나. 턴에는 id만 남기고 보일 때 지금의 기억과 잇는다.
 * 고친 기억은 지금 글이다(상대가 받은 글은 고치기 전 글일 수 있다). 지운 기억은 글 없이 남아, 지운 글이 판 화면에 다시 나오지 않는다.
 */
export type PassedMemoryView =
  | { id: string; state: 'kept'; kind: MemoryKind; text: string; edited: boolean }
  | { id: string; state: 'deleted' };

/** 한 턴에 넘긴 기억들. turn번째 답을 만들 때 상대가 받은 것이다. */
export interface PassedTurnView {
  turn: number;
  memories: PassedMemoryView[];
}

export interface MemoriesResponse {
  memories: MemoryView[];
}

export interface EditMemoryRequest {
  text: string;
}

export interface DeleteMemoryResponse {
  deleted: true;
}

export interface ErrorResponse {
  error: string;
}
