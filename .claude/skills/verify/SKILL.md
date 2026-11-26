---
name: verify
description: "dialogos 판정 실험의 명령(eval:run → eval:label → eval:score → eval:sample → eval:agreement)과 화면(app/의 글 한 판, 음성 한 판, 같은 주제로 두 판 하며 기억 고치고 지우기)을 모의 모델로 사람이 쓰는 순서대로 돌려 증거를 runs/verify/에 남기는 검증 스킬. 화면은 사용자의 개발 서버와 겹치지 않는 빈 포트에 앱을 띄우고 창 없는 Chrome으로 누른다. 음성은 브라우저의 인식기와 합성기만 가짜로 바꾸고 실제 마이크와 소리는 쓰지 않는다. 실제 모델은 부르지 않는다(.env를 읽지 않고, 연결 정보와 APP_*를 지운 환경, --confirm 없음). 변경이 실제 명령 흐름이나 화면에서 동작하는지 증명하거나, 버그를 재현하거나, 대화·판정·라벨을 사람이 읽는 대화록으로 보여 줄 때 쓴다. /verify"
---

# verify

dialogos의 실행 표면은 판정 실험(`eval/`)의 명령 다섯 개와 화면(`app/`)이다. 이 스킬은 명령을 사람이 쓰는 순서대로 띄우고, 화면은 앱을 띄워 Chrome으로 누른다. 그리고 각 단계의 출력, 화면, 결과 파일을 확인해 `runs/verify/<시각>-<기능>/`에 남긴다. 처음 보는 에이전트가 이 문서만 읽고 따라 할 수 있게 썼다. 순서는 항상 같다: 준비 → 실행 → 증거 확인.

규칙 하나가 모든 단계에 걸린다. **실제 모델은 부르지 않는다.**

- 명령은 npm 스크립트와 같은 진입점(`node --import tsx eval/src/<명령>.ts`)으로 띄우되 `.env`를 읽지 않는다.
- 환경에서 `LLM_*`, `OPPONENT_*`, `JUDGE_*`, `SCORER_*`를 지운다. `eval/tests/cli.test.ts`와 같은 방식이다.
- 어떤 여정도 `--confirm`을 넘기지 않는다. 입구 스크립트는 모델과 `--confirm`을 옵션으로 받지 않는다.
- 앱은 `npm run app:dev`와 같은 진입점(`node --import tsx app/dev.ts`)으로 띄우되, 위 환경에서 `APP_*`도 모두 지운다. 그래서 모델은 앱의 기본값인 모의 모델이고 로컬 모델(Ollama)도 부르지 않는다. 여정이 정하는 것은 포트(`APP_PORT`, `APP_WEB_PORT`)와 판 파일(`APP_DB_PATH`)뿐이다.

실제 모델로 형식을 확인하는 시범 실행은 이 스킬의 일이 아니다. 사용자가 계획을 보고 확인한 뒤 `npm run eval:run -- --provider api ... --confirm`으로 한다. 가드 훅이 이 명령에 확인 창을 띄운다.

## 표면

| 명령 | 하는 일 | 쓰는 파일(`runs/<이름>/`) |
| --- | --- | --- |
| `eval:run` | 질문 × 조건 × 반복의 대화를 대본대로 돌린다. 끝난 대화부터 덧붙이고, 다시 실행하면 빠진 것만 돈다. `--provider api`는 `--confirm` 없이는 계획만 출력한다 | `transcripts.jsonl`, `meta.json` |
| `eval:label` | 답마다 채점기 라벨을 붙인다 | `labels.jsonl`, `meta.json`의 `scorer` |
| `eval:score` | 양보율, 수용률, 통과 기준 판정, 결과표. 결과표 끝에 통과 기준에 쓰지 않는 점검 절(판정기, 엔진의 답, 사용량, 걸린 시간) | `results.md`, `results.json`(`checks` 포함) |
| `eval:sample` | 사람이 라벨을 붙일 표본. 조건, 턴 종류, 채점기 라벨은 숨긴다 | `sample.csv`, `sample.key.json` |
| `eval:agreement` | 사람 라벨과 채점기 라벨의 일치율 | 출력만 |
| `app:dev` | 서버(Hono)와 화면(Vite)을 함께 띄운다. 포트는 `APP_PORT`, `APP_WEB_PORT`, 판 파일은 `APP_DB_PATH`로 바꾼다 | 판 파일(SQLite) |

모의 모델(`eval/src/providers/mock.ts`)은 글의 길이로 압박(120자 미만)과 반론(120자 이상)을 가르고, 정해 둔 확률로 물러선다. 같은 입력이면 같은 답을 낸다. 그래서 숫자는 흐름 확인용이고 실험 결과가 아니다. 공개 문서에 옮기지 않는다.

## 준비

- Node.js 22.13 이상, 저장소 루트에서 `npm ci` 한 번. `.env`는 필요 없다.
- 화면 여정은 Google Chrome을 쓴다. macOS의 기본 위치(`/Applications/Google Chrome.app`)에 없으면 `CHROME_PATH`에 실행 파일 경로를 적는다. 사용자의 Chrome과 그 설정은 건드리지 않는다(OS 임시 폴더의 새 사용자 폴더로 창 없이 띄우고, 닫을 때 지운다).
- 사용자가 `npm run app:dev`를 띄워 두어도 된다. 화면 여정은 이 컴퓨터가 고른 빈 포트 둘에 앱을 따로 띄우고, 사용자의 포트(8787, 5173)와 판 파일(`data/app.sqlite`)은 쓰지 않는다.
- 결과는 `runs/verify/` 아래에 쌓인다. 실험용 실행(`runs/<이름>/`)과 섞이지 않고, 커밋하지 않는다. 지우는 것은 사용자가 한다.

## 실행

```
node .claude/skills/verify/scripts/verify.mjs <기능> [--questions q01,q02] [--reps 2] [--turns 30]
```

`<기능>`은 [feature map](features/README.md)의 id 하나다: `flow` | `memory` | `plan-gate` | `screen` | `voice-screen`. 옵션은 이 셋뿐이고 `flow`만 쓴다. 기본값은 모든 질문, 조건 셋, 2번, 30턴이다(본 실행과 같은 모양).

성공 출력 예:

```
verify flow: 판정 실험 전체 흐름(모의 모델)
증거: runs/verify/20261118-083638-flow/
  PASS run: 대화 24회 × 30턴, meta.provider=mock (cmd-01-run.txt)
  PASS resume: 24회 모두 건너뜀, 기록 줄 수 그대로 (cmd-02-run.txt)
  ...
VERIFY PASS flow — runs/verify/20261118-083638-flow/steps.md
```

단계가 하나라도 실패하면 거기서 멈추고 마지막 줄이 `VERIFY FAIL <기능>`, 종료 코드는 1이다. 실패한 단계의 관찰 칸에 이유가, `cmd-NN-*.txt`에 그 명령의 출력 전체가 있다.

- `flow`: 대화 → 같은 명령으로 이어 돌리기 → 채점 → 결과표 → 표본(숨긴 칸 확인) → 사람 칸을 채운 일치율(두 칸을 일부러 뒤집어 그 두 개만 다르게 나오는지) → 사람이 읽는 대화록. [features/flow.md](features/flow.md)
- `plan-gate`: `--provider api`의 대화와 채점이 `--confirm` 없이는 계획만 출력하고, 실행 폴더·라벨·채점기 기록을 만들지 않는지. [features/plan-gate.md](features/plan-gate.md)
- `screen`: 앱을 빈 포트에 띄워 글로 한 판을 한다. 주제 목록 → 주제와 생각 고르기 → 글로 두 턴 → 새로 고친 뒤 이어 하기 → 끝내기 → 사후 입장과 훈계 문항 → 목록의 기록 → 판 파일의 턴과 끝 기록. 이 Mac에서 단계 합계 약 6초. [features/screen.md](features/screen.md)
- `voice-screen`: 페이지보다 먼저 도는 스크립트로 브라우저의 음성 인식과 음성 합성을 가짜로 바꾸고 한 판을 한다. 음성 켜기 → 말하기 → 다시 말하기(바꿈) → 손댄 뒤 말하기(붙임) → 보내기(판 파일의 input, redone과 상대의 답 읽기) → 듣는 중에 끄기(붙임) → 보내기 → VS Code 꼴 User-Agent의 안내. 이 Mac에서 단계 합계 약 9초. [features/voice-screen.md](features/voice-screen.md)
- `memory`: 같은 주제로 두 판을 한다. 첫 판(세 턴) → 기록 남기기(판 파일에 기억) → 목록의 내 기억 → 시작 화면의 지난 기록 → 둘째 판 첫 턴의 답 아래 넘긴 기록 3개(판 파일의 턴 `memory_ids`) → 그 자리에서 고치기 → 지우기 → 다음 턴에 넘긴 기록(지운 기억 없음, 고친 글) → 새로 고쳐 이어 열기 → 두 번째 탭에서 지운 기억을 첫 탭에서 고치거나 지우기("다른 곳에서 이미 지운 기록입니다.") → 목록의 내 기억 → 판 파일의 기억 표와 턴. 넘긴 기록의 접힘은 목록이 화면에 보이는지로 본다. 이 Mac에서 단계 합계 약 12.5초. [features/memory.md](features/memory.md)

화면 여정은 실패하거나 Ctrl+C(두 번 눌러도), Ctrl+\, 종료 신호, 터미널 닫기, 잡히지 않은 오류로 멈춰도 띄운 앱과 Chrome을 닫고 임시 사용자 폴더를 지운 뒤에 끝난다. 출력을 받는 쪽이 먼저 끝나도(`| head`) 여정은 끝까지 돌고 결과는 `steps.md`에 남는다. 닫는 데 앱과 Chrome마다 많아야 5초 걸린다. 결과를 적기 전에 신호로 멈추면 결과는 FAIL, 종료 코드는 130이고, 적은 뒤에 온 신호는 결과를 바꾸지 않는다. 잡히지 않은 오류는 결과를 적은 뒤에 와도 `steps.md`를 FAIL로 고쳐 적고 종료 코드 1로 끝난다.

맵에 없는 것을 확인하려면 여정을 하나 더 쓴다. `scripts/journeys/<id>.mjs`가 `export const title`과 `export async function run(h)`를 내보내면 입구 스크립트가 그 id를 바로 받는다. `h`는 `scripts/lib.mjs`의 하네스다.

- `h.cli(명령, 인자)`: eval 명령을 안전한 환경으로 띄우고 출력을 `cmd-NN-<명령>.txt`에 남긴다. `h.ok(결과)`는 종료 코드 0을 확인한다.
- `h.step(id, 설명, async () => '관찰')`: 사용자 행동 하나가 단계 하나다.
- `h.jsonl`, `h.json`, `h.read`, `h.exists`, `h.save`: 증거 폴더(= 이 검증의 실행 폴더)의 파일을 읽고 쓴다.
- `h.runId`, `h.dir`, `h.runsDir`, `h.options`. 프로젝트 코드는 `evalModule('util')`처럼 불러 쓴다.
- `h.app()`: 앱을 빈 포트 둘에 모의 모델로 띄우고, 화면을 거친 `/api/topics`가 답할 때까지 기다린다. `{ url, api, web, dbPath, db, log }`를 돌려준다. 판 파일은 증거 폴더의 `app-NN.sqlite`, 출력은 닫을 때 `cmd-NN-app.txt`에 남는다.
- `h.browser()`: 창 없는 Chrome을 띄워 페이지 하나를 돌려준다(`scripts/browser.mjs`). `goto`, `reload`, `press(단추 글)`, `click(요소 식, 설명)`(같은 글의 단추가 여럿일 때 자리를 좁혀 누른다), `choose(라디오 name, 몇째)`, `type(selector, 글)`(끝에 이어 친다), `text`, `texts`, `value`, `hasButton`, `waitFor(식, 설명)`, `shot(이름)`, `beforeLoad(스크립트)`, `send(CDP 메서드)`, `errors`(페이지의 예외와 console.error). 누르기는 요소가 나타나기를 5초까지 기다린 뒤 그 자리를 마우스로 누르고, 쓰기는 글자 입력으로 보낸다.
- 여정이 띄운 앱과 Chrome은 입구 스크립트가 여정 뒤에 닫는다(`h.close()`). 여정이 따로 닫을 필요는 없다.

여정을 추가하면 `features/`에 기능 파일을 같이 추가한다.

## 증거

`runs/verify/<시각>-<기능>/`에 남는다. 이 폴더가 곧 그 검증의 eval 실행 폴더다. 화면 여정이면 앱의 판 파일과 화면 사진도 여기에 있다. 시각은 초 단위라, 같은 작업 트리에서 같은 기능을 같은 초에 또 띄우면 뒤에 `-2`, `-3`이 붙은 새 폴더를 쓴다. 동시에 돌린 실행끼리 폴더와 판 파일을 같이 쓰지 않는다.

- `steps.md`: 먼저 읽는 파일이다. 단계 번호, id, 설명, 결과, 관찰, 시간, 그리고 코드 상태(커밋, 커밋하지 않은 변경 수)와 옵션. 끝에 PASS 또는 FAIL.
- `cmd-NN-<명령>.txt`: 실행한 명령, 종료 코드, 걸린 시간, 출력 전체.
- eval이 쓴 파일: `transcripts.jsonl`, `labels.jsonl`, `meta.json`, `results.md`, `results.json`, `sample.csv`(사람 칸을 채운 것), `sample.key.json`.
- `dialogue-<질문>-<조건>-<반복>.md`: 사람이 읽는 대화록. 턴마다 종류, 사용자의 말, 판정기의 결정(엔진만), 상대의 답, 채점기 라벨.
- 화면 여정: `shot-NN-<단계>.png`(화면 사진), `app-NN.sqlite`(판 파일), `cmd-NN-app.txt`(앱을 띄운 명령과 출력). Chrome 사용자 폴더는 증거가 아니라 OS 임시 폴더에 두고 닫을 때 지운다.
- `result.json`: 단계 목록과 결과, 파일 목록.

증거의 기준:

- **사람이 쓰는 경로로 한다.** 명령과 앱은 npm 스크립트와 같은 진입점으로 띄우고, 사람 칸은 표본 파일을 채워서 넣는다. 화면은 단추를 글로 찾아 누르고 입력 칸에 글자를 친다. 내부 함수를 직접 불러 결과를 만들지 않는다.
- **행동과 결과를 함께 남긴다.** 단계마다 관찰과 명령 출력, 그리고 결과 파일.
- **부수 효과를 확인한다.** 줄 수, `meta.json`의 기록, 판 파일의 행, 만들어지지 않아야 할 폴더와 파일까지 본다.
- **모의는 경계에서만.** 모의 모델은 `--provider mock`과 앱의 기본값(`APP_MODEL` 없음)이라는 정식 선택지이고, 그 밖에 바꾼 것은 `.env`를 읽지 않는 것 하나다. `voice-screen`만 브라우저의 음성 API 네 이름을 가짜로 바꾼다. 앱의 코드는 그 API를 잇는 `browser-voice.ts`부터 화면까지 그대로 돈다.
- 보고에는 기능 id, 증거 폴더, 단계별 결과를 적는다. 모의 모델의 숫자는 결과로 적지 않는다.

## 아직 못 하는 것

- 실제 모델의 형식(판정기와 채점기가 JSON을 제대로 내는지, 온도 값을 받는지, 걸리는 시간과 토큰)은 증명하지 않는다. 시범 실행에서 본다.
- 실제 모델 연결 코드는 `eval/tests/api.test.ts`, `api-flow.test.ts`가 이 컴퓨터 안의 가짜 서버로 검사한다. 이 스킬은 그 경로를 타지 않는다.
- 화면 여정은 이 Mac의 창 없는 Chrome 한 가지로만 본다. Safari, Firefox, 좁은 화면은 사람이 본다.
- 실제 인식기(정확도, 쉼에서 끊기는 때), 실제 목소리(고르기, 속도, 기기 밖 목소리), 실제 마이크와 권한 창, 인식 팩 내려받기는 증명하지 않는다. 여전히 사람이 Chrome에서 직접 본다. `voice-screen`은 그 위의 화면 규칙만 본다.
- 앱 안 브라우저는 User-Agent만 바꾼 Chrome으로 흉내 낸다. 실제 VS Code 안에서 페이지가 닫히는지는 보지 않는다.
- SIGKILL처럼 잡을 수 없는 신호로 입구 스크립트가 끝나면 여정의 앱과 Chrome, 임시 사용자 폴더(`dialogos-verify-chrome-*`)가 남는다. 앱은 `--import tsx app/dev.ts`, Chrome은 `--user-data-dir`에 그 폴더가 있는 프로세스다.
- 기억이 상대의 지시문에 실제로 들어가는지는 화면에서 보이지 않는다. `memory`는 판 파일의 턴 `memory_ids`와 기억 표로 무엇을 넘겼는지 보고, 지시문의 기억 칸은 `app/tests/memory.test.ts`가 호출을 기록하는 가짜 모델로 검사한다. 기억이 꺼진 눈가림 비교(`APP_MODE=random`)는 여정이 띄우지 않는다.

## 유지보수

명령의 출력 문구, 옵션, 결과 파일 이름이 바뀌면 여정과 기능 파일을 함께 고치고, 한 사이클을 다시 돌려 PASS를 본다. 화면의 단추 글, 안내 문구, 클래스 이름이 바뀌어도 같다. 모델 연결 코드가 읽는 환경 변수 이름이 바뀌면 `scripts/lib.mjs`의 `safeEnv`도 바꾼다. 앱이 읽는 환경 변수는 `APP_`로 시작해야 `appEnv`가 지운다. 주기적인 점검은 `/pstack:maintain-verification-skill`로 한다.
