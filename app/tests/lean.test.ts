import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEAN_STEPS, leanAccessibleName, leanLabel, sideOfLean } from '../web/src/lean.ts';

test('척도는 왼쪽 끝(첫째 입장)부터 다섯 칸이고, 기운 쪽을 입장 번호로 읽는다', () => {
  assert.deepEqual(
    LEAN_STEPS.map((step) => [step.lean, step.label, sideOfLean(step.lean)]),
    [
      [-2, '확실히', 0],
      [-1, '대체로', 0],
      [0, '반반', null],
      [1, '대체로', 1],
      [2, '확실히', 1],
    ],
  );
});

test('생각은 지킨 입장을 기준으로 읽는다', () => {
  assert.deepEqual(
    LEAN_STEPS.map((step) => leanLabel(step.lean, 0)),
    ['확실히 내 입장', '대체로 내 입장', '반반', '대체로 상대 입장', '확실히 상대 입장'],
  );
  assert.deepEqual(
    LEAN_STEPS.map((step) => leanLabel(step.lean, 1)),
    ['확실히 상대 입장', '대체로 상대 입장', '반반', '대체로 내 입장', '확실히 내 입장'],
  );
});

test('척도의 칸은 소리 내어 읽을 때 입장 문장을 함께 읽는다', () => {
  const stances: [string, string] = ['해도 됩니다.', '해서는 안 됩니다.'];
  assert.deepEqual(
    LEAN_STEPS.map((step) => leanAccessibleName(step.lean, stances)),
    ['확실히: 해도 됩니다.', '대체로: 해도 됩니다.', '반반', '대체로: 해서는 안 됩니다.', '확실히: 해서는 안 됩니다.'],
  );
});
