// 개발 서버(app/dev.ts)의 설정. 환경 변수로 모델의 출처와 판마다 방식을 고르는 법을 정한다.
// 개발 서버는 이 설정으로 서버를 띄우기만 한다. 검사는 서버의 포트를 열지 않고 이 함수를 불러 개발 서버와 같은 설정을 만든다.
// .env를 읽지 않는다.

import type { ModelSource } from './budget.ts';
import { randomMode } from './games.ts';
import { localConfigFromEnv, localProblem, localSource, mockSource, type Env } from './models.ts';
import type { Mode } from './store.ts';

/** 개발 서버가 환경 변수로 고른 것. */
export interface DevSetup {
  models: ModelSource;
  /** 판마다 방식을 고른다. 화면에는 알리지 않는다. */
  pickMode: () => Mode;
  /** 서버의 첫 줄에 알릴 말. */
  label: string;
}

/**
 * 환경 변수로 개발 서버의 설정을 고른다. 고르지 못하면 사람이 고칠 것을 알리는 오류를 던지고, 개발 서버는 띄우지 않는다.
 * APP_MODEL이 없으면 모의 모델이고, local이면 이 컴퓨터에서 도는 로컬 모델(Ollama)이다.
 * 로컬 모델은 설정과 주소를 검사하고 띄울 때 확인(localProblem)까지 마친 출처를 낸다.
 */
export async function devSetup(env: Env): Promise<DevSetup> {
  const choice = env.APP_MODEL || 'mock';
  if (choice === 'mock') return { models: mockSource(), pickMode: randomMode, label: '모의 모델' };
  if (choice !== 'local') throw new Error('APP_MODEL에는 mock(모의 모델, 기본값)이나 local(이 컴퓨터의 로컬 모델)을 적습니다.');
  // 설정이 틀렸거나 주소가 이 컴퓨터가 아니면 여기서 멈춘다. 그 주소로는 모델 목록도 묻지 않는다.
  const config = localConfigFromEnv(env);
  const models = localSource(config);
  const problem = await localProblem(config);
  if (problem) throw new Error(problem);
  const { opponent, judge } = config.models;
  const names = opponent === judge ? opponent : `상대 ${opponent}, 판정기 ${judge}`;
  return {
    models,
    pickMode: randomMode,
    label: `로컬 모델 ${names}, 생각 ${config.think ? '켬' : '끔'}, 무료: 이 컴퓨터 안의 주소만`,
  };
}
