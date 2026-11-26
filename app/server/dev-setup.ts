// 개발 서버(app/dev.ts)의 설정. 환경 변수로 포트, 모델의 출처, 판마다 방식을 고르는 법을 정한다.
// 개발 서버는 이 설정으로 서버를 띄우기만 한다. 검사는 서버의 포트를 열지 않고 이 함수를 불러 개발 서버와 같은 설정을 만든다.
// .env를 읽지 않는다.

import type { ModelSource } from './budget.ts';
import { randomMode } from './games.ts';
import { localConfigFromEnv, localProblem, localSource, mockSource, type Env, type LocalThink } from './models.ts';
import { portsFromEnv, type DevPorts } from './port.ts';
import type { Mode } from './store.ts';

/** 생각 설정마다 첫 줄에 알릴, 생각하는 역할. */
const THINK_LABELS: Readonly<Record<LocalThink, string>> = { judge: '판정기만', all: '판정기와 상대', none: '끔' };

/** 개발 서버가 환경 변수로 고른 것. */
export interface DevSetup {
  models: ModelSource;
  /** 판마다 방식을 고른다. 화면에는 알리지 않는다. */
  pickMode: () => Mode;
  /** 새 판이 기억을 쓰는지(턴마다 같은 주제의 기억을 넘기고, 끝 기록 때 만든다). 방식을 고르는 법(APP_MODE)이 정한다. */
  memory: boolean;
  /** 서버의 첫 줄에 알릴 말. */
  label: string;
  /** 서버와 화면의 포트. 화면 설정(web/vite.config.ts)도 같은 환경 변수를 같은 함수로 읽는다. */
  ports: DevPorts;
}

/**
 * APP_MODE로 판마다 방식을 고르는 법, 새 판이 기억을 쓰는지, 첫 줄에 알릴 말을 고른다.
 * 없으면 engine이다. 개인 사용에서 모든 판이 판정기를 거쳐 근거 없이는 물러서지 않게 하려는 것이다.
 * random은 판마다 지시문 방식과 엔진 방식을 반씩 고른다. 사람이 어느 쪽인지 모른 채 두 방식을 견주는 눈가림 비교에 쓴다.
 * 기억은 engine에서 켜고 random에서 끈다. 기억의 근거와 약점이 판정기의 판단을 드러내 눈가림을 깨기 때문이다(2026-11-25 사용자 결정).
 */
function modeFromEnv(env: Env): Pick<DevSetup, 'pickMode' | 'memory' | 'label'> {
  const choice = env.APP_MODE || 'engine';
  if (choice === 'engine') return { pickMode: () => 'engine', memory: true, label: '엔진 방식, 기억 켬' };
  if (choice === 'random') return { pickMode: randomMode, memory: false, label: '방식 반씩 무작위(눈가림 비교), 기억 끔' };
  throw new Error('APP_MODE에는 engine(모든 판을 엔진 방식으로, 기본값)이나 random(판마다 지시문 방식과 엔진 방식을 반씩 무작위로, 눈가림 비교)을 적습니다.');
}

/**
 * 환경 변수로 개발 서버의 설정을 고른다. 고르지 못하면 사람이 고칠 것을 알리는 오류를 던지고, 개발 서버는 띄우지 않는다.
 * 포트와 판의 방식을 먼저 고른다(portsFromEnv, modeFromEnv). 둘 중 하나가 틀리면 로컬 모델 서버에 아무것도 묻지 않는다.
 * APP_MODEL이 없으면 모의 모델이고, local이면 이 컴퓨터에서 도는 로컬 모델(Ollama)이다.
 * 로컬 모델은 설정과 주소를 검사하고 띄울 때 확인(localProblem)까지 마친 출처를 낸다.
 */
export async function devSetup(env: Env): Promise<DevSetup> {
  const ports = portsFromEnv(env);
  const { pickMode, memory, label: mode } = modeFromEnv(env);
  const choice = env.APP_MODEL || 'mock';
  if (choice === 'mock') return { models: mockSource(), pickMode, memory, label: `${mode}, 모의 모델`, ports };
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
    pickMode,
    memory,
    label: `${mode}, 로컬 모델 ${names}, 생각: ${THINK_LABELS[config.think]}, 무료: 이 컴퓨터 안의 주소만`,
    ports,
  };
}
