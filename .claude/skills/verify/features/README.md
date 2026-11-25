# feature map

`verify.mjs <기능>`이 받는 id와 그 여정이 증명하는 것. 파일마다 단계 id, 사용자 행동, 보여야 하는 것을 적는다. 여정 코드는 `../scripts/journeys/<id>.mjs`다.

| id | 증명하는 것 | 입구 | 기능 파일 |
| --- | --- | --- | --- |
| `flow` | 다섯 명령이 사람이 쓰는 순서대로 이어지고, 이어 돌리기·표본의 눈가림·일치율 계산이 맞다 | `eval:run` → `eval:label` → `eval:score` → `eval:sample` → `eval:agreement` | [flow.md](flow.md) |
| `plan-gate` | 실제 모델 실행이 `--confirm` 없이는 계획만 출력하고 아무것도 만들지 않는다 | `eval:run`, `eval:label`의 `--provider api` | [plan-gate.md](plan-gate.md) |
| `screen` | 글로 한 판이 화면에서 사람이 하는 차례대로 이어지고, 새로 고쳐도 판이 그대로이며, 끝 기록이 목록과 판 파일에 남는다 | `app:dev`(빈 포트, 모의 모델) → 창 없는 Chrome | [screen.md](screen.md) |
| `voice-screen` | 말한 글이 입력 칸에 들어가는 규칙(넣기, 다시 말하면 바꾸기, 손댄 글에는 붙이기, 듣는 중에 끄면 붙이기), 보낸 턴의 input과 redone, 상대의 말 읽기, 앱 안 브라우저의 안내 | `screen`과 같고, 브라우저의 음성 인식과 음성 합성만 가짜 | [voice-screen.md](voice-screen.md) |
| `memory` | 첫 판의 끝 기록이 남긴 기억이 같은 주제의 둘째 판 턴마다 넘어가 답 아래 보이고, 화면에서 고치고 지우면 다음 턴부터 지운 기억은 넘어가지 않고 고친 글이 넘어가며, 판 파일의 기억 표와 턴의 넘긴 기억 id가 화면과 같다 | `screen`과 같다(기본 방식은 엔진이라 기억 켬) | [memory.md](memory.md) |

## 다음 여정 후보

- 실패한 대화에서 멈춘 뒤 같은 명령으로 빠진 것만 이어 돌리기. 모의 모델에는 실패를 일으키는 장치가 없어 지금은 `eval/tests/cli.test.ts`가 맡는다.
- 3번 기준의 재실행을 합친 판정(`eval:score -- --run 첫실행,재실행`).
- 지난 판 [다시 보기]와 기록 전에 나간 판의 [기록 남기기].
- 30턴을 다 써서 끝나는 판. 지금은 `app/tests/server.test.ts`가 맡는다.
