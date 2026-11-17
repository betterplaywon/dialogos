// 실행 결과를 runs/<실행 이름>/ 아래에 읽고 쓴다. 이 폴더는 커밋하지 않는다.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EVAL_DIR } from './data.ts';
import type { ChatModel, Condition, Usage } from './types.ts';
import { apiConfigFromEnv, createApiModel, type ApiRole } from './providers/api.ts';
import { createMockModel } from './providers/mock.ts';

export type Provider = 'mock' | 'api';

/** 실행 하나의 설정. runs/<실행 이름>/meta.json에 쓴다. */
export interface RunMeta {
  runId: string;
  provider: Provider;
  models: { opponent: string; judge: string };
  questions: string[];
  conditions: Condition[];
  reps: number;
  turns: number;
  createdAt: string;
  /** 채점기. eval:label이 채운다. */
  scorer?: { provider: Provider; model: string };
  /** 실제 모델이 쓴 토큰의 합. 여러 번에 나눠 돌리면 더한다. */
  usage?: Partial<Record<'opponent' | 'judge' | 'scorer', Usage>>;
}

/** 결과를 두는 폴더. 검사에서는 EVAL_RUNS_DIR로 다른 곳을 가리킨다. */
export function runsDir(): string {
  return process.env.EVAL_RUNS_DIR || join(EVAL_DIR, '..', 'runs');
}

/** 실행 이름은 폴더 이름으로 쓰이므로 글자, 숫자, 점, 밑줄, 줄표만 받는다. 폴더는 건드리지 않는다. */
export function runPath(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error('실행 이름은 영문자나 숫자로 시작하고, 영문자, 숫자, 점, 밑줄, 줄표만 쓸 수 있습니다.');
  }
  return join(runsDir(), runId);
}

export function runDir(runId: string, create = false): string {
  const dir = runPath(runId);
  if (create) mkdirSync(dir, { recursive: true });
  else if (!existsSync(dir)) throw new Error(`실행 '${runId}'를 찾을 수 없습니다.`);
  return dir;
}

export function defaultRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function toLines(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row) + '\n').join('');
}

export function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, toLines(rows));
}

/** 끝난 것부터 바로 덧붙인다. 도중에 멈춰도 그때까지의 결과가 남는다. */
export function appendJsonl(path: string, rows: unknown[]): void {
  appendFileSync(path, toLines(rows));
}

/**
 * 한 줄에 JSON 하나씩 든 파일을 읽는다.
 * skipBroken이 true면 읽을 수 없는 줄(쓰다가 끊긴 줄)을 건너뛴다. 이어서 실행할 때 쓴다.
 */
export function readJsonl<T>(path: string, skipBroken = false): T[] {
  if (!existsSync(path)) throw new Error(`파일이 없습니다: ${basename(path)}. 앞 단계를 먼저 실행했는지 확인하세요.`);
  const rows: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      if (!skipBroken) throw new Error(`${basename(path)}에 읽을 수 없는 줄이 있습니다.`, { cause: error });
    }
  }
  return rows;
}

export function readMeta(dir: string): RunMeta | undefined {
  const path = join(dir, 'meta.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RunMeta) : undefined;
}

export function writeMeta(dir: string, meta: RunMeta): void {
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

/** 이번에 쓴 토큰을 앞서 쓴 양에 더한다. 호출이 없었으면 그대로 둔다. */
export function addUsage(before: Usage | undefined, now: Usage | undefined): Usage | undefined {
  if (!now || now.calls === 0) return before;
  return {
    calls: (before?.calls ?? 0) + now.calls,
    promptTokens: (before?.promptTokens ?? 0) + now.promptTokens,
    completionTokens: (before?.completionTokens ?? 0) + now.completionTokens,
  };
}

export function parseProvider(value: string | undefined): Provider {
  if (value === undefined || value === 'mock') return 'mock';
  if (value === 'api') return 'api';
  throw new Error("--provider에는 'mock'이나 'api'만 쓸 수 있습니다.");
}

export function createModel(provider: Provider, role: ApiRole): ChatModel {
  return provider === 'mock' ? createMockModel(role) : createApiModel(apiConfigFromEnv(role));
}

/** 대화 하나를 가리키는 열쇠. */
export function dialogueKey(d: { questionId: string; condition: string; rep: number }): string {
  return `${d.questionId}|${d.condition}|${d.rep}`;
}
