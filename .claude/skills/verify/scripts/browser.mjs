// 화면 여정이 쓰는 실제 Chrome. 의존성 없이 DevTools 프로토콜(CDP)로 몬다.
// 창 없는 Chrome을 이번 실행만의 새 사용자 폴더(lib.mjs가 OS 임시 폴더에 만들고 닫을 때 지움)로 띄워, 사용자의 Chrome과 그 설정을 건드리지 않는다.
// 누르기와 쓰기는 사람이 하는 길(마우스 이벤트, 글자 입력)로 보내고, 화면에 보이는 것은 글로 읽어 확인한다.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** promise를 ms까지만 기다린다. 끝나면 타이머를 지워, 여정이 끝난 뒤 프로세스를 붙잡지 않게 한다. */
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** CDP 요청 하나를 기다리는 시간. Chrome이 멎었을 때 여정이 끝없이 기다리지 않게 한다. */
const SEND_MS = 20_000;

function chromePath() {
  const found = [process.env.CHROME_PATH, ...CHROME_CANDIDATES].find((p) => p && existsSync(p));
  if (!found) throw new Error(`Chrome을 찾지 못했다. CHROME_PATH에 실행 파일 경로를 적는다(찾아본 곳: ${CHROME_CANDIDATES.join(', ')}).`);
  return found;
}

/** 페이지 안에서 단추를 글로 찾는 식. 보이는 글이 같고 눌리는 단추 하나. */
const buttonExpr = (text) =>
  `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;

/**
 * Chrome을 띄우고 첫 탭에 붙는다. profileDir은 이번 실행만의 빈 사용자 폴더다.
 * onSpawn은 Chrome을 띄운 바로 그 차례에(사이에 기다림 없이) 닫는 함수를 받는다. 탭에 붙기 전에 종료 신호가 와도
 * 부르는 쪽이 Chrome을 닫을 수 있게 하려는 것이다. 돌려주는 page의 close()도 같은 함수다.
 * close()는 Chrome을 닫고 프로세스가 끝날 때까지 기다린다. 여러 번 불러도 된다.
 */
export async function launchChrome({ profileDir, shotsDir, onSpawn = () => {}, width = 900, height = 1200 }) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const chrome = spawn(
    chromePath(),
    [
      '--headless=new',
      // 디버깅 포트는 Chrome이 빈 포트를 골라 사용자 폴더의 DevToolsActivePort에 적는다.
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // macOS 키체인과 Linux 키링을 묻지 않게 하고, 업데이트·동기화 같은 바깥 요청을 줄이고, 소리를 끈다.
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  let closed = false;
  let ws = null;

  async function close() {
    if (closed) return;
    closed = true;
    // 탭에 붙어 있으면 Chrome에게 닫으라고 하고, 붙기 전이거나 끊겼으면 보낼 길이 없으므로 바로 끄라고 한다.
    const attached = ws?.readyState === WebSocket.OPEN;
    if (attached) ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }));
    if (chrome.exitCode === null && chrome.signalCode === null) {
      if (!attached) chrome.kill('SIGTERM');
      try {
        await within(exited, 5_000, 'Chrome이 5초 안에 닫히지 않았다.');
      } catch {
        chrome.kill('SIGKILL');
        await exited;
      }
    }
    ws?.close();
  }
  onSpawn(close);

  try {
    let target;
    for (let i = 0; i < 100 && !target; i += 1) {
      await sleep(150);
      if (closed) throw new Error('Chrome이 탭에 붙기 전에 닫혔다.');
      if (chrome.exitCode !== null) throw new Error(`Chrome이 뜨자마자 끝났다(종료 코드 ${chrome.exitCode}).`);
      if (!existsSync(portFile)) continue;
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        // 아직 준비되지 않았다.
      }
    }
    if (!target) throw new Error('Chrome의 디버깅 포트에 15초 안에 닿지 못했다.');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Chrome의 페이지에 붙지 못했다.')), { once: true });
    });
  } catch (error) {
    await close();
    throw error;
  }

  let seq = 0;
  const waiting = new Map();
  /** 페이지의 예외와 console.error. 여정 끝에 비어 있는지 본다. */
  const errors = [];
  /** 다음 load 이벤트를 기다리는 쪽. */
  const loads = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject, timer } = waiting.get(msg.id);
      clearTimeout(timer);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '예외');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (msg.method === 'Page.loadEventFired') for (const resolve of loads.splice(0)) resolve();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Chrome이 ${method}에 ${SEND_MS / 1000}초 안에 답하지 않았다.`));
      }, SEND_MS);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`페이지에서 식이 실패했다: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** 식이 참이 될 때까지 기다린다. 안 되면 무엇을 기다렸는지와 그때 화면의 글 일부를 담아 실패한다. */
  async function waitFor(expression, what, ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      if (await evaluate(`Boolean(${expression})`)) return;
      if (Date.now() > until) {
        const seen = await evaluate(`document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''`);
        throw new Error(`${ms / 1000}초를 기다려도 ${what}. 화면: ${seen}`);
      }
      await sleep(100);
    }
  }

  /**
   * 요소의 가운데를 마우스로 누른다. 요소가 나타나기를 5초까지 기다리고, 화면 안으로 굴리고 위치가 잇달아 같게 나올 때까지
   * (많아야 20번) 본 뒤, 그 자리에 그 요소가 있는지 보고 누른다.
   */
  async function clickAt(elementExpr, what) {
    let box = null;
    const until = Date.now() + 5_000;
    for (let i = 0; i < 20; ) {
      const next = await evaluate(`(() => {
        const el = ${elementExpr};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el))) };
      })()`);
      if (!next) {
        if (Date.now() > until) throw new Error(`5초를 기다려도 ${what}이(가) 없다. 보이는 단추: ${(await buttons()).join(', ') || '없음'}`);
        await sleep(100);
        continue;
      }
      if (box && box.x === next.x && box.y === next.y && next.hit) break;
      box = next;
      i += 1;
      await sleep(50);
    }
    if (!box.hit) throw new Error(`${what}의 자리에 다른 요소가 덮여 있어 누르지 못했다.`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  async function buttons() {
    return evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(비활성)' : ''))`);
  }

  let shots = 0;

  return {
    send,
    evaluate,
    waitFor,
    errors,
    buttons,
    close,

    /** 페이지를 열기 전에 돌 스크립트를 넣는다. 이 뒤로 여는 모든 페이지에서 페이지 스크립트보다 먼저 돈다. */
    async beforeLoad(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    /** 주소를 열고 load 이벤트까지 기다린다. */
    async goto(url) {
      const loaded = new Promise((resolve) => loads.push(resolve));
      await send('Page.navigate', { url });
      await within(loaded, 15_000, `${url}이(가) 15초 안에 열리지 않았다.`);
    },

    /** 새로 고침(사람의 F5와 같다). */
    async reload() {
      const loaded = new Promise((resolve) => loads.push(resolve));
      await send('Page.reload', { ignoreCache: false });
      await within(loaded, 15_000, '새로 고친 페이지가 15초 안에 열리지 않았다.');
    },

    /** 보이는 글로 단추를 찾아 누른다. 없거나 비활성이면 그때 보이는 단추를 담아 실패한다. */
    press: (text) => clickAt(buttonExpr(text), `[${text}] 단추(눌리는 것)`),

    /** 단추가 있는가. enabled면 눌리는 것만 센다. */
    hasButton: (text, { enabled = false } = {}) =>
      evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(text)}${enabled ? ' && !b.disabled' : ''})`),

    /** 라디오 단추 묶음(name)에서 index번째를 누른다(라벨 자리를 누른다). */
    choose: (name, index) =>
      clickAt(`document.querySelectorAll('input[name=${JSON.stringify(name)}]')[${index}]?.closest('label')`, `${name}의 ${index + 1}번째 칸`),

    /** 입력 칸(selector)을 눌러 글 끝에 이어 친다. */
    async type(selector, text) {
      await clickAt(`document.querySelector(${JSON.stringify(selector)})`, `입력 칸 ${selector}`);
      await evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
      await send('Input.insertText', { text });
    },

    /** selector에 맞는 요소들의 보이는 글. */
    texts: (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`),
    text: (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`),
    value: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`),

    /** 화면 사진을 증거 폴더에 남기고 파일 이름을 돌려준다. */
    async shot(label) {
      shots += 1;
      await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const name = `shot-${String(shots).padStart(2, '0')}-${label}.png`;
      writeFileSync(path.join(shotsDir, name), Buffer.from(data, 'base64'));
      return name;
    },
  };
}
