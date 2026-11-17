// 사람 라벨과 채점기 라벨을 맞춰 보는 계산.

import type { Dialogue, LabeledTurn } from './types.ts';
import { rng } from './util.ts';

export interface SampleKey {
  questionId: string;
  condition: string;
  rep: number;
  n: number;
}

export interface SampleItem extends SampleKey {
  item: string;
  user: string;
  reply: string;
  /** 이 답이 나오기 전에 이미 거둔 전제. 채점기가 본 것과 같은 정보를 사람에게도 준다. */
  concededBefore: string[];
  machineYield: boolean;
}

function turnKey(row: SampleKey): string {
  return `${row.questionId}|${row.condition}|${row.rep}|${row.n}`;
}

function shuffle<T>(items: T[], next: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
}

/**
 * 사람이 라벨을 붙일 표본을 뽑는다. 씨앗이 같으면 같은 표본이 나온다.
 * 물러섬은 드물 수 있으므로, 채점기가 물러섬이라 한 턴과 버팀이라 한 턴에서 절반씩 뽑는다.
 * 한쪽이 모자라면 다른 쪽에서 채운다.
 */
export function drawSample(dialogues: Dialogue[], labels: LabeledTurn[], n: number, seed: number): SampleItem[] {
  const labelOf = new Map(labels.map((label) => [turnKey(label), label]));
  const all = dialogues.flatMap((d) =>
    d.turns.flatMap((t) => {
      const key = { questionId: d.questionId, condition: d.condition, rep: d.rep, n: t.n };
      const label = labelOf.get(turnKey(key));
      return label ? [{ ...key, user: t.user, reply: t.reply, concededBefore: label.concededBefore, machineYield: label.yield }] : [];
    }),
  );
  // 파일에 적힌 순서와 상관없이 같은 표본이 나오게 먼저 줄을 세운다.
  all.sort((a, b) => (turnKey(a) < turnKey(b) ? -1 : turnKey(a) > turnKey(b) ? 1 : 0));
  const next = rng(seed);
  shuffle(all, next);

  const yields = all.filter((row) => row.machineYield);
  const holds = all.filter((row) => !row.machineYield);
  const holdCount = Math.min(holds.length, n - Math.min(yields.length, Math.floor(n / 2)));
  const yieldCount = Math.min(yields.length, n - holdCount);
  const picked = [...yields.slice(0, yieldCount), ...holds.slice(0, holdCount)];
  shuffle(picked, next);
  return picked.map((row, index) => ({ item: `s${String(index + 1).padStart(3, '0')}`, ...row }));
}

export interface StratumAgreement {
  n: number;
  agree: number;
  rate: number;
}

export interface Agreement {
  n: number;
  agree: number;
  /** 채점기가 물러섬이라 한 표본 가운데 사람도 물러섬이라 한 것. */
  machineYield: StratumAgreement;
  /** 채점기가 버팀이라 한 표본 가운데 사람도 버팀이라 한 것. */
  machineHold: StratumAgreement;
  /** 일치율. yieldShare를 주면 전체 턴으로 환산한 값이다. */
  rate: number;
  /** 우연히 맞을 몫을 뺀 일치도(코헨의 카파). 계산할 수 없으면 NaN. */
  kappa: number;
}

/**
 * 사람 라벨과 채점기 라벨의 일치를 센다.
 * 표본을 물러섬과 버팀에서 절반씩 뽑았다면, 전체 턴에서 채점기가 물러섬이라 한 비율(yieldShare)을 넘겨
 * 전체 턴 기준으로 환산한다. 넘기지 않으면 표본에서 그대로 센다.
 */
export function agreement(pairs: { human: boolean; machine: boolean }[], yieldShare?: number): Agreement {
  const stratum = (machine: boolean): StratumAgreement => {
    const rows = pairs.filter((p) => p.machine === machine);
    const agree = rows.filter((p) => p.human === p.machine).length;
    return { n: rows.length, agree, rate: rows.length === 0 ? NaN : agree / rows.length };
  };
  const machineYield = stratum(true);
  const machineHold = stratum(false);
  const n = pairs.length;
  const base = { n, agree: machineYield.agree + machineHold.agree, machineYield, machineHold };
  if (n === 0) return { ...base, rate: NaN, kappa: NaN };

  const share = yieldShare ?? machineYield.n / n;
  // 전체 턴에 있는 종류인데 표본에는 하나도 없으면 환산할 수 없다.
  if ((share > 0 && machineYield.n === 0) || (share < 1 && machineHold.n === 0)) return { ...base, rate: NaN, kappa: NaN };
  const yieldRate = machineYield.n === 0 ? 0 : machineYield.rate;
  const holdRate = machineHold.n === 0 ? 0 : machineHold.rate;
  const rate = share * yieldRate + (1 - share) * holdRate;
  const humanYes = share * yieldRate + (1 - share) * (1 - holdRate);
  const expected = humanYes * share + (1 - humanYes) * (1 - share);
  return { ...base, rate, kappa: expected >= 1 - 1e-12 ? NaN : (rate - expected) / (1 - expected) };
}
