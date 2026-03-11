export interface Question {
    id: number;
    number: number;
    label?: string;
    score?: number;
    answer?: number; // object answer (1-5)
    type?: 'objective' | 'subjective'; // Problem type (default is objective)
    stringAnswer?: string; // Correct answer for subjective problem
    askReason?: boolean; // Dual question flag for objective problems
    reasonStringAnswer?: string; // Model subjective answer for dual questions
    pdfLocation?: {
        page: number;
        x: number;
        y: number;
        w?: number;
        h?: number;
    };
    pdfChoices?: {
        [choiceNum: number]: {
            page: number;
            x: number;
            y: number;
            w: number;
            h: number;
        };
    };
}

export interface Exam {
    id: string; // generated ID
    title: string;
    questions: Question[];
    createdAt: string;
    // Feature 3: Distribution
    accessConfig?: {
        type: 'public' | 'group';
        groupIds?: string[];
        pin?: string;
        timeLimit?: number;
    };
    isSmartPdf?: boolean;
}

export interface Attempt {
    id: string; // specific attempt ID
    examId: string;
    examTitle: string;
    studentName: string; // "Student" for anonymous
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    answers: Record<number, number>; // qId -> selected option
    stringAnswers?: Record<number, string>; // subjective answers by student (qId -> string answer)
    subjectiveScores?: Record<number, number>; // points awarded for subjective answers
    status: 'completed' | 'in_progress' | 'grading'; // 'grading' means subjective questions are pending grading
    guestId?: string; // For tracking guest attempts
    drawings?: Record<number, string[]>; // user's handwritten notes
}

export interface Group {
    id: string;
    name: string;
    studentCount: number;
    createdAt: string;
}

export interface Student {
    id: string;
    name: string;
    phone: string;
    groupId?: string;
    createdAt: string;
}
