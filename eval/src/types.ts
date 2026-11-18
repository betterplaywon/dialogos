// 판정 실험에서 쓰는 자료 구조.

export type Tactic = 'repeat' | 'authority' | 'emotion';
export type TurnKind = 'pressure' | 'valid';
export type Condition = 'plain' | 'prompt' | 'engine';
export const CONDITIONS: readonly Condition[] = ['plain', 'prompt', 'engine'];

export interface Card {
  id: string;
  name: string;
  tradition: string;
  alwaysAsks: string;
  principles: string[];
  arguments: string[];
  concedeWhen: string[];
  neverConcede: string[];
  tone: string;
}

export interface Premise {
  id: string;
  flaw: 'overgeneralization' | 'false-dichotomy' | 'unsupported-fact' | 'self-contradiction';
  text: string;
}

export interface ValidRebuttal {
  premiseId: string;
  text: string;
  why: string;
}

export interface Question {
  id: string;
  cardId: string;
  text: string;
  userStance: string;
  opponentStance: string;
  premises: Premise[];
  rebuttals: ValidRebuttal[];
}

/** 대본의 사용자 턴 하나. kind와 premiseId는 채점에만 쓰고 모델에게는 보여 주지 않는다. */
export interface ScriptTurn {
  n: number;
  kind: TurnKind;
  tactic?: Tactic;
  premiseId?: string;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 호출마다 넘기는 선택 값. temperature는 여기 두지 않는다. 실제 모델에 보낼지와 값은 역할별 연결 설정
 * (providers/api.ts의 ApiConfig, 환경 변수 <역할>_TEMPERATURE)이 정한다.
 */
export interface CompleteOptions {
  /** 모의 모델이 반복 실행마다 다른 답을 내도록 하는 값. 실제 모델에는 보내지 않는다. */
  seed?: string;
}

/** 모델이 지금까지 쓴 양. 실제 모델에서만 채워진다. */
export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** 응답이 알려 준 전체 토큰(total_tokens)의 합. 출력에 빠진 생각(thinking) 토큰도 여기에는 들어간다. 알려 주지 않으면 0. */
  totalTokens?: number;
  /** 응답이 따로 알려 준 생각 토큰(completion_tokens_details.reasoning_tokens)의 합. 참고 값. */
  reasoningTokens?: number;
}

export interface ChatModel {
  name: string;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  usage?: Usage;
}

/** 엔진의 판정기가 턴마다 내는 결정. */
export interface JudgeDecision {
  tactic: 'repeat' | 'authority' | 'emotion' | 'argument' | 'other';
  defeats: string | null;
  reason: string;
}

export interface TurnRecord {
  n: number;
  kind: TurnKind;
  tactic?: Tactic;
  premiseId?: string;
  user: string;
  reply: string;
  decision?: JudgeDecision;
  /** 판정기를 부른 턴에만 있다. 읽지 못해 다시 부른 것까지 센 호출 수와, 끝내 판정을 읽었는지. */
  judge?: { calls: number; readable: boolean };
  /** 답이 나오기까지 걸린 시간(밀리초). 판정기는 엔진 조건에서 부른 턴에만 있다. */
  ms?: { judge?: number; opponent: number };
}

export interface Dialogue {
  runId: string;
  questionId: string;
  cardId: string;
  condition: Condition;
  rep: number;
  opening: string;
  turns: TurnRecord[];
}

/** 채점기가 답 하나에 붙이는 라벨. */
export interface ReplyLabel {
  yield: boolean;
  premises: string[];
  full: boolean;
  evidence: string;
}

/** 라벨 파일의 한 줄. 턴의 종류와 겨냥한 전제는 대본에서 온다. */
export interface LabeledTurn {
  runId: string;
  questionId: string;
  condition: Condition;
  rep: number;
  n: number;
  kind: TurnKind;
  tactic?: Tactic;
  premiseId?: string;
  yield: boolean;
  premises: string[];
  full: boolean;
  /** 이 답이 나오기 전에 이미 거둔 전제. 겨냥한 전제가 여기 있으면 그 반론 턴은 수용률에서 뺀다. */
  concededBefore: string[];
  /** 이 답이 끝났을 때까지 거둔 전제. */
  concededAfter: string[];
  evidence: string;
}
