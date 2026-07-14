# Premium Feedback And Markup Design

작성일: 2026-06-26

## 목표

Pro/Academy 사용 교사가 학생이 제출한 시험지 원본과 풀이 필기를 저장해 다시 열어보고, 교사 첨삭/마크업/요약 피드백을 작성한 뒤 학생에게 반환할 수 있게 한다.

이 기능은 기존 Pro 가치인 "제출 후 필기 보관"을 "수업 후 피드백 전달"까지 확장한다. 학생 풀이 중에는 업그레이드 압박을 보이지 않고, 교사 화면에서만 프리미엄 가치와 제한을 드러낸다.

## 현재 구조 요약

- 학생 풀이 화면은 `PDFViewer`의 펜/형광펜/지우개 도구를 사용해 PDF 위에 필기를 남긴다.
- 제출 시 `Attempt.drawings`, `drawingsRef`, `handwriting` 메타데이터가 만들어진다.
- Pro/Academy 플랜일 때만 필기 원본을 IndexedDB에 저장하고, Free에서는 답안/점수 중심으로 남긴다.
- 교사 상세 화면 `/teacher/attempt/[attemptId]`는 저장된 학생 필기를 읽기 전용으로 복원해 보여준다.
- 학생 리뷰 화면 `/student/review/[attemptId]`도 저장된 학생 필기를 읽기 전용으로 보여준다.
- Supabase 스키마에는 `omr_attempts`, `omr_assignment_submissions`, `omr_comments`가 있어 피드백 모델의 기반은 있다.

가장 큰 갭은 저장 위치다. 현재 무거운 필기 stroke 본문은 IndexedDB에 저장되고 Supabase attempt payload에는 `drawingsRef`만 남는다. 이 참조는 같은 브라우저 안에서는 유효하지만, 학생 기기에서 제출한 필기를 교사 기기에서 열기에는 부족하다. 프리미엄 첨삭 기능은 원격 asset 저장소가 먼저 필요하다.

## 제품 범위

### 포함

- 학생 제출 시험지 원본 PDF와 학생 필기 레이어 저장
- 교사용 제출 상세 화면에서 학생 필기 읽기
- 교사가 별도 첨삭 레이어에 펜/형광펜/지우개로 마크업 작성
- 교사 텍스트 피드백 작성
- 문항별 짧은 코멘트 작성
- 피드백 상태 관리: 미검토, 검토중, 반환완료
- 피드백 반환 시 학생에게 앱 내 알림 생성
- 교사용 화면에서 학생 열람 여부, 최초 열람 시각, 마지막 열람 시각 표시
- 반환 파일/PDF 리포트 다운로드 허용 여부와 만료일 설정
- 학생 리뷰 화면에서 반환된 첨삭/텍스트 피드백 확인
- Pro 이상 기능 게이트

### 제외

- 실시간 공동 편집
- 영상/음성 피드백
- AI 자동 첨삭
- 교사별 rubrics/성취기준 채점표
- 학부모 전달 채널
- 외부 푸시/문자/카카오 실발송 자동화
- 법적 보관/파기 자동화 전체 구현

## 사용자 흐름

### 학생

1. 학생이 시험지 PDF 위에 필기하며 문제를 푼다.
2. 제출한다.
3. 제출 완료 화면에서는 점수와 기본 리뷰로 이동한다.
4. 교사가 피드백을 반환하면 학생 대시보드/리뷰 화면에 "교사 피드백 도착" 상태가 보인다.
5. 학생이 알림을 열거나 리뷰 화면에 진입하면 열람 상태가 기록된다.
6. 학생은 리뷰 화면에서 원래 풀이 필기와 교사 첨삭 레이어를 함께 본다.
7. 다운로드가 허용된 경우에만 반환 PDF 또는 첨삭 리포트를 내려받을 수 있다.
8. 학생은 텍스트 피드백과 문항별 코멘트를 확인하고, 필요하면 오답 재시험 링크로 이동한다.

### 교사

1. 교사가 시험 결과 또는 학생 프로필에서 제출 상세를 연다.
2. 학생 원본 필기와 자동 채점 결과를 확인한다.
3. "첨삭 시작"을 누르면 교사 첨삭 레이어가 활성화된다.
4. 교사는 PDF 위에 마크업하고, 전체 피드백과 문항별 코멘트를 작성한다.
5. "저장"은 교사에게만 보이는 초안으로 남긴다.
6. 교사는 반환 전 "학생 다운로드 허용"과 다운로드 만료일을 설정한다.
7. "학생에게 반환"을 누르면 학생 리뷰 화면에서 피드백이 공개되고 학생 알림이 생성된다.
8. 반환 이후 교사는 학생이 열람했는지, 언제 처음 열었는지, 마지막으로 언제 봤는지 확인한다.
9. 반환 이후에도 교사는 새 revision을 만들어 수정할 수 있다.

## 데이터 모델

### 새 타입

```ts
export type FeedbackStatus = "draft" | "returned" | "archived";
export type FeedbackNotificationStatus = "not_queued" | "queued" | "sent" | "failed";

export interface AttemptFeedback {
    id: string;
    attemptId: string;
    examId: string;
    organizationId: string;
    studentProfileId?: string;
    teacherUserId?: string;
    status: FeedbackStatus;
    summary?: string;
    questionComments: QuestionFeedbackComment[];
    markup?: FeedbackMarkup;
    downloadPolicy: FeedbackDownloadPolicy;
    delivery?: FeedbackDeliveryReceipt;
    returnedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface QuestionFeedbackComment {
    id: string;
    questionId: number;
    questionNumber: number;
    body: string;
    visibility: "teacher_only" | "student_visible";
}

export interface FeedbackMarkup {
    schemaVersion: 1;
    strokesRef?: StoredDataRef;
    pageCount: number;
    strokeCount: number;
    storage: "indexeddb" | "supabase_storage";
}

export interface FeedbackDownloadPolicy {
    allowStudentDownload: boolean;
    allowAnnotatedPdfDownload: boolean;
    expiresAt?: string;
    watermarkStudentName?: boolean;
}

export interface FeedbackDeliveryReceipt {
    notificationStatus: FeedbackNotificationStatus;
    notificationChannel: "in_app" | "kakao_candidate";
    notifiedAt?: string;
    firstOpenedAt?: string;
    lastOpenedAt?: string;
    openCount: number;
}
```

### Supabase 테이블

기존 `omr_comments`는 일반 코멘트에는 좋지만, PDF 마크업 revision과 반환 상태를 표현하기에는 부족하다. `omr_comments`는 문항/시도별 텍스트 코멘트로 유지하고, 첨삭 패키지는 별도 테이블로 두는 편이 명확하다.

```sql
create table if not exists public.omr_attempt_feedback (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    attempt_id text not null references public.omr_attempts(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    student_profile_id text references public.omr_student_profiles(id) on delete set null,
    teacher_user_id text,
    status text not null default 'draft'
        check (status in ('draft', 'returned', 'archived')),
    summary text,
    allow_student_download boolean not null default false,
    allow_annotated_pdf_download boolean not null default false,
    download_expires_at timestamptz,
    watermark_student_name boolean not null default true,
    notification_status text not null default 'not_queued'
        check (notification_status in ('not_queued', 'queued', 'sent', 'failed')),
    notification_channel text not null default 'in_app'
        check (notification_channel in ('in_app', 'kakao_candidate')),
    notified_at timestamptz,
    first_opened_at timestamptz,
    last_opened_at timestamptz,
    open_count integer not null default 0 check (open_count >= 0),
    markup_bucket text,
    markup_path text,
    markup_size integer,
    markup_stroke_count integer not null default 0,
    markup_page_count integer not null default 0,
    revision integer not null default 1,
    returned_at timestamptz,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (attempt_id, revision)
);

create index if not exists omr_attempt_feedback_attempt_idx
    on public.omr_attempt_feedback (attempt_id, status, updated_at desc);

create index if not exists omr_attempt_feedback_student_idx
    on public.omr_attempt_feedback (student_profile_id, returned_at desc);

create index if not exists omr_attempt_feedback_unread_student_idx
    on public.omr_attempt_feedback (student_profile_id, status, first_opened_at, returned_at desc);
```

텍스트 문항 코멘트는 두 가지 중 하나로 간다.

- MVP: `omr_attempt_feedback.payload.questionComments`에 저장
- 확장: `omr_comments`에 `entity_type = 'question'`, `entity_id = '${attemptId}:${questionId}'`, `visibility = 'student_visible'`로 저장

MVP는 payload가 빠르고, 확장은 검색/알림/이력에 유리하다. 초기 구현은 payload로 시작하고, 반환된 코멘트를 검색하거나 알림으로 묶어야 할 때 `omr_comments`로 승격한다.

### 알림과 열람 상태

피드백 알림은 별도 복잡한 메시징 시스템보다 `omr_attempt_feedback` row의 delivery 필드에서 시작한다.

- `notification_status = 'queued'`: 반환은 완료됐고 앱 내 알림 표시 대상이다.
- `notification_status = 'sent'`: 학생 대시보드/알림 목록에 노출된 상태다.
- `first_opened_at`: 학생이 처음 리뷰 화면을 열거나 알림을 클릭한 시각이다.
- `last_opened_at`: 가장 최근 열람 시각이다.
- `open_count`: 리뷰 화면 진입 횟수다.

외부 알림은 1차 MVP에 넣지 않는다. 3단계에서 기존 `omr_kakao_candidate_reviews`와 연결해 "피드백 도착 안내" 후보를 만들고, 교사 승인 후 Kakao 발송 로그로 남기는 방식이 적합하다.

### 다운로드 정책

반환 피드백은 기본적으로 화면 열람을 우선한다. 파일 다운로드는 교사가 명시적으로 허용한 경우에만 가능하게 한다.

- `allow_student_download`: 학생이 첨삭 원본/자료를 내려받을 수 있는지 여부
- `allow_annotated_pdf_download`: 학생 필기와 교사 첨삭이 합쳐진 PDF 리포트 다운로드 여부
- `download_expires_at`: 다운로드 가능 만료일
- `watermark_student_name`: 다운로드 PDF에 학생 이름/시험명/반환일 워터마크를 넣을지 여부

다운로드 링크는 정적 공개 URL이 아니라 서버 액션 또는 signed URL로 발급한다. 학생 권한, 반환 상태, 만료일, 다운로드 허용 여부를 확인한 뒤 짧은 만료 시간을 가진 URL을 내려주는 방식이 안전하다.

## 원격 Asset 저장

### 저장해야 하는 것

- 학생 풀이 필기: `attempts/{organizationId}/{attemptId}/student-strokes.v1.json`
- 교사 첨삭 필기: `feedback/{organizationId}/{attemptId}/{feedbackId}/teacher-markup.v1.json`
- 향후 PDF 스냅샷: `feedback/{organizationId}/{attemptId}/{feedbackId}/returned-report.pdf`

### 우선순위

1. 기존 IndexedDB 저장은 오프라인/로컬 fallback으로 유지한다.
2. Supabase가 설정되고 Pro/Academy 권한이 있으면 Storage 업로드를 시도한다.
3. 업로드 성공 시 attempt/feedback payload에는 `storage = "supabase_storage"`, bucket/path/size/checksum을 저장한다.
4. 업로드 실패 시 교사에게 "로컬에는 저장됐지만 다른 기기에서는 열 수 없음"을 보여준다.

## 권한과 플랜

### Entitlement

`src/utils/plans.ts`에 다음 entitlement를 추가하는 것을 권장한다.

- `feedbackMarkup`
- `returnedFeedback`
- `remoteHandwritingArchive`

초기에는 `handwritingArchive`에 묶어도 되지만, 가격 정책상 메시지가 더 선명해지려면 분리하는 편이 좋다.

### 접근 규칙

- Free: 자동 채점 결과와 기본 리뷰만 가능. 제출 필기 장기 보관/교사 첨삭 반환은 잠김.
- Pro: 단일 교사 또는 소규모 학원 기준으로 모든 첨삭/반환 기능 가능.
- Academy: Pro 기능 + 교사별 작성자, 감사 로그, 보관 기간, 역할별 권한.

### RLS 방향

- 교사는 같은 organization의 attempt/feedback을 읽고 쓸 수 있다.
- 학생은 본인의 attempt와 `status = 'returned'`인 feedback만 읽을 수 있다.
- 학생은 teacher markup이나 returned feedback을 수정할 수 없다.
- draft feedback은 학생에게 절대 노출되지 않는다.
- 학생 열람 처리는 제한된 server action/RPC로만 허용한다. 학생 클라이언트가 임의로 `status`, `summary`, `markup_path`, 다운로드 정책을 바꾸면 안 된다.
- 다운로드는 `status = 'returned'`, 학생 본인, 다운로드 허용, 만료 전 조건을 모두 통과해야 한다.

## API/서비스 설계

### 클라이언트 서비스

새 파일 후보:

- `src/lib/feedbackPersistence.ts`
- `src/lib/feedbackPersistence.test.ts`

주요 함수:

```ts
loadAttemptFeedback(attemptId: string): Promise<AttemptFeedback | null>
saveAttemptFeedbackDraft(feedback: AttemptFeedback, markup?: PdfDrawings): Promise<PersistenceResult>
returnAttemptFeedback(feedbackId: string): Promise<PersistenceResult>
loadReturnedAttemptFeedback(attemptId: string): Promise<AttemptFeedback | null>
markFeedbackOpened(feedbackId: string): Promise<PersistenceResult>
updateFeedbackDownloadPolicy(feedbackId: string, policy: FeedbackDownloadPolicy): Promise<PersistenceResult>
createReturnedFeedbackDownloadUrl(feedbackId: string): Promise<{ url?: string; error?: string }>
```

### 저장 순서

1. 교사 첨삭 strokes를 IndexedDB에 저장한다.
2. Supabase Storage 업로드를 시도한다.
3. `omr_attempt_feedback` row를 upsert한다.
4. 반환 시 `status = 'returned'`, `returned_at = now()`, `notification_status = 'queued'`로 갱신한다.
5. 학생 대시보드/알림 목록은 queued returned feedback을 "새 피드백"으로 표시한다.
6. 학생 리뷰 화면에서는 returned feedback만 가져온다.
7. 학생이 알림 또는 리뷰 화면을 열면 `markFeedbackOpened`가 최초/최근 열람 시각과 open count를 갱신한다.
8. 다운로드 요청 시 `createReturnedFeedbackDownloadUrl`이 권한/정책/만료일을 검사한다.

## UI 설계

### 교사 제출 상세

현재 `/teacher/attempt/[attemptId]`의 오른쪽 PDF 영역을 확장한다.

- 상단 segmented control: `학생 풀이`, `교사 첨삭`, `함께 보기`
- 첨삭 모드에서만 PDFViewer 편집 도구 활성화
- 학생 필기 레이어는 항상 읽기 전용
- 교사 첨삭 레이어는 별도 `teacherMarkupDrawings` state로 관리
- 오른쪽 또는 하단 패널:
  - 전체 피드백 textarea
  - 문항별 코멘트 리스트
  - 학생 다운로드 허용 toggle
  - 첨삭 PDF 다운로드 허용 toggle
  - 다운로드 만료일 date/time input
  - 저장 버튼
  - 학생에게 반환 버튼
  - 상태 badge: 초안/반환됨/알림대기/열람전/열람완료
- 반환 이후 상태 영역:
  - 알림 생성 여부
  - 학생 최초 열람 시각
  - 마지막 열람 시각
  - 열람 횟수

PDFViewer는 현재 단일 `drawings` 레이어만 받는다. 마크업 기능에는 아래 중 하나가 필요하다.

- 단기: 학생 필기와 교사 첨삭을 렌더링 전에 병합해서 표시하고, 편집 모드에서는 교사 레이어만 수정
- 안정형: `PDFViewer`에 `readOnlyDrawings`와 `editableDrawings`를 분리하는 props 추가

권장 props:

```ts
readOnlyDrawingLayers?: Array<{ id: string; drawings: PdfDrawings; opacity?: number }>;
editableDrawings?: PdfDrawings;
onEditableDrawingsChange?: (page: number, newPaths: string[]) => void;
```

### 학생 리뷰

현재 `/student/review/[attemptId]`의 저장 필기 섹션을 확장한다.

- 반환된 피드백이 있으면 상단에 "교사 피드백" 요약 카드 표시
- 새 피드백이면 학생 대시보드와 알림 영역에 unread badge 표시
- 리뷰 화면 진입 시 열람 처리
- PDF 영역에서 학생 풀이 + 교사 첨삭을 함께 표시
- 문항별 코멘트는 오답 문항 리스트 아래에 붙인다.
- 다운로드 허용 시 버튼 표시, 불가능하면 버튼 자체를 숨기거나 "교사가 다운로드를 허용하지 않았습니다"로 비활성 표시
- draft 또는 teacher_only 코멘트는 숨긴다.

## 구현 단계

### 1단계: 로컬 MVP

- `AttemptFeedback` 타입 추가
- feedback draft를 localStorage/IndexedDB에 저장
- 교사 attempt 화면에서 첨삭 레이어와 요약 피드백 작성
- 학생 review 화면에서 returned 상태만 표시
- 같은 브라우저 기준 앱 내 unread badge와 열람 처리 구현
- 다운로드 허용 여부를 로컬 정책으로 저장하고 학생 화면 버튼 노출 제어
- Pro 이상 gate 적용

성공 기준:

- 같은 브라우저에서 교사가 첨삭하고 학생 리뷰 화면에서 확인할 수 있다.
- 학생 필기와 교사 첨삭이 서로 덮어쓰지 않는다.
- Free 플랜은 교사 화면에서 업그레이드 안내만 보인다.
- 학생이 리뷰 화면을 열면 교사 화면에 열람됨으로 바뀐다.
- 다운로드 비허용 피드백은 학생에게 다운로드 버튼이 보이지 않는다.

### 2단계: 원격 저장 MVP

- Supabase Storage 업로드/다운로드 helper 추가
- 학생 제출 필기를 원격 asset으로 저장
- 교사 첨삭도 원격 asset으로 저장
- `omr_attempt_feedback` 테이블과 계약 테스트 추가
- RLS 초안/반환 가시성 정책 추가
- 열람 처리 server action/RPC 추가
- 다운로드 signed URL 발급 server action 추가

성공 기준:

- 학생 기기에서 제출한 필기를 교사 기기에서 볼 수 있다.
- 교사 기기에서 반환한 첨삭을 학생 기기에서 볼 수 있다.
- Storage 업로드 실패 시 사용자에게 범위가 명확한 경고가 표시된다.
- 학생 열람 상태가 다른 교사 기기에서도 동기화된다.
- 다운로드 정책이 서버에서 강제된다.

### 3단계: 수업 운영 기능

- 학생/시험/반별 "피드백 미반환" 필터
- 학생/시험/반별 "피드백 미열람" 필터
- 반환 완료 알림 후보 생성
- 피드백 도착 Kakao 후보 생성 및 승인 후 발송 로그 연결
- PDF 리포트 export에 교사 첨삭 포함
- 다운로드 이력과 만료 정책
- feedback revision 이력
- Academy 감사 로그와 보관 정책 연결

## 테스트 계획

- `feedbackPersistence.test.ts`: local/remote row mapping, draft/returned 상태, payload sanitize
- `feedbackDelivery.test.ts`: notification status, first/last opened, open count, unread 필터
- `feedbackDownloadPolicy.test.ts`: 허용/비허용/만료/학생 권한별 다운로드 판단
- `supabaseSchemaContract.test.ts`: `omr_attempt_feedback` 테이블, 인덱스, RLS 문자열 확인
- `PDFViewer` 테스트 또는 UI surface 테스트: 읽기 전용 레이어와 편집 레이어가 분리되는지 확인
- Playwright:
  - Pro 교사: 제출 상세 열기, 첨삭 저장, 반환
  - 학생: 알림 확인, 반환된 피드백 열람, 열람 상태 반영
  - 학생: 다운로드 허용/비허용 상태 확인
  - Free 교사: 첨삭 버튼 대신 upgrade prompt 확인
- 회귀:
  - 기존 학생 풀이 필기 저장
  - 기존 학생 리뷰 화면
  - 시험 삭제 시 관련 IndexedDB/Storage ref 정리

## 출시 메시지

Pro 기능명:

"교사 첨삭 피드백"

짧은 설명:

"학생이 제출한 시험지 필기를 보관하고, PDF 위에 직접 첨삭해 다시 돌려보낼 수 있습니다."

업그레이드 프롬프트 위치:

- 교사 제출 상세에서 "첨삭 시작" 클릭 시
- 학생 필기 보관이 없는 Free 제출을 교사가 열었을 때
- PDF 리포트에 첨삭 포함을 선택했을 때
- 학생 다운로드 허용 또는 열람 추적을 켰을 때

학생 화면에는 업그레이드 메시지를 노출하지 않는다.

## 주요 리스크

- IndexedDB 참조만으로는 다른 기기에서 필기 원본을 볼 수 없다.
- 학생 개인정보와 필기 데이터가 포함되므로 production RLS와 Auth 전환 전에는 실제 학생 데이터 저장을 피해야 한다.
- PDFViewer가 단일 drawing layer 전제라 레이어 분리 없이 구현하면 학생 필기와 교사 첨삭이 섞일 수 있다.
- Supabase Storage quota와 retention 정책을 플랜 제한과 연결해야 한다.
- 오프라인 PWA 상태에서 저장한 교사 첨삭의 동기화 실패 처리가 필요하다.
- 열람 추적은 학생이 실제 내용을 이해했다는 뜻이 아니라 화면을 열었다는 신호일 뿐이다. UI 문구도 "열람"으로 제한한다.
- 다운로드 비허용은 앱 UI와 signed URL 발급을 막는 정책이지, 화면 캡처까지 막는 보안 기능은 아니다.

## 권장 우선순위

1. `PDFViewer` 레이어 분리
2. `AttemptFeedback` 타입과 로컬 MVP
3. 교사 attempt 화면의 첨삭/반환 UI
4. 알림/unread badge와 열람 상태 기록
5. 학생 review 화면의 returned feedback 표시
6. 다운로드 정책과 signed URL 발급
7. Supabase Storage 기반 원격 필기/첨삭 저장
8. RLS/Auth/보관 정책 강화
