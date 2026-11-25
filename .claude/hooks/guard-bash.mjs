#!/usr/bin/env node
// PreToolUse(Bash) 가드. 되돌리기 어렵거나 사람 몫인 명령은 막고(종료 코드 2, 이유와 대안은 stderr로 Claude에게 간다),
// 돈이 드는 실행은 사용자의 확인 창으로 넘긴다(permissionDecision "ask"). 입력(stdin JSON): { tool_input: { command }, cwd }.
// 위험한 명령의 패턴은 이 파일과 guard-bash.test.mjs에만 적는다(AGENTS.md 4번의 예외). 규칙과 장치의 대응은 CLAUDE.md의 표.
// 가드는 협조하는 에이전트의 실수를 막는다. 셸 문법을 일부러 비튼 명령까지 모두 막는 보안 경계는 아니어서, 가드 자체는 사람이 머지하고
// 그 밖의 변경은 독립 검증이 본다(CLAUDE.md '자율 범위'). 그래서 해석하기 어려운 모양은 하나하나 읽기보다 보이면 막는다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentBranch, git, readInput, run } from './_shared.mjs';

const input = readInput();
const command = String(input.tool_input?.command ?? '');
const cwd = input.cwd || process.cwd();

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`);
}

// 사람이 머지하는 경로: 에이전트가 할 수 있는 일을 정하고 지키는 파일(가드와 훅, 권한과 로컬 설정, CI와 npm 설정, 규칙 문서).
// 에이전트가 이 파일을 고쳐 스스로 머지하면 자기 제약을 풀 수 있다. 로컬 설정은 훅을 끌 수 있고, npm 설정은 게이트(npm run check)를 돌리는 셸을 바꿀 수 있다.
// 그 밖의 경로는 독립 검증이 사람 몫의 검토를 더해 본다(CLAUDE.md '자율 범위').
const SENSITIVE = ['.claude/hooks/**', '.claude/settings*.json', '.github/workflows/**', '.npmrc', 'CLAUDE.md', 'AGENTS.md'].map(globToRegExp);

const COMMIT_SUBJECT = /^(feat|fix|docs|refactor|test|chore|perf|build|ci|style|revert)(\([a-z0-9,./-]+\))?!?: \S/;

// 공개 글(커밋 메시지, 커밋할 변경, PR과 이슈의 글)에 들어가면 안 되는 것. 찾은 값은 안내에 옮겨 적지 않는다.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /noreply|@(?:[\w-]+\.)*example\.(?:com|org|net)$|\.(?:test|invalid|example)$/i;
const PHONE = /(?<!\d)01[016789][-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/;
const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}/,
];

// 명령 전체를 보고 막는 규칙. [정규식, 이유와 대안]
const WHOLE_COMMAND_RULES = [
  // 되돌릴 수 없는 삭제와 덮어쓰기
  [
    /\bgit\s+(reset\s+--hard\b|checkout\s+(\S+\s+)?(--\s+)?\.(\s|$)|restore\s+(--\s+)?\.(\s|$)|clean\s+-[a-zA-Z]*[fd])/,
    '작업 트리 전체 되돌리기 금지. 사용자의 커밋하지 않은 편집이 사라진다. 내가 바꾼 파일만 `git restore -- <파일>`로 되돌린다.',
  ],
  [/\bgit\s+stash\s+(drop|clear)\b/, 'stash 삭제 금지(사용자 작업일 수 있다). pop으로 되살린다.'],
  [/\bgit\s+branch\s+(-[a-zA-Z]*D\b|[^|;&\n]*--delete\s+--force)/, '브랜치 강제 삭제 금지. 머지된 브랜치만 -d로 지운다.'],
  [/\bgit\s+worktree\s+remove\b[^|;&\n]*\s(-f|--force)\b/, '변경이 남은 worktree를 강제로 지우지 않는다. 변경을 커밋하거나 사용자에게 묻는다.'],
  [/\bfind\b[^|;&\n]*\s-(delete|exec\s+rm)\b/, 'find로 지우지 않는다. 지울 파일을 확인하고 rm으로 하나씩 지운다.'],
  [/(^|[^>&0-9])>\s*["']?(\.\/)?(runs|notes)\//, 'runs/와 notes/의 파일을 >로 덮어쓰지 않는다. 커밋되지 않아 되돌릴 수 없다.'],
  // 이력 다시 쓰기
  [
    /\bgit\s+(rebase|filter-branch|filter-repo|replace|update-ref)\b|\bgit\s+commit\b[^|;&\n]*\s--amend\b|\bgit\s+pull\b[^|;&\n]*\s--rebase\b|\bgit\s+reflog\s+(expire|delete)\b|\bgit\s+(checkout\s+-B|switch\s+(-C|--force-create)|branch\s+(-f|--force))\s/,
    '이력 다시 쓰기 금지(AGENTS.md 4번). 고칠 것은 새 커밋으로 고치고, main이 앞서면 `git merge origin/main`으로 따라잡는다.',
  ],
  [
    /\bgit\s+reset\b[^|;&\n]*(\s--(soft|keep|merge)\b|\s(HEAD|@)[~^]|\sORIG_HEAD\b|\sorigin\/)/,
    '브랜치를 뒤로 옮기는 reset 금지(이력 다시 쓰기). 스테이지만 비울 때는 `git restore --staged <파일>`을 쓴다.',
  ],
  // 검증 없이 받은 코드 실행, 보안 설정
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|node|python3?)\b/, '받은 스크립트를 바로 실행하지 않는다(AGENTS.md 4번).'],
  [/(^|[\s;&|])sudo\s/, 'sudo 금지.'],
  [/\bnpx\s+(-y|--yes)\b/, '설치 확인 없이 패키지를 받아 실행하지 않는다. 저장소의 의존성은 npm 스크립트로 쓴다.'],
  [/\bnpm\s+(install-scripts\s+approve|config\s+set)\b/, 'npm 설정과 설치 스크립트 허용은 사용자가 정한다.'],
  [/\b(killall|pkill)\b/, '이름으로 프로세스를 끝내지 않는다. 내가 띄운 PID만 끝낸다.'],
  // 사람 몫의 설정과 외부 발행
  [/\b(npm|pnpm|yarn)\s+publish\b/, '패키지 발행 금지. 외부 발행은 사용자가 한다.'],
  [
    /\bgh\s+(repo\s+(edit|delete|rename|archive|unarchive|sync|transfer)|secret\b|variable\s+(set|delete)|workflow\s+(disable|delete|enable)|release\b|auth\b|ruleset\b|config\s+set|(issue|run|cache|label)\s+delete)/,
    'GitHub 설정·비밀·릴리스·인증 변경과 삭제 금지. 사용자 몫.',
  ],
  [/\bclaude\s+(plugin\s+(uninstall|disable|remove)|config)\b/, 'Claude Code 플러그인·설정 변경 금지.'],
  // ${이름+x}처럼 있는지만 보는 확장은 값을 내지 않으므로 둔다.
  [/\$\{?[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|DSN)\b(?!:?\+)/, '비밀값 환경 변수를 출력하거나 넘기지 않는다.'],
];

function toplevel() {
  return git(['rev-parse', '--show-toplevel'], cwd);
}


function ghJson(args) {
  const out = run('gh', args, { cwd, timeout: 30_000 });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function forbiddenWords() {
  // 목록은 커밋되지 않아 worktree에는 없다. worktree의 toplevel이 아니라 주 저장소(공통 .git의 부모)에서 찾는다.
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const file = path.join(commonDir ? path.dirname(commonDir) : cwd, 'notes', 'forbidden-words.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ word: line.trim(), line: i + 1 }))
    .filter(({ word }) => word && !word.startsWith('#'));
}

/** 공개 글의 문제. 찾은 단어나 값은 대화에 옮기지 않으려고 종류와 줄 번호만 알린다. */
function publicTextProblem(text) {
  const hit = forbiddenWords().find(({ word }) => text.includes(word));
  if (hit) return `공개 글에 금칙어가 있다(notes/forbidden-words.txt ${hit.line}번째 줄). 문장을 바꾼다.`;
  if ((text.match(EMAIL) ?? []).some((e) => !ALLOWED_EMAIL.test(e)))
    return '공개 글에 이메일 주소가 있다(AGENTS.md 2번). noreply 주소와 예시 도메인만 쓴다.';
  if (PHONE.test(text)) return '공개 글에 전화번호로 보이는 숫자가 있다(AGENTS.md 2번).';
  if (SECRETS.some((re) => re.test(text))) return '공개 글에 비밀값으로 보이는 문자열이 있다(AGENTS.md 1번). 값은 로컬의 .env에만 둔다.';
  return null;
}

function optionValue(seg, names) {
  for (const name of names) {
    const m = seg.match(new RegExp(`(?:^|\\s)${name.replace(/-/g, '\\-')}(?:=|\\s+)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\S+)`, 's'));
    if (m) return m[1].replace(/^(["'])(.*)\1$/s, '$2');
  }
  return null;
}

function segments(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg) {
  return (seg.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/s, '$2'));
}

// 비밀값이 든 파일: .env(.env.example 제외), 인증 정보 폴더와 파일, 저장소 설정 파일, 금칙어 목록(목록 자체가 비공개다).
const SECRET_FILE =
  /(^|[/=])\.env(\.[\w-]+)?$|(^|\/)\.(netrc|npmrc|git-credentials|pgpass)$|(^|\/)\.(ssh|aws|gnupg)(\/|$)|(^|\/)\.config\/gh(\/|$)|(^|\/)\.git\/config$|(^|\/)notes\/forbidden-words\.txt$/;
const PATH_ONLY = ['ls', 'test', '[', '[[', 'stat', 'file', 'basename', 'dirname', 'touch'];

function checkSecretFiles(words) {
  if (PATH_ONLY.includes(words[0])) return null;
  const hit = words.find((w) => SECRET_FILE.test(w) && !/\.env\.example$/.test(w) && !w.startsWith('--exclude'));
  if (hit)
    return `비밀 파일 읽기·수정·실행 금지(${hit}). .env는 npm 스크립트의 --env-file-if-exists 옵션으로만 읽힌다. 실제 모델 실행은 npm run eval:* 명령으로 한다.`;
  // grep -r은 .gitignore를 무시하고 .env까지 읽는다.
  if (words[0] === 'grep' && words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive')) {
    const excluded = words.some((w) => /^--exclude=["']?\.env/.test(w));
    const operands = words.slice(1).filter((w) => !w.startsWith('-'));
    const dirs = words.some((w) => w === '-e' || w.startsWith('--regexp')) ? operands : operands.slice(1);
    const exposed = (dirs.length ? dirs : ['.']).some((d) => {
      try {
        const abs = path.resolve(cwd, d);
        return statSync(abs).isDirectory() && existsSync(path.join(abs, '.env'));
      } catch {
        return false;
      }
    });
    if (exposed && !excluded) return "grep -r이 .env를 읽게 된다. rg를 쓰거나(.gitignore를 따른다) --exclude='.env*'를 붙인다.";
  }
  return null;
}

const ENV_DUMP_REASON = '환경 변수 출력 금지(비밀값이 섞인다). 특정 변수가 있는지만 볼 때는 `test -n "${이름+x}"`를 쓴다.';

function checkEnvDump(words) {
  const [first, second] = words;
  const dumps =
    first === 'printenv' ||
    (first === 'env' && words.slice(1).every((w) => w.startsWith('-'))) ||
    (['set', 'export', 'declare', 'typeset'].includes(first) && (words.length === 1 || ['-p', '-x', '-px'].includes(second)));
  return dumps ? ENV_DUMP_REASON : null;
}

// git 내부 정보(작성자 이름과 주소, 원격 주소, 저장소 설정)를 화면에 내지 않는다(AGENTS.md 3번).
const IDENT_PLACEHOLDER = /%[ac][nNeElL]/;

function showsIdentity(args, seg) {
  if (args.includes('--oneline')) return false;
  const format = args.find((a) => /^--(format|pretty)(=|$)/.test(a));
  if (!format) return true;
  const named = format.match(/^--(?:format|pretty)=(\w+)$/)?.[1];
  if (named) return !['oneline', 'reference'].includes(named);
  return IDENT_PLACEHOLDER.test(seg);
}

function checkGitRead(sub, args, seg) {
  switch (sub) {
    case 'config':
      return 'git 설정은 읽지도 바꾸지도 않는다(작성자 주소와 원격 주소가 들어 있다, AGENTS.md 3번). 사용자 몫.';
    case 'var':
    case 'shortlog':
    case 'cat-file':
      return `git ${sub}는 작성자 이름과 주소를 출력한다(AGENTS.md 3번). git log --oneline이나 --format=%H%n%s로 본다.`;
    case 'remote':
      return args.length === 0 ? null : '원격 주소는 출력하거나 바꾸지 않는다(AGENTS.md 3번). 원격 이름만 볼 때는 `git remote`.';
    case 'blame':
      return args.includes('-s') ? null : 'git blame은 -s를 붙여 작성자 이름을 빼고 본다(AGENTS.md 3번).';
    case 'log':
    case 'show':
    case 'whatchanged': {
      const operands = args.filter((a) => !a.startsWith('-'));
      if (sub === 'show' && operands.length > 0 && operands.every((a) => a.includes(':'))) return null; // <rev>:<경로>는 파일 내용만 낸다.
      return showsIdentity(args, seg)
        ? `git ${sub}의 기본 출력에는 작성자 주소가 들어 있다(AGENTS.md 3번). --oneline이나 작성자 자리표시가 없는 --format(예: --format=%H%n%s)으로 본다.`
        : null;
    }
    default:
      return null;
  }
}

// 지우지 않는 곳: 통째로 지우지 않는 폴더, 커밋되지 않아 지우면 되돌릴 수 없는 곳(실행 결과와 개인 메모).
const KEEP_DIRS = /^(\.git|\.github|\.claude|\.agents|eval|notes|runs)\/?$/;
const UNTRACKED_DATA = /^(notes|runs)(\/|$)/;

function checkRm(words) {
  const recursive = words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
  const home = process.env.HOME ?? '';
  const top = toplevel() ?? cwd;
  const inside = (abs, root) => abs === root || abs.startsWith(`${root}/`);
  for (const raw of words.slice(1).filter((w) => !w.startsWith('-'))) {
    const target = raw.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
    const abs = path.resolve(cwd, target);
    const rel = path.relative(top, abs);
    const inRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inRepo && UNTRACKED_DATA.test(rel)) return `${raw}: runs/와 notes/는 커밋되지 않아 지우면 되돌릴 수 없다. 정리는 사용자가 한다.`;
    if (!recursive) continue;
    if (['/', '/*', '.', './', '..', '../', '*', home, `${home}/`].includes(target) || abs === top) return `rm -r 대상이 위험하다(${raw}).`;
    if (inRepo && KEEP_DIRS.test(rel)) return `${raw} 폴더를 통째로 지우지 않는다.`;
    if (!inRepo && !inside(abs, '/private/tmp') && !inside(abs, '/tmp') && !inside(abs, path.resolve(tmpdir())))
      return `프로젝트와 임시 폴더 밖은 지우지 않는다(${raw}).`;
  }
  return null;
}

function checkPrText(words, seg, dir) {
  const title = optionValue(command, ['--title', '-t']);
  if (words[2] === 'create' && title !== null && !/^\S.* - \S/.test(title))
    return `PR 제목 형식 위반: "${title}". 형식은 <대단위> - <소규모>(한국어). 어휘는 .github/pull_request_template.md 머리말.`;
  return ghTextProblem(words, seg, dir);
}

// 글을 올리는 gh 명령. 이 명령은 앞에 다른 명령을 묶지 않고(sequenceProblem), 글 파일까지 읽어 검사한다.
const GH_POSTS = { pr: new Set(['create', 'edit', 'comment', 'review', 'close', 'merge']), issue: new Set(['create', 'edit', 'comment', 'close', 'reopen']) };
const postsText = (gh) => GH_POSTS[gh[1]]?.has(gh[2]) ?? false;

// gh pr·gh issue가 글을 파일에서 읽는 자리: --body-file, -F, 붙여 쓴 -F파일, 묶은 짧은 옵션의 F(-wF 파일). 같은 옵션을 두 번 주면 모두 읽는다.
function ghBodyFiles(words) {
  const files = [];
  for (let i = 3; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--body-file' || w === '-F') files.push(words[(i += 1)] ?? '-');
    else if (w.startsWith('--body-file=')) files.push(w.slice('--body-file='.length));
    else if (/^-[A-Za-z]*F/.test(w)) {
      const rest = w.slice(w.indexOf('F') + 1).replace(/^=/, '');
      files.push(rest || (words[(i += 1)] ?? '-'));
    }
  }
  return files;
}

// 글을 파일로 넘기면 명령 글자에는 본문이 없다. 그 파일까지 읽어 함께 검사한다. 상대 경로는 앞의 cd까지 따른 폴더(dir)에서 찾는다.
// 읽지 못하는 파일과 표준 입력(`-`, /dev/의 파일)은 검사할 수 없으므로 막는다.
function readTextFiles(files, dir) {
  let text = '';
  for (const file of files) {
    if (file === '-' || file.startsWith('/dev/')) return { problem: '글을 표준 입력으로 넘기지 않는다. 가드가 읽을 수 있는 파일로 넘긴다.' };
    try {
      text += `\n${readFileSync(path.resolve(dir, file), 'utf8')}`;
    } catch {
      return { problem: `글 파일을 읽지 못했다: ${file}` };
    }
  }
  return { text };
}

/** gh pr·gh issue의 글. 본문은 heredoc으로 여러 줄일 수 있어 조각이 아니라 명령 전체를 보고, 이 gh 조각이 넘긴 글 파일을 모두 읽어 함께 본다. */
function ghTextProblem(words, seg, dir) {
  // 명령 치환($(cat 파일), 백틱)으로 넣은 글은 실행 전에 볼 수 없다. heredoc($(cat <<'EOF' …))은 글이 명령에 있어 받는다.
  if (/`|\$\((?!\s*cat\s*<<)/.test(seg)) return '글을 명령 치환으로 넣지 않는다. --body-file 파일이나 heredoc으로 넘긴다.';
  const files = readTextFiles(ghBodyFiles(words), dir);
  return files.problem ?? publicTextProblem(command + files.text);
}

const GH_API_VALUE_FLAGS = new Set(['-H', '--header', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

function ghApiEndpoint(words) {
  for (let i = 2; i < words.length; i += 1) {
    if (GH_API_VALUE_FLAGS.has(words[i])) i += 1;
    else if (!words[i].startsWith('-')) return words[i];
  }
  return '';
}

// gh api는 읽기(GET)만 한다. 글은 gh pr·gh issue 명령으로 올리고(가드가 그 글을 검사한다), 그 밖의 쓰기와 설정은 사용자 몫이다.
// 메서드와 본문 옵션은 붙여 쓰기(-XPOST, -Fk=@파일)와 묶음(-iF)까지 있어 하나하나 읽지 않고, 보이면 막는다.
const GH_API_WRITE = /^(-[A-Za-z]*[XFf]|--(method|field|raw-field|input)(=|$))/;

function checkGhApi(words) {
  const endpoint = ghApiEndpoint(words);
  if (/^\/?users?(\/|$)/i.test(endpoint)) return '계정 정보를 출력하지 않는다(AGENTS.md 2번).';
  if (words.slice(2).some((w) => GH_API_WRITE.test(w)))
    return 'gh api는 읽기(GET)만 한다. 메서드와 본문 옵션(-X, -F, -f, --input)을 쓰지 않는다. PR·이슈의 글은 gh pr comment·gh issue comment --body-file로 올리고, 그 밖의 쓰기와 설정은 사용자 몫이다.';
  return null;
}

// gh pr merge에서 값을 하나 더 받는 옵션. 그 값은 PR을 가리키는 자리 인자가 아니다.
const MERGE_VALUE_FLAGS = new Set(['--match-head-commit', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '-R', '--repo']);

// 머지할 PR은 글자 그대로의 번호나 PR 주소로만 받는다. 브랜치 이름이나 변수($N), 생략(지금 브랜치)은
// 가드가 보는 PR과 gh가 머지하는 PR이 달라질 수 있어서 받지 않는다.
function prNumber(words) {
  for (let i = 3; i < words.length; i += 1) {
    const w = words[i];
    if (MERGE_VALUE_FLAGS.has(w)) i += 1;
    else if (w.startsWith('-')) continue;
    else return Number(w.match(/^\d+$/)?.[0] ?? w.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/)?.[1] ?? NaN) || null;
  }
  return null;
}

function checkPassed(c) {
  if (c.conclusion) return /^(SUCCESS|NEUTRAL|SKIPPED)$/.test(c.conclusion);
  if (c.state) return c.state === 'SUCCESS';
  return false;
}

function checkMerge(words) {
  if (words.includes('--admin')) return '--admin 머지 금지(보호 규칙 우회).';
  if (['--squash', '--rebase', '-s', '-r'].some((f) => words.includes(f))) return '이 저장소는 merge commit만 쓴다: gh pr merge <번호> --merge';
  if (!words.includes('--merge') && !words.includes('-m')) return '머지 방식을 밝힌다: gh pr merge <번호> --merge';
  // 독립 검증의 판정은 한 head에 대한 것이다. 검증 뒤에 커밋이 더해지면 GitHub이 머지를 거절하게 head를 못박는다.
  if (!words.some((w) => w === '--match-head-commit' || w.startsWith('--match-head-commit=')))
    return '검증한 head로 머지한다: gh pr merge <번호> --merge --match-head-commit <검증한 head SHA>';
  if (words.some((w) => w === '-R' || w === '--repo' || w.startsWith('--repo='))) return '다른 저장소의 PR은 머지하지 않는다(--repo).';
  const number = prNumber(words);
  if (!number) return 'PR 번호를 글자 그대로 적는다: gh pr merge <번호> --merge --match-head-commit <검증한 head SHA>. 브랜치 이름, 변수, 생략은 받지 않는다.';
  const info = ghJson(['pr', 'view', String(number), '--json', 'files,isDraft,state,statusCheckRollup']);
  if (!info) return `PR #${number} 정보를 읽지 못했다.`;
  if (info.isDraft) return `PR #${number}는 draft다. gh pr ready 뒤에 머지한다.`;
  const hits = (info.files ?? []).map((f) => f.path).filter((p) => SENSITIVE.some((re) => re.test(p)));
  if (hits.length)
    return `PR #${number}는 사람이 머지하는 경로를 건드린다:\n${hits.map((h) => `  ${h}`).join('\n')}\nmerge-ready로 보고하고 멈춘다.`;
  if ((info.statusCheckRollup ?? []).length === 0) return `PR #${number}에 체크가 하나도 없다. CI가 돈 뒤 머지한다.`;
  const notGreen = (info.statusCheckRollup ?? []).filter((c) => !checkPassed(c));
  if (notGreen.length)
    return `PR #${number}의 체크가 녹색이 아니다: ${notGreen.map((c) => `${c.name ?? c.context}=${c.conclusion || c.state || c.status}`).join(', ')}. 녹색이 된 뒤 머지한다.`;
  return null;
}

function commitMessage(cmd) {
  // -m "$(cat <<'EOF' … EOF\n)"는 따옴표 짝으로 읽지 않는다. 명령 치환 안의 큰따옴표는 바깥 따옴표를 닫지 않아서
  // 짝으로 읽으면 본문의 첫 큰따옴표에서 메시지가 잘린다. 셸처럼 구분자만 있는 줄 앞까지 읽는다.
  const m = cmd.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"\$\(cat\s*<<\s*(\S+)[^\n]*\n|("(?:[^"\\]|\\.)*"|'[^']*'|\S+))/s);
  if (!m) return null;
  const [head, heredocWord, value] = m;
  if (heredocWord) {
    const lines = cmd.slice(m.index + head.length).split('\n');
    const end = lines.indexOf(heredocWord.replace(/['"\\]/g, ''));
    return lines.slice(0, end === -1 ? lines.length : end).join('\n');
  }
  const text = value.replace(/^(["'])(.*)\1$/s, '$2');
  return text.startsWith('$(') ? null : text;
}

/** 작성자와 커미터 주소가 noreply인가. 주소는 읽기만 하고 어디에도 내지 않는다. */
function identityProblem(seg) {
  const author = optionValue(seg, ['--author']);
  if (author !== null && !/noreply/i.test(author)) return '--author 주소가 noreply 주소가 아니다(AGENTS.md 3번).';
  for (const [name, label] of [
    ['GIT_AUTHOR_IDENT', '작성자'],
    ['GIT_COMMITTER_IDENT', '커미터'],
  ]) {
    const ident = git(['var', name], cwd);
    if (ident === null) continue;
    if (!/noreply/i.test(ident.match(/<([^>]*)>/)?.[1] ?? ''))
      return `커밋 ${label} 주소가 noreply 주소가 아니다(AGENTS.md 3번). 사용자가 이 저장소의 작성자 주소를 noreply 주소로 바꾼 뒤 다시 커밋한다. 주소는 출력하지 않는다.`;
  }
  return null;
}

/** 이번 커밋에 들어갈 변경의 더한 줄만 파일별로 검사한다. -a면 추적 중인 파일의 변경 전체가 들어간다. */
/** diff에서 더한 줄만 파일별로 모아 금칙어, 이메일, 비밀값을 찾는다. label은 안내에 쓰는 이름이다. */
function addedLinesProblem(diff, label) {
  const added = new Map();
  let file = '?';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('+')) added.set(file, `${added.get(file) ?? ''}${line.slice(1)}\n`);
  }
  const list = forbiddenWords();
  for (const [name, text] of added) {
    const hit = list.find(({ word }) => text.includes(word));
    if (hit) return `${label}(${name})에 금칙어가 있다(notes/forbidden-words.txt ${hit.line}번째 줄).`;
    if ((text.match(EMAIL) ?? []).some((e) => !ALLOWED_EMAIL.test(e)))
      return `${label}(${name})에 이메일 주소가 있다(AGENTS.md 2번). noreply 주소와 예시 도메인만 쓴다.`;
    if (SECRETS.some((re) => re.test(text))) return `${label}(${name})에 비밀값으로 보이는 문자열이 있다(AGENTS.md 1번).`;
  }
  return null;
}

function stagedProblem(words) {
  const all = words.some((w) => w === '--all' || /^-[a-zA-Z]*a/.test(w));
  const diff = git(all ? ['diff', 'HEAD', '-U0', '--no-color'] : ['diff', '--cached', '-U0', '--no-color'], cwd);
  return diff ? addedLinesProblem(diff, '커밋할 변경') : null;
}

// 커밋 전 게이트: npm run check(형식 검사와 검사, 4초 안팎). CI도 같은 명령을 돌린다.
// 이 저장소인지는 가드 파일이 있는지로 본다. package.json은 에이전트가 머지하는 경로라 그 name으로 보면 에이전트가 게이트를 끌 수 있다.
// 가드 검사의 임시 저장소에는 가드 파일이 없어 게이트가 돌지 않는다.
function runCommitGate(top) {
  if (!existsSync(path.join(top, '.claude', 'hooks', 'guard-bash.mjs'))) return null;
  try {
    execFileSync('npm', ['run', 'check'], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    return `커밋 전 게이트 실패: npm run check\n${tail}\n고친 뒤 다시 커밋한다.`;
  }
  return null;
}

/** 커밋 명령 자체에 붙인 작성자·커미터 주소(앞의 환경 변수, git -c)도 noreply여야 한다. 주소는 내지 않는다. */
function overrideIdentityProblem(words, assigns) {
  const values = ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL'].filter((name) => Object.hasOwn(assigns, name)).map((name) => assigns[name]);
  words.forEach((w, i) => {
    if (words[i - 1] === '-c' && /^(user|author|committer)\.email=/i.test(w)) values.push(w.slice(w.indexOf('=') + 1));
  });
  return values.some((v) => !/noreply/i.test(v)) ? '커밋 명령에 붙인 작성자 주소가 noreply 주소가 아니다(AGENTS.md 3번). 주소는 출력하지 않는다.' : null;
}

/** -F(--file)로 넘긴 메시지 파일. 읽지 못하면 검사할 수 없으므로 막는다. */
function messageFromFile(seg) {
  const file = optionValue(seg, ['-F', '--file']);
  if (file === null) return null;
  if (file === '-') return { problem: '커밋 메시지를 표준 입력(-F -)으로 넘기지 않는다. -m이나 메시지 파일을 쓴다.' };
  try {
    return { text: readFileSync(path.resolve(cwd, file), 'utf8') };
  } catch {
    return { problem: `커밋 메시지 파일을 읽지 못했다: ${file}. 파일을 먼저 만들고, 커밋은 따로 실행한다.` };
  }
}

function checkCommit(seg, words, assigns = {}) {
  if (words.includes('--no-verify') || words.includes('-n')) return '--no-verify 금지.';
  // 메시지는 heredoc으로 여러 줄일 수 있어 조각이 아니라 명령 전체에서 찾는다. -F면 그 파일을 읽는다.
  const fromFile = messageFromFile(seg);
  if (fromFile?.problem) return fromFile.problem;
  const message = commitMessage(command) ?? fromFile?.text ?? null;
  if (message) {
    const subject = message.split('\n')[0].trim();
    if (!COMMIT_SUBJECT.test(subject) && !/^(Merge|Revert) /.test(subject))
      return `커밋 제목 형식 위반: "${subject}". 형식은 type(scope): 제목. scope는 모듈, 제목은 한국어. 예) feat(eval): 판정을 읽지 못한 턴 다시 부르기`;
    const bad = publicTextProblem(message);
    if (bad) return bad;
  }
  const override = overrideIdentityProblem(words, assigns);
  if (override) return override;
  const top = toplevel();
  if (!top) return null;
  const hasCommit = git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd) !== null;
  if (hasCommit && currentBranch(cwd) === 'main') return 'main에 직접 커밋 금지. `git switch -c <type>/<짧은-설명>` 뒤에 커밋한다.';
  return identityProblem(seg) ?? stagedProblem(words) ?? runCommitGate(top);
}

function checkPush(words) {
  const args = words.slice(words.indexOf('push') + 1);
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => /^--force(-with-lease|-if-includes)?(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f)))
    return '강제 push 금지. push한 이력은 다시 쓰지 않는다. main이 앞서면 `git merge origin/main`으로 따라잡고 고칠 것은 새 커밋으로 고친다.';
  if (flags.some((f) => f === '--delete' || f === '--prune' || f === '--mirror' || /^-[a-zA-Z]*d/.test(f)) || positional.some((p) => /^:\S+/.test(p)))
    return '원격 브랜치 삭제 금지. 머지된 브랜치는 GitHub이 지운다. 그 밖의 삭제는 사용자에게 맡긴다.';
  if (positional.some((p) => p.startsWith('+'))) return '`+refspec` 강제 push 금지.';
  const refs = positional.slice(1);
  const targetsMain =
    flags.includes('--all') || refs.some((r) => /(^|:)(refs\/heads\/)?main$/.test(r)) || (positional.length === 1 && positional[0] === 'main');
  if (targetsMain) return 'main에 직접 push 금지. 브랜치에 push하고 PR을 연다. 저장소의 첫 push는 사용자가 한다.';
  if ((refs.length === 0 || refs.every((r) => r === 'HEAD')) && currentBranch(cwd) === 'main')
    return '지금 main에 있다. `git switch -c <type>/<짧은-설명>` 뒤에 push한다. 저장소의 첫 push는 사용자가 한다.';
  const outgoing = git(['log', '--format=%B', 'origin/main..HEAD'], cwd);
  const messageProblem = outgoing ? publicTextProblem(outgoing) : null;
  if (messageProblem) return messageProblem;
  // 커밋할 때의 검사를 비켜 간 변경(다른 도구로 만든 커밋 등)이 공개 브랜치로 나가지 않게, 보낼 커밋의 더한 줄도 본다.
  const patch = git(['log', '-p', '-U0', '--no-color', '--format=', 'origin/main..HEAD'], cwd);
  return patch ? addedLinesProblem(patch, '보낼 커밋의 변경') : null;
}

// gh의 전역 옵션(-R/--repo, --hostname 등)을 뒤로 옮겨 하위 명령이 words[1], words[2]에 오게 한다. 옮긴 옵션은 남겨 머지의 --repo 막기가 본다.
function ghWords(words) {
  let at = 1;
  while (at < words.length && words[at].startsWith('-')) at += ['-R', '--repo', '--hostname'].includes(words[at]) ? 2 : 1;
  return ['gh', ...words.slice(at), ...words.slice(1, at)];
}

function checkSegment(seg, words, assigns, dir = cwd) {
  const [first, second, third] = words;
  if (first === 'git') {
    const at = words.findIndex((w, i) => i > 0 && !w.startsWith('-') && words[i - 1] !== '-C' && words[i - 1] !== '-c');
    const sub = at === -1 ? undefined : words[at];
    const args = at === -1 ? [] : words.slice(at + 1);
    if (sub === 'push') return checkPush(words);
    if (sub === 'commit') return checkCommit(seg, words, assigns);
    if (sub === 'tag') return publicTextProblem(command);
    return checkGitRead(sub, args, seg);
  }
  if (first === 'gh') {
    const gh = ghWords(words);
    const [, sub, action] = gh;
    if (sub === 'pr' && action === 'merge') return checkMerge(gh) ?? ghTextProblem(gh, seg, dir);
    if (sub === 'api') return checkGhApi(gh);
    if (sub === 'pr' && postsText(gh)) return checkPrText(gh, seg, dir);
    if (sub === 'issue') return ghTextProblem(gh, seg, dir);
    return null;
  }
  if (first === 'rm' || first === 'unlink') return checkRm(words);
  return null;
}

// 명령 앞에 붙어 뒤의 명령을 그대로 실행하는 것들. 걷어 낸 뒤 실제 명령의 첫 단어로 검사한다.
// withValue는 값을 하나 더 받는 옵션, positional은 옵션 뒤에 오는 자리 인자의 수(timeout의 시간)다.
const WRAPPERS = new Map([
  ['env', { withValue: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] }],
  ['command', { withValue: [] }],
  ['builtin', { withValue: [] }],
  ['exec', { withValue: ['-a'] }],
  ['nohup', { withValue: [] }],
  ['time', { withValue: [] }],
  ['nice', { withValue: ['-n', '--adjustment'] }],
  ['timeout', { withValue: ['-s', '--signal', '-k', '--kill-after'], positional: 1 }],
  ['stdbuf', { withValue: ['-i', '-o', '-e'] }],
  ['caffeinate', { withValue: ['-t', '-w'] }],
  ['xargs', { withValue: ['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-a'] }],
  // 셸 예약어 뒤에 오는 명령(`for … do 명령`, `if 명령; then 명령`, `else 명령`)도 같은 규칙으로 본다.
  ['do', { withValue: [] }],
  ['then', { withValue: [] }],
  ['else', { withValue: [] }],
  ['elif', { withValue: [] }],
  ['if', { withValue: [] }],
  ['while', { withValue: [] }],
  ['until', { withValue: [] }],
  ['function', { withValue: [], positional: 1 }],
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// 한 겹짜리 명령 치환. 안쪽에 괄호가 있는 것(커밋 메시지의 heredoc 등)은 줄마다 조각으로 이미 검사된다.
const SUBSTITUTION = /\$\(([^()]*)\)/g;
// 백틱 명령 치환. 따옴표 안의 백틱(인용한 코드)까지 명령으로 보므로 막힐 수 있다. 그때는 글을 파일로 넘긴다.
const BACKTICK = /`([^`]*)`/g;

/**
 * 앞에 붙은 환경 변수 지정, 감싸는 실행기, 묶음 기호를 걷어 내고 실제로 실행되는 명령의 단어를 낸다.
 * 경로를 붙여 부른 명령(/usr/bin/git)은 이름만 남기고, 묶음을 닫는 기호와 짝이 안 맞는 따옴표는 마지막 단어에서 뗀다.
 * 실행하지 않는 형태(command -v)는 null. env 뒤에 명령이 없으면 환경 변수를 모두 출력하므로 dumpsEnv가 켜진다.
 */
function unwrap(words) {
  let rest = words;
  const assigns = Object.create(null);
  let wrapper = null;
  for (let round = 0; round < 32 && rest.length > 0; round += 1) {
    const head = rest[0].replace(/^[({!\\]+/, '');
    if (head !== rest[0]) {
      rest = head ? [head, ...rest.slice(1)] : rest.slice(1);
      continue;
    }
    // 함수 정의 `f() { 명령; }`의 이름은 걷어 내고 본문의 명령을 본다.
    if (/^[\w.-]+\(\)$/.test(head)) {
      rest = rest.slice(1);
      continue;
    }
    if (ASSIGNMENT.test(head)) {
      const at = head.indexOf('=');
      assigns[head.slice(0, at)] = head.slice(at + 1);
      rest = rest.slice(1);
      continue;
    }
    const name = path.basename(head);
    const spec = WRAPPERS.get(name);
    if (!spec) {
      rest = [name, ...rest.slice(1)];
      wrapper = null;
      break;
    }
    let i = 1;
    while (i < rest.length && rest[i].startsWith('-') && rest[i] !== '--') {
      if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(rest[i])) return null;
      if (spec.withValue.includes(rest[i])) i += 1;
      i += 1;
    }
    if (rest[i] === '--') i += 1;
    rest = rest.slice(i + (spec.positional ?? 0));
    wrapper = name;
  }
  if (rest.length > 0) {
    const last = rest[rest.length - 1].replace(/["')}]+$/, '');
    rest = last ? [...rest.slice(0, -1), last] : rest.slice(0, -1);
  }
  return { words: rest, assigns, dumpsEnv: rest.length === 0 && wrapper === 'env' };
}

/** sh -c와 eval이 실행하는 명령도 같은 규칙으로 본다. */
function checkShell(words, depth) {
  const [first] = words;
  if (first === 'eval') return check(words.slice(1).join(' '), depth + 1);
  if (!SHELLS.has(first)) return null;
  const at = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  if (at === -1) return null;
  return check(words.slice(at + 1).join(' ').replace(/^["']|["']$/g, ''), depth + 1);
}

/** git 조각의 하위 명령(add, commit, push …). git이 아니면 null. */
function gitSubcommand(words) {
  if (words[0] !== 'git') return null;
  const at = words.findIndex((w, i) => i > 0 && !w.startsWith('-') && words[i - 1] !== '-C' && words[i - 1] !== '-c');
  return at === -1 ? null : words[at];
}

const STAGING = new Set(['add', 'stage', 'rm', 'mv', 'apply']);
const MAKES_COMMITS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'pull', 'am']);

/**
 * 가드는 명령을 실행하기 전에 한 번만 본다. 그래서 한 명령 안에서 앞 조각이 스테이지에 올린 변경이나 새로 만든 커밋은
 * 뒤 조각(commit, push)을 검사할 때 아직 없다. 2026-11-19에 이 틈으로 금칙어가 든 커밋이 공개 브랜치에 나갔다.
 */
function sequenceProblem(cmd) {
  const subs = [];
  const firsts = [];
  for (const seg of segments(cmd)) {
    const run = unwrap(tokens(seg));
    const words = run?.words ?? [];
    // 가드는 실행 전에 한 번만 보므로 앞 명령이 바꾼 글 파일을 볼 수 없다. 폴더만 바꾸는 cd는 글 파일을 그 폴더에서 찾아 따른다.
    if (words[0] === 'gh' && postsText(ghWords(words)) && firsts.some((f) => f !== 'cd'))
      return 'PR·이슈 글을 올리는 gh 명령 앞에 다른 명령을 묶지 않는다(cd만 된다). 가드는 실행 전에 한 번만 보므로 앞 명령이 바꾼 글 파일을 볼 수 없다.';
    if (words[0]) firsts.push(words[0]);
    const sub = run ? gitSubcommand(words) : null;
    if (sub) subs.push(sub);
  }
  for (const [i, sub] of subs.entries()) {
    const before = subs.slice(0, i);
    if (sub === 'commit' && before.some((b) => STAGING.has(b)))
      return 'git add(스테이지에 올리기)와 git commit을 한 명령에 묶지 않는다. 가드가 커밋할 변경을 미리 볼 수 있게 add를 먼저 따로 실행한다.';
    if (sub === 'push' && before.some((b) => MAKES_COMMITS.has(b)))
      return '커밋을 만드는 명령과 git push를 한 명령에 묶지 않는다. 가드가 보낼 커밋을 미리 볼 수 있게 push는 따로 실행한다.';
  }
  return null;
}

function check(cmd, depth = 0) {
  if (depth > 4) return null;
  for (const [re, reason] of WHOLE_COMMAND_RULES) if (re.test(cmd)) return reason;
  const sequence = sequenceProblem(cmd);
  if (sequence) return sequence;
  for (const match of [...cmd.matchAll(SUBSTITUTION), ...cmd.matchAll(BACKTICK)]) {
    const reason = check(match[1], depth + 1);
    if (reason) return reason;
  }
  // 앞의 cd를 따라간 폴더. 글 파일의 상대 경로를 이 폴더에서 찾는다.
  let dir = cwd;
  for (const seg of segments(cmd)) {
    const raw = tokens(seg);
    if (raw.length === 0) continue;
    const run = unwrap(raw);
    if (!run) continue;
    const { words, assigns, dumpsEnv } = run;
    if (words[0] === 'cd') dir = path.resolve(dir, (words[1] ?? process.env.HOME ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    const assigned = Object.entries(assigns).map(([name, value]) => `${name}=${value}`);
    const reason =
      (dumpsEnv ? ENV_DUMP_REASON : null) ??
      checkSecretFiles(raw) ??
      checkSecretFiles([...words, ...assigned]) ??
      (words.length > 0 ? (checkEnvDump(words) ?? checkShell(words, depth) ?? checkSegment(seg, words, assigns, dir)) : null);
    if (reason) return reason;
  }
  return null;
}

// 실제 모델 호출은 돈이 든다. 계획만 출력하는 실행(--confirm 없음)은 그대로 두고, --confirm이 붙은 실제 호출만 사용자에게 묻는다.
function needsConfirmation(cmd) {
  return segments(cmd).some((seg) => /--provider(=|\s+)["']?api\b/.test(seg) && tokens(seg).includes('--confirm'));
}

function main() {
  if (!command.trim()) return;
  const reason = check(command);
  if (reason) {
    process.stderr.write(`[guard] ${reason}\n`);
    process.exit(2);
  }
  if (needsConfirmation(command)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason:
            '[guard] 실제 모델을 부르는 실행이라 비용이 듭니다. 바로 앞에 보여 준 계획의 호출 횟수를 확인했을 때만 허용하세요.',
        },
      }),
    );
  }
}

main();
