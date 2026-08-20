# GRAIN DSL — 설계 문서 (언어 v0.4 · scale-aware 도구 루프 v0.6)

LLM 생성 사실적 텍스처를 위한 프랙탈 field 언어와 결정론적 런타임 설계.
프로토타입: `grain-bench.html` (브라우저 단일 파일, 의존성 없음)

한 줄 요약:

```text
grain = 순수 field 수식 DSL (+ 인라인 macro) → 확장 → validator(비용·구조 확정) → 픽셀 프로그램 → PBR 채널
```

> v0.4 방향: `noise/fbm/ridged/worley/spots/stripes`는 언어 primitive가 아니라 펼쳐지는 graph library다. 런타임의 결정론적 난수 원자는 `hash2(ix, iy, seed, period)` 하나이며, LLM이 격자 보간·옥타브 합·최근접 거리망을 직접 조립한다. 프로토타입은 기존 재질의 단계적 이주를 위해 고수준 primitive를 legacy shortcut으로 잠시 유지한다.

## 0. v0.4 헌법 — 좋은 귀찮음

GRAIN은 사람이 편하게 쓰는 재질 DSL이 아니라 LLM이 생성·복제·변이하는 결정론적 field graph machine이다. 반복 조립이 가능하고 그 중간값을 노출했을 때 표현력이 증가하는 연산은 내장 primitive로 제공하지 않는다.

| kernel에 남김 | graph library로 내림 |
|---|---|
| 스칼라 산술·비교·선택 | gradient/value noise |
| `floor`, `fract`, `sqrt`, `sin`, `smoothstep` 등 고정 수학 함수 | fbm과 octave 합 |
| `hash2(ix, iy, seed, period)` | ridged 변환 |
| `u`, `v`, var, 상수, SSA 참조 | Worley F1/F2/edge/id |
| PBR 출력 결선 | spots, stripes, warp |

경계 원칙:

1. 분해가 새로운 중간값과 조합을 노출하면 LLM에게 조립시킨다.
2. 분해가 표현력은 늘리지 않고 백엔드 결정론만 위협하면 kernel에 고정한다.
3. 모든 graph는 macro 확장 후 앞선 레지스터만 참조하는 유한 SSA DAG가 된다.
4. graph library의 이름은 실행 의미가 아니다. validator와 backend는 펼쳐진 graph만 신뢰한다.

따라서 `worley_edge`는 존재하지 않는다. LLM은 주변 셀 feature point, 거리, F1/F2 선택망과 `F2-F1`을 직접 구성한다. 반면 정수 hash의 multiply/XOR/shift 구현은 자유화하지 않는다. 이는 재질 표현력을 거의 늘리지 않으면서 JS/WGSL/GLSL 동일성만 깨뜨리기 때문이다.

CIRCLE UI와의 관계: 같은 사상(LLM 출력 = 실행할 코드가 아니라 검증 가능한 데이터, static topology, 되먹임 금지, 에러 메시지가 곧 생성 품질)을 텍스처 도메인에 이식한 것. 다른 점은 독자에서 사람을 배제한다는 것.

---

## 1. 이 언어가 풀려는 문제

사실적인 재질(가죽·나무·돌·직물·부식금속)을 LLM이 만들게 하려면 세 가지 길이 있다. 이미지 생성 모델은 사실적이지만 파라미터화·타일링·PBR 채널 분리·결정론이 없다. 셰이더 코드를 뱉게 하면 CIRCLE UI에서 봤던 문제 그대로다 — 검증 불가, 실행 위험, 비용 예측 불가. GRAIN은 세 번째 길이다: **텍스처를 스케일 계층에 대한 순수 수식으로 기술하는 좁고 닫힌 언어**를 만들고, LLM은 그 안에서만 쓴다.

핵심 관찰은 사실감의 대부분이 **다중 스케일 자기유사성**에서 온다는 것이다. 가죽은 큰 주름 구획 안에 작은 구획, 그 안에 미세 요철과 모공. 대리석은 굵은 맥과 같은 규칙의 3배 스케일 가는 맥. 화강암은 큰 입자와 작은 입자. 그래서 primitive를 픽셀 연산이 아니라 fbm(옥타브 합), ridged, worley(세포), 도메인 워프 같은 **프랙탈 생성자**로 잡으면, 텍스처는 "어떤 스케일에서 어떤 규칙을 어떻게 결합했나"의 짧은 명세가 된다.

## 2. 설계 기준 — 사람을 독자에서 배제하면 무엇이 바뀌는가

CIRCLE UI DSL은 "LLM과 사람이 같이 읽는 표면"이었고 그래서 짧고 예쁜 수식 표면을 지향했다. GRAIN은 그 제약을 버린다. 남는 기준은 둘뿐이다.

**논리적 닫힘.** 모든 문서가 유한 비용에 결정론적으로 종료하고, 잘못된 것은 컴파일 단계에서 잡힌다. 실패 모드는 "이상한 그림"으로 격리된다.

**LLM 탐색 친화성.** 작은 편집이 작은 변화를 만들고, "더 낡게", "더 거칠게" 같은 방향이 파라미터 공간에서 연속이다. 암묵적 기본값과 축약 문법은 오히려 해롭다 — 사람에겐 노이즈여도 LLM에겐 완전 명시적인 쪽이 오류가 적고 validator도 검사가 쉽다.

그 결과 GRAIN 문서는 사람이 읽기엔 파라미터 덩어리다. 하지만 모든 줄이 `무엇 = 수식` 이고, 모든 구조 파라미터가 literal이며, 재질의 *의미*는 언어에 없다. "가죽"은 언어의 어휘가 아니라 "워프한 worley 경계 두 스케일 × 미세 fbm × spots 모공"이라는 트리이고, 그걸 아는 건 LLM 쪽이다.

## 3. 계산 모델 — 텍스처는 하나의 순수 field

텍스처 하나는 `(u, v, rho) → {height, albedo(h,s,v), rough, metal}` 인 순수 함수다. `u,v ∈ [0,1)²`, `rho`는 한 픽셀이 덮는 UV 폭이다. 중간 field들이 선언 순서대로 계산되고(DAG), 출력이 그 위에서 계산된다.

| 항목 | 규약 |
|---|---|
| 좌표 | `u, v` 정규화 UV. 도메인 워프·이방성은 좌표 수식으로 표현(`fbm(u*40, v*1.5, …)`) |
| footprint | `rho = 1/(resolution·zoom)`. 가까이 갈수록 작아지며 더 작은 유한 scale band를 활성화하는 읽기 전용 입력 |
| field | `field name = 수식`. 앞선 field와 var만 참조 가능 (forward ref 컴파일 에러) |
| var | 재질 변수. `var name = literal`. env에서 교체 가능(재컴파일 불필요) |
| out | `height`(필수), `albedo`(필수, `hsv(h,s,v)` 튜플), `rough`, `metal` |
| seed | 문서 seed. 모든 primitive의 seed와 결합되어 결정론적 |

**되먹임 금지가 헌법 조항이다.** 픽셀은 이웃 픽셀의 결과를 읽지 못하고, 어떤 field도 자기 자신을 읽지 못한다. reaction-diffusion·침식 시뮬레이션 같은 반복 계산은 영구 금지 — 닫힌 형식(closed-form) 프랙탈만 허용한다. CIRCLE UI의 3단계 헌법이 텍스처에서는 더 단순해진다: 텍스처는 애초에 시간이 없어서 1단계(순수)만 있고 2단계 슬롯도 필요 없다.

## 4. Primitive — 프랙탈 생성자

| primitive | 시맨틱 | 구조 literal | 비용/px |
|---|---|---|---|
| `noise(x, y, freq, seed)` | gradient noise 0..1 | seed | 1 |
| `fbm(x, y, freq, oct, lac, gain, seed)` | 옥타브 합. 자기유사성의 기본 단위 | oct(1..8), seed | oct |
| `ridged(x, y, freq, oct, lac, gain, seed)` | `1−|n|` 옥타브 합. 맥·능선·박리 | oct, seed | oct |
| `worley(x, y, freq, jitter, out=f1|f2|edge|id, seed)` | 세포 구조. edge=구획 경계, id=입자별 결정론 난수 | out, seed | 3 |
| `spots(x, y, freq, prob, radius, seed)` | 확률적 소프트 원반. 모공·도관·피팅 | seed | 3 |
| `stripes(x, freq, duty, soft)` | 주기 띠. 직물·나이테·방사조직 | – | 0.2 |
| `hash(x, seed)` | 결정론 pseudo-random | seed | 0.2 |
| `hsv(h, s, v)` | albedo 튜플 (`out albedo`에서만) | – | 0 |

수식 함수는 CIRCLE UI와 같은 집합(`sin cos abs sqrt floor fract mod pow clamp lerp smoothstep step select min max …`), 상수 `PI TAU`, 삼항·비교·논리.

**프랙탈 성질은 두 층에서 나온다.** primitive 내부(fbm/ridged의 옥타브)와 문서 구조(같은 primitive를 다른 스케일로 다시 호출: `worley(freq=11)` + `worley(freq=30)`, `ridged(px, py)` + `ridged(px*3.1, py*3.1)`). 후자가 더 중요하다 — 실제 재질은 스케일마다 규칙이 *살짝* 다르고, 그 "살짝"이 사실감이다.

## 5. Static topology — 비용의 컴파일 타임 확정

CIRCLE UI의 `repeat` literal 강제에 대응하는 장치가 세 개다.

**구조 파라미터 literal 강제.** `oct`, `seed`, `out` 은 literal이어야 한다. `oct=u` 같은 것은 컴파일 에러(`fbm()의 'oct'는 숫자 literal이어야 함 (컴파일 타임 확정)`). freq·jitter·prob 같은 연속 파라미터는 수식 허용 — 비용에 영향을 주지 않기 때문이다.

**픽셀당 비용 예산.** validator가 primitive 비용을 합산해 `cost/px`를 확정하고, 예산(현재 64)을 넘으면 거부한다. 이 숫자는 spec만 보고 나오므로, GPU 셰이더든 MCU 베이크든 실행 전에 예산 판정이 가능하다. 프로토타입 6종 재질은 8~25 범위.

**field 수·var 수 상한.** 32 / 16. 장치 프로파일에서 재조정 대상.

## 6. 재질 변수 — 색조 소유권 규약

CIRCLE UI의 테마 계층이 여기서는 재질 변수다. `var`는 env 값이라 교체에 재컴파일이 없고, 같은 문서가 `wear`, `grain`, `base_h` 만 바꿔 새 가죽/낡은 가죽/거친 가죽이 된다.

규약: **색조(h)는 var가 소유하고, 명암 구조(v)와 요철은 field가 소유한다.** albedo의 h 수식이 어떤 var에도 연결되지 않으면 lint 경고(`albedo의 색조(h)가 어떤 var에도 연결되어 있지 않음`). 컴파일은 통과시키되 규약 위반을 도구가 가르친다 — validator 응답에 이 lint가 포함되면 생성 모델의 self-correction 루프가 규약까지 커버한다.

## 6.5 Macro 계층 — 언어 안의 재사용 단위

재질 6종을 쓰고 나니 반복 패턴이 명확했다: 워프 좌표 만들기, 같은 primitive를 다른 스케일로 한 번 더, fbm 문턱으로 마스크, spots로 구멍. 이걸 매번 처음부터 쓰게 두면 LLM의 실패 공간이 넓어지고, 채점 루프가 배운 것을 어디에도 붙여둘 수 없다. 그래서 macro를 **언어 안에** 넣었다 — 언어 밖 스니펫이 아니라 문법이고, canonical 산출물에는 펼쳐진 field와 출처(어느 macro의 몇 번째 인스턴스)가 둘 다 남는다.

```text
macro creases(x, y, scale=1, depth=1):
  wx = warp(x, y)
  wy = warp(y, x, seed=1)
  big   = worley(wx, wy, freq=11*scale, out=edge, seed=4)
  small = worley(wx, wy, freq=30*scale, out=edge, seed=5)
  return depth*(0.7*(1 - smoothstep(0, 0.16, big)) + 0.35*(1 - smoothstep(0, 0.14, small)))

field crease = creases(u, v, scale=grain)
```

**시맨틱은 AST 인라인 확장이다.** 언어의 계산 모델은 조금도 바뀌지 않는다 — 확장 후에는 field 목록일 뿐이라 비용·literal·되먹임 금지가 그대로 성립한다. 규칙:

| 규칙 | 근거 |
|---|---|
| 앞선 macro만 참조, 재귀 불가, 중첩 깊이 ≤ 4 | 확장이 유한하고 비용이 컴파일 타임에 확정 |
| 본문은 파라미터·local·var·상수만 봄, 바깥 field 불가 (위생) | 숨은 결합 금지 — macro는 어디에 붙여도 같은 뜻 |
| literal 인자는 치환, 수식 인자는 hidden field에 1회 바인딩 | literal은 `oct` 같은 구조 literal로 흘러갈 수 있어야 하고, 수식은 두 번 계산되면 안 됨 |
| 암묵 파라미터 `seed`(literal): 본문 안 모든 primitive의 seed에 더해짐 | 같은 macro의 여러 인스턴스가 서로 다른 난수. `veins(u,v)`와 `veins(u,v, scale=3.1, seed=1)` |
| local은 `__macro_N_local` hidden field로 확장, 사용 지점 앞에 삽입 | 픽셀당 1회 평가, DAG 유지. 확장 후 field 상한 128 |

**두 종류의 이어붙이기가 같은 장치로 된다.** 수직(가죽 = warp → creases → pores 조합)과 수평(새들 = 가죽 표면 + 정사각형 경계 마스크 + `stitch_row`). SADDLE LEATHER PANEL은 `edge_d = min(min(u, 1-u), min(v, 1-v))`로 패널 경계까지의 거리를 먼저 정하고, 홈·박음질·마모가 그 형태를 공유하게 한다. 박음질 경로는 랜덤이 아니며 `hash` 변이는 개별 실밥의 길이·두께·위치 오차에만 제한된다. 4 def / 8 인스턴스 / hidden field 40개 / 비용 31.4.

**이 계층의 진짜 의미.** 언어는 얼리고 라이브러리는 자란다. 채점 루프(§8)가 "이 macro는 가죽류에서 점수가 높다", "이 macro 두 개는 같이 쓰면 깨진다" 같은 지식을 macro 단위에 붙여둘 수 있고, LLM은 검증된 sub-tree를 이름으로 부른다. 사람이 아니라 LLM이 채점 루프로 키워가는 macro 라이브러리가 이 프로젝트의 진짜 산출물이다.

## 6.7 결정론과 주기 — 타일링

**모든 것이 결정적이다.** 난수 소스는 없다. 모든 "무작위"는 정수 격자 좌표 `(ix, iy, seed)`를 정수 곱셈·XOR로 섞는 hash 하나에서 나오고, noise·worley·spots가 그 위에 선다. 같은 spec·seed·var면 어느 기계에서 몇 번 돌려도 픽셀 하나까지 같다 — 채점 루프("이 편집이 점수를 올렸다")와 preview=장치 등가성의 전제다.

**결정적이지만 주기는 없다.** hash는 좌표가 다르면 값도 다르므로, 좌표를 아무리 옮겨도 무늬가 되풀이되지 않는다(32비트 wrap까지). 자연 재질에 주기가 없는 것과 같다. 주기는 필요할 때 *넣는* 것이다: 직물의 `stripes`, 나이테의 `sin` 은 의도된 주기이고, 텍스처를 벽에 이어 붙이기 위한 **타일링**도 마찬가지로 의도해서 넣는다.

타일링은 격자 wrap으로 구현된다. `tile = N` 문장(문서 기본값) 또는 primitive의 `tile=N` literal이 켜지면 hash 격자 좌표를 주기로 접는다: 주기 = `tile·freq`(fbm/ridged는 옥타브마다 `tile·freq·lac^i`). 그래서 세 가지 규칙이 따라온다.

| 규칙 | 검사 |
|---|---|
| `tile·freq` 정수 | freq가 literal이면 컴파일 에러(`tile·freq(1·2.5)가 정수여야`), 수식이면 경고 + 실측 |
| `lac` 정수 (tile>0일 때) | 컴파일 에러 |
| primitive에 넣는 *좌표* 자체가 주기적 | 정적으로 못 잡음 → **SEAM 실측치** — 경계 양쪽 (u=0 vs 1, v=0 vs 1)에서 height·albedo 최대 차이. 0이면 완전 타일 |

세 번째가 이 프로젝트의 태도를 잘 보여준다. `wx*1.8` 같은 비주기 좌표를 정적으로 금지하려면 수식의 주기성 추론이 필요한데, 그 대신 값싼 실측 지표를 validator 응답에 넣는다. 결정적이니까 실측이 곧 증명이다. 참나무 예제는 일부러 tile을 끄고 널판으로 두었고 SEAM 0.22가 그걸 보여준다; 나머지 6종은 SEAM 정확히 0.

`lac`은 이제 항상 literal(구조 파라미터). 벤치에는 2×2/3×3 타일 미리보기가 있다.

## 6.8 Scale-aware field — 가까이 가도 같은 재질

고정 PNG를 확대하는 것은 스케일 계층이 아니다. 렌더러는 같은 중심의 더 작은 UV 창을 다시 평가하며, `zoom=z`일 때 폭 `1/z`, `rho=1/(N·z)`를 사용한다. normal 계산도 UV 미분 크기를 보존하도록 relief에 zoom을 반영한다.

무한 옥타브는 유한 비용 헌법과 충돌하므로 허용하지 않는다. LLM은 목표 관찰 범위에 맞춰 4–6개의 유한 band를 명시하고 `rho`로 가시성을 조절한다. 멀리서는 미세 band가 0이어서 aliasing되지 않고, 가까이서는 큰 구조의 단순 확대가 아니라 더 작은 균열·응집체·입자·공극이 나타난다.

검증 도구는 같은 지점을 기본 `1×/4×/16×/64×`에서 렌더하고 각 줌의 채널 분산, 평균 공간 gradient, 4-neighbor high-pass RMS를 반환한다. 비전 검수는 큰 구조 내부와 경계 위 최소 두 중심을 사용한다. 한 균열 위만 확대하면 같은 절벽을 스케일 계층으로 오인하기 때문이다.

## 7. 검증기가 막는 것

| 검사 | 프로토타입 동작 |
|---|---|
| 구조 파라미터 비literal / 범위 초과 | 거부, 위치·허용 범위 명시 |
| 알 수 없는 식별자/함수/인자 이름 | 거부, 이름과 허용 목록 명시 |
| field forward reference | 거부 (`field 'b'은 뒤에서 선언됨`) |
| out을 수식에서 참조 | 거부 (field로 빼라고 안내) |
| hsv를 albedo 밖에서 / albedo가 튜플 아님 | 거부 |
| 필수 출력 누락 | 거부 |
| 비용 예산 초과 | 거부, 줄일 항목 안내 |
| macro 재귀·전방 참조·깊이 초과·인자 누락/미지·본문에서 바깥 field·return 누락 | 거부, 위치 명시 |
| tile>0에서 tile·freq 비정수(literal) / lac 비정수 | 거부 |
| tile>0에서 freq 수식 | 경고 + SEAM 실측 |
| DSL 문법 오류 | **줄 번호 포함** 에러 |
| 색조 미연결, var 미사용 | 경고(컴파일 통과) |

에디터는 이 루프의 실물이다: 잘못된 편집은 줄 번호 에러를 띄우고 마지막 정상 spec을 유지한 채 계속 렌더링한다.

## 8. 사람이 배제되면 필요한 두 번째 검증기

문법 validator는 "실행 가능한가"만 보장하지 "가죽 같은가"는 모른다. CIRCLE UI에서는 사람이 봤지만, GRAIN에서는 그 판정도 루프 안에 있어야 한다. 그래서 두 번째 검증기가 설계에 포함된다: **렌더 → 비전 모델 채점(혹은 참조 사진과의 통계 거리 — 파워 스펙트럼 기울기, 세포 크기 분포, 색 히스토그램) → 재편집.** 이게 성립해야 "사람이 못 쓰는 언어"가 처음 의미를 갖는다. 사람은 "낡은 안장 가죽"이라고만 말하고, 나머지는 LLM이 이 언어 안에서 탐색한다.

v0.6 도구층은 이 루프의 기계적 절반을 구현했다. `validate_material`은 문법·구조 검증과 함께 SEAM, 결정론, 채널 범위·분산·공간 디테일을 구조화된 진단으로 반환한다. `render_material`은 단일 줌의 6개 PBR PNG를, `render_material_multiscale`은 같은 지점의 여러 줌 이미지를 MCP image content로 반환한다. 따라서 비전 입력이 가능한 LLM은 렌더를 직접 보고 명세를 다시 편집할 수 있다. 목표 재질과 닮았는지를 자동 점수화하고 macro별 성과를 축적하는 비전 채점기는 아직 외부 에이전트의 비평에 맡긴다.

### 8.1. LLM 도구 표면 (v0.6 구현)

| 파일/도구 | 역할 |
|---|---|
| `grain-tools.mjs` | 브라우저 엔진을 재사용하는 Node API. 구조화 진단, 통계 분석, 결정론 검사, PNG 렌더, `materials/*.grain` 자동 발견 |
| `grain-cli.mjs` | 파일/표준입력 기반 `examples`, `example`, `validate`, `render`, `render-scales`와 안정된 종료 코드 |
| `grain-mcp-server.mjs` | 의존성 없는 stdio MCP. 예제/검증/단일 렌더/다중 스케일 렌더 5도구 |
| `GRAIN-LLM-GUIDE.md` | 예제 선택 → 작은 편집 → 다중 스케일 검증 → 6뷰 렌더 → 단일 결함 수정 운용 계약 |
| `grain-test.mjs` | 예제, 거부 진단, PNG, CLI, MCP JSON-RPC 회귀 테스트 |

도구의 진단은 사람이 읽는 에러 문자열뿐 아니라 `code`, `line`, `suggestion`을 포함한다. 생성 모델은 문장을 재해석할 필요 없이 코드별 복구 전략을 적용할 수 있다. 렌더 이미지마다 view 이름을 인접 text content로 붙여 비전 모델이 albedo와 normal을 혼동하지 않게 한다.

완성된 spec은 `materials/{id}.grain`에 두면 별도 레지스트리 편집 없이 CLI/MCP 예제 목록에 `origin=library`로 합류한다. 이 경로가 “언어는 얼리고 라이브러리는 자란다”는 원칙의 첫 영구 저장소다. 현재는 파일 단위 발견만 구현하며, 다음 단계에서 macro 출처와 비전 점수를 함께 저장한다.

## 9. 프로토타입으로 검증된 것

전 항목 자동 테스트 통과(Node 헤드리스 + 브라우저 스모크).

**엔진.** Pratt 파서(우선순위·삼항·이름 인자), 결정론적 hash/gradient noise/fbm/ridged/worley/spots, 컴파일 타임 비용 산정, 클로저 컴파일, 4채널 평가(192² 약 100~250ms JS).

**validator.** 10종 + macro 10종 거부 케이스(비literal oct, 범위, forward ref, 미지 함수, 필수 출력, hsv 위치, enum, 문법, 미완 수식, 예산 초과) 모두 정확한 메시지로 거부. lint 2종 검출. 같은 spec 2회 평가 완전 동일(결정론).

**macro.** 파싱·AST 인라인·literal 치환→oct·수식 1회 바인딩·seed 오프셋(같은 seed 인스턴스 동일, 다른 seed 상이)·위생·깊이 제한 테스트 통과.

**타일링.** 7개 tile 예제에서 SEAM 정확히 0, 참나무(tile 끔)는 현재 128점 실측 약 0.106으로 비주기 좌표를 검출한다. 격자 wrap이 hash 결정론을 깨지 않음(결정론 테스트 유지).

**재질 8종.** 빙열 유약 도자기, 가죽(2단 자기유사 세포+모공), 참나무(워프 나이테+이방성 섬유+방사조직), 화강암(worley id 3종 광물+2스케일 입자), 캔버스(평직 체커+실 단면+슬럽), 부식강(fbm 마스크+ridged 박리+metal 채널), 대리석(2단 워프 ridged 맥, 3배 스케일 자기유사), 새들(정사각형 경계 기반 스티치 + 엣지 마모). 전부 macro 기반, 예산 내, lint clean, var 슬라이더로 재컴파일 없이 변형.

**렌더.** height→normal(relief 배율), Blinn 근사 PBR(rough·metal 반영), 4뷰(shaded/albedo/height/normal), 광원 드래그.

**스케일.** canonical IR의 `INPUT rho`, 줌 좌표 재평가, zoom 보정 normal, 1×/4×/16×/64× 이미지와 줌별 통계, MCP image label 테스트 통과. 마른 흙 library 재질은 큰 균열에서 먼지 균열까지 유한 band를 `rho`로 단계 활성화한다.

## 10. Device/셰이더 IR로의 함의

문서가 확정하는 것이 그대로 IR 요구사항이다: field 평가 순서(= 픽셀 프로그램 순서, macro는 확장돼 사라짐), primitive 비용 테이블(= 예산 판정), 구조 literal(= 언롤 가능한 고정 루프), var(= uniform/slot). GLSL/WGSL 백엔드는 거의 1:1 번역이고, MCU 베이크는 같은 프로그램을 CPU에서 한 번 실행해 아틀라스로 굽는 경로다. 산술 시맨틱 통일 문제도 CIRCLE UI와 같다 — JS double / GPU float32 / 고정소수점 사이의 hash·floor 차이가 픽셀 차이가 되므로, hash는 정수 연산으로 못 박았고(현재 imul 기반) noise 보간도 정수 격자 기준이다.

## 11. 현재 한계와 다음 단계

macro 다음 단계: 확장 산출물에 macro 출처를 남기고 있으니(hidden field 이름·인스턴스 번호), 채점 루프가 macro 단위로 점수를 누적하는 것이 자연스럽다. macro 라이브러리를 문서 밖 별도 파일(`prelude`)로 공유하는 것도 필요하다 — 지금은 예제마다 가죽 macro가 복제되어 있다.

미구현: 3D/트리플래너 좌표, 이방성 primitive(현재는 좌표 스케일로 우회), `curl`·`warp` 같은 sugar(현재 field 조합으로 가능해서 보류), 자동 비전 점수와 macro별 성과 저장소, GLSL 백엔드. `rho` band는 현재 저자가 수동으로 가중하므로 primitive별 analytic prefilter나 적분 기반 anti-aliasing은 아직 없다. 비용 모델은 상대 단위이며 실측 보정이 필요하다. Node 도구는 단일 소스를 유지하기 위해 현재 HTML의 엔진 script를 로드하므로, 장기적으로는 엔진을 독립 canonical module로 옮기고 HTML과 도구가 함께 import하도록 정리해야 한다.

권장 순서: 엔진 canonical module 분리 → prelude(공유 macro 파일) → 실제 비전 채점 + macro 성과 DB → 참조 사진 대비 통계 거리 지표 → GLSL 백엔드(preview를 셰이더로, JS는 검증기로) → 재질 라이브러리를 LLM 자체 탐색으로 확장.
