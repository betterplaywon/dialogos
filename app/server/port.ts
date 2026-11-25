// 개발 서버(app/dev.ts)가 듣는 포트. 화면(Vite)은 /api를 서버 포트로 넘긴다.
// 같은 컴퓨터에 개발 서버를 하나 더 띄울 때(verify 스킬의 화면 여정 등) 환경 변수로 바꾼다. .env를 읽지 않는다.

import type { Env } from './models.ts';

/** 서버(Hono)와 화면(Vite)의 포트. */
export interface DevPorts {
  api: number;
  web: number;
}

/** 환경 변수를 적지 않았을 때의 포트. */
export const DEFAULT_PORTS: DevPorts = { api: 8787, web: 5173 };

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function portOf(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= MIN_PORT && port <= MAX_PORT)) {
    throw new Error(`${name}에는 ${MIN_PORT}부터 ${MAX_PORT}까지의 정수를 적습니다(기본값 ${fallback}).`);
  }
  return port;
}

/**
 * APP_PORT(서버)와 APP_WEB_PORT(화면)를 읽는다. 적지 않으면 8787과 5173이다.
 * 1024~65535의 정수가 아니거나 둘이 같으면 사람이 고칠 것을 알리는 오류를 던진다. 개발 서버는 띄우지 않는다.
 */
export function portsFromEnv(env: Env): DevPorts {
  const ports: DevPorts = { api: portOf(env, 'APP_PORT', DEFAULT_PORTS.api), web: portOf(env, 'APP_WEB_PORT', DEFAULT_PORTS.web) };
  if (ports.api === ports.web) throw new Error(`APP_PORT와 APP_WEB_PORT가 같습니다(${ports.api}). 서버와 화면은 다른 포트를 씁니다.`);
  return ports;
}
