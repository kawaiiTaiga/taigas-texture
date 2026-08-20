# GRAIN — LLM 제작 가이드

이 문서는 사람이 DSL을 손으로 익히기 위한 튜토리얼이 아니다. 생성 모델이 GRAIN 재질을 **생성 → 검증 → 렌더 → 비평 → 한 번 수정**하는 반복 루프를 안정적으로 수행하기 위한 운용 계약이다.

## 1. 반드시 지킬 루프

```text
list_material_examples
→ get_material_example(가장 가까운 구조)
→ 목표에 맞게 작은 수정
→ validate_material
→ error는 전부 수정, warning은 의식적으로 수용하거나 수정
→ render_material_multiscale(같은 지점 1× + 4× + 16× + 64×)
→ macro interior와 crack boundary 두 중심에서 스케일 계층 확인
→ render_material(shaded + albedo + height + normal + rough + metal)
→ 한 가지 가장 큰 시각적 결함을 선택
→ 한 번에 한 구조 또는 한 파라미터 계열만 수정
→ 다시 validate_material
```

`list_material_examples`는 HTML에 내장된 기준 예제뿐 아니라 `materials/*.grain`에 저장된 검증 재질도 자동 발견한다. 완성한 재질을 이 폴더에 저장하면 다음 에이전트가 별도 등록 작업 없이 `origin: "library"` 항목으로 재사용할 수 있다.

최종 후보의 최소 조건:

- `valid = true`
- `analysis.deterministic = true`
- 타일 재질이면 `analysis.seam = 0`
- 비용이 64/px 이하
- height/rough/metal에 `NON_FINITE_CHANNEL` 또는 `CHANNEL_OUT_OF_RANGE`가 없음
- shaded만 그럴듯한 것이 아니라 albedo, height, normal, rough, metal이 같은 재질 구조를 일관되게 설명함
- 1×를 확대 복사한 것이 아니라 4×·16×·64×마다 더 작은 물리 구조가 새로 나타남

## 2. 생성 전략

처음부터 긴 spec을 발명하지 않는다. 목표와 가장 가까운 예제 하나를 고르고, 다음 순서로 바꾼다.

1. **큰 스케일:** 패널 굴곡, 덩어리, 큰 맥, 큰 얼룩
2. **중간 스케일:** 세포 경계, 직조, 나이테, 결정, 박리
3. **미세 스케일:** 모공, 잔섬유, 피팅, 미세 입자
4. **PBR 결선:** 같은 구조가 height, albedo, rough, metal에서 물리적으로 일관되게 보이도록 연결
5. **var 노출:** 색조와 사용자가 바꿀 의미 있는 축만 `var`로 공개

스케일마다 규칙을 조금 다르게 한다. 같은 noise를 모든 채널에 그대로 복사하면 절차적 CG처럼 보인다. albedo의 저주파 얼룩, height의 날카로운 경계, rough의 마모 반응처럼 역할을 분리한다.

### 2.1. `rho`와 유한 스케일 계층

`rho`는 현재 렌더에서 한 픽셀이 덮는 UV 폭이며 `1 / (resolution × zoom)`이다. 줌할수록 작아진다. 너무 작은 구조를 멀리서 aliasing시키지 말고, 해당 구조가 실제로 보일 때만 활성화한다.

```text
field near4  = 1 - smoothstep(0.0012, 0.0030, rho)
field near16 = 1 - smoothstep(0.0003, 0.0009, rho)
field micro  = near4  * 작은_균열
field grain  = near16 * 더_작은_응집토
```

GRAIN은 비용이 무한한 진짜 프랙탈을 허용하지 않는다. 대신 목표 관찰 범위를 먼저 정하고 보통 4–6개의 유한 band를 둔다. 각 band의 진폭은 작아져야 하며, 같은 패턴의 단순 축소 복사보다 재질에 맞는 다음 물리 계층을 사용한다.

```text
1×  큰 수축 균열
4×  흙판 내부의 2차 균열과 들뜬 껍질
16× 응집토와 작은 부스러기
64× 광물 알갱이, 먼지 균열, 미세 공극
```

## 3. 오류 코드별 복구

| 코드 | 바로 할 일 |
|---|---|
| `MISSING_OUTPUT` | `out height`, `out albedo = hsv(...)` 추가 |
| `STATIC_LITERAL_REQUIRED` | oct/lac/seed/tile/enum에서 var·field 제거, literal 사용 |
| `FORWARD_REFERENCE` | 참조 대상을 현재 줄 앞으로 이동 |
| `UNKNOWN_FUNCTION` / `UNKNOWN_IDENTIFIER` | 철자와 선언 순서 확인, 임의 함수 생성 금지 |
| `MACRO_CONTRACT` | 재귀 제거, 앞선 macro만 호출, 바깥 field 참조를 파라미터로 전달 |
| `TILE_PERIOD_INVALID` | `tile·freq`를 정수로, lac을 정수로; 비타일이면 `tile = 0` |
| `COST_BUDGET_EXCEEDED` | oct와 worley/spots 호출 축소, 중복 계산을 local/field로 공유 |
| `TILE_SEAM_DETECTED` | primitive 입력 좌표와 warp 자체를 주기적으로 구성 |
| `HEIGHT_NEARLY_FLAT` | height에 중간/미세 스케일 진폭 추가 |
| `ALBEDO_NEARLY_FLAT` | height 복사 대신 독립적인 저주파 색 변화 추가 |
| `CHANNEL_OUT_OF_RANGE` | 해당 output을 `clamp(..., 0, 1)`로 제한 |
| `UNKNOWN_VARIABLE_OVERRIDE` | `summary.variables`에 나온 이름만 `values`로 전달 |

진단의 `suggestion`은 일반 규칙보다 현재 실패에 더 가깝다. 먼저 그대로 적용하고 다시 검증한다.

## 4. 렌더 비평 규칙

한 번의 렌더에서 다음을 순서대로 본다.

1. **정체성:** 설명 없이 봐도 목표 재질 계열로 읽히는가?
2. **스케일 계층:** 큰·중간·미세 구조가 모두 있으며 서로 다른 역할을 하는가?
3. **반복 흔적:** 규칙적인 격자, 방향성 없는 백색 잡음, 같은 패턴의 채널 복사가 보이는가?
4. **경계:** 타일 미리보기에서 이음새가 없는가?
5. **PBR 일관성:** 홈은 normal/height에서 들어가고, 마모는 rough/albedo에 설득력 있게 반응하는가?
6. **과장:** relief를 낮춰도 구조가 유지되고, 높여도 깨지지 않는가?
7. **줌 연속성:** 1×/4×/16×/64×에서 같은 재질로 읽히면서 새로운 구조가 나타나는가?

다중 스케일 검수는 최소 두 중심에서 한다. 하나는 큰 구조 내부, 다른 하나는 큰 경계 위다. 경계 한 곳만 계속 확대하면 같은 절벽만 커져 스케일 계층을 잘못 평가하게 된다. 미세 균열은 목표 줌에서 최소 2–3픽셀 폭이어야 점선 aliasing으로 보이지 않는다.

비평 뒤에는 가장 큰 결함 하나만 고른다. 예: “중간 스케일 균열이 없어 플라스틱처럼 보임.” 다음 편집은 그 결함만 겨냥한다.

## 5. LLM용 작업 프롬프트

아래 계약을 GRAIN 재질 작성 에이전트의 지침으로 사용할 수 있다.

```text
You author deterministic GRAIN material specs.
Start from the closest bundled example and preserve valid syntax.
Never invent primitives or use forward references, recursion, feedback, or dynamic structural arguments.
Call validate_material after every edit. Repair errors using diagnostic.code and suggestion.
Do not render an invalid spec.
For tiled materials require seam=0 at the intended var values.
After validation, call render_material_multiscale at 1x, 4x, 16x, and 64x for both a macro-interior point and a macro-boundary point.
Use rho-gated finite scale bands so newly resolved physical structure appears at each zoom without aliasing in distant views.
Then render shaded, albedo, height, normal, rough, and metal at the relevant zoom.
Critique material identity, scale hierarchy, zoom continuity, repetition, seams, and PBR coherence.
Change only one structural idea or one related parameter family per iteration.
Finish only when valid=true, deterministic=true, cost<=64, required range diagnostics are clear, and the rendered maps agree.
Return the final complete spec plus a short account of accepted warnings.
```

## 6. CLI 사용

```powershell
node grain-cli.mjs examples --json
node grain-cli.mjs validate --example leather --json
node grain-cli.mjs validate material.grain --json
node grain-cli.mjs render material.grain --out renders/material --resolution 256 --values '{"wear":0.7}' --json
node grain-cli.mjs render-scales material.grain --out renders/material-scales --resolution 256 --zooms 1,4,16,64 --center 0.5,0.5 --json
```

표준 입력도 받을 수 있다.

```powershell
Get-Content material.grain -Raw | node grain-cli.mjs validate - --json
```

종료 코드는 성공 `0`, 잘못된 재질 `1`, 도구 사용 오류 `2`다. 자동 루프에서는 사람용 문장보다 `--json` 결과의 `diagnostics[].code`를 기준으로 분기한다.

## 7. MCP 서버

의존성 없는 stdio MCP 서버는 다음 명령으로 실행한다.

```powershell
node grain-mcp-server.mjs
```

노출 도구:

- `list_material_examples`
- `get_material_example`
- `validate_material`
- `render_material`
- `render_material_multiscale`

`render_material`은 로컬 파일 경로를 돌려주는 대신 MCP image content로 PNG를 직접 반환한다. 따라서 비전 입력을 사용할 수 있는 LLM은 같은 호출 안에서 shaded 및 PBR 지도를 보고 다음 편집을 결정할 수 있다.

`render_material_multiscale`은 같은 중심 좌표를 여러 줌에서 다시 계산한다. 반환되는 `scales[].viewport.rho`, 채널 통계, 공간 gradient/high-pass 지표와 줌 이름표가 붙은 이미지로 가까이서 디테일이 사라지는지 검사한다.

`materials/*.grain`은 성장하는 재질 라이브러리다. 파일 이름이 example id가 되고 첫 번째 `#` 주석이 표시 이름이 된다. bundled id와 같은 파일 이름은 충돌로 거부한다.
