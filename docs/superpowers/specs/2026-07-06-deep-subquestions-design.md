# 하위 질문 / 심화 응답 설계 문서

- 날짜: 2026-07-06
- 브랜치: `deep0.1`
- 대상 영역: 문제 설계, 학생 응시, 제출 저장, 교사 리뷰, 문항 분석
- 핵심 파일 후보: `src/types/omr.ts`, `src/app/create/page.tsx`, `src/app/solve/[id]/page.tsx`, `src/lib/examSolvePayload.ts`, `src/lib/studentExamCore.ts`, `src/lib/omrPersistence.ts`

## 1. 결론

문제 안에 붙는 심화 문제는 별도 OMR 문항으로 만들지 않는다. `Exam.questions`에 가짜 문항을 섞으면 문항 번호, 정답 필수 검증, OMR 카드, 자동채점, `QuestionResult` 통계가 모두 흔들린다.

`deep0.1`의 기준 설계는 다음과 같다.

1. 본문항은 기존 `Question` 그대로 유지한다.
2. 하위 질문 정의는 `Question.subQuestions`에 optional field로 붙인다.
3. 학생의 하위 질문 응답은 `Attempt.subQuestionAnswers`에 객관식 답안과 분리 저장한다.
4. MVP에서는 하위 질문이 점수, 정오, 총점, 문항별 정답률에 영향을 주지 않는다.
5. 화면에서는 기능명을 `하위 질문`으로 쓰고, 상위 섹션명은 `고급 문항 구성`으로 둔다.
6. 어떤 문항에도 기본 하위 질문을 자동 생성하지 않는다. 교사가 `상세 설정 추가`를 명시적으로 실행한 문항에만 학생 입력 UI가 생긴다.

## 2. 목적

OMR은 빠른 객관식 채점에 강하지만, 교사가 실제로 알고 싶은 것은 정답 여부만이 아니다.

- 학생이 왜 특정 번호를 골랐는가
- 지문형 문항에서 근거를 제대로 찾았는가
- 정답자는 이해하고 맞힌 것인지 찍어서 맞힌 것인지
- 오답자는 개념 부족, 지문 오독, 계산 실수, 시간 부족 중 무엇이 문제였는지
- 객관식 문항 아래에 "왜 입원했는가?", "이 번호를 왜 찍었는가?" 같은 짧은 주관식 확인을 붙일 수 있는지

이 기능의 목표는 자동채점 시스템을 복잡하게 만드는 것이 아니라, 객관식 문항 아래에 사고 과정 수집 레이어를 추가하는 것이다.

## 3. 기능 명칭

| 맥락 | 명칭 |
| --- | --- |
| 화면 섹션 | 고급 문항 구성 |
| 기능명 | 하위 질문 |
| 설명 문구 | 객관식 답안 아래에 추가 질문을 붙입니다. OMR 문항 수는 바뀌지 않습니다. |
| 교육적 표현 | 사고 확인 질문 |
| 리포트 표현 | 심화 응답 |
| 내부 필드 | `subQuestions`, `subQuestionAnswers` |

`심화 문제`라는 명칭은 난이도 `심화`와 충돌할 수 있으므로, 생성 화면에서는 `하위 질문`을 기본 명칭으로 사용한다.

## 4. MVP 범위

### 포함

- 문항별 하위 질문 0-2개
- 질문 유형은 짧은 서술형만 지원
- 질문 문구, 필수 여부, 최대 글자 수를 `상세 설정`으로 추가
- 전체 문항, 특정 범위, 특정 문항 목록에 같은 상세 설정 일괄 적용
- 학생 응시 화면에서 해당 문항 선택 시 하위 질문 입력
- 자동 저장 draft에 하위 질문 응답 포함
- 제출 시 필수 하위 질문 누락 처리: 수동 제출은 차단, 타이머 자동 제출은 허용
- 교사 시도 상세에서 학생별 하위 질문 응답 표시
- 학생 리뷰에서 본인 하위 질문 응답 표시
- CSV 내보내기에는 2차에서 포함, MVP에서는 화면 표시를 우선

### 제외

- 하위 질문 점수 반영
- AI 자동 채점
- 루브릭 기반 부분 점수
- 하위 객관식 문항
- PDF 위 자유 배치
- 문항 DB 별도 테이블화
- 기존 `studentQuestions` 재사용

기존 `studentQuestions`는 제출 후 학생이 선생님에게 남기는 질문이다. 교사가 시험 설계 시 붙이는 하위 질문과 의미가 다르므로 재사용하지 않는다.

## 5. 교육 설계 패턴

| 패턴 | 목적 | 예시 |
| --- | --- | --- |
| 선택 이유 | 우연 정답과 이해 정답 구분 | 이 답을 고른 이유를 한 문장으로 쓰세요. |
| 지문 근거 | 지문형 문항의 근거 확인 | 정답의 근거가 되는 문장이나 표현을 쓰세요. |
| 풀이 과정 | 계산/논리 전개 확인 | 처음 세운 식이나 풀이 방향을 쓰세요. |
| 오답 원인 | 자기 진단 수집 | 틀렸다면 원인을 쓰세요. |
| 심화 변형 | 조건 변화 사고 확인 | 조건이 바뀌면 답이 어떻게 달라지나요? |
| 본문 맥락 | 지문 속 세부 이유 확인 | 왜 입원했는지 본문 근거로 쓰세요. |

권장 사용량은 20문항 기준 2-4문항이다. 시험 전체의 30%를 넘으면 응시 시간이 길어질 수 있다는 경고를 보여준다.

## 6. 데이터 모델

### Question 확장

```ts
export type QuestionSubQuestionKind = "free_text";

export interface QuestionSubQuestion {
    id: string;
    prompt: string;
    kind: QuestionSubQuestionKind;
    required?: boolean;
    maxLength?: number;
    visibility?: "solve" | "review" | "teacher_only";
    answerGuide?: string;
}

export interface Question {
    id: number;
    number: number;
    // existing fields...
    subQuestions?: QuestionSubQuestion[];
}
```

MVP에서 학생에게 보낼 수 있는 필드는 `id`, `prompt`, `kind`, `required`, `maxLength`, `visibility`이다. `answerGuide`는 교사용 채점 기준이므로 `stripExamForSolving`에서 반드시 제거한다.

### Attempt 확장

```ts
export interface SubQuestionAnswer {
    body: string;
    answeredAt?: string;
}

export type SubQuestionAnswers = Record<number, Record<string, SubQuestionAnswer>>;

export interface Attempt {
    answers: Record<number, number>;
    subQuestionAnswers?: SubQuestionAnswers;
}
```

첫 번째 key는 부모 `question.id`, 두 번째 key는 `subQuestion.id`이다. 객관식 답안인 `answers`와 분리해서 기존 채점 로직을 보호한다.

## 7. 불변조건

- `Question.id`와 `Question.number`는 계속 OMR 객관식 문항의 단위다.
- 하위 질문은 `Exam.questions.length`에 포함하지 않는다.
- 하위 질문은 `gradeAttempt`, `computeExamTotalScore`, `buildQuestionResults`의 점수 계산에 영향을 주지 않는다.
- `QuestionResult`는 계속 부모 문항당 1행이다.
- 하위 질문 `id`는 부모 문항 안에서 유일하고 저장 후 안정적이어야 한다.
- 기존 시험에는 `subQuestions`가 없어도 정상 동작해야 한다.
- 기존 응시 기록에는 `subQuestionAnswers`가 없어도 정상 동작해야 한다.
- `subQuestions`가 없는 문항은 기본 객관식 문항으로만 동작한다.
- `required`는 기본값이 아니다. 교사가 상세 설정에서 켠 하위 질문에만 적용된다.
- 재시험은 부모 문항 id 기준으로 scope를 잡고, 해당 부모 문항의 하위 질문만 함께 보여준다.
- 풀이 전 학생 payload에 정답, 해설, `answerGuide`, 루브릭이 포함되면 안 된다.

## 8. 생성 화면 UX

위치는 `문항 빠른 세팅` 아래, 현재 `전문가 설계` 아코디언 위가 적절하다. 하위 질문은 학생에게 실제로 보이는 입력이므로, 분석용 태그 중심의 `전문가 설계` 안에 숨기지 않는다.

이 섹션은 기본 입력폼을 항상 노출하지 않는다. 빈 상태에서는 설명과 `상세 설정 추가`, `일괄 적용` 진입점만 보여준다. 상세 설정을 추가한 뒤에만 질문 카드, 필수 여부, 글자 수 같은 편집 UI가 나타난다.

사용성 원칙:

- 설정은 2클릭 안에 시작할 수 있어야 한다: `상세 설정 추가` -> 템플릿 선택.
- 기본 화면은 한 줄 요약과 작은 액션만 보여준다. 긴 설명, 큰 카드, 큰 버튼을 기본 노출하지 않는다.
- 하위 질문 카드는 접힌 상태를 기본으로 하고, 펼친 카드도 질문 문구와 핵심 옵션만 보인다.
- 일괄 적용은 별도 큰 상시 패널이 아니라 작은 버튼/메뉴에서 열리는 compact sheet로 처리한다.
- 버튼은 텍스트가 긴 사각 버튼을 남발하지 않고, chip/menu/icon button 조합을 우선한다.
- 학생/교사 리뷰 화면에서는 응답 원문을 기본으로 모두 펼치지 않는다. 요약 row와 `보기` 확장으로 처리한다.

### 접힌 상태

- 하위 질문 없음: `고급 문항 구성 · 객관식만 사용 중`
- 하위 질문 있음: `고급 문항 구성 · 하위 2 · 필수 1`

### 상세 설정 카드 구조

```text
고급 문항 구성
객관식 답안 아래에 추가 질문을 붙입니다. OMR 문항 수는 바뀌지 않습니다.

[상세 설정 추가] [⋯]

12-A · 선택 · 300자                                      [⋯]
이 답을 고른 이유를 한 문장으로 쓰세요.
```

### 템플릿

- 선택 이유 묻기: 이 답을 고른 이유를 한 문장으로 쓰세요.
- 근거 쓰기: 정답의 근거가 되는 부분을 쓰세요.
- 풀이 과정: 처음 세운 식이나 풀이 방향을 쓰세요.
- 본문 세부 질문: 본문 근거를 바탕으로 답하세요.
- 직접 만들기

## 8.1 일괄 적용 UX

일괄 적용은 기본 설정을 전체 문항에 강제로 깔아두는 기능이 아니다. 교사가 만든 `상세 설정 묶음`을 선택한 대상 문항에 복사하는 기능이다. 복사된 뒤에는 각 문항의 하위 질문이 독립적으로 수정된다.

일괄 적용 진입점은 두 가지다.

- 새 상세 설정을 작성한 뒤 대상 문항에 적용
- 이미 특정 문항에 만든 하위 질문 카드에서 `이 설정 일괄 적용` 실행

UI는 별도 대형 패널이 아니라 compact sheet로 연다. 기존 카드 복사로 시작하면 질문 편집 영역은 접고 대상 선택을 먼저 보여준다.

대상 선택 방식:

| 대상 | 예시 | 동작 |
| --- | --- | --- |
| 현재 문항 | 12번 | 선택 중인 문항에만 추가 |
| 전체 문항 | 1-20번 | 모든 문항에 추가 |
| 범위 | 5-10번 | 시작/끝 번호 사이 문항에 추가 |
| 특정 문항 | 1, 3, 7, 12번 | 체크박스 또는 `1,3,7,12` 입력으로 추가 |

적용 충돌 정책:

- 대상 문항에 같은 prompt와 template이 이미 있으면 중복 추가하지 않고 skip한다.
- 문항당 최대 2개 제한을 넘는 문항은 skip하고 결과 요약에 표시한다.
- 전체 문항 적용 또는 전체의 30% 초과 적용은 확인 모달을 띄운다.
- 일괄 적용은 기존 하위 질문을 자동 삭제하거나 덮어쓰지 않는다. MVP는 `추가만` 지원한다.

결과 요약:

```text
하위 질문 일괄 적용 완료
적용 12문항 · 중복 3문항 건너뜀 · 제한 초과 2문항 건너뜀
```

### OMR 카드 표시

`OMRCardView`의 메타 칩 영역에 본문항 레이아웃을 깨지 않는 작은 칩을 추가한다.

- `하위 1`
- `하위 2`
- 필수 하위 질문이 있으면 `필수` 칩 추가

## 9. 학생 응시 UX

기본 OMR 답안 선택 흐름은 유지한다.

1. 학생이 부모 문항을 선택한다.
2. 객관식 보기 버튼 아래에 하위 질문 입력 영역이 열린다.
3. 하위 질문 응답은 답안과 함께 자동 저장된다.
4. 필수 하위 질문이 비어 있으면 제출 전 안내한다.

진행률은 분리해서 표시한다.

- 객관식: `18/20`
- 필수 하위: `3/4`

MVP 정책은 `필수 하위 질문 누락 시 제출 차단`으로 고정한다. 자동 제출은 예외로 제출은 진행하되 누락 상태를 저장한다.

## 10. 저장과 보안

현재 원문 `Exam.payload`와 `omr_exam_questions.payload`가 문항 payload를 보존하므로, MVP에서는 별도 DB 컬럼 추가 없이 optional JSON 필드로 시작할 수 있다.

필요한 처리:

- `sanitizeExamPayload`와 question sanitize에서 malformed `subQuestions` 정규화
- `sanitizeAttemptPayload`에서 malformed `subQuestionAnswers` 정규화
- `stripExamForSolving`에서 `answerGuide` 제거
- `stripExamForReview`에서는 학생 제출 이후 공개 가능한 필드만 유지
- localStorage draft 크기 보호를 위해 `maxLength` 기본 300자, 최대 500자로 제한

별도 테이블은 2차 이후 검색/집계가 필요할 때 검토한다.

## 11. 구현 순서

### Phase 1. 타입과 순수 로직

- `src/types/omr.ts`
  - `QuestionSubQuestion`, `SubQuestionAnswer`, `SubQuestionAnswers` 추가
  - `Question.subQuestions?`, `Attempt.subQuestionAnswers?` 추가
  - 점수 함수가 변경되지 않는 회귀 테스트 추가
- `src/lib/examSolvePayload.ts`
  - solve payload에서 `answerGuide` 제거

### Phase 2. 생성 화면

- `src/app/create/page.tsx`
  - 선택 문항의 하위 질문 CRUD
  - 템플릿 추가
  - 전체/범위/특정 문항 일괄 적용
  - 필수/최대 글자 수 설정
  - 문항 수 감소 시 하위 질문도 함께 사라지는 점을 confirm에 반영
- `src/components/OMRCardView.tsx`
  - `하위 n`, `필수` 메타 칩 표시

### Phase 3. 검증과 저장

- `src/lib/examValidation.ts`
  - prompt 누락, maxLength 범위, 시험 전체 하위 질문 과다 경고
- `src/lib/omrPersistence.ts`
  - exam/attempt sanitize
  - Supabase payload roundtrip 테스트

### Phase 4. 학생 응시와 제출

- `src/app/solve/[id]/page.tsx`
  - `subQuestionAnswers` state/ref/draft 추가
  - 현재 문항 하위 질문 입력 UI
  - 필수 누락 제출 차단
  - submit input에 `subQuestionAnswers` 포함
- `src/lib/studentExamCore.ts`
  - `SubmitAttemptInput.subQuestionAnswers?`
  - 서버 authoritative attempt에 복사
  - 로컬 fallback에도 복사

### Phase 5. 리뷰와 리포트

- `src/app/teacher/attempt/[attemptId]/page.tsx`
  - 학생 응답 표시
  - 미응답/응답 있음 상태 표시
- `src/app/student/review/[attemptId]/page.tsx`
  - 본인 하위 응답 표시
- CSV export는 화면 표시 안정화 이후 추가

## 12. QA 기준

### 생성/편집

- 문항별 하위 질문 추가, 수정, 삭제가 가능하다.
- 전체/범위/특정 문항 일괄 적용이 가능하며, 중복과 제한 초과 문항은 안전하게 건너뛴다.
- 저장 후 새로고침해도 하위 질문이 유지된다.
- 하위 질문이 없는 시험은 기존 생성 화면과 동일하게 동작한다.
- prompt가 비어 있으면 배포 전 경고한다.
- maxLength는 1-500자 범위로 제한된다.

### 응시

- 하위 질문이 있는 문항에서만 입력 UI가 나타난다.
- 답안 자동 저장과 함께 하위 응답도 복구된다.
- 필수 하위 질문이 비어 있으면 수동 제출이 차단된다.
- 자동 제출은 차단하지 않고 미응답 상태로 저장한다.
- 모바일에서 입력창이 OMR, PDF, 제출 버튼과 겹치지 않는다.

### 채점

- 하위 질문 유무와 무관하게 객관식 점수가 동일하다.
- `gradeAttempt` 결과가 기존 시험과 달라지지 않는다.
- `QuestionResult` 개수는 부모 문항 수와 동일하다.
- 재시험에서도 scope 안의 부모 문항에 딸린 하위 질문만 표시된다.

### 보안/페이로드

- 풀이 payload에 `answer`, `explanation`, `answerGuide`가 포함되지 않는다.
- 기존 시험/응시 기록을 읽을 때 optional field 누락으로 크래시가 나지 않는다.

## 13. 테스트 후보

- `src/types/omr.test.ts`
  - 하위 질문이 있어도 총점/채점이 그대로인지
- `src/lib/examSolvePayload.test.ts`
  - `answerGuide` 제거 확인
- `src/lib/examValidation.test.ts`
  - prompt 누락, maxLength 범위, 과다 사용 경고
- `src/lib/studentExamCore.test.ts`
  - `subQuestionAnswers`가 attempt에 저장되고 점수에는 영향 없는지
- `src/lib/omrPersistence.test.ts`
  - payload roundtrip과 sanitize
- `src/lib/uiSurface.test.ts`
  - 생성 화면, 응시 화면, 리뷰 화면에 핵심 UI 문자열 존재

## 14. 확정 정책

필수 하위 질문 누락은 `수동 제출 차단, 자동 제출 허용`으로 고정한다. 이는 교사가 필수로 설정한 의도를 지키면서도 타이머 종료 제출을 막지 않는 균형안이다.
