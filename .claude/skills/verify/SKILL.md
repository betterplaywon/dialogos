---
name: verify
description: "dialogos 판정 실험의 명령(eval:run → eval:label → eval:score → eval:sample → eval:agreement)을 모의 모델로 사람이 쓰는 순서대로 돌려 증거를 runs/verify/에 남기는 검증 스킬. 실제 모델은 부르지 않는다(.env를 읽지 않고, 연결 정보를 지운 환경, --confirm 없음). 변경이 실제 명령 흐름에서 동작하는지 증명하거나, 버그를 재현하거나, 대화·판정·라벨을 사람이 읽는 대화록으로 보여 줄 때 쓴다. /verify"
---

# verify

dialogos의 실행 표면은 지금 판정 실험(`eval/`)의 명령 다섯 개다. 이 스킬은 그 명령을 사람이 쓰는 순서대로 띄운다. 그리고 각 단계의 출력과 결과 파일을 확인해 `runs/verify/<시각>-<기능>/`에 남긴다. 처음 보는 에이전트가 이 문서만 읽고 따라 할 수 있게 썼다. 순서는 항상 같다: 준비 → 실행 → 증거 확인.

규칙 하나가 모든 단계에 걸린다. **실제 모델은 부르지 않는다.**

- 명령은 npm 스크립트와 같은 진입점(`node --import tsx eval/src/<명령>.ts`)으로 띄우되 `.env`를 읽지 않는다.
- 환경에서 `LLM_*`, `OPPONENT_*`, `JUDGE_*`, `SCORER_*`를 지운다. `eval/tests/cli.test.ts`와 같은 방식이다.
- 어떤 여정도 `--confirm`을 넘기지 않는다. 입구 스크립트는 모델과 `--confirm`을 옵션으로 받지 않는다.

실제 모델로 형식을 확인하는 시범 실행은 이 스킬의 일이 아니다. 사용자가 계획을 보고 확인한 뒤 `npm run eval:run -- --provider api ... --confirm`으로 한다. 가드 훅이 이 명령에 확인 창을 띄운다.

## 표면

| 명령 | 하는 일 | 쓰는 파일(`runs/<이름>/`) |
| --- | --- | --- |
| `eval:run` | 질문 × 조건 × 반복의 대화를 대본대로 돌린다. 끝난 대화부터 덧붙이고, 다시 실행하면 빠진 것만 돈다. `--provider api`는 `--confirm` 없이는 계획만 출력한다 | `transcripts.jsonl`, `meta.json` |
| `eval:label` | 답마다 채점기 라벨을 붙인다 | `labels.jsonl`, `meta.json`의 `scorer` |
| `eval:score` | 양보율, 수용률, 통과 기준 판정, 결과표. 결과표 끝에 통과 기준에 쓰지 않는 점검 절(판정기, 엔진의 답, 사용량, 걸린 시간) | `results.md`, `results.json`(`checks` 포함) |
| `eval:sample` | 사람이 라벨을 붙일 표본. 조건, 턴 종류, 채점기 라벨은 숨긴다 | `sample.csv`, `sample.key.json` |
| `eval:agreement` | 사람 라벨과 채점기 라벨의 일치율 | 출력만 |

모의 모델(`eval/src/providers/mock.ts`)은 글의 길이로 압박(120자 미만)과 반론(120자 이상)을 가르고, 정해 둔 확률로 물러선다. 같은 입력이면 같은 답을 낸다. 그래서 숫자는 흐름 확인용이고 실험 결과가 아니다. 공개 문서에 옮기지 않는다.

## 준비

- Node.js 22.13 이상, 저장소 루트에서 `npm ci` 한 번. `.env`는 필요 없다.
- 결과는 `runs/verify/` 아래에 쌓인다. 실험용 실행(`runs/<이름>/`)과 섞이지 않고, 커밋하지 않는다. 지우는 것은 사용자가 한다.

## 실행

```
node .claude/skills/verify/scripts/verify.mjs <기능> [--questions q01,q02] [--reps 2] [--turns 30]
```

`<기능>`은 [feature map](features/README.md)의 id 하나다: `flow` | `plan-gate`. 옵션은 이 셋뿐이고 `flow`만 쓴다. 기본값은 모든 질문, 조건 셋, 2번, 30턴이다(본 실행과 같은 모양).

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

맵에 없는 것을 확인하려면 여정을 하나 더 쓴다. `scripts/journeys/<id>.mjs`가 `export const title`과 `export async function run(h)`를 내보내면 입구 스크립트가 그 id를 바로 받는다. `h`는 `scripts/lib.mjs`의 하네스다.

- `h.cli(명령, 인자)`: eval 명령을 안전한 환경으로 띄우고 출력을 `cmd-NN-<명령>.txt`에 남긴다. `h.ok(결과)`는 종료 코드 0을 확인한다.
- `h.step(id, 설명, async () => '관찰')`: 사용자 행동 하나가 단계 하나다.
- `h.jsonl`, `h.json`, `h.read`, `h.exists`, `h.save`: 증거 폴더(= 이 검증의 실행 폴더)의 파일을 읽고 쓴다.
- `h.runId`, `h.dir`, `h.runsDir`, `h.options`. 프로젝트 코드는 `evalModule('util')`처럼 불러 쓴다.

여정을 추가하면 `features/`에 기능 파일을 같이 추가한다.

## 증거

`runs/verify/<시각>-<기능>/`에 남는다. 이 폴더가 곧 그 검증의 eval 실행 폴더다.

- `steps.md`: 먼저 읽는 파일이다. 단계 번호, id, 설명, 결과, 관찰, 시간, 그리고 코드 상태(커밋, 커밋하지 않은 변경 수)와 옵션. 끝에 PASS 또는 FAIL.
- `cmd-NN-<명령>.txt`: 실행한 명령, 종료 코드, 걸린 시간, 출력 전체.
- eval이 쓴 파일: `transcripts.jsonl`, `labels.jsonl`, `meta.json`, `results.md`, `results.json`, `sample.csv`(사람 칸을 채운 것), `sample.key.json`.
- `dialogue-<질문>-<조건>-<반복>.md`: 사람이 읽는 대화록. 턴마다 종류, 사용자의 말, 판정기의 결정(엔진만), 상대의 답, 채점기 라벨.
- `result.json`: 단계 목록과 결과, 파일 목록.

증거의 기준:

- **사람이 쓰는 경로로 한다.** 명령은 npm 스크립트와 같은 진입점으로 띄우고, 사람 칸은 표본 파일을 채워서 넣는다. 내부 함수를 직접 불러 결과를 만들지 않는다.
- **행동과 결과를 함께 남긴다.** 단계마다 관찰과 명령 출력, 그리고 결과 파일.
- **부수 효과를 확인한다.** 줄 수, `meta.json`의 기록, 만들어지지 않아야 할 폴더와 파일까지 본다.
- **모의는 경계에서만.** 모의 모델은 `--provider mock`이라는 정식 선택지이고, 그 밖에 바꾼 것은 `.env`를 읽지 않는 것 하나다.
- 보고에는 기능 id, 증거 폴더, 단계별 결과를 적는다. 모의 모델의 숫자는 결과로 적지 않는다.

## 아직 못 하는 것

- 실제 모델의 형식(판정기와 채점기가 JSON을 제대로 내는지, 온도 값을 받는지, 걸리는 시간과 토큰)은 증명하지 않는다. 시범 실행에서 본다.
- 실제 모델 연결 코드는 `eval/tests/api.test.ts`, `api-flow.test.ts`가 이 컴퓨터 안의 가짜 서버로 검사한다. 이 스킬은 그 경로를 타지 않는다.
- 화면, 음성, 서버, 기억은 아직 없다. 생기면 여정을 더한다.

## 유지보수

명령의 출력 문구, 옵션, 결과 파일 이름이 바뀌면 여정과 기능 파일을 함께 고치고, 한 사이클을 다시 돌려 PASS를 본다. 모델 연결 코드가 읽는 환경 변수 이름이 바뀌면 `scripts/lib.mjs`의 `safeEnv`도 바꾼다. 주기적인 점검은 `/pstack:maintain-verification-skill`로 한다.
