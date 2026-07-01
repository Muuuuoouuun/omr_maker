# 계정 기반 플랜 바인딩 + 테스트/학생 계정 정리

- 날짜: 2026-07-01
- 상태: 승인됨 (설계)

## 배경

현재 교사 플랜(`free`/`pro`/`academy`)은 계정과 무관하게 브라우저 `localStorage.omr_plan`에만
저장된다. 로그인해도 전원 `free`로 시작하고, 플랜은 `/teacher/billing`에서 브라우저별로 수동
전환해야만 바뀐다. 서버 `omr_organizations.plan`은 로그인/billing 어디에서도 갱신되지 않으므로
이 앱은 **플랜을 클라이언트 authoritative**로 다룬다.

목표:
1. 어드민 계정 = 풀 프리미엄(모든 기능) → `academy` 플랜.
2. 테스트 계정 3종을 티어별로 차등: `test1`=free, `test2`=pro, `test3`=academy(엔터프라이즈).
3. 로그인만으로 해당 플랜이 자동 적용되도록(수동 전환 불필요).
4. 샘플 학생 로스터를 반 단위로 깔끔하게 재구성.

## 설계

### 1. 계정에 플랜 필드 추가 (server)

- `TeacherCredential`에 `plan?: PlanKey` 추가.
- `TEACHER_ACCOUNTS` / `OMR_TEACHER_ACCOUNTS` JSON 각 항목의 `"plan"`을 `normalizePlan()`으로 검증해
  파싱한다. 값이 없거나 잘못되면 `undefined`(→ 게이팅상 free).
- 단일 교사 경로(`TEACHER_LOGIN_ID`/`TEACHER_PASSWORD`)는 선택적 `TEACHER_PLAN` env로 플랜 지정.
- `TeacherLoginIdentity`(로그인 응답)에 `plan?: PlanKey` 포함. `verifyTeacherLogin`이 매칭된
  자격증명의 plan을 반환한다.
- `normalizePlan`은 legacy `"school"`을 `"academy"`로 매핑하고 그 외 무효값은 `null` 처리.

### 2. 로그인 시 클라이언트 적용 (client)

`src/app/page.tsx`의 `handleTeacherLogin`에서 세션 저장 성공 후:

```ts
if (res.teacher?.plan) setCurrentPlan(res.teacher.plan);
```

- 계정이 **명시적 plan을 가질 때만** `omr_plan`을 덮어쓴다.
- plan이 없는 계정(레거시/단일 교사 무설정)은 브라우저의 기존 플랜(예: billing으로 올린 값)을
  건드리지 않는다 → 하위호환.
- 결과: `test2`로 로그인하면 즉시 Pro 게이팅, `test1`로 로그인하면 free로 초기화.

서버 `org.plan` 동기화는 범위 밖(YAGNI). 현재 어떤 게이팅도 서버 plan을 읽지 않으며 billing도
서버를 갱신하지 않는다. 클라이언트 authoritative 패턴을 유지한다.

### 3. 계정 구성 (`.env.local`의 `TEACHER_ACCOUNTS`)

| id | 이름 | plan | 비밀번호(로컬) |
|---|---|---|---|
| `admin` | 관리자 | `academy` | `admin1234` |
| `test1` | 테스트1 · 무료 | `free` | `test1234` |
| `test2` | 테스트2 · 프로 | `pro` | `test1234` |
| `test3` | 테스트3 · 엔터프라이즈 | `academy` | `test1234` |

`.env.local`은 gitignore 대상이라 예측 가능한 로컬 비밀번호를 사용한다.

### 4. 학생 로스터 재구성 (`examples/student-roster.csv`)

컬럼(`id,name,email,group,region`) 유지. 3개 반 × 4명 = 12명으로 반/지역 일관되게 재구성.
교사가 `/teacher/users`에서 임포트하면 반영된다.

## 손대는 파일

- `src/lib/teacherAuth.ts` (+ `teacherAuth.test.ts`) — plan 파싱/반환 (TDD)
- `src/app/page.tsx` — 로그인 시 plan 적용
- `.env.local` — 계정 4개
- `examples/student-roster.csv` — 로스터 재구성
- `README.md` — 계정 표 갱신

`src/app/actions/auth.ts`는 `TeacherLoginIdentity`를 그대로 반환하므로 타입만으로 plan이 전달된다.

## 테스트

- `TEACHER_ACCOUNTS` 각 항목의 plan 파싱 및 `verifyTeacherLogin` 반환 확인.
- `"school"` → `academy` 정규화, 무효 plan → undefined, plan 미지정 → undefined.
- `TEACHER_PLAN` 단일 교사 경로.
- 기존 `.toEqual` 자격증명 테스트가 `plan: undefined`로 유지되는지(회귀).

## 하위호환

- plan 없는 계정은 로그인 시 `omr_plan` 미변경.
- 기존 세션/쿠키 스키마 불변(세션에 plan을 싣지 않음).
