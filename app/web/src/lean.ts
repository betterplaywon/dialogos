// 다섯 칸 척도(판 앞뒤의 생각)와 훈계 문항을 화면 글로 바꾼다.

import type { Lean, SideIndex, Verdict } from '../../server/contract.ts';

/** 척도의 다섯 칸. 왼쪽 끝이 sides[0], 오른쪽 끝이 sides[1]의 입장이다. */
export const LEAN_STEPS: readonly { lean: Lean; label: string }[] = [
  { lean: -2, label: '확실히' },
  { lean: -1, label: '대체로' },
  { lean: 0, label: '반반' },
  { lean: 1, label: '대체로' },
  { lean: 2, label: '확실히' },
];

export const VERDICT_LABEL: Record<Verdict, string> = { debate: '토론', lecture: '훈계' };

/** 생각이 기운 입장. 반반이면 null이다. */
export function sideOfLean(lean: Lean): SideIndex | null {
  if (lean < 0) return 0;
  if (lean > 0) return 1;
  return null;
}

/** 지킨 입장을 기준으로 읽은 생각. 예: '대체로 내 입장', '반반', '확실히 상대 입장'. */
export function leanLabel(lean: Lean, side: SideIndex): string {
  const leaning = sideOfLean(lean);
  if (leaning === null) return '반반';
  const strength = Math.abs(lean) === 2 ? '확실히' : '대체로';
  return `${strength} ${leaning === side ? '내 입장' : '상대 입장'}`;
}

/** 척도의 한 칸을 소리 내어 읽을 때의 이름. 예: '대체로: 맛있다고 거짓말해서는 안 됩니다.' */
export function leanAccessibleName(lean: Lean, stances: readonly [string, string]): string {
  const leaning = sideOfLean(lean);
  if (leaning === null) return '반반';
  return `${Math.abs(lean) === 2 ? '확실히' : '대체로'}: ${stances[leaning]}`;
}
