#!/usr/bin/env node
// SessionStart 훅. 작업 상태 몇 줄을 컨텍스트에 넣는다: 브랜치와 커밋하지 않은 변경, 인수인계 메모, 열린 PR,
// 최근 보고서와 결정 기록, 최근 실행. 세션 인계가 빨라진다. 값이 아니라 위치만 알린다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { currentBranch, git, projectDir, readInput, run } from './_shared.mjs';

/** 폴더 안에서 가장 최근에 바뀐 항목의 이름. */
function newest(dir, keep) {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter(keep)
    .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .at(-1)?.name;
}

const input = readInput();
const project = projectDir(input);
const lines = [];

const branch = currentBranch(project) ?? '?';
const hasCommit = git(['rev-parse', '--verify', '--quiet', 'HEAD'], project) !== null;
const dirty = (git(['status', '--short'], project) ?? '').split('\n').filter(Boolean).length;
lines.push(
  `[dialogos] 브랜치 ${branch}${hasCommit ? '' : '(커밋 없음)'}, 커밋하지 않은 변경 ${dirty}개. 규칙은 AGENTS.md와 CLAUDE.md, 비자명한 작업은 /pstack:poteto-mode로 시작.`,
);
if (existsSync(path.join(project, 'notes', 'handoff.md'))) lines.push('인수인계 메모 notes/handoff.md를 먼저 읽는다.');

const prs = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '10'], { cwd: project, timeout: 8_000 });
if (prs) {
  try {
    const list = JSON.parse(prs);
    lines.push(list.length ? `열린 PR: ${list.map((p) => `#${p.number} ${p.title} (${p.headRefName})`).join(' · ')}` : '열린 PR 없음.');
  } catch {
    // gh 출력이 JSON이 아니면 건너뛴다.
  }
}

const report = newest(path.join(project, 'notes', 'reports'), (f) => f.endsWith('.md'));
if (report) lines.push(`최근 보고서: notes/reports/${report}`);
const trail = newest(path.join(project, 'notes', 'audit'), (f) => f.endsWith('.tsv'));
if (trail) lines.push(`결정 기록: notes/audit/${trail} (column -s$'\\t' -t 로 본다)`);

const runsDir = path.join(project, 'runs');
const latest = newest(runsDir, (f) => f !== 'verify' && existsSync(path.join(runsDir, f, 'meta.json')));
if (latest) {
  try {
    const meta = JSON.parse(readFileSync(path.join(runsDir, latest, 'meta.json'), 'utf8'));
    lines.push(`최근 실행: runs/${latest} (${meta.provider === 'api' ? '실제 모델' : '모의 모델'})`);
  } catch {
    // meta.json을 읽지 못하면 건너뛴다.
  }
}

console.log(lines.join('\n'));
