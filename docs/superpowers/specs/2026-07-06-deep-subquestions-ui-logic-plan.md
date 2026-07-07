# 하위 질문 UI / 로직 상세 기획

- 날짜: 2026-07-06
- 브랜치: `deep0.1`
- 상위 문서: `docs/superpowers/specs/2026-07-06-deep-subquestions-design.md`
- 목표: 구현자가 바로 작업을 나눌 수 있도록 화면 상태, 컴포넌트 배치, 검증, 저장, 제출 로직을 상세화한다.

## 1. 제품 원칙

하위 질문은 새 문항이 아니라 기존 객관식 문항에 붙는 고급 입력 레이어다.

- OMR 문항 수는 변하지 않는다.
- 어떤 문항에도 기본 하위 질문을 자동으로 만들지 않는다.
- 교사가 `상세 설정 추가`를 실행한 문항에만 학생 입력 UI가 나타난다.
- 객관식 자동채점은 기존 그대로 유지한다.
- 하위 질문은 학생 사고 과정, 근거, 풀이 방향을 수집한다.
- MVP에서는 하위 질문이 점수에 반영되지 않는다.
- 교사용 화면에서는 `하위 질문`, 학생/리포트 화면에서는 `심화 응답` 표현을 사용한다.

## 2. 권한 / 고급 기능 분리

현재 플랜 모델에는 `advancedAnalytics`가 있지만, 하위 질문은 분석이 아니라 시험 설계 기능이다. 별도 entitlement를 추가하는 편이 장기적으로 명확하다.

권장 entitlement:

```ts
advancedQuestionDesign: boolean;
```

초기 정책:

| 플랜 | 동작 |
| --- | --- |
| Free | 섹션은 보이되 추가 버튼 disabled, 예시/업그레이드 안내 표시 |
| Pro | 하위 질문 생성, 일괄 적용, 응시, 리뷰 가능 |
| Academy | Pro 기능 + 이후 저장 템플릿, 조직 리포트 후보 |

구현상 첫 slice에서 entitlement 추가가 부담되면 `advancedAnalytics`를 임시로 재사용할 수 있다. 단, 문서와 UI copy에는 `고급 문항 구성`으로 분리해서 향후 entitlement 이전을 쉽게 한다.

## 3. 타입 상세

### 3.1 문항 정의

```ts
export type QuestionSubQuestionKind = "free_text";
export type QuestionSubQuestionVisibility = "solve" | "review" | "teacher_only";
export type QuestionSubQuestionTemplate =
    | "choice_reason"
    | "evidence"
    | "solution_process"
    | "context_detail"
    | "custom";

export interface QuestionSubQuestion {
    id: string;
    prompt: string;
    kind: QuestionSubQuestionKind;
    required?: boolean;
    maxLength?: number;
    visibility?: QuestionSubQuestionVisibility;
    template?: QuestionSubQuestionTemplate;
    answerGuide?: string;
}

export type QuestionSubQuestionDraft = Omit<QuestionSubQuestion, "id">;
```

MVP 필드 원칙:

- `id`: 저장 후 변하지 않는 안정 ID
- `prompt`: 학생에게 보이는 질문
- `kind`: MVP에서는 `"free_text"` 고정
- `required`: 상세 설정에서 교사가 켰을 때만 수동 제출 차단 기준
- `maxLength`: 상세 설정 추가 시 제안값 300, 최대 500
- `visibility`: 상세 설정 추가 시 제안값 `"solve"`
- `template`: UI 표시와 추후 분석용
- `answerGuide`: 교사용 기준, 풀이 전 payload에서는 제거

### 3.2 학생 응답

```ts
export interface SubQuestionAnswer {
    body: string;
    answeredAt?: string;
}

export type SubQuestionAnswers = Record<number, Record<string, SubQuestionAnswer>>;
```

응답 저장 규칙:

- 부모 key는 `question.id`
- 자식 key는 `subQuestion.id`
- 빈 문자열은 저장하지 않는다.
- 글자 수는 입력 시와 제출 시 모두 clamp한다.
- 부모 문항이 재시험 scope 밖이면 제출 payload에서 제거한다.

## 4. 순수 helper 설계

새 파일 후보: `src/lib/subQuestions.ts`

```ts
export const DEFAULT_SUB_QUESTION_MAX_LENGTH = 300;
export const MAX_SUB_QUESTION_LENGTH = 500;
export const MAX_SUB_QUESTIONS_PER_QUESTION = 2;

export function normalizeSubQuestion(input: unknown): QuestionSubQuestion | null;
export function normalizeSubQuestions(input: unknown): QuestionSubQuestion[];
export function normalizeSubQuestionAnswers(input: unknown): SubQuestionAnswers;
export function makeSubQuestionId(existing: QuestionSubQuestion[]): string;
export function subQuestionDisplayLabel(questionNumber: number, index: number): string;
export function visibleSubQuestionsForSolve(question: Question): QuestionSubQuestion[];
export function countSubQuestions(questions: Question[]): {
    total: number;
    required: number;
    questionCount: number;
};
export function trimSubQuestionAnswer(body: string, maxLength?: number): string;
export function updateSubQuestionAnswer(
    answers: SubQuestionAnswers,
    questionId: number,
    subQuestionId: string,
    body: string,
    nowIso: string,
): SubQuestionAnswers;
export function collectMissingRequiredSubQuestions(
    questions: Question[],
    answers: SubQuestionAnswers | undefined,
): MissingRequiredSubQuestion[];
export function pruneSubQuestionAnswersToQuestions(
    questions: Question[],
    answers: SubQuestionAnswers | undefined,
): SubQuestionAnswers | undefined;
export function parseQuestionTargetExpression(input: string, questions: Question[]): number[];
export function applySubQuestionDraftToQuestions(
    questions: Question[],
    draft: QuestionSubQuestionDraft,
    targetQuestionIds: number[],
): {
    questions: Question[];
    appliedQuestionIds: number[];
    duplicateQuestionIds: number[];
    limitExceededQuestionIds: number[];
};
```

`subQuestionDisplayLabel(12, 0)`은 `12-A`, `subQuestionDisplayLabel(12, 1)`은 `12-B`를 반환한다. 이 label은 화면용이며 저장 ID가 아니다.

## 5. 생성 화면 UI 설계

대상: `src/app/create/page.tsx`

### 5.0 컴팩트 사용성 원칙

이 기능은 고급 기능이지만 설정을 어렵게 만들면 안 된다. 동시에 생성 화면의 우측 설정 패널은 이미 밀도가 높으므로, 하위 질문 UI가 새 대형 패널처럼 비대해지면 안 된다.

기준:

- 빈 상태는 2줄 이하 설명 + 작은 액션 2개만 둔다.
- 기본 액션은 `상세 설정 추가`, 보조 액션은 icon/menu 형태의 `일괄 적용`으로 둔다.
- 템플릿은 큰 버튼 5개를 항상 펼치지 않는다. `상세 설정 추가` 클릭 시 compact menu로 보여준다.
- 하위 질문 카드는 접힌 상태를 기본으로 한다. 접힌 높이는 한 문항 카드 안에서 44-56px 수준을 목표로 한다.
- 펼친 카드도 textarea + 1줄 옵션만 보인다. 고급 옵션은 MVP에서 만들지 않는다.
- 반복 항목 안에 또 큰 카드가 들어가는 구조를 피한다. 얇은 bordered row 또는 compact panel을 사용한다.
- 버튼 높이는 데스크톱 30-34px, 터치/모바일 36-40px를 목표로 한다.
- chip은 상태 표시에만 쓰고, 긴 문장형 버튼을 chip처럼 만들지 않는다.
- 라벨 문구는 짧게 쓴다: `선택`, `필수`, `300자`, `복사 적용`, `삭제`.
- 한 화면에 primary CTA는 하나만 보인다.

### 5.1 배치

현재 생성 화면의 우측 설정 패널 안에서 다음 순서로 둔다.

1. 빠른 정답 입력
2. 문항 빠른 세팅
3. 고급 문항 구성
4. 문항 라벨 일괄 적용
5. 전문가 설계
6. PDF 문항 연결

이유:

- `문항 빠른 세팅`은 답안/배점/라벨의 핵심 작업이다.
- `고급 문항 구성`은 선택 문항에 직접 붙는 학생 입력이므로 라벨 설정보다 위에 둔다.
- `하위 질문 일괄 적용`은 별도 상시 카드로 두지 않는다. `고급 문항 구성` 헤더 또는 하위 질문 카드 메뉴에서 compact sheet로 연다.
- `전문가 설계`는 분석 태그/해설 중심이므로 하위 질문보다 뒤에 둔다.

### 5.2 섹션 헤더

접힌 헤더:

```text
고급 문항 구성
객관식만 사용 중
```

하위 질문이 있을 때:

```text
고급 문항 구성
하위 2 · 필수 1
```

헤더 우측 상태 칩:

- 없음: `선택사항`
- 있음: `하위 n`
- Free 잠금: `Pro`

헤더 액션:

- `+` icon button: 상세 설정 추가
- `MoreHorizontal` menu: 일괄 적용, 모두 접기, 설정 삭제

좁은 패널에서는 `상세 설정 추가` 텍스트 버튼 대신 `+` 아이콘 버튼과 tooltip을 쓴다. 텍스트 버튼은 빈 상태에서만 노출한다.

### 5.3 빈 상태

```text
이 문항은 객관식만 사용합니다.
객관식 답안 아래에 추가 질문을 붙입니다. OMR 문항 수는 바뀌지 않습니다.
[상세 설정 추가] [⋯]
```

Free 플랜:

```text
고급 문항 구성은 Pro 이상에서 사용할 수 있습니다.
[예시 보기] [업그레이드]
```

### 5.4 상세 설정 추가

`상세 설정 추가` 버튼은 작은 메뉴를 연다. 메뉴를 열기 전에는 질문 문구 textarea, 필수 toggle, 글자 수 input을 렌더하지 않는다.

| 템플릿 | prompt |
| --- | --- |
| 선택 이유 묻기 | 이 답을 고른 이유를 한 문장으로 쓰세요. |
| 근거 쓰기 | 정답의 근거가 되는 부분을 쓰세요. |
| 풀이 과정 | 처음 세운 식이나 풀이 방향을 쓰세요. |
| 본문 세부 질문 | 본문 근거를 바탕으로 답하세요. |
| 직접 만들기 |  |

메뉴 구성:

- 상단 3개 quick item: `선택 이유`, `근거`, `풀이`
- 하단 작은 `더보기` 또는 `직접 만들기`
- 각 항목은 1줄 label + 매우 짧은 보조 문구만 사용한다.

큰 버튼 5개를 패널에 항상 펼쳐 두지 않는다. 이 기능은 자주 쓰는 고급 설정이므로, 화면 공간을 차지하는 버튼 묶음보다 menu/sheet가 낫다.

템플릿을 선택하면 그때 `Question.subQuestions`에 새 항목을 만든다. 직접 만들기는 prompt가 빈 카드로 열리지만, 저장/배포 전 validation에서 반드시 채우게 한다.

### 5.5 하위 질문 카드

카드 접힌 행:

```text
12-A  선택 · 300자
이 답을 고른 이유를 한 문장으로 쓰세요.        [⋯]
```

카드 펼친 영역:

- 질문 문구 textarea
- 옵션 1줄: `선택/필수` segmented control, `최대 글자 수` compact number input
- 우측 overflow menu: `이 설정 일괄 적용`, `삭제`

펼친 카드 레이아웃:

```text
12-A  선택 · 300자                         [⋯]
[질문 문구 textarea, 2-3줄]
[선택 응답 | 필수 응답]   최대 [300] 자
```

삭제, 복사 적용, 고급 항목은 항상 보이는 큰 버튼으로 두지 않는다. overflow menu에 넣는다.

MVP에서 제외:

- drag 정렬
- 복제
- 루브릭
- 수동 채점

정렬은 배열 순서로만 관리한다. 문항당 최대 2개라 drag/drop은 과하다.

### 5.6 생성 화면 상태

새 UI state:

```ts
const [isSubQuestionConfigOpen, setIsSubQuestionConfigOpen] = useState(false);
const [expandedSubQuestionId, setExpandedSubQuestionId] = useState<string | null>(null);
const [subQuestionBatchOpen, setSubQuestionBatchOpen] = useState(false);
```

`selectedQuestionId`가 바뀌면 `expandedSubQuestionId`는 null로 초기화한다. `isSubQuestionConfigOpen`은 유지해도 된다.

### 5.7 생성 화면 updater

`updateSelectedQuestion` 위에 얹는다.

```ts
function addSubQuestion(template: QuestionSubQuestionTemplate): void;
function updateSubQuestion(subQuestionId: string, patch: Partial<QuestionSubQuestion>): void;
function deleteSubQuestion(subQuestionId: string): void;
function setSubQuestionRequired(subQuestionId: string, required: boolean): void;
function setSubQuestionMaxLength(subQuestionId: string, maxLength: number): void;
```

삭제 정책:

- 아직 배포 전 기준에서는 즉시 삭제
- 토스트 문구: `하위 질문 삭제됨`
- Undo는 MVP에서 제외

### 5.8 하위 질문 일괄 적용 UI

일괄 적용은 "기본 하위 질문을 모든 문항에 항상 켜는 기능"이 아니다. 교사가 만든 상세 설정 묶음을 대상 문항에 한 번 복사한다. 복사 이후 각 문항의 하위 질문은 서로 독립적이다.

진입점:

- 고급 문항 구성 헤더의 overflow menu `일괄 적용`
- 각 하위 질문 카드의 overflow menu `이 설정 일괄 적용`
- 빈 상태의 `⋯` menu 안 `일괄 적용`

권장 UI는 compact sheet다. 별도 상시 패널이나 큰 카드로 만들지 않는다.

일괄 적용 모달은 두 가지 시작 상태를 지원한다.

| 시작 상태 | 사용 상황 | 동작 |
| --- | --- | --- |
| 빈 draft | 새 상세 설정을 여러 문항에 바로 추가 | 템플릿/질문 문구부터 입력 |
| 기존 카드 복사 | 특정 문항에 이미 만든 설정을 다른 문항에도 적용 | 해당 카드의 prompt, required, maxLength, visibility를 draft로 채움 |

```text
하위 질문 일괄 적용

[설정]  선택 이유 · 선택 · 300자        [수정]
[대상]  현재 | 전체 | 범위 | 직접
        범위 [5] - [10]   또는   직접 [1,3,5-8]

적용 가능 16 · 중복 2 · 제한 초과 2
[취소] [적용]
```

compact sheet 규칙:

- sheet 폭은 설정 패널 폭에 맞추고, desktop max-width 420px 수준으로 제한한다.
- 시작 상태가 기존 카드 복사라면 질문 문구 textarea를 기본으로 접는다. `수정`을 누를 때만 펼친다.
- 새 draft 상태에서만 템플릿 menu와 textarea를 먼저 보여준다.
- target 선택은 radio card가 아니라 segmented control 한 줄로 둔다.
- 대상 입력은 선택한 모드에 필요한 input만 표시한다.
- 미리보기 결과는 표가 아니라 한 줄 summary로 둔다.

대상 모드:

```ts
type SubQuestionBatchTarget =
    | { mode: "current"; questionId: number }
    | { mode: "all" }
    | { mode: "range"; start: number; end: number }
    | { mode: "specific"; expression: string };
```

특정 문항 입력은 `1,3,7,12`와 `1,3,5-8` 형식을 허용한다. 파서는 중복 제거, 오름차순 정렬, 존재하지 않는 문항 번호 제거를 수행한다.

적용 방식:

- MVP는 `추가만` 지원한다.
- 같은 문항에 같은 `template + prompt`가 이미 있으면 skip한다.
- 문항당 `MAX_SUB_QUESTIONS_PER_QUESTION`을 넘으면 skip한다.
- overwrite, replace, delete batch는 2차로 미룬다.

적용 전 미리보기:

```text
대상 20문항
적용 가능 16문항 · 중복 2문항 · 제한 초과 2문항
```

적용 후 toast:

```text
하위 질문 일괄 적용 완료
16문항 적용 · 2문항 중복 · 2문항 제한 초과
```

전체 문항 또는 전체의 30% 초과 대상이면 확인 문구를 추가한다.

```text
많은 문항에 하위 질문이 추가됩니다. 학생 응시 시간이 길어질 수 있습니다.
```

## 6. 생성 화면 로직

### 6.1 문항 수 감소 guard

현재 `handleQuestionCountChange`는 줄어드는 문항 중 정답 입력만 확인한다. 하위 질문도 손실 정보에 포함한다.

추가 계산:

```ts
const losingSubQuestions = questions
    .slice(newCount)
    .reduce((sum, q) => sum + (q.subQuestions?.length || 0), 0);
```

확인 문구:

```text
줄어드는 문항에 정답 n개, 하위 질문 m개가 있습니다. 문항 수를 줄이면 함께 삭제됩니다.
```

### 6.2 빠른 요약

`designSummary`에 추가:

```ts
subQuestionCount: number;
requiredSubQuestionCount: number;
subQuestionedQuestionCount: number;
```

상단 품질 체크에 표시:

- `하위 질문 3개`
- `필수 하위 1개`
- 30% 초과 시 warning: `하위 질문이 많아 응시 시간이 길어질 수 있습니다.`

일괄 적용 결과는 상단 품질 체크에 계속 남기지 않는다. 적용 전 compact sheet의 한 줄 미리보기와 적용 후 toast로만 보여준다.

### 6.3 검증

`validateExamDraft`에 다음 issue 추가:

| code | severity | 조건 |
| --- | --- | --- |
| `subquestion_prompt_required` | error | prompt trim 빈 값 |
| `subquestion_max_length_invalid` | error | maxLength < 1 또는 > 500 |
| `subquestion_limit_exceeded` | error | 문항당 2개 초과 |
| `subquestion_batch_target_empty` | error | 일괄 적용 대상이 0문항 |
| `subquestion_overuse` | warning | 하위 질문 있는 문항이 전체의 30% 초과 |
| `required_subquestion_overuse` | warning | 필수 하위 질문 10개 초과 |

## 7. OMR 카드 표시 설계

대상: `src/components/OMRCardView.tsx`

추가 표시:

- `q.subQuestions?.length`가 있으면 `하위 n` chip
- required가 하나라도 있으면 `필수` chip
- 응시 모드에서는 required 미작성 상태를 받을 수 있도록 optional prop 추가

```ts
subQuestionStatusByQuestionId?: Record<number, "none" | "optional" | "required-complete" | "required-missing">;
```

MVP 첫 구현은 editor 모드의 메타 칩만 먼저 넣고, solve 상태 칩은 응시 UI 구현 시 추가해도 된다.

## 8. 학생 응시 UI 설계

대상: `src/app/solve/[id]/page.tsx`

### 8.1 배치

OMR 패널 안에서 `OMRCardView` 아래에 `현재 문항 하위 질문` 블록을 둔다.

```text
12번 심화 응답 · 1개
12-A 필수 · 0/300
이 답을 고른 이유를 한 문장으로 쓰세요.
[textarea]
```

이유:

- PDF 문제지 위에 입력 UI를 올리지 않는다.
- 전체 OMR 카드 하나하나를 키우지 않는다.
- 현재 선택 문항 중심의 응시 흐름을 유지한다.

모바일에서는 OMR 패널 스크롤 안에서 같은 위치를 유지한다. 별도 bottom sheet는 MVP에서 제외한다.

학생 화면 밀도 규칙:

- 하위 질문이 없는 문항에서는 아무 영역도 렌더하지 않는다.
- 하위 질문이 1개면 header 없이 질문 label + textarea만 보여준다.
- 하위 질문이 2개면 작은 섹션 header `심화 응답 2개`를 보여준다.
- textarea 기본 높이는 72-88px, 내용이 길어지면 내부 스크롤 또는 vertical resize를 허용한다.
- 필수/선택 상태는 큰 배지가 아니라 작은 텍스트 chip으로 표시한다.
- OMR 카드 자체 높이는 하위 질문 때문에 변하지 않는다.

### 8.2 상태

추가 state/ref:

```ts
const [subQuestionAnswers, setSubQuestionAnswers] = useState<SubQuestionAnswers>({});
const subQuestionAnswersRef = useRef<SubQuestionAnswers>({});
```

`SolveDraft` 확장:

```ts
interface SolveDraft {
    answers: Record<number, number>;
    subQuestionAnswers?: SubQuestionAnswers;
    drawings?: PdfDrawings;
    drawingsRef?: StoredDataRef;
    timeRemaining: number | null;
    startedAt: string;
    savedAt: string;
}
```

### 8.3 입력 핸들러

```ts
const handleSubQuestionAnswerChange = (
    questionId: number,
    subQuestion: QuestionSubQuestion,
    body: string,
) => {
    const nowIso = new Date().toISOString();
    const next = updateSubQuestionAnswer(
        subQuestionAnswersRef.current,
        questionId,
        subQuestion.id,
        body,
        nowIso,
    );
    subQuestionAnswersRef.current = next;
    setSubQuestionAnswers(next);
    latestDraftRef.current = {
        ...latestDraftRef.current,
        answers: studentAnswersRef.current,
        subQuestionAnswers: next,
        savedAt: nowIso,
    };
    void saveDraftSnapshot(latestDraftRef.current);
};
```

쓰기 빈도가 높으므로 저장 호출은 기존 autosave interval에 맡기고, 즉시 저장은 blur 또는 500ms debounce로 줄이는 편이 좋다. MVP에서는 기존 답안 클릭과 동일한 `saveDraftSnapshot` 호출 패턴을 재사용하되, 긴 입력에서 localStorage write가 과해지지 않는지 확인한다.

### 8.4 제출 확인

`SubmitConfirmState` 확장:

```ts
interface SubmitConfirmState {
    unanswered: number;
    total: number;
    missingRequiredSubQuestions: MissingRequiredSubQuestion[];
}
```

수동 제출 흐름:

1. 객관식 미답 계산
2. 필수 하위 질문 누락 계산
3. 누락이 있으면 confirm dialog에서 제출 버튼 disabled
4. `첫 누락으로 이동` 버튼 제공

자동 제출 흐름:

1. 객관식 미답과 하위 질문 누락을 계산한다.
2. 제출을 차단하지 않는다.
3. `subQuestionAnswers`에 있는 응답만 저장한다.
4. 교사 리뷰에서 필수 미응답 상태로 보인다.

### 8.5 이동 버튼

필수 하위 질문 누락 시:

```text
12-A 필수 하위 질문이 비어 있습니다.
[12번으로 이동]
```

클릭 동작:

- `handleQuestionClick(questionId)`
- OMR 패널이 접혀 있으면 펼침
- textarea focus

## 9. 제출 / 서버 로직

대상: `src/lib/studentExamCore.ts`, `src/app/actions/studentExam.ts`

`SubmitAttemptInput`에 추가:

```ts
subQuestionAnswers?: SubQuestionAnswers;
```

`buildServerAttempt` 처리:

```ts
const scopedSubQuestionAnswers = pruneSubQuestionAnswersToQuestions(scope.questions, input.subQuestionAnswers);

const attempt: Attempt = {
    // existing fields...
    subQuestionAnswers: scopedSubQuestionAnswers,
};
```

중요:

- 서버는 점수를 클라이언트에서 받지 않듯, 하위 질문 응답도 scope와 maxLength를 다시 검증한다.
- scope 밖 questionId는 제거한다.
- 존재하지 않는 subQuestionId는 제거한다.
- teacher-only visibility 응답은 solve에서 받을 일이 없지만 서버에서도 제거한다.

## 10. 페이로드 보안

대상: `src/lib/examSolvePayload.ts`

`stripExamForSolving`에서 question 단위로 다음을 수행한다.

```ts
const subQuestions = question.subQuestions
    ?.filter(item => item.visibility !== "teacher_only")
    .map(({ answerGuide: _omitGuide, ...safe }) => safe);
```

주의:

- `explanation`은 기존처럼 제거
- `answer`도 기존처럼 제거
- `answerGuide`는 반드시 제거
- review payload에서는 제출 후이므로 `answer`/`explanation`은 유지 가능하지만 `teacher_only` 정책은 별도 판단이 필요하다. MVP에서는 review에서도 `teacher_only`를 학생에게 보여주지 않는다.

## 11. 저장 / sanitize

대상: `src/lib/omrPersistence.ts`

정규화 원칙:

- `subQuestions`가 배열이 아니면 제거
- prompt trim
- prompt 빈 항목은 제거 또는 validation error 대상으로 유지할지 선택 필요
- persistence sanitize에서는 빈 prompt 항목 제거가 더 안전하다.
- maxLength는 1-500으로 clamp
- kind가 없거나 invalid면 `"free_text"`
- required는 boolean만 유지
- visibility invalid면 `"solve"`
- answerGuide는 string이면 trim, 빈 값이면 제거

Attempt sanitize:

- questionId가 finite number가 아니면 제거
- subQuestionId가 string이 아니면 제거
- body trim
- 빈 body는 제거
- answeredAt이 invalid면 제거

## 12. 리뷰 화면 설계

### 12.1 교사 시도 상세

대상: `src/app/teacher/attempt/[attemptId]/page.tsx`

문항별 결과 행 또는 필기 리뷰 영역 아래에 표시한다. 기본은 compact summary이고, 원문 응답은 펼쳤을 때만 보인다.

```text
심화 응답 1 · 필수 미응답 0
12-A · 필수 · 응답 있음      [보기]
```

상태:

- `응답 있음`
- `미응답`
- `필수 미응답`

MVP에서는 교사 피드백 입력을 넣지 않는다.

리뷰 화면 밀도 규칙:

- 모든 문항에 응답 원문을 한꺼번에 펼치지 않는다.
- 문항별 summary row를 먼저 보여주고, `보기` 클릭 시 원문을 펼친다.
- 긴 응답은 2줄 clamp 후 `더보기`로 확장한다.
- 응답 없는 선택 질문은 기본 숨김, 필수 미응답만 표시한다.

### 12.2 학생 리뷰

대상: `src/app/student/review/[attemptId]/page.tsx`

정답/해설 영역 아래에 본인 응답을 읽기 전용으로 표시한다.

```text
내 심화 응답
12-A
...
```

학생에게 보여줄 수 없는 visibility는 제외한다.

## 13. 상세 상태 모델

### 13.1 하위 질문 정의 상태

| 상태 | 조건 | UI |
| --- | --- | --- |
| none | `subQuestions` 없음 | 객관식만 사용 중 |
| draft-invalid | prompt 빈 값 | 빨간 테두리, 배포 전 오류 |
| optional | required false | 선택 응답 |
| required | required true | 필수 |
| locked | Free 플랜 | Pro chip, disabled |

### 13.2 학생 응답 상태

| 상태 | 조건 | UI |
| --- | --- | --- |
| no-subquestion | 하위 질문 없음 | 표시 없음 |
| optional-empty | 선택 질문 미응답 | 회색 |
| required-empty | 필수 질문 미응답 | 경고 |
| answered | body 있음 | 완료 |
| too-long | maxLength 초과 | 입력 차단 또는 잘림 |
| out-of-scope | 재시험 scope 밖 | 제출 payload에서 제거 |

## 14. 구현 slice

### Slice A. 타입 / helper / 테스트

- `src/types/omr.ts`
- `src/lib/subQuestions.ts`
- `src/types/omr.test.ts`
- `src/lib/subQuestions.test.ts`

완료 기준:

- 하위 질문이 있어도 `gradeAttempt` 결과가 변하지 않는다.
- helper가 missing required를 정확히 계산한다.

### Slice B. 생성 UI

- `src/app/create/page.tsx`
- `src/components/OMRCardView.tsx`
- `src/app/globals.css` 필요 시 최소 추가

완료 기준:

- 선택 문항에 하위 질문 추가/수정/삭제 가능
- 전체/범위/특정 문항에 하위 질문 일괄 적용 가능
- 중복 prompt와 문항당 최대 개수 초과는 건너뛰고 결과 요약 표시
- 저장 후 다시 편집해도 유지
- OMR 카드에 `하위 n` 표시

### Slice C. 검증 / payload / persistence

- `src/lib/examValidation.ts`
- `src/lib/examSolvePayload.ts`
- `src/lib/omrPersistence.ts`

완료 기준:

- 빈 prompt는 배포 오류
- solve payload에 `answerGuide` 없음
- 저장 roundtrip에서 optional field 유지

### Slice D. 응시 / 제출

- `src/app/solve/[id]/page.tsx`
- `src/lib/studentExamCore.ts`
- `src/app/actions/studentExam.ts`

완료 기준:

- 하위 응답 autosave 복구
- 필수 누락 수동 제출 차단
- 자동 제출은 저장 진행
- 점수 변화 없음

### Slice E. 리뷰

- `src/app/teacher/attempt/[attemptId]/page.tsx`
- `src/app/student/review/[attemptId]/page.tsx`

완료 기준:

- 교사/학생이 응답을 확인 가능
- 기존 attempt는 응답 영역 없이 정상 렌더

## 15. QA 시나리오

1. 하위 질문 없는 기존 시험 생성-응시-리뷰가 그대로 동작한다.
2. 5번 문항에 선택 하위 질문 1개를 추가하고 저장 후 편집 모드에서 유지된다.
3. 7번 문항에 필수 하위 질문 1개를 추가하면 OMR 카드에 `하위 1`, `필수`가 표시된다.
4. 학생이 7번 객관식만 답하고 필수 하위 질문을 비우면 수동 제출이 차단된다.
5. 타이머 자동 제출에서는 필수 하위 질문이 비어 있어도 attempt가 저장된다.
6. 하위 질문이 있어도 객관식 점수와 `QuestionResult` 개수는 기존과 동일하다.
7. solve payload에는 정답, 해설, `answerGuide`가 없다.
8. 재시험 scope가 7번만이면 7번의 하위 질문만 노출된다.
9. 기존 attempt에는 `subQuestionAnswers`가 없어도 교사/학생 리뷰가 깨지지 않는다.
10. 모바일에서 textarea가 제출 버튼이나 OMR 카드와 겹치지 않는다.

## 16. 열어둘 결정

아래는 MVP 구현 중 결정할 수 있다.

- Free 플랜에서 하위 질문 섹션을 완전히 숨길지, 잠금 상태로 보여줄지
- `answerGuide`를 review payload에서 교사에게만 유지할지
- 하위 질문 응답을 CSV에 MVP에서 바로 포함할지
- 입력 중 draft 저장을 즉시 저장, blur 저장, debounce 저장 중 무엇으로 할지

현재 권장값:

- Free는 잠금 상태로 보여준다.
- `answerGuide`는 solve/review 학생 payload에서 제거한다.
- CSV는 리뷰 화면 안정화 후 추가한다.
- textarea 입력은 500ms debounce 저장으로 구현한다.
