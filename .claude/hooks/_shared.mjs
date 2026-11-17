// 훅 공용 도우미. 훅은 세션을 막지 않도록 실패를 삼킨다(가드 훅의 차단과 확인 요청만 예외).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

export function run(cmd, args, { cwd, timeout = 15_000 } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
  } catch {
    return null;
  }
}

export const git = (args, cwd) => run('git', args, { cwd });

/** 브랜치 이름. 커밋이 하나도 없는 저장소에서도 이름을 낸다. */
export const currentBranch = (cwd) => git(['branch', '--show-current'], cwd) || null;

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function notify(title, subtitle, body) {
  if (process.platform !== 'darwin') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  run('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`], {
    timeout: 5_000,
  });
}
