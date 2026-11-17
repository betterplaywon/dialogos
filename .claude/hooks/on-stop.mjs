#!/usr/bin/env node
// Stop 훅. 실행이 멈추면 (1) macOS 알림을 띄우고 (2) 마지막 답변을 notes/reports/<날짜>.md에 덧붙인다.
// 사용자가 터미널을 보지 않아도 보고서가 쌓인다. notes/는 커밋하지 않는다.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { currentBranch, notify, projectDir, readInput } from './_shared.mjs';

const pad = (n) => String(n).padStart(2, '0');

try {
  const input = readInput();
  if (!input.stop_hook_active) {
    const project = projectDir(input);
    const branch = currentBranch(project) ?? '?';
    const text = String(input.last_assistant_message ?? '').trim();
    const now = new Date();
    if (text) {
      const dir = path.join(project, 'notes', 'reports');
      mkdirSync(dir, { recursive: true });
      const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      appendFileSync(path.join(dir, `${day}.md`), `\n## ${pad(now.getHours())}:${pad(now.getMinutes())} · ${branch}\n\n${text}\n`);
    }
    notify('Claude Code · dialogos', `${branch} 작업이 멈췄습니다`, text.replace(/\s+/g, ' ').slice(0, 120));
  }
} catch {
  // 훅은 세션을 막지 않는다.
}
