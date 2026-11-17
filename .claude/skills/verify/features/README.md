# feature map

`verify.mjs <기능>`이 받는 id와 그 여정이 증명하는 것. 파일마다 단계 id, 사용자 행동, 보여야 하는 것을 적는다. 여정 코드는 `../scripts/journeys/<id>.mjs`다.

| id | 증명하는 것 | 입구 | 기능 파일 |
| --- | --- | --- | --- |
| `flow` | 다섯 명령이 사람이 쓰는 순서대로 이어지고, 이어 돌리기·표본의 눈가림·일치율 계산이 맞다 | `eval:run` → `eval:label` → `eval:score` → `eval:sample` → `eval:agreement` | [flow.md](flow.md) |
| `plan-gate` | 실제 모델 실행이 `--confirm` 없이는 계획만 출력하고 아무것도 만들지 않는다 | `eval:run`, `eval:label`의 `--provider api` | [plan-gate.md](plan-gate.md) |

## 다음 여정 후보

- 실패한 대화에서 멈춘 뒤 같은 명령으로 빠진 것만 이어 돌리기. 모의 모델에는 실패를 일으키는 장치가 없어 지금은 `eval/tests/cli.test.ts`가 맡는다.
- 3번 기준의 재실행을 합친 판정(`eval:score -- --run 첫실행,재실행`).
- 화면, 음성, 서버가 생기면 그 표면의 여정.
