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
    /** Problem PDF stored as a data URL while the app is localStorage-backed. */
    pdfData?: string;
    /** Optional answer key PDF stored as a data URL. */
    answerKeyPdf?: string;
    // Distribution
    accessConfig?: {
        type: 'public' | 'group';
        groupIds?: string[];
        pin?: string;
    };
}

/** Per-page serialized canvas stroke paths drawn on the PDF. */
export type PdfDrawings = Record<number, string[]>;

export interface Attempt {
    id: string; // specific attempt ID
    examId: string;
    examTitle: string;
    studentName: string; // "Student" for anonymous
    /** Stable student identifier — preferred over studentName for joins. */
    studentId?: string;
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    answers: Record<number, number>; // qId -> selected option
    /** Student handwriting captured from the PDF drawing layer. */
    drawings?: PdfDrawings;
    status: 'completed' | 'in_progress';
    guestId?: string; // For tracking guest attempts
    /** If true, submitted because the timer hit zero. */
    autoSubmitted?: boolean;
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
