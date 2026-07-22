export const DEFAULT_CHOICE_COUNT = 5;

export interface StoredDataRef {
    store: 'indexeddb' | 'remote';
    key: string;
    organizationId?: string;
    kind?: 'problem_pdf' | 'answer_key_pdf' | 'attempt_handwriting';
    examId?: string;
    attemptId?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    updatedAt?: string;
}

export interface QuestionPdfRegion {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export type QuestionSubQuestionKind = 'free_text';
export type QuestionSubQuestionTemplateId = 'choice_reason' | 'evidence' | 'solution_process' | 'context_detail' | 'custom';

/** Teacher-authored prompt attached to a parent OMR question. It never affects scoring. */
export interface QuestionSubQuestion {
    schemaVersion: 1;
    /** Stable inside the parent question and used as the persisted answer key. */
    id: string;
    prompt: string;
    kind: QuestionSubQuestionKind;
    templateId?: QuestionSubQuestionTemplateId;
    /** Optional by default. Manual submission is blocked only when explicitly true. */
    required?: boolean;
    maxLength?: number;
    /** Teacher-only guide. Student solve/review payload projections must remove it. */
    answerGuide?: string;
    /** Teacher-only authoring note, separate from the student-facing prompt. */
    teacherNote?: string;
}

export type SubQuestionReviewStatus = 'needs_review' | 'reviewed';

export interface SubQuestionAnswer {
    schemaVersion: 1;
    body: string;
    answeredAt?: string;
    reviewStatus: SubQuestionReviewStatus;
    reviewedAt?: string;
    reviewedBy?: string;
}

export type SubQuestionAnswers = Record<number, Record<string, SubQuestionAnswer>>;

export interface MissingRequiredSubQuestion {
    questionId: number;
    subQuestionId: string;
}

export interface Question {
    id: number;
    number: number;
    label?: string;
    score?: number;
    answer?: number;
    /** Number of choices (4 or 5). Default 5 when undefined. */
    choices?: 4 | 5;
    /** Optional teacher-authored explanation shown in review. */
    explanation?: string;
    /** Optional advanced design metadata for teacher diagnostics. */
    tags?: {
        subject?: string;
        unit?: string;
        concept?: string;
        skill?: string;
        difficulty?: 'easy' | 'medium' | 'hard' | 'killer';
        cognitiveLevel?: 'recall' | 'understanding' | 'application' | 'reasoning';
        source?: string;
        expectedTimeSec?: number;
        mistakeTypes?: string[];
        prerequisites?: string[];
    };
    pdfLocation?: {
        page: number;
        x: number;
        y: number;
    };
    /** Optional precise crop box for premium question-level review/DB. */
    pdfRegion?: QuestionPdfRegion;
    /** Shared reading-passage regions used by every question in the detected range. */
    passagePdfRegions?: QuestionPdfRegion[];
    /** Optional cropped question image asset for future premium question-bank storage. */
    imageAssetRef?: StoredDataRef;
    /** Optional thought-process prompts. Maximum two; normalized on persistence. */
    subQuestions?: QuestionSubQuestion[];
}

export function normalizeChoiceCount(value: unknown, fallback: 4 | 5 = DEFAULT_CHOICE_COUNT): 4 | 5 {
    if (value === 4 || value === 5) return value;
    return fallback;
}

export function questionChoiceCount(question: Pick<Question, "choices">, fallback: 4 | 5 = DEFAULT_CHOICE_COUNT): 4 | 5 {
    return normalizeChoiceCount(question.choices, fallback);
}

export interface Exam {
    id: string; // generated ID
    title: string;
    /** App workspace/organization scope for remote persistence. */
    organizationId?: string;
    /** Optional class scope when an exam belongs to one class. */
    classId?: string;
    /** App-managed teacher user id until Supabase Auth owns user ids. */
    createdByUserId?: string;
    questions: Question[];
    createdAt: string;
    updatedAt?: string;
    /** Duration in minutes. Default 50 when undefined. */
    durationMin?: number;
    /** ISO timestamps for when exam is accessible. */
    startAt?: string;
    endAt?: string;
    /** Soft-archived exams don't show in student dashboards. */
    archived?: boolean;
    /** Legacy inline problem PDF data URL. New saves prefer pdfDataRef. */
    pdfData?: string;
    /** Problem PDF stored outside localStorage to avoid quota pressure. */
    pdfDataRef?: StoredDataRef;
    /** Legacy inline answer key PDF data URL. New saves prefer answerKeyPdfRef. */
    answerKeyPdf?: string;
    /** Optional answer key PDF stored outside localStorage to avoid quota pressure. */
    answerKeyPdfRef?: StoredDataRef;
    // Distribution
    accessConfig?: {
        type: 'public' | 'group';
        groupIds?: string[];
        pin?: string;
    };
}

/** Per-page serialized canvas stroke paths drawn on the PDF. */
export type PdfDrawings = Record<number, string[]>;

export type IdentityType = 'guest' | 'temporary' | 'registered';
export type PlanKey = 'free' | 'pro' | 'academy';
export type StoredPlanKey = PlanKey | 'school';
export type FeedbackStatus = 'draft' | 'returned' | 'archived';
export type FeedbackNotificationStatus = 'not_queued' | 'queued' | 'sent' | 'failed';
export type FeedbackNotificationChannel = 'in_app' | 'kakao_candidate';

export interface FeedbackDownloadPolicy {
    allowStudentDownload: boolean;
    allowAnnotatedPdfDownload: boolean;
    expiresAt?: string;
    watermarkStudentName?: boolean;
}

export interface FeedbackDeliveryReceipt {
    notificationStatus: FeedbackNotificationStatus;
    notificationChannel: FeedbackNotificationChannel;
    notifiedAt?: string;
    firstOpenedAt?: string;
    lastOpenedAt?: string;
    openCount: number;
}

export interface QuestionFeedbackComment {
    id: string;
    questionId: number;
    questionNumber: number;
    body: string;
    visibility: 'teacher_only' | 'student_visible';
}

export interface FeedbackMarkup {
    schemaVersion: 1;
    strokesRef?: StoredDataRef;
    pageCount: number;
    strokeCount: number;
    storage: 'indexeddb' | 'supabase_storage';
}

export interface AttemptFeedback {
    id: string;
    attemptId: string;
    examId: string;
    organizationId?: string;
    studentProfileId?: string;
    teacherUserId?: string;
    status: FeedbackStatus;
    summary?: string;
    questionComments: QuestionFeedbackComment[];
    markup?: FeedbackMarkup;
    downloadPolicy: FeedbackDownloadPolicy;
    delivery: FeedbackDeliveryReceipt;
    returnedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface QuestionDrawingSummary {
    questionId: number;
    questionNumber: number;
    page: number;
    strokeCount: number;
}

export type QuestionResultStatus = 'correct' | 'wrong' | 'unanswered' | 'ungraded';

export interface QuestionResult {
    schemaVersion: 1;
    attemptId: string;
    examId: string;
    examTitle: string;
    /** App workspace/organization scope for remote persistence. */
    organizationId?: string;
    /** Optional class scope. Falls back to groupId when absent. */
    classId?: string;
    /** Optional assignment scope for future gradebook flows. */
    assignmentId?: string;
    /** Canonical roster/student profile id. Falls back to studentId when absent. */
    studentProfileId?: string;
    studentName: string;
    studentId?: string;
    groupId?: string;
    groupName?: string;
    /** Optional operating region/campus snapshot for academy-level analytics. */
    regionId?: string;
    regionName?: string;
    identityType?: IdentityType;
    questionId: number;
    questionNumber: number;
    canonicalQuestionId?: string;
    label?: string;
    score: number;
    earnedScore: number;
    selectedAnswer?: number;
    correctAnswer?: number;
    status: QuestionResultStatus;
    isCorrect: boolean;
    isWrong: boolean;
    isUnanswered: boolean;
    subject?: string;
    unit?: string;
    concept?: string;
    skill?: string;
    source?: string;
    difficulty?: NonNullable<Question["tags"]>["difficulty"];
    cognitiveLevel?: NonNullable<Question["tags"]>["cognitiveLevel"];
    mistakeTypes?: string[];
    prerequisites?: string[];
    expectedTimeSec?: number;
    pdfPage?: number;
    pdfLocation?: Question["pdfLocation"];
    pdfRegion?: QuestionPdfRegion;
    passagePdfRegions?: QuestionPdfRegion[];
    timeSec?: number;
    visitCount?: number;
    revisitCount?: number;
    answerChangeCount?: number;
    handwritingStrokeCount?: number;
    handwritingPage?: number;
    retakeSourceAttemptId?: string;
    retakeMode?: RetakeMetadata["mode"];
    answeredAt?: string;
    finishedAt: string;
}

export type HandwritingStatus = 'none' | 'saved' | 'failed' | 'unavailable' | 'plan_required';

export interface AttemptHandwriting {
    schemaVersion: 1;
    status: HandwritingStatus;
    strokesRef?: StoredDataRef;
    plan: StoredPlanKey;
    summary: {
        pageCount: number;
        strokeCount: number;
        questionCount: number;
    };
    questions: Record<number, QuestionDrawingSummary>;
}

export interface QuestionTiming {
    questionId: number;
    questionNumber: number;
    totalTimeSec: number;
    visitCount: number;
    revisitCount: number;
    answerChangeCount: number;
    firstVisitedAt?: string;
    lastVisitedAt?: string;
    lastAnsweredAt?: string;
}

export interface FocusLossEvent {
    at: string;
    questionId?: number;
    questionNumber?: number;
    count: number;
    reason: 'blur' | 'hidden';
}

export interface RetakeMetadata {
    sourceAttemptId: string;
    questionIds: number[];
    mode: 'wrong' | 'similar' | 'custom';
    labels?: string[];
    concepts?: string[];
    createdAt: string;
}

export type StudentQuestionStatus = 'queued' | 'answered';

export interface StudentQuestionAnswer {
    body: string;
    createdAt: string;
    teacherName?: string;
}

/** A per-question free-text question the student left for the teacher on review. */
export interface StudentQuestionNote {
    questionId: number;
    questionNumber: number;
    body: string;
    createdAt: string;
    status: StudentQuestionStatus;
    answer?: StudentQuestionAnswer;
}

export interface Attempt {
    id: string; // specific attempt ID
    examId: string;
    examTitle: string;
    /** App workspace/organization scope for remote persistence. */
    organizationId?: string;
    /** Optional class scope. Falls back to groupId when absent. */
    classId?: string;
    /** Optional assignment scope for future gradebook flows. */
    assignmentId?: string;
    /** Canonical roster/student profile id. Falls back to studentId when absent. */
    studentProfileId?: string;
    studentName: string; // "Student" for anonymous
    /** Stable student identifier — preferred over studentName for joins. */
    studentId?: string;
    /** Group snapshot at submission time. */
    groupId?: string;
    groupName?: string;
    /** Optional operating region/campus snapshot at submission time. */
    regionId?: string;
    regionName?: string;
    /** Whether this attempt belongs to a guest, class-issued temporary ID, or registered account. */
    identityType?: IdentityType;
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    answers: Record<number, number>; // qId -> selected option
    /** Free-text responses keyed by parent question id, then stable sub-question id. */
    subQuestionAnswers?: SubQuestionAnswers;
    /** Required prompts left blank only when a timer auto-submitted the attempt. */
    missingRequiredSubQuestions?: MissingRequiredSubQuestion[];
    /** Student handwriting captured from the PDF drawing layer. */
    drawings?: PdfDrawings;
    /** External drawings reference in IndexedDB to bypass localStorage limits. */
    drawingsRef?: StoredDataRef;
    /** Premium handwriting archive model. Legacy attempts may only have drawings/drawingsRef. */
    handwriting?: AttemptHandwriting;
    /** True when the submitted handwriting payload was archived for later review. */
    handwritingArchived?: boolean;
    /** Plan snapshot used when deciding whether to archive handwriting. */
    handwritingPlan?: StoredPlanKey;
    /** Lightweight handwriting metrics for teacher lists and premium usage. */
    drawingPageCount?: number;
    drawingStrokeCount?: number;
    /** Per-question handwriting summary. The heavy payload remains in drawingsRef. */
    questionDrawings?: QuestionDrawingSummary[];
    /** Stable per-question result rows used for student/class/exam/type analytics. */
    questionResults?: QuestionResult[];
    status: 'completed' | 'in_progress';
    guestId?: string; // For tracking guest attempts
    /** If true, submitted because the timer hit zero. */
    autoSubmitted?: boolean;
    /** Number of times the student switched tabs or lost focus during the exam. */
    tabFociLostCount?: number;
    /** Per-question timing and revisit metrics captured while solving. */
    questionTimings?: QuestionTiming[];
    /** Timestamped focus-loss events with the active question when available. */
    focusLossEvents?: FocusLossEvent[];
    /** Present when this attempt is a premium retake over selected questions. */
    retake?: RetakeMetadata;
    /** Per-question questions the student left for the teacher during review. */
    studentQuestions?: StudentQuestionNote[];
    /** Guest provenance after a merge into a canonical student profile. */
    mergedFromGuestId?: string;
    mergedAt?: string;
}

export interface Group {
    id: string;
    name: string;
    studentCount: number;
    createdAt: string;
}

// ────────────────────────────────────────────────────────────
// Helper: compute a question's effective score weight.
// Teachers may leave `score` blank; fall back to equal split.
// ────────────────────────────────────────────────────────────
export function questionWeight(q: Question, totalQuestions: number): number {
    if (typeof q.score === 'number' && !Number.isNaN(q.score) && q.score > 0) return q.score;
    return totalQuestions > 0 ? 100 / totalQuestions : 0;
}

export function computeExamTotalScore(questions: Question[]): number {
    return questions.reduce((sum, q) => sum + questionWeight(q, questions.length), 0);
}

export function gradeAttempt(questions: Question[], answers: Record<number, number>): {
    earnedScore: number;
    totalScore: number;
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    ungradedCount: number;
} {
    let earned = 0;
    let total = 0;
    let correct = 0;
    let incorrect = 0;
    let unanswered = 0;
    let ungraded = 0;
    for (const q of questions) {
        // Teacher left the answer key blank → the question is not gradable. Exclude it
        // from the total so it never penalises the student, and never count it as wrong.
        // Mirrors resolveQuestionStatus("ungraded") in premiumAnalytics so the saved score
        // and the teacher/analytics display score agree.
        if (q.answer === undefined || q.answer === null) {
            ungraded++;
            continue;
        }
        const weight = questionWeight(q, questions.length);
        total += weight;
        const selected = answers[q.id];
        if (selected === undefined || selected === null || selected === 0) {
            unanswered++;
            continue;
        }
        if (selected === q.answer) {
            earned += weight;
            correct++;
        } else {
            incorrect++;
        }
    }
    return {
        earnedScore: Math.round(earned * 100) / 100,
        totalScore: Math.round(total * 100) / 100,
        correctCount: correct,
        incorrectCount: incorrect,
        unansweredCount: unanswered,
        ungradedCount: ungraded,
    };
}
