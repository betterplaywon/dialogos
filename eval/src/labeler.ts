// 채점기로 답마다 라벨을 붙인다. 채점기는 조건과 턴의 종류를 보지 않는다.

import type { ChatModel, Dialogue, LabeledTurn, Question, ReplyLabel } from './types.ts';
import { scorerSystem, scorerUser } from './prompts.ts';
import { extractJson } from './util.ts';

/** 채점기의 답을 읽는다. 이미 거둔 전제와 모르는 id는 버린다. */
export function parseLabel(raw: string, question: Question, conceded: ReadonlySet<string>): ReplyLabel {
  const data = extractJson(raw) as Record<string, unknown>;
  if (typeof data.yield !== 'boolean') throw new Error('yield 값이 없습니다.');
  const full = data.full === true;
  const listed = Array.isArray(data.premises) ? data.premises.filter((p): p is string => typeof p === 'string') : [];
  const premises = [...new Set(listed.map((p) => p.trim()))].filter(
    (id) => question.premises.some((p) => p.id === id) && !conceded.has(id),
  );
  return {
    yield: data.yield || full || premises.length > 0,
    premises,
    full,
    evidence: typeof data.evidence === 'string' ? data.evidence : '',
  };
}

/** 채점기를 몇 번까지 부를지. 답을 읽지 못했을 때만 다시 부른다. */
export const SCORER_ATTEMPTS = 3;

export async function labelDialogue(dialogue: Dialogue, question: Question, scorer: ChatModel, maxAttempts = SCORER_ATTEMPTS): Promise<LabeledTurn[]> {
  const conceded = new Set<string>();
  const out: LabeledTurn[] = [];
  for (const turn of dialogue.turns) {
    let label: ReplyLabel | undefined;
    let lastError = '';
    for (let attempt = 0; attempt < maxAttempts && !label; attempt++) {
      const raw = await scorer.complete(
        [
          { role: 'system', content: scorerSystem() },
          { role: 'user', content: scorerUser(question, conceded, turn.user, turn.reply) },
        ],
        { temperature: 0 },
      );
      try {
        label = parseLabel(raw, question, conceded);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!label) {
      throw new Error(`채점기의 답을 읽지 못했습니다 (${dialogue.questionId}, ${dialogue.condition}, ${dialogue.rep}번째, ${turn.n}턴): ${lastError}`);
    }
    const concededBefore = [...conceded].sort();
    for (const id of label.premises) conceded.add(id);
    if (label.full) for (const premise of question.premises) conceded.add(premise.id);
    out.push({
      runId: dialogue.runId,
      questionId: dialogue.questionId,
      condition: dialogue.condition,
      rep: dialogue.rep,
      n: turn.n,
      kind: turn.kind,
      ...(turn.tactic ? { tactic: turn.tactic } : {}),
      ...(turn.premiseId ? { premiseId: turn.premiseId } : {}),
      yield: label.yield,
      premises: label.premises,
      full: label.full,
      concededBefore,
      concededAfter: [...conceded].sort(),
      evidence: label.evidence,
    });
  }
  return out;
}
