import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MEMORY_TEXT, MEMORIES_PER_TURN } from '../server/memory.ts';
import * as web from '../web/src/memory-limits.ts';

// 화면은 서버 파일에서 값을 가져올 수 없어 같은 수를 따로 둔다. 서버 값을 바꾸면 화면도 함께 바꿔야 한다.
test('화면의 기억 글자 수 상한과 한 턴에 넘기는 기억 수는 서버와 같다', () => {
  assert.equal(web.MEMORY_MAX, MAX_MEMORY_TEXT);
  assert.equal(web.MEMORIES_PER_TURN, MEMORIES_PER_TURN);
});
