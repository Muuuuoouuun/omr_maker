export interface Question {
    id: number;
    number: number;
    label?: string;
    score?: number;
    answer?: number;
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
    // Feature 3: Distribution
    accessConfig?: {
        type: 'public' | 'group';
        groupIds?: string[];
        pin?: string;
    };
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
    status: 'completed' | 'in_progress';
    guestId?: string; // For tracking guest attempts
}

export interface Group {
    id: string;
    name: string;
    studentCount: number;
    createdAt: string;
}
