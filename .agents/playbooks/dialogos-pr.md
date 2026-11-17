---
extends: opening-a-pr, shipping
when: Use it whenever a PR is opened, updated, or landed in this repository.
---

# dialogos PR 규칙

이 저장소의 브랜치, 커밋, PR, 머지 규칙은 CLAUDE.md가 정한다. 이 파일은 그 규칙을 pstack 플레이북의 해당 단계에 끼워 넣는다. 앵커 검사는 `node ~/.claude/plugins/cache/pstack-claude/pstack/<버전>/skills/poteto-mode/scripts/check-playbooks.mjs`로 한다.

- **Replace** "Work from a git worktree off main.": 메인 세션은 같은 폴더에서 브랜치만 바꿔 일한다. 커밋하지 않은 변경은 이름을 붙여 stash한다. worktree는 코드를 쓰는 서브에이전트에게만 준다.
- **Replace** "Rebase into small, ordered commits before opening PRs.": 커밋은 처음부터 변경 이유 단위로 나눠 만든다. 만든 커밋은 다시 쓰지 않는다(AGENTS.md 4번, 가드 훅이 막는다).
- **Replace** "Amend when the fix belongs in a just-made commit.": 방금 만든 커밋을 고칠 때도 새 커밋을 더한다.
- **Replace** "Conventional Commits `type(scope): subject`, no trailing period": PR 제목은 `<대단위> - <소규모>`(한국어, 소규모가 여럿이면 ·로 잇는다). 어휘와 예시는 `.github/pull_request_template.md` 머리말에 있다. 커밋 제목은 그대로 Conventional Commits `type(scope): 제목`(scope는 모듈, 제목은 한국어).
- **Replace** "Use `##` headings, not bold lead-ins, in this order, and drop a section with nothing to say": PR 본문은 `.github/pull_request_template.md`의 항목을 그대로 쓴다. `## Why`는 1 배경, `## What changed`는 2 변경 내용, `## Scope`는 '범위 밖', `## Tradeoffs`는 1 배경의 대안 문장, `## Blast Radius`는 5 리뷰어가 볼 것, `## Verification`은 4 검증에 넣는다. 체크박스는 비워 둔다(사용자가 확인한다). 본문은 파일로 써서 `--body-file`로 넘기고, 수치는 실측만 쓴다. 모의 실행의 숫자는 쓰지 않는다.
- **Replace** "Each child branch rebases onto its parent's exact tip and its PR targets the parent branch.": 자식 브랜치는 부모 브랜치를 merge로 따라가고, PR은 부모 브랜치를 겨냥한다.
- **Replace** "Rebase on trunk before substantial stack work.": 큰 작업 전에는 `git merge origin/main`으로 main을 따라잡는다.
- **After** "Landing needs the user's landing authority": CLAUDE.md '자율 범위'가 그 권한이다. 사람이 머지하는 경로(실험 설계와 측정 도구, 돈이 드는 연결, 의존성과 명령, 비밀값 경계, 공개 문서, 규칙과 에이전트 장치)를 건드리지 않은 PR은 CI 녹색과 독립 검증 PASS가 있으면 에이전트가 착륙시킨다. 그 경로를 건드린 PR은 merge-ready로 보고하고 멈춘다(가드 훅이 머지를 막는다).
- **Replace** "gh pr merge <pr> --repo <owner/repo> --squash --match-head-commit <verified-head>": 이 저장소는 merge commit만 쓴다. `gh pr merge <pr> --merge --match-head-commit <verified-head>`를 쓴다.
- **Replace** "replay only its own commits onto the merge result from the recorded old parent boundary": push한 이력은 다시 쓰지 않는다(가드 훅이 막는다). 자식 브랜치에 `git merge origin/main`을 하고 보통으로 push한다. patch-id 규칙 대신 새 head에서 검증을 다시 받는다.
