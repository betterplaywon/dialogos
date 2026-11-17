import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argCount, argList, argNumber, argString, extractJson, hash, mapLimit, median, parseArgs, parseCsv, percent, rng, toCsv } from '../src/util.ts';

test('hash와 rng는 같은 입력에 같은 값을 낸다', () => {
  assert.equal(hash('q01'), hash('q01'));
  assert.notEqual(hash('q01'), hash('q02'));
  assert.ok(Number.isInteger(hash('한글')) && hash('한글') >= 0);
  const a = rng(42);
  const b = rng(42);
  const values = Array.from({ length: 100 }, () => a());
  assert.deepEqual(values, Array.from({ length: 100 }, () => b()));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  assert.notEqual(rng(1)(), rng(2)());
});

test('명령줄 인자를 읽는다', () => {
  const args = parseArgs(['--provider', 'mock', '--confirm', '--reps', '3', 'stray', '--questions', 'q01, q02,']);
  assert.equal(argString(args, 'provider'), 'mock');
  assert.equal(args.confirm, true);
  assert.equal(argNumber(args, 'reps', 2), 3);
  assert.equal(argNumber(args, 'turns', 30), 30);
  assert.equal(argString(args, 'run', 'fallback'), 'fallback');
  assert.deepEqual(argList(args, 'questions'), ['q01', 'q02']);
  assert.equal(argList(args, 'conditions'), undefined);
});

test('숫자가 아니거나 1보다 작은 값은 거절한다', () => {
  assert.throws(() => argNumber(parseArgs(['--reps', 'two']), 'reps', 2), /숫자/);
  assert.throws(() => argCount(parseArgs(['--reps', '0']), 'reps', 2), /1 이상의 정수/);
  assert.throws(() => argCount(parseArgs(['--reps', '1.5']), 'reps', 2), /1 이상의 정수/);
  assert.equal(argCount(parseArgs([]), 'reps', 2), 2);
});

test('모델의 답에서 JSON 객체를 꺼낸다', () => {
  assert.deepEqual(extractJson('{"yield":true}'), { yield: true });
  assert.deepEqual(extractJson('```json\n{"a":{"b":[1,2]}}\n```\n설명입니다.'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('판정: {"reason":"중괄호 } 와 \\"따옴표\\"가 든 글","defeats":null} 끝'), {
    reason: '중괄호 } 와 "따옴표"가 든 글',
    defeats: null,
  });
  assert.throws(() => extractJson('JSON이 없습니다'), /JSON 객체가 없습니다/);
  assert.throws(() => extractJson('{"a": 1'), /닫히지 않았습니다/);
});

test('CSV는 쉼표, 따옴표, 줄바꿈이 든 칸을 그대로 되돌린다', () => {
  const rows = [
    ['item', 'reply', 'human_yield'],
    ['s001', '쉼표, 그리고 "따옴표"', ''],
    ['s002', 'P1. 첫 줄\nP2. 둘째 줄', '1'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(parseCsv('a,b\n\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('mapLimit은 순서를 지키고 동시에 도는 수를 넘기지 않는다', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([5, 1, 4, 2, 3], 2, async (value) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running--;
    return value * 10;
  });
  assert.deepEqual(results, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 2, async () => 1), []);
});

test('중앙값과 백분율 표시', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(percent(0.125), '12.5%');
  assert.equal(percent(NaN), '-');
});
