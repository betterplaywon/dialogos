// 개발 서버의 포트(APP_PORT, APP_WEB_PORT) 검사. 포트를 열지 않는다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devSetup } from '../server/dev-setup.ts';
import { portsFromEnv } from '../server/port.ts';

test('포트를 적지 않으면 README에 적은 기본값(서버 8787, 화면 5173)이다. 빈 값과 공백뿐인 값도 적지 않은 것으로 본다', () => {
  assert.deepEqual(portsFromEnv({}), { api: 8787, web: 5173 });
  assert.deepEqual(portsFromEnv({ APP_PORT: '', APP_WEB_PORT: '  ' }), { api: 8787, web: 5173 });
});

test('APP_PORT와 APP_WEB_PORT를 따로 읽고, 앞뒤 공백은 뗀다', () => {
  assert.deepEqual(portsFromEnv({ APP_PORT: '50001' }), { api: 50001, web: 5173 });
  assert.deepEqual(portsFromEnv({ APP_WEB_PORT: ' 50002 ' }), { api: 8787, web: 50002 });
  assert.deepEqual(portsFromEnv({ APP_PORT: '1024', APP_WEB_PORT: '65535' }), { api: 1024, web: 65535 });
});

test('1024~65535의 정수가 아니면 그 변수의 이름과 쓸 수 있는 값을 알리고 받지 않는다', () => {
  for (const value of ['80', '1023', '65536', '0', '-1', '8787.5', '8e3', 'abc', '87 87', '0x2253']) {
    assert.throws(() => portsFromEnv({ APP_PORT: value }), /^Error: APP_PORT에는 1024부터 65535까지의 정수를 적습니다\(기본값 8787\)\.$/, value);
    assert.throws(() => portsFromEnv({ APP_WEB_PORT: value }), /^Error: APP_WEB_PORT에는 1024부터 65535까지의 정수를 적습니다\(기본값 5173\)\.$/, value);
  }
});

test('서버와 화면의 포트가 같으면 받지 않는다. 기본값과 겹치게 한쪽만 적은 경우도 같다', () => {
  assert.throws(() => portsFromEnv({ APP_PORT: '50001', APP_WEB_PORT: '50001' }), /APP_PORT와 APP_WEB_PORT가 같습니다\(50001\)/);
  assert.throws(() => portsFromEnv({ APP_PORT: '5173' }), /APP_PORT와 APP_WEB_PORT가 같습니다\(5173\)/);
});

test('개발 서버의 설정은 고른 포트를 싣고, 포트가 틀리면 로컬 모델 서버에 묻기 전에 멈춘다', async () => {
  assert.deepEqual((await devSetup({ APP_PORT: '50001', APP_WEB_PORT: '50002' })).ports, { api: 50001, web: 50002 });
  assert.deepEqual((await devSetup({})).ports, { api: 8787, web: 5173 });
  // 포트를 늦게 읽으면 아무도 듣지 않는 이 주소(discard 포트)에 목록을 물어 다른 까닭으로 멈춘다.
  await assert.rejects(devSetup({ APP_PORT: '80', APP_MODEL: 'local', APP_LOCAL_URL: 'http://127.0.0.1:9/v1' }), /^Error: APP_PORT에는/);
});
