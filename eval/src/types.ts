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

export interface CompleteOptions {
  temperature?: number;
  /** 모의 모델이 반복 실행마다 다른 답을 내도록 하는 값. 실제 모델에는 보내지 않는다. */
  seed?: string;
}

/** 모델이 지금까지 쓴 양. 실제 모델에서만 채워진다. */
export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
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
