// 대화 한 판을 돌린다. 세 조건의 차이는 상대의 답을 만드는 방식뿐이다.
// 한 턴(엔진이면 판정 → 답)은 runTurn이 맡는다. 판정 실험의 runDialogue와 서비스의 서버가 같은 함수를 불러,
// 잰 상대와 배포한 상대가 같은 코드로 답하게 한다.

import type { Card, ChatMessage, ChatModel, CompleteOptions, Condition, Dialogue, JudgeDecision, Question, TurnRecord } from './types.ts';
import { engineSystem, judgeSystem, judgeUser, plainSystem, promptSystem } from './prompts.ts';
import { buildScript, DEFAULT_TURNS, firstUserMessage, openingStatement } from './script.ts';
import { extractJson } from './util.ts';

export interface DialogueModels {
  opponent: ChatModel;
  /** 엔진 조건과, decoyJudge를 켠 지시문 조건(서버의 눈가림 비교)에서만 쓴다. */
  judge: ChatModel;
}

export interface DialogueInput {
  runId: string;
  question: Question;
  card: Card;
  condition: Condition;
  rep: number;
  models: DialogueModels;
  totalTurns?: number;
}

/** 한 판의 진행 상태. runTurn이 턴마다 고친다. */
export interface DialogueState {
  /** 상대 모델에게 넘기는 대화. 사용자의 첫 말과 상대의 첫 발언으로 시작한다. */
  history: ChatMessage[];
  /** 엔진이 지금까지 거둔 전제. */
  conceded: Set<string>;
}

export interface TurnInput {
  question: Question;
  card: Card;
  condition: Condition;
  models: DialogueModels;
  /** 사용자의 이번 말. */
  text: string;
  /** 모의 모델이 반복마다 다른 답을 내게 하는 값. 실제 모델에는 보내지 않는다. */
  seed?: string;
  /**
   * 같은 주제의 지난 판에서 서버가 넘기는 기록. 지시문 방식과 엔진 방식의 상대 지시문에만 넣고,
   * 판정기와 대화에는 넣지 않는다. 범용 조건은 입장 카드가 없어 넣지 않는다.
   * 판정 실험(runDialogue)은 넘기지 않으므로, 잰 조건의 지시문은 기록이 생기기 전과 같다.
   */
  memories?: readonly string[];
  /**
   * 지시문 조건에서도 판정기를 엔진 조건과 똑같이 부르고, 판정은 쓰지 않고 버린다. 상대의 지시문과 장부는 그대로다.
   * 눈가림 비교에서 엔진 방식 판만 판정기를 불러 답이 늦게 오면, 기다리는 시간으로 방식이 드러나기 때문이다(이슈 #25).
   * 판정 실험(runDialogue)은 넘기지 않으므로, 잰 지시문 조건은 판정기를 부르지 않는다. 엔진 조건과 범용 조건에서는 쓰지 않는다.
   */
  decoyJudge?: boolean;
}

/** 한 턴의 결과. 판정 실험의 TurnRecord에서 대본 칸(n, kind, tactic, premiseId)과 사용자의 말을 뺀 것이다. */
export interface TurnOutcome {
  reply: string;
  /** 엔진 조건에만 있다. */
  decision?: JudgeDecision;
  /** 판정기를 부른 턴에만 있다. */
  judge?: TurnRecord['judge'];
  ms: NonNullable<TurnRecord['ms']>;
}

const TACTICS: readonly JudgeDecision['tactic'][] = ['repeat', 'authority', 'emotion', 'argument', 'other'];

/** 판정기를 몇 번까지 부를지. 답을 읽지 못했을 때만 다시 부른다. */
export const JUDGE_ATTEMPTS = 2;

/** 판정기의 답을 끝내 읽지 못했을 때 쓰는 판정. 불확실하면 물러서지 않는 쪽이 이 엔진의 기본값이다. */
export const UNREADABLE_DECISION: JudgeDecision = { tactic: 'other', defeats: null, reason: '판정기의 답을 읽지 못했습니다.' };

/** 전제를 모두 내준 뒤에는 판정기를 부르지 않는다. 그 턴에 남기는 판정. */
export const NOT_JUDGED_DECISION: JudgeDecision = { tactic: 'other', defeats: null, reason: '남은 전제가 없어 판정하지 않았습니다.' };

/**
 * 판정기의 답을 읽는다. 읽을 수 없으면 null을 낸다.
 * 모르는 전제나 이미 내준 전제를 가리키면 '무너지지 않음'으로 둔다.
 */
export function parseDecision(raw: string, question: Question, conceded: ReadonlySet<string>): JudgeDecision | null {
  let data: Record<string, unknown>;
  try {
    data = extractJson(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tactic = TACTICS.find((t) => t === data.tactic) ?? 'other';
  const candidate = typeof data.defeats === 'string' ? data.defeats.trim() : null;
  const known = candidate !== null && question.premises.some((p) => p.id === candidate) && !conceded.has(candidate);
  const reason = typeof data.reason === 'string' ? data.reason : '';
  return { tactic, defeats: known ? candidate : null, reason };
}

/** 한 판의 첫 상태. 세 조건 모두 같은 첫 말과 첫 발언에서 시작한다. */
export function openingState(question: Question): DialogueState {
  return {
    history: [
      { role: 'user', content: firstUserMessage(question) },
      { role: 'assistant', content: openingStatement(question) },
    ],
    conceded: new Set<string>(),
  };
}

/** 판정기를 한 번 부른 결과. parsed는 읽은 판정이고, 끝내 읽지 못했으면 null이다. */
interface Judged {
  parsed: JudgeDecision | null;
  record: NonNullable<TurnRecord['judge']>;
  ms: number;
}

/** 사용자의 이번 말을 판정기에 묻는다. 답을 읽지 못했을 때만 JUDGE_ATTEMPTS번까지 다시 부른다. */
async function judgeTurn(
  judge: ChatModel,
  { card, question, conceded, lastReply, text }: { card: Card; question: Question; conceded: ReadonlySet<string>; lastReply: string; text: string },
  opts: CompleteOptions,
): Promise<Judged> {
  const started = performance.now();
  let parsed: JudgeDecision | null = null;
  let calls = 0;
  while (calls < JUDGE_ATTEMPTS && !parsed) {
    const raw = await judge.complete(
      [
        { role: 'system', content: judgeSystem() },
        { role: 'user', content: judgeUser(card, question, conceded, lastReply, text) },
      ],
      opts,
    );
    calls++;
    parsed = parseDecision(raw, question, conceded);
  }
  return { parsed, record: { calls, readable: parsed !== null }, ms: Math.round(performance.now() - started) };
}

/**
 * 한 턴을 돈다. 엔진 조건이면 판정기가 먼저 "이 말이 남은 전제 하나를 무너뜨렸는가"를 판정하고,
 * 그 판정을 넣은 지시문으로 상대가 답한다. 지시문 조건에서 decoyJudge를 켜면 판정기를 똑같이 부르고 판정은 버린다.
 * state의 history와 conceded는 턴을 끝까지 마쳤을 때만 바꾼다. 모델 호출이 실패하면 state는 그대로라,
 * 같은 state로 다시 시도할 수 있다.
 */
export async function runTurn(state: DialogueState, input: TurnInput): Promise<TurnOutcome> {
  const { question, card, condition, models, text, memories } = input;
  const history: ChatMessage[] = [...state.history];
  const conceded = new Set(state.conceded);
  const opts: CompleteOptions = input.seed === undefined ? {} : { seed: input.seed };
  const lastReply = history[history.length - 1]?.content ?? '';
  history.push({ role: 'user', content: text });

  let decision: JudgeDecision | undefined;
  let judged: Judged | undefined;
  let system: string;
  if (condition === 'plain') {
    system = plainSystem();
  } else if (condition === 'prompt') {
    // 판정은 쓰지 않는다. 부른 횟수, 답을 읽었는지, 걸린 시간만 남긴다.
    if (input.decoyJudge) judged = await judgeTurn(models.judge, { card, question, conceded, lastReply, text }, opts);
    system = promptSystem(card, question, memories);
  } else {
    if (conceded.size >= question.premises.length) {
      // 전제를 모두 내준 뒤에는 더 판정할 것이 없다. 판정기를 부르지 않는다.
      decision = NOT_JUDGED_DECISION;
    } else {
      judged = await judgeTurn(models.judge, { card, question, conceded, lastReply, text }, opts);
      decision = judged.parsed ?? UNREADABLE_DECISION;
      if (decision.defeats) conceded.add(decision.defeats);
    }
    system = engineSystem(card, question, conceded, decision, memories);
  }

  const started = performance.now();
  const reply = await models.opponent.complete([{ role: 'system', content: system }, ...history], opts);
  const opponentMs = Math.round(performance.now() - started);
  history.push({ role: 'assistant', content: reply });
  state.history = history;
  state.conceded = conceded;
  return {
    reply,
    ...(decision ? { decision } : {}),
    ...(judged ? { judge: judged.record } : {}),
    ms: { ...(judged ? { judge: judged.ms } : {}), opponent: opponentMs },
  };
}

export async function runDialogue(input: DialogueInput): Promise<Dialogue> {
  const { question, card, condition, rep, models } = input;
  const script = buildScript(question, input.totalTurns ?? DEFAULT_TURNS);
  const state = openingState(question);
  const turns: TurnRecord[] = [];

  for (const turn of script) {
    const seed = `${question.id}|${condition}|${rep}|${turn.n}`;
    const outcome = await runTurn(state, { question, card, condition, models, text: turn.text, seed });
    turns.push({
      n: turn.n,
      kind: turn.kind,
      ...(turn.tactic ? { tactic: turn.tactic } : {}),
      ...(turn.premiseId ? { premiseId: turn.premiseId } : {}),
      user: turn.text,
      reply: outcome.reply,
      ...(outcome.decision ? { decision: outcome.decision } : {}),
      ...(outcome.judge ? { judge: outcome.judge } : {}),
      ms: outcome.ms,
    });
  }

  return { runId: input.runId, questionId: question.id, cardId: card.id, condition, rep, opening: openingStatement(question), turns };
}
