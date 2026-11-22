// 통과 기준에는 쓰지 않는 점검 값. 시범 실행과 본 실행에서 볼 것을 실행마다 같은 방식으로 센다.
// - 판정기: 끝내 읽지 못한 판정, 다시 부른 호출, 대본이 정한 턴의 종류와 판정이 맞았는지
// - 엔진의 답: 판정이 시킨 대로 물러서거나 버텼는지(채점기 라벨로 센다)
// - 사용량과 걸린 시간: 역할별 토큰과 대화 1회 평균, 조건별 시간
// 결과표(results.md) 끝의 '점검' 절과 results.json의 checks가 이 값이다.

import { NOT_JUDGED_DECISION, UNREADABLE_DECISION } from './dialogue.ts';
import type { RunMeta } from './runio.ts';
import { CONDITIONS, type Condition, type Dialogue, type LabeledTurn, type TurnRecord, type Usage } from './types.ts';
import { billedOutputTokens, percent, quantile } from './util.ts';

export interface JudgeChecks {
  /** 엔진 조건의 대화 수. */
  dialogues: number;
  /** 판정기를 부른 턴. 전제를 모두 내준 뒤의 턴에서는 부르지 않는다. */
  judged: number;
  /** 끝내 읽지 못해 '무너지지 않음'으로 둔 턴. */
  unreadable: number;
  /** 읽지 못해 다시 부른 호출. 호출 수가 적히지 않은 기록에서는 세지 못한다. */
  retries: number;
  /** 압박 턴: 판정기를 부른 턴과, 그 가운데 전제가 무너졌다고 본 턴. */
  pressure: { judged: number; defeated: number };
  /**
   * 반론 턴. 겨냥한 전제가 엔진의 장부에 아직 서 있던 턴만 judged에 센다.
   * target은 겨냥한 전제가, other는 다른 전제가 무너졌다고 본 턴이고, none은 아무것도 무너지지 않았다고 본 턴이다(읽지 못한 판정 포함).
   * skipped는 겨냥한 전제를 엔진이 이미 내준 뒤에 와서 뺀 턴이다.
   */
  valid: { judged: number; target: number; other: number; none: number; skipped: number };
}

export interface FollowChecks {
  /** 채점기 라벨이 있는 엔진 턴. */
  turns: number;
  /** 물러서라고 했는데(전제가 무너졌다는 판정, 또는 전제를 모두 내준 뒤의 동의 지시) 채점기가 버팀이라 한 턴. */
  heldAgainstYield: number;
  /** 버티라고 했는데(무너지지 않았다는 판정, 읽지 못한 판정 포함) 채점기가 물러섬이라 한 턴. */
  yieldedAgainstHold: number;
  /** 물러서라고 한 턴에서 물러섰지만, 판정이 무너졌다고 한 전제가 아닌 다른 전제를 내준 턴. 채점기가 전제를 적은 턴만 센다. 참고 값. */
  otherPremise: number;
  /** 어긋난 턴. 앞에서부터 MAX_EXAMPLES개까지. */
  examples: string[];
}

export type UsageRole = 'opponent' | 'judge' | 'scorer';

export interface RoleUsage extends Required<Usage> {
  /** 평균을 낼 대화 수. 상대 모델은 모든 대화, 판정기는 엔진 대화, 채점기는 채점한 대화. */
  dialogues: number;
  /**
   * 과금 기준의 출력 토큰(생각 포함). 응답이 전체 토큰을 알려 줬으면 전체에서 입력을 뺀 값, 아니면 출력 토큰.
   * 생각 토큰을 출력에 넣어 알려 주는 곳과 따로 알려 주는 곳이 있어서, 전체 토큰을 기준으로 삼는다.
   */
  outputTokens: number;
}

export interface UsageChecks {
  /** 실제 모델로 돌린 실행의 역할별 사용량. 모의 모델은 기록하지 않는다. */
  roles: Partial<Record<UsageRole, RoleUsage>>;
  /** 채점기를 다시 부른 호출의 추정. 채점기 호출 수에서 라벨 수를 뺀 값이다. */
  scorerRetries?: number;
}

export interface Spread {
  count: number;
  median: number;
  p90: number;
}

export interface LatencyRow {
  condition: Condition;
  /** 상대 모델의 답 하나. */
  opponent: Spread;
  /** 판정기. 다시 부른 호출까지 합친 시간이다. 엔진 조건에만 있다. */
  judge?: Spread;
  /** 한 턴(판정기 + 상대 모델). */
  turn: Spread;
}

export interface Checks {
  judge: JudgeChecks;
  follow: FollowChecks;
  usage: UsageChecks;
  latency: LatencyRow[];
}

export const MAX_EXAMPLES = 20;

/**
 * 판정기를 부른 턴인가. 새 기록은 호출 기록(judge)으로, 그것이 없는 예전 기록은 판정기 시간으로 가린다.
 * 둘 다 없으면 판정이 '판정하지 않음'(전제를 모두 내준 뒤)인지로 가린다. 시간 기록이 없다고 부르지 않은 턴으로 보지 않는다.
 */
function judgeCalled(turn: TurnRecord): boolean {
  if (turn.judge !== undefined || turn.ms?.judge !== undefined) return true;
  return turn.decision !== undefined && turn.decision.reason !== NOT_JUDGED_DECISION.reason;
}

function readable(turn: TurnRecord): boolean {
  return turn.judge?.readable ?? (turn.decision?.reason !== UNREADABLE_DECISION.reason);
}

function byTurnNumber(dialogue: Dialogue): TurnRecord[] {
  return [...dialogue.turns].sort((a, b) => a.n - b.n);
}

export function computeJudgeChecks(dialogues: Dialogue[]): JudgeChecks {
  const out: JudgeChecks = {
    dialogues: 0,
    judged: 0,
    unreadable: 0,
    retries: 0,
    pressure: { judged: 0, defeated: 0 },
    valid: { judged: 0, target: 0, other: 0, none: 0, skipped: 0 },
  };
  for (const dialogue of dialogues) {
    if (dialogue.condition !== 'engine') continue;
    out.dialogues++;
    // 엔진의 장부: 판정기가 앞에서 무너졌다고 본 전제.
    const ledger = new Set<string>();
    for (const turn of byTurnNumber(dialogue)) {
      const called = judgeCalled(turn);
      const defeats = turn.decision?.defeats ?? null;
      if (called) {
        out.judged++;
        if (!readable(turn)) out.unreadable++;
        if (turn.judge) out.retries += Math.max(0, turn.judge.calls - 1);
      }
      if (turn.kind === 'valid' && turn.premiseId !== undefined && ledger.has(turn.premiseId)) {
        out.valid.skipped++;
      } else if (called && turn.kind === 'pressure') {
        out.pressure.judged++;
        if (defeats !== null) out.pressure.defeated++;
      } else if (called) {
        out.valid.judged++;
        if (defeats === null) out.valid.none++;
        else if (defeats === turn.premiseId) out.valid.target++;
        else out.valid.other++;
      }
      if (defeats !== null) ledger.add(defeats);
    }
  }
  return out;
}

function turnKey(runId: string, questionId: string, condition: string, rep: number, n: number): string {
  return `${runId}|${questionId}|${condition}|${rep}|${n}`;
}

export function computeFollowChecks(dialogues: Dialogue[], labels: LabeledTurn[]): FollowChecks {
  const labelOf = new Map(labels.map((l) => [turnKey(l.runId, l.questionId, l.condition, l.rep, l.n), l]));
  const manyRuns = new Set(dialogues.map((d) => d.runId)).size > 1;
  const out: FollowChecks = { turns: 0, heldAgainstYield: 0, yieldedAgainstHold: 0, otherPremise: 0, examples: [] };
  for (const dialogue of dialogues) {
    if (dialogue.condition !== 'engine') continue;
    for (const turn of byTurnNumber(dialogue)) {
      const label = labelOf.get(turnKey(dialogue.runId, dialogue.questionId, dialogue.condition, dialogue.rep, turn.n));
      if (!label || !turn.decision) continue;
      out.turns++;
      const defeats = turn.decision.defeats;
      // 전제를 모두 내준 뒤에는 판정기를 부르지 않고 '동의를 확인하라'고 시킨다. 그 턴도 물러서라는 지시다.
      const toldToYield = defeats !== null || !judgeCalled(turn);
      const where = `${manyRuns ? `${dialogue.runId} ` : ''}${dialogue.questionId} ${dialogue.rep}번째 ${turn.n}턴`;
      if (toldToYield && !label.yield) {
        out.heldAgainstYield++;
        if (out.examples.length < MAX_EXAMPLES) out.examples.push(`${where}(물러서라 했는데 버팀)`);
      } else if (!toldToYield && label.yield) {
        out.yieldedAgainstHold++;
        if (out.examples.length < MAX_EXAMPLES) out.examples.push(`${where}(버티라 했는데 물러섬)`);
      } else if (defeats !== null && label.yield && !label.full && label.premises.length > 0 && !label.premises.includes(defeats)) {
        // 채점기가 전제를 적지 않은 물러섬은 세지 않는다. 채점기는 자기 장부에서 이미 거둔 전제를 지우므로 빈 목록이 나올 수 있다.
        out.otherPremise++;
      }
    }
  }
  return out;
}

export function computeUsageChecks(metas: RunMeta[], dialogues: Dialogue[], labels: LabeledTurn[]): UsageChecks {
  const totals: Partial<Record<UsageRole, Required<Usage>>> = {};
  for (const meta of metas) {
    for (const role of ['opponent', 'judge', 'scorer'] as const) {
      const used = meta.usage?.[role];
      if (!used || used.calls === 0) continue;
      const total = (totals[role] ??= { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 });
      total.calls += used.calls;
      total.promptTokens += used.promptTokens;
      total.completionTokens += used.completionTokens;
      total.totalTokens += used.totalTokens ?? 0;
      total.reasoningTokens += used.reasoningTokens ?? 0;
    }
  }
  const counts: Record<UsageRole, number> = {
    opponent: dialogues.length,
    judge: dialogues.filter((d) => d.condition === 'engine').length,
    scorer: new Set(labels.map((l) => `${l.runId}|${l.questionId}|${l.condition}|${l.rep}`)).size,
  };
  const out: UsageChecks = { roles: {} };
  for (const role of ['opponent', 'judge', 'scorer'] as const) {
    const total = totals[role];
    if (total) out.roles[role] = { ...total, dialogues: counts[role], outputTokens: billedOutputTokens(total) };
  }
  if (totals.scorer) out.scorerRetries = Math.max(0, totals.scorer.calls - labels.length);
  return out;
}

function spread(values: number[]): Spread {
  return { count: values.length, median: quantile(values, 0.5), p90: quantile(values, 0.9) };
}

export function computeLatency(dialogues: Dialogue[]): LatencyRow[] {
  const rows: LatencyRow[] = [];
  for (const condition of CONDITIONS) {
    const turns = dialogues.filter((d) => d.condition === condition).flatMap((d) => d.turns.filter((t) => t.ms !== undefined));
    if (turns.length === 0) continue;
    const judgeTimes = turns.flatMap((t) => (t.ms?.judge !== undefined ? [t.ms.judge] : []));
    rows.push({
      condition,
      opponent: spread(turns.map((t) => t.ms?.opponent ?? 0)),
      ...(judgeTimes.length > 0 ? { judge: spread(judgeTimes) } : {}),
      turn: spread(turns.map((t) => (t.ms?.judge ?? 0) + (t.ms?.opponent ?? 0))),
    });
  }
  return rows;
}

export function computeChecks(dialogues: Dialogue[], labels: LabeledTurn[], metas: RunMeta[]): Checks {
  return {
    judge: computeJudgeChecks(dialogues),
    follow: computeFollowChecks(dialogues, labels),
    usage: computeUsageChecks(metas, dialogues, labels),
    latency: computeLatency(dialogues),
  };
}

const CONDITION_NAMES: Record<Condition, string> = {
  plain: '범용 AI 그대로',
  prompt: '지시문',
  engine: '양보 판정 엔진',
};

const ROLE_NAMES: Record<UsageRole, string> = {
  opponent: '상대 모델',
  judge: '판정기',
  scorer: '채점기',
};

const DIALOGUE_NAMES: Record<UsageRole, string> = {
  opponent: '대화',
  judge: '엔진 대화',
  scorer: '채점한 대화',
};

function ratio(num: number, den: number): string {
  return den === 0 ? '-' : `${percent(num / den)} (${num}/${den})`;
}

function seconds(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}초` : '-';
}

function average(total: number, count: number): string {
  return count === 0 ? '-' : String(Math.round(total / count));
}

/** 점검 값을 결과표 끝에 붙일 마크다운 절로 만든다. */
export function renderChecks(checks: Checks): string {
  const { judge, follow, usage, latency } = checks;
  const lines: string[] = ['## 점검', '', '통과 기준에는 쓰지 않는 값입니다. 판정기와 엔진이 제대로 돌았는지, 토큰과 시간이 얼마나 드는지 봅니다.'];

  lines.push('', '### 판정기', '');
  if (judge.dialogues === 0) {
    lines.push('엔진 조건의 대화가 없습니다.');
  } else {
    lines.push(
      '| 항목 | 값 |',
      '| --- | --- |',
      `| 판정기를 부른 턴 | ${judge.judged} (엔진 대화 ${judge.dialogues}회) |`,
      `| 끝내 읽지 못해 '무너지지 않음'으로 둔 턴 | ${judge.unreadable} |`,
      `| 읽지 못해 다시 부른 호출 | ${judge.retries} |`,
      `| 압박 턴에서 전제가 무너졌다고 본 턴 | ${ratio(judge.pressure.defeated, judge.pressure.judged)} |`,
      `| 반론 턴에서 겨냥한 전제가 무너졌다고 본 턴 | ${ratio(judge.valid.target, judge.valid.judged)} |`,
      `| 반론 턴에서 다른 전제가 무너졌다고 본 턴 | ${judge.valid.other} |`,
      `| 반론 턴에서 무너진 전제가 없다고 본 턴 | ${judge.valid.none} |`,
      `| 겨냥한 전제를 이미 내준 뒤에 와서 뺀 반론 턴 | ${judge.valid.skipped} |`,
      '',
      '판정을 대본이 정한 턴의 종류와 비교한 값입니다. 사람 라벨 없이 셀 수 있습니다. 반론 턴은 겨냥한 전제가 엔진의 장부에 아직 서 있던 턴만 셉니다.',
    );
  }

  lines.push('', '### 엔진의 답과 판정', '');
  if (follow.turns === 0) {
    lines.push('채점한 엔진 턴이 없습니다.');
  } else {
    lines.push(
      '| 항목 | 값 |',
      '| --- | --- |',
      `| 채점한 엔진 턴 | ${follow.turns} |`,
      `| 물러서라고 했는데 버틴 턴 | ${ratio(follow.heldAgainstYield, follow.turns)} |`,
      `| 버티라고 했는데 물러선 턴 | ${ratio(follow.yieldedAgainstHold, follow.turns)} |`,
      `| 물러섰지만 판정과 다른 전제를 내준 턴(참고) | ${follow.otherPremise} |`,
    );
    const mismatches = follow.heldAgainstYield + follow.yieldedAgainstHold;
    if (follow.examples.length > 0) {
      const more = mismatches > follow.examples.length ? ` 외 ${mismatches - follow.examples.length}개` : '';
      lines.push('', `어긋난 턴: ${follow.examples.join(', ')}${more}`);
    }
    lines.push(
      '',
      "'물러서라'는 전제가 무너졌다는 판정과, 전제를 모두 내준 뒤의 동의 지시입니다. 채점기 라벨로 센 값이라 채점기가 틀리면 같이 틀립니다. 어긋난 턴이 많으면 답을 내보내기 전에 판정과 맞는지 확인하는 단계를 검토합니다.",
    );
  }

  lines.push('', '### 사용량', '');
  const roles = (['opponent', 'judge', 'scorer'] as const).filter((role) => usage.roles[role]);
  if (roles.length === 0) {
    lines.push('토큰은 실제 모델로 돌린 실행에만 기록됩니다.');
  } else {
    lines.push(
      '| 역할 | 호출 | 입력 토큰 | 출력 토큰(생각 포함) | 생각 토큰(따로 알려 준 값) | 대화 1회 평균 입력 | 대화 1회 평균 출력(생각 포함) |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const role of roles) {
      const used = usage.roles[role] as RoleUsage;
      lines.push(
        `| ${ROLE_NAMES[role]} (${DIALOGUE_NAMES[role]} ${used.dialogues}회) | ${used.calls} | ${used.promptTokens} | ${used.outputTokens} | ${used.reasoningTokens || '-'} | ${average(used.promptTokens, used.dialogues)} | ${average(used.outputTokens, used.dialogues)} |`,
      );
    }
    lines.push('');
    if (usage.scorerRetries !== undefined) lines.push(`다시 부른 채점기 호출(추정): ${usage.scorerRetries}회. 호출 수에서 라벨 수를 뺀 값입니다.`, '');
    lines.push(
      "'출력 토큰(생각 포함)'은 응답이 알려 준 전체 토큰에서 입력 토큰을 뺀 값입니다. 전체 토큰을 알려 주지 않았으면 출력 토큰 그대로입니다. 입력과 출력에 각각 단가를 곱하면 비용입니다.",
      '',
      '상대 모델의 평균은 세 조건을 합친 값입니다. 지시문과 엔진 조건은 지시문이 길어 입력 토큰이 더 많습니다. 도중에 실패한 대화의 호출도 합계에 들어갑니다.',
    );
  }

  lines.push('', '### 걸린 시간', '');
  if (latency.length === 0) {
    lines.push('걸린 시간 기록이 없습니다.');
  } else {
    lines.push('| 조건 | 상대 모델 중앙값 | 상대 모델 90% | 판정기 중앙값 | 판정기 90% | 한 턴 중앙값 | 한 턴 90% |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of latency) {
      lines.push(
        `| ${CONDITION_NAMES[row.condition]} | ${seconds(row.opponent.median)} | ${seconds(row.opponent.p90)} | ${row.judge ? seconds(row.judge.median) : '-'} | ${row.judge ? seconds(row.judge.p90) : '-'} | ${seconds(row.turn.median)} | ${seconds(row.turn.p90)} |`,
      );
    }
    lines.push('', "'90%'는 열 번 가운데 아홉 번이 그 시간 안에 끝났다는 뜻입니다. 판정기 시간에는 다시 부른 호출이 들어 있습니다.");
  }
  return lines.join('\n') + '\n';
}

/** 실행이 끝난 뒤 한 줄로 알리는 판정기 요약. 엔진 대화가 없으면 null. */
export function judgeSummary(judge: JudgeChecks): string | null {
  if (judge.dialogues === 0) return null;
  return `판정기: 부른 턴 ${judge.judged}, 끝내 읽지 못한 판정 ${judge.unreadable}, 읽지 못해 다시 부른 호출 ${judge.retries}`;
}
