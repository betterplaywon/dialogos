// 음성으로 한 판의 입력 칸 규칙을 화면에서 확인한다: 켜기 → 말하기 → 다시 말하기 → 손댄 뒤 말하기 → 보내기 → 듣는 중에 끄기
// → 보내기 → 앱 안 브라우저(VS Code)의 안내. 브라우저의 음성 인식과 음성 합성만 가짜로 바꾼다(브라우저 API 경계의 모의).
// 가짜 인식기는 여정이 정한 글을 정한 때 내고, 가짜 합성기는 받은 글을 적고, 소리 없이 start와 end를 낸다. 실제 마이크와 소리는 쓰지 않는다.
// 단계 id와 기대값은 features/voice-screen.md에 있다.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

export const title = '음성으로 한 판(화면, 가짜 인식기와 합성기, 모의 모델, 창 없는 Chrome)';

/** VS Code 안의 브라우저가 보내는 User-Agent의 꼴(app/tests/embedded-browser.test.ts와 같다). */
const VS_CODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.129.0 Chrome/148.0.0.0 Electron/42.6.0 Safari/537.36';

const NOTICE = {
  put: '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  replaced: '앞서 인식한 글을 새로 인식한 글로 바꿨습니다. 고친 뒤 보내 주세요.',
  appended: '쓰던 글은 두고 인식한 글을 끝에 붙였습니다. 고친 뒤 보내 주세요.',
};

/**
 * 페이지 스크립트보다 먼저 돌아 브라우저의 음성 인식과 음성 합성을 가짜로 바꾼다. 문자열로 페이지에 넣으므로 바깥 변수를 쓰지 않는다.
 * - 인식기: start하면 __fakeVoice.say로 넣어 둔 글 하나를 중간 결과로 내고 기다린다. stop하면 그 글을 확정 결과로 내고 끝난다.
 *   기기 안 인식(available, install)은 바로 된다고 답한다.
 * - 합성기: 한국어 기기 목소리 하나가 있고, speak한 글을 적은 뒤 차례로 start와 end를 낸다. 소리는 내지 않는다.
 * - 네 이름(SpeechRecognition, webkitSpeechRecognition, speechSynthesis, SpeechSynthesisUtterance)을 읽은 횟수까지 센다.
 */
function installFakeVoice() {
  const log = { touched: 0, recognizers: 0, starts: [], stops: 0, available: 0, install: 0, utterances: 0, voiceLists: 0, spoken: [], cancels: 0 };
  const lines = [];
  window.__fakeVoice = { log, say: (text) => lines.push(text) };

  const resultsOf = (text, isFinal) => [Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal })];
  class FakeRecognition {
    constructor() {
      log.recognizers += 1;
      Object.assign(this, { lang: '', continuous: false, interimResults: false, maxAlternatives: 1, onstart: null, onresult: null, onerror: null, onend: null });
      this.live = false;
      this.text = null;
    }
    start() {
      log.starts.push({ lang: this.lang, processLocally: this.processLocally === true, interimResults: this.interimResults });
      this.live = true;
      this.text = lines.shift() ?? null;
      setTimeout(() => {
        if (!this.live) return;
        this.onstart?.();
        if (this.text !== null) setTimeout(() => this.live && this.onresult?.({ results: resultsOf(this.text, false) }), 30);
      }, 30);
    }
    stop() {
      log.stops += 1;
      if (!this.live) return;
      this.live = false;
      setTimeout(() => {
        if (this.text !== null) this.onresult?.({ results: resultsOf(this.text, true) });
        this.onend?.();
      }, 30);
    }
    abort() {
      if (!this.live) return;
      this.live = false;
      setTimeout(() => {
        this.onerror?.({ error: 'aborted' });
        this.onend?.();
      }, 0);
    }
  }
  FakeRecognition.available = async () => {
    log.available += 1;
    return 'available';
  };
  FakeRecognition.install = async () => {
    log.install += 1;
    return true;
  };

  const voices = [{ name: 'verify 가짜 한국어', lang: 'ko-KR', localService: true, default: true, voiceURI: 'verify-fake-ko' }];
  class FakeUtterance extends EventTarget {
    constructor(text = '') {
      super();
      log.utterances += 1;
      Object.assign(this, { text, lang: '', voice: null, rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null });
    }
  }
  const fire = (utterance, type, extra = {}) => {
    const event = Object.assign(new Event(type), extra);
    utterance.dispatchEvent(event);
    utterance[`on${type}`]?.(event);
  };
  const queue = [];
  let current = null;
  const next = () => {
    if (current || queue.length === 0) return;
    const utterance = queue.shift();
    current = utterance;
    setTimeout(() => {
      if (current !== utterance) return;
      fire(utterance, 'start');
      setTimeout(() => {
        if (current !== utterance) return;
        current = null;
        fire(utterance, 'end');
        next();
      }, 40);
    }, 10);
  };
  class FakeSynthesis extends EventTarget {
    getVoices() {
      log.voiceLists += 1;
      return voices;
    }
    speak(utterance) {
      log.spoken.push({ text: utterance.text, voice: utterance.voice?.name ?? null, volume: utterance.volume });
      queue.push(utterance);
      next();
    }
    cancel() {
      log.cancels += 1;
      queue.length = 0;
      const utterance = current;
      current = null;
      if (utterance) setTimeout(() => fire(utterance, 'error', { error: 'interrupted' }), 0);
    }
    pause() {}
    resume() {}
    get speaking() {
      return current !== null;
    }
    get pending() {
      return queue.length > 0;
    }
    get paused() {
      return false;
    }
  }
  const synthesis = new FakeSynthesis();
  const define = (name, value) =>
    Object.defineProperty(window, name, {
      configurable: true,
      get() {
        log.touched += 1;
        return value;
      },
    });
  define('SpeechRecognition', FakeRecognition);
  define('webkitSpeechRecognition', FakeRecognition);
  define('speechSynthesis', synthesis);
  define('SpeechSynthesisUtterance', FakeUtterance);
}

/** 글자와 숫자만 남긴다. 합성기는 글을 문장 조각으로 나눠 받으므로 이것으로 견준다. */
const letters = (text) => text.replace(/[^\p{L}\p{N}]/gu, '');

export async function run(h) {
  let app;
  let page;
  const fake = () => page.evaluate('window.__fakeVoice.log');
  /** 합성기에 간 글을 from번째 것부터 이어 글자와 숫자만 남긴 것. */
  const spokenSince = async (from) => letters((await fake()).spoken.slice(from).map((u) => u.text).join(''));
  const draft = () => page.value('#draft');
  const turnRow = (n) => {
    const db = new DatabaseSync(app.dbPath, { readOnly: true });
    try {
      return { ...db.prepare('SELECT n, user_text, input, redone FROM turns WHERE n = ?').get(n) };
    } finally {
      db.close();
    }
  };
  /** 가짜 인식기에 글을 넣고 [말하기]를 누른다. 듣는 중의 글이 보이면 돌아온다. */
  async function speak(text) {
    await page.evaluate(`window.__fakeVoice.say(${JSON.stringify(text)})`);
    await page.press('말하기');
    await page.waitFor(`document.querySelector('.interim')?.innerText.includes(${JSON.stringify(`듣는 중: ${text}`)})`, `듣는 중에 "${text}"가 보이지 않는다`);
  }
  /** [말 마치기]를 눌러 들은 글이 입력 칸에 들어오기를 기다린다. 입력 칸의 글과 알림을 돌려준다. */
  async function finish() {
    await page.press('말 마치기');
    await page.waitFor(`!document.querySelector('.interim') && document.querySelector('.voice-status')?.innerText.trim() !== ''`, '듣기가 끝나지 않는다');
    return { draft: await draft(), notice: await page.text('.voice-status') };
  }
  /** [보내기]를 누르고 n번째 턴의 답을 기다린다. */
  async function send(n) {
    await page.press('보내기');
    await page.waitFor(
      `document.querySelector('.game-meta p')?.innerText.endsWith('턴 ${n} / 30') && !document.querySelector('.message.pending')`,
      `턴 ${n}의 답이 오지 않는다`,
    );
    return (await page.texts('.message.opponent p')).at(-1);
  }

  await h.step('app', '앱을 빈 포트 둘에 모의 모델로 띄운다(app/dev.ts, 증거 폴더의 새 판 파일)', async () => {
    app = await h.app();
    return `서버 127.0.0.1:${app.api}, 화면 ${app.url}, 판 파일 ${app.db} (${app.log})`;
  });

  await h.step('start', '가짜 음성을 넣은 Chrome으로 첫 주제를 "대체로"로 시작한다. 켜기 전에는 인식기와 합성기를 부르지 않는다', async () => {
    page = await h.browser();
    await page.beforeLoad(`(${installFakeVoice.toString()})();`);
    await page.goto(app.url);
    await page.press('이 주제로');
    await page.choose('start-lean', 1);
    await page.press('이 입장으로 시작');
    await page.waitFor(`document.querySelector('.game')`, '판 화면이 열리지 않는다');
    assert.equal(await page.hasButton('음성으로 하기', { enabled: true }), true, '[음성으로 하기]가 없다');
    const log = await fake();
    assert.deepEqual(
      { recognizers: log.recognizers, install: log.install, available: log.available, utterances: log.utterances, voiceLists: log.voiceLists, spoken: log.spoken.length },
      { recognizers: 0, install: 0, available: 0, utterances: 0, voiceLists: 0, spoken: 0 },
      '켜기 전에 가짜 인식기나 합성기를 불렀다',
    );
    return `${await page.text('.game-meta p')}, [음성으로 하기] 있음, 가짜 인식기·합성기 호출 0 (${await page.shot('start')})`;
  });

  await h.step('voice-on', '[음성으로 하기]를 누르면 기기 안 인식을 준비하고, 상대의 첫 발언을 합성기로 읽는다', async () => {
    const opening = (await page.texts('.message.opponent p'))[0];
    await page.press('음성으로 하기');
    await page.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '말하기' && !b.disabled)`, '[말하기]가 눌리지 않는다');
    assert.equal(await page.text('.voice-bar p[role="status"]'), '말소리는 이 기기 안에서 글로 바뀝니다.');
    assert.equal(await page.hasButton('음성 끄기'), true, '[음성 끄기]가 없다');
    await page.waitFor(`window.__fakeVoice.log.spoken.length > 1 && !window.speechSynthesis.speaking && !window.speechSynthesis.pending`, '합성기가 첫 발언을 다 읽지 않는다');
    const log = await fake();
    assert.equal(log.spoken[0].text, '', '켜는 누름 안의 첫 읽기는 빈 글이다');
    assert.equal(log.spoken[0].volume, 0, '빈 첫 읽기의 소리 크기');
    assert.equal(await spokenSince(1), letters(opening), '합성기에 간 글 = 상대의 첫 발언');
    assert.ok(log.spoken.slice(1).every((u) => u.voice === 'verify 가짜 한국어'), '기기 목소리로 읽는다');
    assert.deepEqual({ install: log.install, available: log.available }, { install: 1, available: 1 });
    return `기기 안 인식 안내, [말하기]·[음성 끄기], 첫 발언 ${log.spoken.length - 1}조각을 기기 목소리로 읽음 (${await page.shot('voice-on')})`;
  });

  await h.step('say-first', "말하기('첫째') → 입력 칸에 '첫째'가 들어간다", async () => {
    await speak('첫째');
    const listeningShot = await page.shot('listening-first');
    const { draft: text, notice } = await finish();
    assert.equal(text, '첫째');
    assert.equal(notice, NOTICE.put);
    const [start] = (await fake()).starts;
    assert.deepEqual(start, { lang: 'ko-KR', processLocally: true, interimResults: true }, '인식기 설정');
    return `입력 칸 '${text}', 알림 '${notice}', 인식기 ko-KR·기기 안 (${listeningShot}, ${await page.shot('said-first')})`;
  });

  await h.step('say-again', "손대지 않고 다시 말하기('둘째') → 입력 칸이 '둘째'로 바뀐다(2026-11-23 결정)", async () => {
    await speak('둘째');
    const { draft: text, notice } = await finish();
    assert.equal(text, '둘째', '직전 인식 글을 새로 들은 글로 바꾼다');
    assert.equal(notice, NOTICE.replaced);
    return `입력 칸 '${text}', 알림 '${notice}' (${await page.shot('said-again')})`;
  });

  await h.step('edit-then-say', "입력 칸 끝에 ' 그리고'를 친 뒤 말하기('셋째') → 쓴 글 끝에 붙는다(2026-11-24 결정)", async () => {
    await page.type('#draft', ' 그리고');
    assert.equal(await draft(), '둘째 그리고', '친 글');
    await speak('셋째');
    const { draft: text, notice } = await finish();
    assert.equal(text, '둘째 그리고 셋째', '손댄 글은 지우지 않고 끝에 붙인다');
    assert.equal(notice, NOTICE.appended);
    return `입력 칸 '${text}', 알림 '${notice}' (${await page.shot('edited-then-said')})`;
  });

  await h.step('send-voice', '[보내기] → 판 파일의 턴 1이 input=voice, redone=1이고, 상대의 답을 합성기로 읽는다', async () => {
    const before = (await fake()).spoken.length;
    const reply = await send(1);
    assert.deepEqual(turnRow(1), { n: 1, user_text: '둘째 그리고 셋째', input: 'voice', redone: 1 });
    await page.waitFor(`window.__fakeVoice.log.spoken.length > ${before} && !window.speechSynthesis.speaking && !window.speechSynthesis.pending`, '합성기가 답을 다 읽지 않는다');
    assert.equal(await spokenSince(before), letters(reply), '합성기에 간 글 = 상대의 답');
    return `턴 1: '둘째 그리고 셋째', input voice, redone 1. 답 ${reply.length}자를 읽음 (${await page.shot('sent-voice')})`;
  });

  await h.step('off-while-listening', "말하기('넷째') 뒤 다시 듣는 중('다섯째')에 [음성 끄기] → 들은 글이 끝에 붙고 입력 칸의 글은 그대로(PR #30)", async () => {
    await speak('넷째');
    assert.equal((await finish()).draft, '넷째');
    await speak('다섯째');
    const listeningShot = await page.shot('listening-fifth');
    await page.press('음성 끄기');
    await page.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '음성으로 하기')`, '음성이 꺼지지 않는다');
    const text = await draft();
    assert.equal(text, '넷째 다섯째', '끄면서 넘긴 글은 바꾸지 않고 끝에 붙인다');
    assert.equal(await page.hasButton('말하기'), false, '끈 뒤에 [말하기]가 남았다');
    return `끄기 전 입력 칸 '넷째', 끈 뒤 '${text}' (${listeningShot}, ${await page.shot('turned-off')})`;
  });

  await h.step('send-after-off', '[보내기] → 판 파일의 턴 2가 input=voice, redone=0이고, 음성이 꺼져 답을 읽지 않는다', async () => {
    const before = (await fake()).spoken.length;
    await send(2);
    assert.deepEqual(turnRow(2), { n: 2, user_text: '넷째 다섯째', input: 'voice', redone: 0 });
    // 읽기는 답이 온 바로 뒤에 시작한다. 잠시 기다려도 합성기에 간 글이 없어야 한다.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await fake()).spoken.length, before, '꺼진 뒤 합성기에 글이 갔다');
    return `턴 2: '넷째 다섯째', input voice, redone 0. 합성기에 간 글 없음 (${await page.shot('sent-after-off')})`;
  });

  await h.step('embedded', 'User-Agent가 VS Code(Electron) 꼴인 새 페이지에서는 Chrome에서 열라는 안내가 보이고, 가짜 인식기와 합성기에 닿지 않는다(PR #29, #31)', async () => {
    await page.send('Emulation.setUserAgentOverride', { userAgent: VS_CODE });
    await page.goto(app.url);
    assert.match(await page.evaluate('navigator.userAgent'), /Electron\//);
    await page.press('이어 하기');
    await page.waitFor(`document.querySelector('.game')`, '이어 한 판이 열리지 않는다');
    const bar = await page.text('.voice-bar');
    assert.match(bar, /^이 창은 앱 안에 들어 있는 브라우저라 음성 기능을 쓸 수 없습니다\. Chrome에서 이 주소를 열면 음성으로 토론할 수 있습니다\./, `앱 안 브라우저의 안내 대신 보인 음성 줄: ${bar.slice(0, 120)}`);
    assert.equal(await page.hasButton('음성으로 하기'), false, '앱 안 브라우저에 [음성으로 하기]가 보인다');
    const log = await fake();
    const touched = { touched: log.touched, recognizers: log.recognizers, install: log.install, available: log.available, utterances: log.utterances, voiceLists: log.voiceLists, spoken: log.spoken.length };
    assert.deepEqual(touched, { touched: 0, recognizers: 0, install: 0, available: 0, utterances: 0, voiceLists: 0, spoken: 0 }, '앱 안 브라우저에서 가짜 음성에 닿았다');
    assert.deepEqual(page.errors, [], '화면의 예외나 console.error');
    return `안내 "${bar.slice(0, 40)}…", [음성으로 하기] 없음, 가짜 음성에 닿은 횟수 0, 화면 오류 0 (${await page.shot('embedded')})`;
  });
}
