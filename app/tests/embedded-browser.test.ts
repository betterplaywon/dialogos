import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEmbeddedBrowser } from '../web/src/embedded-browser.ts';

// 브라우저가 보내는 User-Agent의 꼴. VS Code는 Electron 위에서 돌며 자기 이름(Code/)과 Electron/을 함께 적는다.
// 앱과 Electron의 버전은 2026-11-23 이 Mac의 VS Code(1.129.0, Electron 42.6.0)에서 읽었고, Chrome/ 뒤의 숫자는 꼴을 보이려고 넣은 값이다.
const VS_CODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.129.0 Chrome/148.0.0.0 Electron/42.6.0 Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const EDGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:160.0) Gecko/20100101 Firefox/160.0';

test('Electron으로 만든 앱 안의 브라우저(VS Code 등)를 가려낸다', () => {
  assert.equal(isEmbeddedBrowser(VS_CODE), true);
});

test('Chrome, Edge, Safari, Firefox는 앱 안의 브라우저가 아니다', () => {
  for (const userAgent of [CHROME, EDGE, SAFARI, FIREFOX, '']) assert.equal(isEmbeddedBrowser(userAgent), false);
});
