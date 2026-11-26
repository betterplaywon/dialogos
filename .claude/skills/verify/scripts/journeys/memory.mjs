// 사용자별 기억을 사람이 쓰는 차례대로 화면에서 확인한다: 같은 주제로 첫 판(기록 남기기) → 목록의 내 기억 → 시작 화면의 지난 기록
// → 둘째 판 첫 턴의 답 아래 넘긴 기록 → 그 자리에서 고치기와 지우기 → 다음 턴에 넘긴 기록 → 새로 고쳐 이어 열기
// → 두 번째 탭에서 지운 기억을 첫 탭에서 고치거나 지우기 → 목록의 내 기억 → 판 파일.
// 앱은 빈 포트에 모의 모델로 띄우고(기본 방식은 엔진이라 기억 켬), 화면은 창 없는 Chrome으로 누른다. 두 번째 탭은 Chrome을 하나 더 띄운다.
// 단계 id와 기대값은 features/memory.md에 있다.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

export const title = '같은 주제로 두 판, 넘긴 기록을 고치고 지우기(화면, 모의 모델, 창 없는 Chrome)';

/** 사람이 칠 글. 모의 모델은 글의 길이로 압박(짧은 글)과 반론(긴 글)을 가른다. */
const SHORT = '근거가 무엇인지 다시 말해 주세요.';
const LONG =
  '선의의 거짓말이라도 상대가 나중에 알게 되면 신뢰가 무너집니다. 맛이 없다는 말을 부드럽게 전하는 방법이 있는데, 굳이 거짓말을 고를 까닭이 무엇입니까? 정직하게 말하면서도 상대의 마음을 다치지 않게 하는 길이 분명히 있습니다.';
/** 첫 판의 세 턴(압박, 반론, 같은 압박). 주장 말고도 근거, 바뀐 생각, 약점 기억이 생길 수 있는 판이다. */
const FIRST_GAME = [SHORT, LONG, SHORT];
/** 첫 기록을 고칠 글. */
const EDITED = '고친 주장: 처음에는 거짓말이 신뢰를 무너뜨린다고 말했다.';
/** 다른 탭에서 이미 지운 기록을 그런 줄 모르고 고칠 글. */
const STALE_EDIT = '지운 줄 모르고 고친 글.';

/** 화면이 보이는 기억 종류 이름(app/web/src/memories.tsx). */
const KIND = { claim: '주장', ground: '근거', shift: '바뀐 생각', weakness: '약점' };
/** 한 턴에 상대에게 넘기는 기억 수(app/server/memory.ts의 MEMORIES_PER_TURN). */
const PER_TURN = 3;
/** 지운 자리에 보이는 글과, 그 자리에서 지웠을 때와 고치거나 지우려다 다른 곳에서 이미 지운 것을 알았을 때만 붙는 안내. */
const DELETED = '지운 기록';
const DELETED_HERE = '지운 기록 기억만 지웠습니다. 판 기록은 남습니다.';
const DELETED_ELSEWHERE = '지운 기록 다른 곳에서 이미 지운 기록입니다.';

/** 판 화면에서 k번째 턴의 답인 상대의 말. 0번째는 판을 시작할 때 나온 첫 발언이다. */
const reply = (k) => `[...document.querySelectorAll('.message.opponent:not(.pending)')][${k}]`;
/** scope 안에서 보이는 글이 text인 눌리는 단추. scope가 아직 없으면 null이라 누르기가 나타나기를 기다린다. */
const buttonIn = (scope, text) =>
  `[...((${scope})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
/** 넘긴 기록을 여닫는 단추의 글. */
const toggleText = (n) => `이 답을 만들 때 넘긴 기록 ${n}개`;
/** 기억 표의 줄 하나가 화면의 기록 항목으로 보이는 글: 종류, 글, 고친 기록이면 '고침'. */
const shown = (row) => `${KIND[row.kind]} ${row.text}${row.edited_at ? ' 고침' : ''}`;

export async function run(h) {
  let app;
  let page;
  /** 두 번째 탭. 첫 탭이 모르는 사이에 기억을 지운다. */
  let other;
  const games = {};
  /** 첫 판이 끝 기록 때 만든 기억(판 파일의 차례 = 최근 것부터, 한 판 안에서는 만든 차례). 고치고 지운 뒤에도 처음 그대로 둔다. */
  let made = [];
  /** 지금 판 파일에 있어야 할 기억. 고치면 그 줄을 판 파일에서 다시 읽은 것으로 바꾸고, 지우면 뺀다. */
  let current = [];
  /** 둘째 판 턴 2에 넘긴 기억(그때의 판 파일 줄). */
  let passed2 = [];
  /** 두 번째 탭에서 지운 기억 둘. 첫 탭의 턴 2 답 아래에 아직 글로 보이던 것이다. */
  let elsewhere = [];

  /** 판 파일을 읽기 전용으로 열어 읽는다. 앱이 띄워져 있어도 읽을 수 있다. */
  const db = (work) => {
    const file = new DatabaseSync(app.dbPath, { readOnly: true });
    try {
      return work(file);
    } finally {
      file.close();
    }
  };
  /** 기억 표 전체(이 판 파일의 사용자는 한 사람). 서버가 상대에게 넘기는 차례와 같은 정렬이다. */
  const memoryRows = () => db((d) => d.prepare('SELECT * FROM memories ORDER BY created_at DESC, rowid ASC').all().map((r) => ({ ...r })));
  const turnRows = (gameId) =>
    db((d) => d.prepare('SELECT n, memory_ids, at FROM turns WHERE game_id = ? ORDER BY n').all(gameId).map((r) => ({ n: r.n, ids: JSON.parse(r.memory_ids), at: r.at })));
  const ids = (rows) => rows.map((m) => m.id);
  /** 판 화면의 넘긴 기억 자리에 보일 글. 남은 기억은 지금 글, 지운 기억은 '지운 기록'이다(그 자리에서 지운 게 아니면 알림이 없다). */
  const nowShown = (memory) => {
    const row = current.find((m) => m.id === memory.id);
    return row ? shown(row) : DELETED;
  };

  /** scope 안 기록 항목들의 보이는 글. */
  const itemsIn = (scope) =>
    page.evaluate(`[...((${scope})?.querySelectorAll('.memory .memory-body') ?? [])].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);

  /** 입력 칸에 글을 쳐서 보내고, 턴 n의 답이 올 때까지 기다린다. */
  async function send(text, n) {
    await page.type('#draft', text);
    await page.press('보내기');
    await page.waitFor(
      `document.querySelector('.game-meta p')?.innerText.endsWith('턴 ${n} / 30') && !document.querySelector('.message.pending')`,
      `턴 ${n}의 답이 오지 않는다`,
    );
  }

  /**
   * 턴 k의 답 아래 접힌 넘긴 기록을 펼쳐 항목의 글을 읽는다. 단추 글의 개수가 맞아야 누른다.
   * 접힘은 단추의 aria-expanded와 함께, 단추가 가리키는 목록(aria-controls)이 화면에 실제로 보이는지(checkVisibility)로 본다.
   * aria-expanded만 보면 목록이 늘 펼쳐져 있어도 통과한다.
   */
  async function openPassed(k, count) {
    const toggle = `${reply(k)}?.querySelector('.passed-toggle')`;
    const list = `document.getElementById(${toggle}?.getAttribute('aria-controls'))`;
    assert.equal(await page.evaluate(`${toggle}?.textContent ?? null`), toggleText(count), `턴 ${k}의 답 아래 넘긴 기록 단추`);
    const before = await page.evaluate(`({ expanded: ${toggle}.getAttribute('aria-expanded'), visible: ${list}?.checkVisibility() ?? null })`);
    assert.deepEqual(before, { expanded: 'false', visible: false }, `턴 ${k}의 넘긴 기록은 처음에 접혀 있어 목록이 보이지 않는다(본 것 ${JSON.stringify(before)})`);
    await page.click(buttonIn(reply(k), toggleText(count)), `턴 ${k}의 [${toggleText(count)}]`);
    await page.waitFor(`${toggle}.getAttribute('aria-expanded') === 'true' && ${list}?.checkVisibility()`, `턴 ${k}의 넘긴 기록이 펼쳐져 보이지 않는다`);
    return itemsIn(reply(k));
  }

  /** 고치거나 지우려고 누른 기록 자리(item)가 지운 기록이나 오류 줄로 바뀔 때까지 기다린 뒤, 오류 줄이 없는지 본다. */
  async function settled(item, what) {
    await page.waitFor(`${item}.classList.contains('deleted') || ${item}.querySelector('.memory-error')`, `${what}이(가) 지운 기록으로도 오류로도 바뀌지 않는다`);
    const error = await page.evaluate(`${item}.querySelector('.memory-error')?.textContent ?? null`);
    assert.equal(error, null, `${what}에 오류 줄이 보인다: ${error}`);
  }

  await h.step('app', '앱을 빈 포트 둘에 모의 모델로 띄운다(app/dev.ts, 기본 방식은 엔진이라 기억 켬, 증거 폴더의 새 판 파일)', async () => {
    app = await h.app();
    return `서버 127.0.0.1:${app.api}, 화면 ${app.url}, 판 파일 ${app.db} (${app.log})`;
  });

  await h.step('first-game', '첫 주제를 왼쪽 "대체로"로 시작해 세 턴(압박, 반론, 압박)을 보낸다. 기억이 없어 답 아래 넘긴 기록이 없다', async () => {
    page = await h.browser();
    await page.goto(app.url);
    await page.waitFor(`document.querySelectorAll('.topic').length > 0`, '주제 목록이 보이지 않는다');
    await page.press('이 주제로');
    await page.waitFor(`document.querySelector('.start')`, '시작 화면이 열리지 않는다');
    games.question = await page.text('#start-title');
    await page.choose('start-lean', 1);
    await page.press('이 입장으로 시작');
    await page.waitFor(`document.querySelector('.game')`, '판 화면이 열리지 않는다');
    for (const [i, text] of FIRST_GAME.entries()) await send(text, i + 1);
    assert.equal(await page.evaluate(`document.querySelectorAll('.passed').length`), 0, '기억이 없는데 넘긴 기록이 보인다');
    games.first = db((d) => d.prepare('SELECT id, topic_id, memory FROM games').get());
    assert.equal(games.first.memory, 1, '판 파일의 games.memory(이 판이 기억을 쓰는지)');
    assert.deepEqual(turnRows(games.first.id).map((t) => t.ids), [[], [], []], '첫 판의 턴에 넘긴 기억 id');
    return `턴 3 / 30, 넘긴 기록 0개, games.memory 1, 턴마다 memory_ids [] (${await page.shot('first-game')})`;
  });

  await h.step('record', '[끝내기] → 사후 입장 오른쪽 "대체로", 훈계 문항 "토론" → [기록 남기기]. 판 파일에 그 판의 기억이 생긴다', async () => {
    await page.press('끝내기');
    await page.waitFor(`document.querySelector('.end-record')`, '끝 기록 칸이 보이지 않는다');
    await page.choose('end-lean', 3);
    await page.choose('verdict', 0);
    await page.press('기록 남기기');
    await page.waitFor(`document.querySelector('.ended')`, '기록한 판의 화면이 보이지 않는다');
    made = memoryRows();
    current = [...made];
    const kinds = made.map((m) => m.kind);
    // 지운 자리를 다음 기억이 채우는 것까지 보려면 한 턴에 넘기는 수보다 하나 더 있어야 한다.
    assert.ok(made.length > PER_TURN, `기억이 ${PER_TURN + 1}개보다 적다: ${kinds.join(', ')}`);
    for (const m of made) {
      assert.deepEqual(
        { game: m.game_id, topic: m.topic_id, side: m.side, edited: m.edited_at },
        { game: games.first.id, topic: games.first.topic_id, side: 0, edited: null },
        `기억 ${m.id}`,
      );
    }
    assert.equal(kinds[0], 'claim', '첫 기억은 주장');
    assert.ok(made[0].text.endsWith(`첫 말: "${SHORT}"`), `주장 기억이 첫 턴에 친 글을 담지 않는다: ${made[0].text}`);
    assert.ok(kinds.includes('shift'), `생각이 바뀌었는데(-1 → 1) 바뀐 생각 기억이 없다: ${kinds.join(', ')}`);
    return `기억 ${made.length}개: ${kinds.join(', ')} (${await page.shot('recorded')})`;
  });

  await h.step('list', '[목록으로] 나가면 내 기억 절에 그 주제의 묶음이 있고, 항목이 판 파일의 기억과 같은 차례로 보인다', async () => {
    await page.press('목록으로');
    await page.waitFor(`document.querySelector('#my-memories-title')`, '내 기억 절이 보이지 않는다');
    assert.deepEqual(await page.texts('.memory-group h3'), [games.question], '내 기억의 묶음은 첫 판의 주제 하나');
    assert.deepEqual(await page.texts('.memory-group .memory .memory-body'), made.map(shown), '내 기억의 항목');
    return `내 기억 묶음 1개, 항목 ${made.length}개 (${await page.shot('list')})`;
  });

  await h.step('start', '같은 주제의 [이 주제로]를 누르면 시작 화면에 이 주제의 지난 기록과 "최근 3개까지 넘깁니다"가 보인다', async () => {
    await page.press('이 주제로');
    await page.waitFor(`document.querySelector('.start .memory-section .memory')`, '시작 화면에 지난 기록이 없다');
    assert.equal(await page.text('#start-title'), games.question, '첫 판과 같은 주제');
    const note = await page.text('.start .memory-section p');
    assert.match(note, new RegExp(`상대에게 최근 ${PER_TURN}개까지 넘깁니다`));
    assert.deepEqual(await page.texts('.start .memory .memory-body'), made.map(shown), '시작 화면의 지난 기록');
    return `지난 기록 ${made.length}개, 안내 "${note}" (${await page.shot('start')})`;
  });

  await h.step('passed', '같은 입장으로 둘째 판을 시작해 한 턴을 보내면, 답 아래 넘긴 기록이 최근 3개이고 판 파일의 턴 1에 그 id가 남는다', async () => {
    await page.choose('start-lean', 1);
    await page.press('이 입장으로 시작');
    await page.waitFor(`document.querySelector('.game')`, '둘째 판이 열리지 않는다');
    games.second = db((d) => d.prepare('SELECT id, topic_id FROM games ORDER BY rowid DESC LIMIT 1').get());
    assert.notEqual(games.second.id, games.first.id, '새 판');
    assert.equal(games.second.topic_id, games.first.topic_id, '같은 주제');
    await send(SHORT, 1);
    assert.equal(await page.evaluate(`Boolean(${reply(0)}?.querySelector('.passed'))`), false, '판의 첫 발언 아래에 넘긴 기록이 있다');
    const closed = await page.shot('passed-closed');
    const passed = current.slice(0, PER_TURN);
    assert.deepEqual(await openPassed(1, PER_TURN), passed.map(shown), '턴 1의 답 아래 넘긴 기록');
    assert.deepEqual(turnRows(games.second.id).map((t) => t.ids), [ids(passed)], '판 파일의 턴 1 memory_ids');
    return `"${toggleText(PER_TURN)}" 접힘(${closed}) → 펼침: ${passed.map((m) => m.kind).join(', ')}, 턴 1 memory_ids가 같은 id ${PER_TURN}개 (${await page.shot('passed-open')})`;
  });

  await h.step('edit', '넘긴 첫 기록의 [고치기] → 입력 칸의 글을 바꿔 [저장]. 그 자리에 고친 글과 "고침"이 보이고 판 파일의 기억 글이 바뀐다', async () => {
    const first = `${reply(1)}?.querySelectorAll('.memory')[0]`;
    await page.click(buttonIn(first, '고치기'), '첫 기록의 [고치기]');
    await page.waitFor(`${first}.querySelector('.memory-edit textarea')`, '고치기 입력 칸이 열리지 않는다');
    assert.equal(await page.evaluate(`${first}.querySelector('textarea').value`), made[0].text, '입력 칸은 지금 글로 시작한다');
    // 사람이 입력 칸의 글을 모두 골라 새로 치는 것과 같다.
    await page.evaluate(`(() => { const t = ${first}.querySelector('textarea'); t.focus(); t.select(); })()`);
    await page.send('Input.insertText', { text: EDITED });
    const editing = await page.shot('editing');
    await page.click(buttonIn(first, '저장'), '첫 기록의 [저장]');
    await page.waitFor(`!${first}.querySelector('textarea') && ${first}.querySelector('.memory-edited')`, '고친 글이 보이지 않는다');
    const row = memoryRows().find((m) => m.id === made[0].id);
    assert.equal(row.text, EDITED, '판 파일의 기억 글');
    assert.ok(row.edited_at, '판 파일의 edited_at');
    current[0] = row;
    assert.deepEqual(await itemsIn(reply(1)), current.slice(0, PER_TURN).map(shown), '고친 뒤의 넘긴 기록');
    return `입력 칸(${editing}) → "${shown(row)}", 판 파일 edited_at ${row.edited_at} (${await page.shot('edited')})`;
  });

  await h.step('delete', '넘긴 둘째 기록의 [지우기] → 그 자리의 물음에 [정말 지우기]. "지운 기록"과 안내가 보이고, 판 파일에서 빠지고, 글이 화면에 남지 않는다', async () => {
    const second = `${reply(1)}?.querySelectorAll('.memory')[1]`;
    await page.click(buttonIn(second, '지우기'), '둘째 기록의 [지우기]');
    await page.waitFor(`${second}.querySelector('.memory-confirm')`, '지우기 물음이 보이지 않는다');
    const ask = await page.evaluate(`${second}.querySelector('.memory-confirm > span').textContent`);
    assert.equal(ask, '이 기록을 지울까요? 상대에게 더 넘기지 않습니다. 판 기록은 남습니다.');
    const asking = await page.shot('delete-confirm');
    await page.click(buttonIn(second, '정말 지우기'), '둘째 기록의 [정말 지우기]');
    await page.waitFor(`${second}.classList.contains('deleted')`, '지운 기록으로 바뀌지 않는다');
    assert.deepEqual(await itemsIn(reply(1)), [shown(current[0]), DELETED_HERE, ...made.slice(2, PER_TURN).map(shown)], '지운 뒤의 넘긴 기록');
    current = current.filter((m) => m.id !== made[1].id);
    assert.deepEqual(ids(memoryRows()), ids(current), '판 파일의 기억(지운 것만 빠진다)');
    assert.ok(!(await page.evaluate('document.body.innerText')).includes(made[1].text), '지운 기억의 글이 화면에 남았다');
    return `물음(${asking}) → "${DELETED_HERE}", 판 파일에서 ${made[1].kind} 기억이 빠짐 (${await page.shot('deleted')})`;
  });

  await h.step('next-turn', '다음 턴을 보내면, 답 아래 넘긴 기록에 지운 기억이 없고 고친 글이 있으며, 판 파일의 턴 2 id와 같다', async () => {
    await send(SHORT, 2);
    // 지운 둘째 기억 자리를 그다음 기억이 채운다.
    const passed = current.slice(0, PER_TURN);
    passed2 = passed;
    assert.deepEqual(await openPassed(2, passed.length), passed.map(shown), '턴 2의 답 아래 넘긴 기록');
    const turns = turnRows(games.second.id);
    assert.deepEqual(turns.map((t) => t.ids), [ids(made.slice(0, PER_TURN)), ids(passed)], '판 파일의 턴 1, 2 memory_ids');
    assert.ok(!turns[1].ids.includes(made[1].id), '턴 2에 지운 기억이 넘어갔다');
    // 서버는 턴마다 기억 표에서 지금 글을 읽어 넘긴다. 턴 2보다 먼저 고쳤으므로 턴 2에 넘긴 첫 기억의 글은 고친 글이다.
    assert.ok(current[0].edited_at < turns[1].at, `고친 때(${current[0].edited_at})가 턴 2(${turns[1].at})보다 늦다`);
    return `턴 2에 넘긴 기록 ${passed.length}개(${passed.map((m) => m.kind).join(', ')}, 지운 ${made[1].kind} 없음), 고친 때 < 턴 2 (${await page.shot('next-turn')})`;
  });

  await h.step('reopen', '새로 고쳐 지난 판의 [이어 하기]를 누르면, 턴 1의 넘긴 기록은 고친 글(고침), 지운 기록, 그대로인 기록이고 턴 2는 다음 턴 때와 같다', async () => {
    await page.reload();
    await page.waitFor(`document.querySelectorAll('.past-game').length === 2`, '지난 판 둘이 보이지 않는다');
    await page.press('이어 하기');
    await page.waitFor(`document.querySelectorAll('.passed').length === 2`, '이어 연 판에 넘긴 기록 둘이 없다');
    // 새로 고친 뒤라 화면이 덮어 둔 것이 없다. 항목은 서버가 보낸 판(GameView.passed) 그대로다.
    const turn1 = await openPassed(1, PER_TURN);
    assert.deepEqual(turn1, [shown(current[0]), DELETED, ...made.slice(2, PER_TURN).map(shown)], '턴 1의 넘긴 기록');
    const turn2 = await openPassed(2, Math.min(PER_TURN, current.length));
    assert.deepEqual(turn2, current.slice(0, PER_TURN).map(shown), '턴 2의 넘긴 기록');
    const body = await page.evaluate('document.body.innerText');
    assert.ok(!body.includes(made[1].text), '지운 기억의 글이 다시 나왔다');
    assert.ok(!body.includes(made[0].text), '고치기 전 글이 나왔다');
    return `턴 1: ${turn1.join(' / ')} · 턴 2: ${turn2.length}개, 지운 글과 고치기 전 글 없음 (${await page.shot('reopened')})`;
  });

  await h.step('other-tab', '두 번째 탭에서 목록의 내 기억을 열어, 첫 탭의 턴 2 답 아래에 글로 보이는 고치지 않은 기억 둘을 [지우기] → [정말 지우기]. 판 파일에서 빠지고, 첫 탭은 모른 채 그 둘을 글로 보인다', async () => {
    elsewhere = passed2.filter((m) => !m.edited_at);
    assert.equal(elsewhere.length, 2, `턴 2에 넘긴 고치지 않은 기억이 둘이 아니다: ${passed2.map((m) => m.kind).join(', ')}`);
    other = await h.browser();
    await other.goto(app.url);
    await other.waitFor(`document.querySelector('#my-memories-title')`, '두 번째 탭에 내 기억 절이 보이지 않는다');
    assert.deepEqual(await other.texts('.memory-group .memory .memory-body'), current.map(shown), '두 번째 탭의 내 기억');
    for (const memory of elsewhere) {
      const item = `document.querySelectorAll('.memory-group .memory')[${current.findIndex((m) => m.id === memory.id)}]`;
      await other.click(buttonIn(item, '지우기'), `두 번째 탭의 ${KIND[memory.kind]} 기록 [지우기]`);
      await other.click(buttonIn(item, '정말 지우기'), `두 번째 탭의 ${KIND[memory.kind]} 기록 [정말 지우기]`);
      await other.waitFor(`${item}.classList.contains('deleted')`, `두 번째 탭의 ${KIND[memory.kind]} 기록이 지운 기록으로 바뀌지 않는다`);
    }
    const shot = await other.shot('other-tab');
    current = current.filter((m) => !ids(elsewhere).includes(m.id));
    assert.deepEqual(ids(memoryRows()), ids(current), '판 파일의 기억(두 번째 탭에서 지운 둘이 빠진다)');
    assert.deepEqual(await itemsIn(reply(2)), passed2.map(shown), '첫 탭의 턴 2 넘긴 기록(아직 지운 줄 모른다)');
    return `두 번째 탭에서 ${elsewhere.map((m) => m.kind).join(', ')} 기억을 지움(${shot}), 판 파일의 기억 ${current.length}개, 첫 탭의 턴 2는 그대로 ${passed2.length}개`;
  });

  await h.step('stale-edit', '첫 탭에서 두 번째 탭이 지운 첫째 기억의 [고치기] → 글을 바꿔 [저장]. 그 자리가 "지운 기록"과 "다른 곳에서 이미 지운 기록입니다."로 바뀌고, 같은 기억이 넘어간 턴 1의 자리도 지운 기록이 된다', async () => {
    const [target] = elsewhere;
    const item = `${reply(2)}?.querySelectorAll('.memory')[${passed2.findIndex((m) => m.id === target.id)}]`;
    await page.click(buttonIn(item, '고치기'), `턴 2의 ${KIND[target.kind]} 기록 [고치기]`);
    await page.waitFor(`${item}.querySelector('.memory-edit textarea')`, '고치기 입력 칸이 열리지 않는다');
    await page.evaluate(`(() => { const t = ${item}.querySelector('textarea'); t.focus(); t.select(); })()`);
    await page.send('Input.insertText', { text: STALE_EDIT });
    await page.click(buttonIn(item, '저장'), `턴 2의 ${KIND[target.kind]} 기록 [저장]`);
    await settled(item, `턴 2의 ${KIND[target.kind]} 기록`);
    assert.deepEqual(await itemsIn(reply(2)), passed2.map((m) => (m.id === target.id ? DELETED_ELSEWHERE : shown(m))), '턴 2의 넘긴 기록');
    // 같은 기억이 턴 1에도 넘어갔다. 한 곳에서 안 것은 판 화면 전체에 미치고, 알림은 누른 자리에만 있다.
    assert.deepEqual(await itemsIn(reply(1)), made.slice(0, PER_TURN).map(nowShown), '턴 1의 넘긴 기록');
    assert.ok(!(await page.evaluate('document.body.innerText')).includes(target.text), '다른 탭에서 지운 기억의 글이 화면에 남았다');
    assert.deepEqual(ids(memoryRows()), ids(current), '판 파일의 기억(고쳐 보려 해도 다시 생기지 않는다)');
    return `"${DELETED_ELSEWHERE}", 턴 1의 같은 기억도 "${DELETED}", 오류 줄 없음 (${await page.shot('stale-edit')})`;
  });

  await h.step('stale-delete', '첫 탭에서 두 번째 탭이 지운 둘째 기억의 [지우기] → [정말 지우기]. 그 자리가 "지운 기록"과 "다른 곳에서 이미 지운 기록입니다."로 바뀌고 오류 줄이 없다', async () => {
    const [, target] = elsewhere;
    const item = `${reply(2)}?.querySelectorAll('.memory')[${passed2.findIndex((m) => m.id === target.id)}]`;
    await page.click(buttonIn(item, '지우기'), `턴 2의 ${KIND[target.kind]} 기록 [지우기]`);
    await page.click(buttonIn(item, '정말 지우기'), `턴 2의 ${KIND[target.kind]} 기록 [정말 지우기]`);
    await settled(item, `턴 2의 ${KIND[target.kind]} 기록`);
    assert.deepEqual(await itemsIn(reply(2)), passed2.map((m) => (ids(elsewhere).includes(m.id) ? DELETED_ELSEWHERE : shown(m))), '턴 2의 넘긴 기록');
    assert.ok(!(await page.evaluate('document.body.innerText')).includes(target.text), '다른 탭에서 지운 기억의 글이 화면에 남았다');
    assert.deepEqual(ids(memoryRows()), ids(current), '판 파일의 기억');
    return `"${DELETED_ELSEWHERE}", 오류 줄 없음 (${await page.shot('stale-delete')})`;
  });

  await h.step('list-after', '[목록으로] 나가면 내 기억에 고친 글(고침)이 있고 지운 기억은 없다', async () => {
    await page.press('목록으로');
    await page.waitFor(`document.querySelector('#my-memories-title')`, '내 기억 절이 보이지 않는다');
    assert.deepEqual(await page.texts('.memory-group .memory .memory-body'), current.map(shown), '내 기억의 항목');
    return `내 기억 ${current.length}개(고친 글 1, 지운 기억 없음) (${await page.shot('list-after')})`;
  });

  await h.step('db', '판 파일: 기억 표가 화면에서 본 것과 같고, 둘째 판 턴의 넘긴 기억 id가 화면의 넘긴 기록과 같으며, 첫 판의 턴은 그대로다. 두 탭 모두 화면에 오류가 없다', () => {
    const rows = memoryRows();
    assert.deepEqual(rows, current, '기억 표(고친 줄은 고칠 때 읽은 그대로, 지운 줄은 없음)');
    const [all, firstTurns] = db((d) => [
      d.prepare('SELECT id, memory, verdict FROM games ORDER BY rowid').all().map((r) => [r.id, r.memory, r.verdict]),
      d.prepare('SELECT n, user_text FROM turns WHERE game_id = ? ORDER BY n').all(games.first.id).map((r) => ({ ...r })),
    ]);
    assert.deepEqual(all, [[games.first.id, 1, 'debate'], [games.second.id, 1, null]], '판 둘, 둘 다 기억을 쓴다');
    assert.deepEqual(firstTurns, FIRST_GAME.map((text, i) => ({ n: i + 1, user_text: text })), '기억을 지워도 첫 판의 턴 원문은 남는다');
    const passedIds = turnRows(games.second.id).map((t) => t.ids);
    assert.deepEqual(passedIds, [ids(made.slice(0, PER_TURN)), ids(passed2)], '둘째 판 턴의 memory_ids');
    assert.deepEqual({ first: page.errors, other: other.errors }, { first: [], other: [] }, '두 탭 화면의 예외나 console.error');
    const gone = made.filter((m) => !ids(current).includes(m.id));
    return `memories ${rows.length}행(고친 것 1, 지운 ${gone.map((m) => m.kind).join(', ')} 없음), 둘째 판 memory_ids ${passedIds.map((x) => x.length).join('개, ')}개, 첫 판 턴 ${firstTurns.length}행 그대로, 화면 오류 0 (${app.db})`;
  });
}
