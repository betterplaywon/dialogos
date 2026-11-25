import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateVoice } from '../web/src/embedded-browser.ts';

// 브라우저가 보내는 User-Agent의 꼴. VS Code는 Electron 위에서 돌며 자기 이름(Code/)과 Electron/을 함께 적는다.
// 앱과 Electron의 버전은 2026-11-23 이 Mac의 VS Code(1.129.0, Electron 42.6.0)에서 읽었고, Chrome/ 뒤의 숫자는 꼴을 보이려고 넣은 값이다.
const VS_CODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.129.0 Chrome/148.0.0.0 Electron/42.6.0 Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const EDGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:160.0) Gecko/20100101 Firefox/160.0';

const RECOGNITION = { port: 'recognition' };
const SPEECH = { port: 'speech' };

/** 실제로는 browserRecognition과 browserSpeech 자리다. 이들이 만든 객체를 거쳐 [음성으로 하기]가 음성 서비스를 부르므로, 앱 안의 브라우저에서는 아예 만들지 않는다. */
function makers() {
  const made: string[] = [];
  const make = {
    recognition: () => {
      made.push('recognition');
      return RECOGNITION;
    },
    speech: () => {
      made.push('speech');
      return SPEECH;
    },
  };
  return { made, make };
}

// VS Code가 아닌 Electron 앱의 꼴. 앱 이름은 꼴을 보이려고 지어낸 것이다. 가림이 VS Code만 보도록 좁아지면 이 꼴에서 실패한다.
const OTHER_ELECTRON =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ExampleApp/3.2.1 Chrome/148.0.0.0 Electron/42.6.0 Safari/537.36';

test('Electron으로 만든 앱 안의 브라우저(VS Code 등)에서는 인식과 합성을 만들지 않는다', () => {
  for (const userAgent of [VS_CODE, OTHER_ELECTRON]) {
    const { made, make } = makers();
    assert.deepEqual(gateVoice(userAgent, make), { embedded: true, recognition: null, speech: null }, userAgent);
    assert.deepEqual(made, [], userAgent);
  }
});

test('Chrome, Edge, Safari, Firefox에서는 인식과 합성을 한 번씩 만들어 그대로 넘긴다', () => {
  for (const userAgent of [CHROME, EDGE, SAFARI, FIREFOX, '']) {
    const { made, make } = makers();
    const gated = gateVoice(userAgent, make);
    assert.equal(gated.embedded, false, userAgent);
    assert.equal(gated.recognition, RECOGNITION, userAgent);
    assert.equal(gated.speech, SPEECH, userAgent);
    assert.deepEqual(made.sort(), ['recognition', 'speech'], userAgent);
  }
});
