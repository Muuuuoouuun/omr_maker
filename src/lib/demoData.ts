import type { Attempt, Exam, Question } from "@/types/omr";

const DAY_MS = 86_400_000;

const DEMO_CLASSES = [
    { id: "class-a", name: "A반" },
    { id: "class-b", name: "B반" },
    { id: "class-c", name: "C반" },
] as const;

export function shouldUseDemoData(nodeEnv = process.env.NODE_ENV): boolean {
    return nodeEnv !== "production";
}

function englishQuestion(index: number): Question {
    const number = index + 1;
    const label = index < 5 ? "문법" : index < 10 ? "독해" : "어휘";
    const concept = index < 5 ? "시제/문장 구조" : index < 10 ? "빈칸 추론" : "문맥 어휘";
    return {
        id: number,
        number,
        label,
        score: 5,
        answer: 1,
        tags: {
            subject: "영어",
            unit: label,
            concept,
            skill: index < 10 ? "지문 판단" : "어휘 추론",
            difficulty: index % 7 === 0 ? "hard" : "medium",
            mistakeTypes: index < 10 ? ["근거 미확인"] : ["어휘 혼동"],
        },
    };
}

function mathQuestion(index: number): Question {
    const number = index + 1;
    const label = index < 5 ? "계산" : index < 10 ? "이해" : "응용";
    const concept = index < 5 ? "식의 계산" : index < 10 ? "함수 이해" : "활용 문제";
    return {
        id: number,
        number,
        label,
        score: 6.66,
        answer: 1,
        tags: {
            subject: "수학",
            unit: label,
            concept,
            skill: index < 5 ? "계산 정확도" : "조건 해석",
            difficulty: index >= 10 ? "hard" : "medium",
            mistakeTypes: index >= 10 ? ["조건 누락"] : ["계산 실수"],
        },
    };
}

function demoAnswerIsCorrect(studentIndex: number, questionIndex: number, examId: string, classIndex: number): boolean {
    const seed = studentIndex * 17 + questionIndex * 13 + examId.length + classIndex * 11;
    const classPenalty = classIndex === 0 ? 0 : classIndex === 1 ? 1 : 2;
    const topicPenalty = questionIndex >= 5 && questionIndex < 10 ? classIndex : questionIndex >= 10 ? 2 - classIndex : 0;
    return (seed + classPenalty + topicPenalty) % 10 >= 3 + classPenalty;
}

export function buildDemoDashboardData(now = Date.now()): { exams: Exam[]; attempts: Attempt[] } {
    const exams: Exam[] = [
        {
            id: "mock-1",
            title: "[예시] Midterm English Test",
            createdAt: new Date(now - DAY_MS * 2).toISOString(),
            questions: Array.from({ length: 20 }, (_, index) => englishQuestion(index)),
        },
        {
            id: "mock-2",
            title: "[예시] Chapter 4 Mathematics",
            createdAt: new Date(now - DAY_MS * 5).toISOString(),
            questions: Array.from({ length: 15 }, (_, index) => mathQuestion(index)),
        },
    ];

    const attempts = exams.flatMap(exam => {
        const totalScore = exam.questions.reduce((sum, question) => sum + (question.score || 0), 0);

        return Array.from({ length: 27 }, (_, index): Attempt => {
            const classInfo = DEMO_CLASSES[index % DEMO_CLASSES.length];
            const classIndex = index % DEMO_CLASSES.length;
            const studentNumber = Math.floor(index / DEMO_CLASSES.length) + 1;
            const answers: Record<number, number> = {};
            const score = exam.questions.reduce((sum, question, questionIndex) => {
                const isCorrect = demoAnswerIsCorrect(index, questionIndex, exam.id, classIndex);
                const correctAnswer = question.answer || 1;
                answers[question.id] = isCorrect ? correctAnswer : correctAnswer === 1 ? 2 : 1;
                return sum + (isCorrect ? (question.score || 0) : 0);
            }, 0);

            return {
                id: `mock-attempt-${exam.id}-${index}`,
                examId: exam.id,
                examTitle: exam.title,
                studentName: `${classInfo.name} 학생 ${studentNumber}`,
                studentId: `${classInfo.id}::student-${studentNumber}`,
                groupId: classInfo.id,
                groupName: classInfo.name,
                identityType: "temporary",
                startedAt: new Date(now - DAY_MS).toISOString(),
                finishedAt: new Date(now - DAY_MS + index * 1000).toISOString(),
                score,
                totalScore,
                status: "completed",
                answers,
            };
        });
    });

    return { exams, attempts };
}
