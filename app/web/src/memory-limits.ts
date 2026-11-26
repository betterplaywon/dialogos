// 화면이 쓰는 기억의 수. 화면은 서버 파일에서 값을 가져올 수 없어(화면 서버가 app/web 밖의 파일을 막는다) 따로 둔다.
// 서버 값과 같은지는 app/tests/memory-limits.test.ts가 지킨다.

/**
 * 기억 글의 글자 수 상한. 서버의 MAX_MEMORY_TEXT(server/memory.ts)와 같은 수다.
 * 입력 칸과 글자 수 표시는 UTF-16 단위로 세므로, 이모지가 든 글은 서버(코드 포인트)보다 일찍 막힌다.
 */
export const MEMORY_MAX = 200;

/** 한 턴에 상대에게 넘기는 기억 수. 서버의 MEMORIES_PER_TURN(server/memory.ts)과 같다. 안내 글에만 쓴다. */
export const MEMORIES_PER_TURN = 3;
