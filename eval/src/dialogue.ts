// 대화 한 판을 돌린다. 세 조건의 차이는 상대의 답을 만드는 방식뿐이다.

import type { Card, ChatMessage, ChatModel, Condition, Dialogue, JudgeDecision, Question, TurnRecord } from './types.ts';
import { engineSystem, judgeSystem, judgeUser, plainSystem, promptSystem } from './prompts.ts';
import { buildScript, DEFAULT_TURNS, firstUserMessage, openingStatement } from './script.ts';
import { extractJson } from './util.ts';

export interface DialogueModels {
  opponent: ChatModel;
  /** 엔진 조건에서만 쓴다. */
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
  opponentTemperature?: number;
}

const TACTICS: readonly JudgeDecision['tactic'][] = ['repeat', 'authority', 'emotion', 'argument', 'other'];

/** 판정기를 몇 번까지 부를지. 답을 읽지 못했을 때만 다시 부른다. */
export const JUDGE_ATTEMPTS = 2;

/** 판정기의 답을 끝내 읽지 못했을 때 쓰는 판정. 불확실하면 물러서지 않는 쪽이 이 엔진의 기본값이다. */
export const UNREADABLE_DECISION: JudgeDecision = { tactic: 'other', defeats: null, reason: '판정기의 답을 읽지 못했습니다.' };

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

export async function runDialogue(input: DialogueInput): Promise<Dialogue> {
  const { question, card, condition, rep, models } = input;
  const temperature = input.opponentTemperature ?? 0.7;
  const script = buildScript(question, input.totalTurns ?? DEFAULT_TURNS);
  const opening = openingStatement(question);
  const history: ChatMessage[] = [
    { role: 'user', content: firstUserMessage(question) },
    { role: 'assistant', content: opening },
  ];
  const conceded = new Set<string>();
  const turns: TurnRecord[] = [];

  for (const turn of script) {
    const seed = `${question.id}|${condition}|${rep}|${turn.n}`;
    const lastReply = history[history.length - 1]?.content ?? '';
    history.push({ role: 'user', content: turn.text });

    let decision: JudgeDecision | undefined;
    let judgeMs: number | undefined;
    let judgeRecord: TurnRecord['judge'];
    let system: string;
    if (condition === 'plain') {
      system = plainSystem();
    } else if (condition === 'prompt') {
      system = promptSystem(card, question);
    } else {
      if (conceded.size >= question.premises.length) {
        // 전제를 모두 내준 뒤에는 더 판정할 것이 없다. 판정기를 부르지 않는다.
        decision = { tactic: 'other', defeats: null, reason: '남은 전제가 없어 판정하지 않았습니다.' };
      } else {
        const started = performance.now();
        let parsed: JudgeDecision | null = null;
        let calls = 0;
        while (calls < JUDGE_ATTEMPTS && !parsed) {
          const raw = await models.judge.complete(
            [
              { role: 'system', content: judgeSystem() },
              { role: 'user', content: judgeUser(card, question, conceded, lastReply, turn.text) },
            ],
            { temperature: 0, seed },
          );
          calls++;
          parsed = parseDecision(raw, question, conceded);
        }
        judgeMs = Math.round(performance.now() - started);
        judgeRecord = { calls, readable: parsed !== null };
        decision = parsed ?? UNREADABLE_DECISION;
        if (decision.defeats) conceded.add(decision.defeats);
      }
      system = engineSystem(card, question, conceded, decision);
    }

    const started = performance.now();
    const reply = await models.opponent.complete([{ role: 'system', content: system }, ...history], { temperature, seed });
    const opponentMs = Math.round(performance.now() - started);
    history.push({ role: 'assistant', content: reply });
    turns.push({
      n: turn.n,
      kind: turn.kind,
      ...(turn.tactic ? { tactic: turn.tactic } : {}),
      ...(turn.premiseId ? { premiseId: turn.premiseId } : {}),
      user: turn.text,
      reply,
      ...(decision ? { decision } : {}),
      ...(judgeRecord ? { judge: judgeRecord } : {}),
      ms: { ...(judgeMs !== undefined ? { judge: judgeMs } : {}), opponent: opponentMs },
    });
  }

  return { runId: input.runId, questionId: question.id, cardId: card.id, condition, rep, opening, turns };
}
