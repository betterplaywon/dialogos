// 글로 한 판을 사람이 하는 차례대로 화면에서 한다: 주제 목록 → 주제·생각 고르기 → 글로 두 턴 → 새로 고침 → 이어 하기
// → 끝내기 → 사후 입장과 훈계 문항 → 목록의 기록 → 판 파일. 앱은 빈 포트에 모의 모델로 띄우고, 화면은 창 없는 Chrome으로 누른다.
// 단계 id와 기대값은 features/screen.md에 있다.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

export const title = '글로 한 판(화면, 모의 모델, 창 없는 Chrome)';

/** 사람이 칠 두 턴. 모의 모델은 글의 길이로 압박과 반론을 가르므로 짧은 것과 긴 것을 하나씩 둔다. */
const TURNS = [
  '근거가 무엇인지 다시 말해 주세요.',
  '선의의 거짓말이라도 상대가 나중에 알게 되면 신뢰가 무너집니다. 맛이 없다는 말을 부드럽게 전하는 방법이 있는데, 굳이 거짓말을 고를 까닭이 무엇입니까?',
];

/** 판 화면 머리의 한 줄: "내 입장: … · 상대: … · 턴 n / 30". */
const meta = (page) => page.text('.game-meta p');

export async function run(h) {
  let app;
  let page;
  /** 판 화면에 보이던 말들. 새로 고친 뒤 그대로인지 견준다. */
  let messages = [];
  const chosen = {};

  await h.step('app', '앱을 빈 포트 둘에 모의 모델로 띄운다(app/dev.ts, 증거 폴더의 새 판 파일)', async () => {
    app = await h.app();
    return `서버 127.0.0.1:${app.api}, 화면 ${app.url}, 판 파일 ${app.db} (${app.log})`;
  });

  await h.step('topics', '화면을 열면 주제 목록과 모의 모델 안내가 보이고 지난 판은 없다', async () => {
    page = await h.browser();
    await page.goto(app.url);
    await page.waitFor(`document.querySelectorAll('.topic').length > 0`, '주제 목록이 보이지 않는다');
    const topics = await page.texts('.topic .question');
    assert.match(await page.text('.notice'), /모의 모델로 도는 개발용 화면입니다/);
    assert.equal((await page.texts('.past-game')).length, 0, '새 판 파일인데 지난 판이 있다');
    chosen.question = topics[0];
    return `주제 ${topics.length}개, 모의 모델 안내, 지난 판 없음 (${await page.shot('topics')})`;
  });

  await h.step('start', '첫 주제를 고르고, 척도에서 왼쪽 입장 "대체로"를 골라 시작한다', async () => {
    await page.press('이 주제로');
    await page.waitFor(`document.querySelector('.start')`, '시작 화면이 열리지 않는다');
    assert.equal(await page.text('#start-title'), chosen.question, '고른 주제의 질문');
    assert.equal(await page.hasButton('이 입장으로 시작', { enabled: true }), false, '생각을 고르기 전에 시작 단추가 눌린다');
    await page.choose('start-lean', 1);
    const caption = await page.text('.start .actions .muted');
    assert.match(caption, /^지킬 입장: .+ · 상대: .+$/, `고른 뒤의 안내: ${caption}`);
    await page.press('이 입장으로 시작');
    await page.waitFor(`document.querySelector('.game')`, '판 화면이 열리지 않는다');
    messages = await page.texts('.message p');
    const head = await meta(page);
    assert.match(head, /· 턴 0 \/ 30$/);
    assert.deepEqual(await page.texts('.message .who'), ['나 · 고른 입장', head.match(/상대: (.+) · 턴/)[1]], '고른 입장과 상대의 첫 발언');
    chosen.stance = head.match(/^내 입장: (.+) · 상대/)[1];
    assert.equal(caption, `지킬 입장: ${chosen.stance} · 상대: ${head.match(/상대: (.+) · 턴/)[1]}`, '시작 화면에서 본 입장과 상대');
    return `${head}, 말 ${messages.length}개 (${await page.shot('start')})`;
  });

  for (const [index, text] of TURNS.entries()) {
    const n = index + 1;
    await h.step(`turn-${n}`, `글을 입력 칸에 쳐서 [보내기]로 ${n}번째 턴을 보낸다`, async () => {
      await page.type('#draft', text);
      assert.equal(await page.value('#draft'), text, '입력 칸의 글');
      await page.press('보내기');
      await page.waitFor(
        `document.querySelector('.game-meta p')?.innerText.endsWith('턴 ${n} / 30') && !document.querySelector('.message.pending')`,
        `턴 ${n}의 답이 오지 않는다`,
      );
      const now = await page.texts('.message p');
      assert.equal(now.length, messages.length + 2, '내 말과 상대의 답이 하나씩 더해진다');
      assert.equal(now.at(-2), text, '보낸 글이 내 말로 보인다');
      assert.ok(now.at(-1).length > 0, '상대의 답');
      assert.equal(await page.value('#draft'), '', '보낸 뒤 입력 칸이 빈다');
      messages = now;
      return `턴 ${n} / 30, 말 ${now.length}개, 상대의 답 ${now.at(-1).length}자 (${await page.shot(`turn-${n}`)})`;
    });
  }

  await h.step('reload', '페이지를 새로 열면 지난 판에 그 판이 진행 중으로 있고, [이어 하기]로 같은 말들이 그대로 보인다', async () => {
    await page.reload();
    await page.waitFor(`document.querySelector('.past-game')`, '지난 판 목록이 보이지 않는다');
    const past = await page.texts('.past-game .past-text');
    assert.equal(past.length, 1, '지난 판의 수');
    assert.match(past[0], new RegExp(`^${escape(chosen.question)} .* · 2 / 30턴 · 진행 중 · `), past[0]);
    assert.match(past[0], /생각: 대체로 내 입장$/, past[0]);
    const listShot = await page.shot('reload-list');
    await page.press('이어 하기');
    await page.waitFor(`document.querySelector('.game')`, '이어 한 판이 열리지 않는다');
    assert.deepEqual(await page.texts('.message p'), messages, '새로 고치기 전과 같은 말들');
    assert.match(await meta(page), /· 턴 2 \/ 30$/);
    return `지난 판 1개(2 / 30턴 · 진행 중), 이어 연 판의 말 ${messages.length}개가 그대로 (${listShot}, ${await page.shot('resumed')})`;
  });

  await h.step('end', '[끝내기]를 누르면 판이 끝나고, 두 문항에 답하기 전에는 기록 단추가 눌리지 않는다', async () => {
    await page.press('끝내기');
    await page.waitFor(`document.querySelector('.end-record')`, '끝 기록 칸이 보이지 않는다');
    const panel = await page.text('.end-record > p');
    assert.equal(panel, '판을 끝냈습니다. 2턴을 주고받았습니다. 두 가지에 답하면 판이 닫힙니다.');
    assert.equal(await page.hasButton('보내기'), false, '끝난 판에 입력 칸이 남았다');
    assert.equal(await page.hasButton('기록 남기기', { enabled: true }), false, '답하기 전에 기록 단추가 눌린다');
    await page.choose('end-lean', 3);
    assert.equal(await page.hasButton('기록 남기기', { enabled: true }), false, '한 문항만 답했는데 기록 단추가 눌린다');
    return `${panel} (${await page.shot('end')})`;
  });

  await h.step('record', '사후 입장 "대체로"(오른쪽 입장)와 훈계 문항 "토론"을 골라 [기록 남기기]를 누른다', async () => {
    await page.choose('verdict', 0);
    await page.press('기록 남기기');
    await page.waitFor(`document.querySelector('.ended')`, '기록한 판의 화면이 보이지 않는다');
    const summary = await page.texts('.ended p');
    assert.deepEqual(summary.slice(0, 2), ['판을 끝냈습니다. 2턴을 주고받았습니다.', '생각: 대체로 내 입장 → 대체로 상대 입장 · 이번 판은 토론']);
    assert.equal(summary.length, 2, '글로만 한 판인데 말로 보낸 턴의 줄이 있다');
    return `${summary.join(' / ')} (${await page.shot('recorded')})`;
  });

  await h.step('list', '[목록으로] 나가면 지난 판에 그 판의 기록이 보인다', async () => {
    await page.press('목록으로');
    // 목록은 나갈 때 지난 판을 다시 받는다. 받기 전에는 새로 고칠 때 받은 목록(진행 중)이 잠깐 보인다.
    await page.waitFor(
      `document.querySelector('.topics') && [...document.querySelectorAll('.past-game')].some((li) => li.innerText.includes('· 토론 ·'))`,
      '지난 판에 기록한 판(토론)이 보이지 않는다',
    );
    const past = await page.texts('.past-game .past-text');
    assert.equal(past.length, 1, '지난 판의 수');
    assert.match(past[0], / · 2 \/ 30턴 · 토론 · /, `지난 판의 상태: ${past[0]}`);
    assert.match(past[0], /생각: 대체로 내 입장 → 대체로 상대 입장$/, past[0]);
    assert.deepEqual(await page.texts('.past-game button'), ['다시 보기']);
    return `${past[0]} [다시 보기] (${await page.shot('list')})`;
  });

  await h.step('db', '판 파일에 판 하나, 글로 넣은 두 턴, 끝 기록이 남고, 화면에 오류가 없다', () => {
    const db = new DatabaseSync(app.dbPath, { readOnly: true });
    try {
      const games = db.prepare('SELECT id, side, start_lean, end_reason, end_lean, verdict, ended_at, recorded_at FROM games').all();
      assert.equal(games.length, 1, '판의 수');
      const [game] = games;
      assert.deepEqual(
        { side: game.side, start: game.start_lean, reason: game.end_reason, end: game.end_lean, verdict: game.verdict },
        { side: 0, start: -1, reason: 'user', end: 1, verdict: 'debate' },
      );
      assert.ok(game.ended_at && game.recorded_at, '끝난 때와 기록한 때');
      const turns = db.prepare('SELECT n, user_text, input, redone FROM turns WHERE game_id = ? ORDER BY n').all(game.id);
      assert.deepEqual(
        turns.map((t) => ({ ...t })),
        TURNS.map((text, i) => ({ n: i + 1, user_text: text, input: 'text', redone: 0 })),
      );
    } finally {
      db.close();
    }
    assert.deepEqual(page.errors, [], '화면의 예외나 console.error');
    return `games 1행(side 0, start_lean -1, end_reason user, end_lean 1, verdict debate), turns 2행(input text, redone 0), 화면 오류 0 (${app.db})`;
  });
}

/** 정규식에 넣을 글. */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
