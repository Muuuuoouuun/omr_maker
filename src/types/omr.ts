export interface StoredDataRef {
    store: 'indexeddb';
    key: string;
    name?: string;
    mimeType?: string;
    size?: number;
    updatedAt?: string;
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
}

export interface Exam {
    id: string; // generated ID
    title: string;
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

export interface QuestionDrawingSummary {
    questionId: number;
    questionNumber: number;
    page: number;
    strokeCount: number;
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

export interface Attempt {
    id: string; // specific attempt ID
    examId: string;
    examTitle: string;
    studentName: string; // "Student" for anonymous
    /** Stable student identifier — preferred over studentName for joins. */
    studentId?: string;
    /** Group snapshot at submission time. */
    groupId?: string;
    groupName?: string;
    /** Whether this attempt belongs to a guest, class-issued temporary ID, or registered account. */
    identityType?: IdentityType;
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    answers: Record<number, number>; // qId -> selected option
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
} {
    const totalScore = computeExamTotalScore(questions);
    let earned = 0;
    let correct = 0;
    let incorrect = 0;
    let unanswered = 0;
    for (const q of questions) {
        const selected = answers[q.id];
        if (selected === undefined || selected === null || selected === 0) {
            unanswered++;
            continue;
        }
        if (q.answer !== undefined && selected === q.answer) {
            earned += questionWeight(q, questions.length);
            correct++;
        } else {
            incorrect++;
        }
    }
    return {
        earnedScore: Math.round(earned * 100) / 100,
        totalScore: Math.round(totalScore * 100) / 100,
        correctCount: correct,
        incorrectCount: incorrect,
        unansweredCount: unanswered,
    };
}
