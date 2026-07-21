import type { Attempt, Exam, Question } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { isMockupTeacherIdentity } from "@/lib/mockupAccount";
import type { TeacherSessionIdentity } from "@/lib/teacherSession";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const DEMO_CLASSES = [
    { id: "class-2-1", name: "2학년 1반", region: "본관", color: "#1769e0", avgScore: 87 },
    { id: "class-2-2", name: "2학년 2반", region: "본관", color: "#39bfa2", avgScore: 84 },
    { id: "class-2-3", name: "2학년 3반", region: "서관", color: "#ff766f", avgScore: 76 },
    { id: "class-2-4", name: "2학년 4반", region: "서관", color: "#73cbb8", avgScore: 83 },
] as const;

const STUDENT_GIVEN_NAMES = [
    "서준", "서연", "도윤", "지우", "하준", "하윤", "지호", "민서", "준서", "채원", "현우",
    "수아", "시우", "윤서", "건우", "지민", "우진", "예은", "민준", "다은", "은우",
] as const;
const STUDENT_SURNAMES = ["김", "이", "박", "최", "정", "강", "조"] as const;

interface DemoExamSpec {
    id: string;
    title: string;
    subject: string;
    daysAgo: number;
    targetRate: number;
    attendance: number;
    archived: boolean;
    units: readonly string[];
    concepts: readonly string[];
}

const DEMO_EXAM_SPECS: readonly DemoExamSpec[] = [
    {
        id: "mock-diagnostic-math",
        title: "[예시] 1차 수학 진단평가",
        subject: "수학",
        daysAgo: 118,
        targetRate: 0.76,
        attendance: 78,
        archived: true,
        units: ["식의 계산", "방정식", "함수", "도형", "확률"],
        concepts: ["다항식 계산", "연립방정식", "함수 해석", "닮음과 비례", "경우의 수"],
    },
    {
        id: "mock-english-reading-1",
        title: "[예시] 영어 독해 실전 1회",
        subject: "영어",
        daysAgo: 96,
        targetRate: 0.79,
        attendance: 80,
        archived: true,
        units: ["어휘", "문법", "빈칸 추론", "글의 순서", "요약"],
        concepts: ["문맥 어휘", "관계사", "논리적 연결", "문장 배열", "핵심 주장"],
    },
    {
        id: "mock-science-unit",
        title: "[예시] 통합과학 단원평가",
        subject: "통합과학",
        daysAgo: 73,
        targetRate: 0.80,
        attendance: 81,
        archived: true,
        units: ["물질", "에너지", "생명", "지구", "환경"],
        concepts: ["물질의 규칙성", "역학적 에너지", "생명 시스템", "지권의 변화", "생태계 평형"],
    },
    {
        id: "mock-math-midterm",
        title: "[예시] 2학기 수학 중간고사",
        subject: "수학",
        daysAgo: 51,
        targetRate: 0.82,
        attendance: 82,
        archived: true,
        units: ["다항식", "방정식과 부등식", "경우의 수", "행렬", "서술형"],
        concepts: ["인수분해", "이차부등식", "순열과 조합", "행렬 연산", "풀이 과정"],
    },
    {
        id: "mock-english-reading-3",
        title: "[예시] 영어 독해 실전 3회",
        subject: "영어",
        daysAgo: 31,
        targetRate: 0.83,
        attendance: 83,
        archived: false,
        units: ["어휘", "어법", "빈칸 추론", "장문 독해", "요약"],
        concepts: ["문맥 어휘", "수 일치", "근거 추론", "세부 정보", "주제 압축"],
    },
    {
        id: "mock-calculus-limit",
        title: "[예시] 수학 I 함수의 극한",
        subject: "수학",
        daysAgo: 14,
        targetRate: 0.87,
        attendance: 84,
        archived: false,
        units: ["수열", "급수", "함수의 극한", "함수의 연속", "서술형"],
        concepts: ["등비수열", "무한급수", "극한값 계산", "연속성 판단", "풀이 과정"],
    },
    {
        id: "mock-final-comprehensive",
        title: "[예시] 기말고사 대비 종합평가",
        subject: "수학",
        daysAgo: 3,
        targetRate: 0.90,
        attendance: 84,
        archived: false,
        units: ["수열", "함수의 극한", "미분", "적분", "서술형"],
        concepts: ["수열의 합", "극한의 성질", "접선의 방정식", "정적분 활용", "풀이 과정"],
    },
] as const;

export interface DemoDashboardData {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents: RosterStudent[];
    rosterGroups: RosterGroup[];
}

export function shouldUseDemoData(identity: Partial<TeacherSessionIdentity> | null | undefined): boolean {
    return isMockupTeacherIdentity(identity);
}

function stableUnitInterval(...values: number[]): number {
    let hash = 2166136261;
    for (const value of values) {
        hash ^= value + 0x9e3779b9 + (hash << 6) + (hash >>> 2);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0xffffffff;
}

function demoQuestion(spec: DemoExamSpec, index: number): Question {
    const unitIndex = Math.min(spec.units.length - 1, Math.floor(index / 4));
    const number = index + 1;
    const isWrittenResponse = number === 12 || unitIndex === spec.units.length - 1;
    const difficulty: NonNullable<NonNullable<Question["tags"]>["difficulty"]> = number === 20
        ? "killer"
        : isWrittenResponse || number % 7 === 0
            ? "hard"
            : number <= 4
                ? "easy"
                : "medium";

    return {
        id: number,
        number,
        label: isWrittenResponse ? "서술형" : spec.units[unitIndex],
        score: 5,
        answer: (number % 5) + 1,
        choices: 5,
        explanation: `${spec.concepts[unitIndex]}의 핵심 조건을 순서대로 확인합니다.`,
        tags: {
            subject: spec.subject,
            unit: spec.units[unitIndex],
            concept: spec.concepts[unitIndex],
            skill: isWrittenResponse ? "풀이 과정 설명" : number % 2 === 0 ? "조건 해석" : "개념 적용",
            difficulty,
            cognitiveLevel: difficulty === "easy" ? "understanding" : difficulty === "medium" ? "application" : "reasoning",
            expectedTimeSec: difficulty === "killer" ? 260 : difficulty === "hard" ? 190 : difficulty === "medium" ? 120 : 75,
            mistakeTypes: isWrittenResponse ? ["풀이 근거 누락", "조건 해석 오류"] : number % 2 === 0 ? ["계산 실수"] : ["핵심 조건 누락"],
            prerequisites: unitIndex > 0 ? [spec.concepts[unitIndex - 1]] : [],
        },
    };
}

function studentName(classIndex: number, studentIndex: number): string {
    const surname = STUDENT_SURNAMES[(studentIndex + classIndex * 2) % STUDENT_SURNAMES.length];
    const givenName = STUDENT_GIVEN_NAMES[studentIndex % STUDENT_GIVEN_NAMES.length];
    return `${surname}${givenName}`;
}

function buildRosterStudents(now: number): RosterStudent[] {
    return DEMO_CLASSES.flatMap((classInfo, classIndex) => (
        Array.from({ length: 21 }, (_, studentIndex): RosterStudent => {
            const name = studentName(classIndex, studentIndex);
            return {
                id: `${classInfo.id}::student-${studentIndex + 1}`,
                name,
                email: `student${classIndex + 1}${String(studentIndex + 1).padStart(2, "0")}@demo.omr`,
                group: classInfo.name,
                region: classInfo.region,
                avatar: name.slice(-2),
                avgScore: Math.max(61, Math.min(96, classInfo.avgScore + ((studentIndex * 7) % 13) - 6)),
                examsTaken: 5 + ((studentIndex + classIndex) % 3),
                lastActive: new Date(now - ((studentIndex % 4) + 1) * DAY_MS).toISOString(),
                trend: studentIndex % 5 === 0 ? "down" : studentIndex % 3 === 0 ? "flat" : "up",
                status: studentIndex % 8 === 0 ? "idle" : "active",
            };
        })
    ));
}

function shouldAnswerCorrectly(params: {
    spec: DemoExamSpec;
    examIndex: number;
    studentIndex: number;
    classIndex: number;
    question: Question;
    questionIndex: number;
}): boolean {
    const { spec, examIndex, studentIndex, classIndex, question, questionIndex } = params;
    const classDelta = [0.055, 0.025, -0.062, 0.012][classIndex] || 0;
    const abilityDelta = ((studentIndex % 21) - 10) * 0.006;
    const difficultyDelta = question.tags?.difficulty === "killer"
        ? -0.18
        : question.tags?.difficulty === "hard"
            ? -0.09
            : question.tags?.difficulty === "easy"
                ? 0.07
                : 0;
    const conceptDelta = question.tags?.concept === "극한값 계산" || question.tags?.concept === "극한의 성질"
        ? -0.12
        : question.number === 12
            ? -0.1
            : 0;
    const threshold = Math.max(0.24, Math.min(0.98, spec.targetRate + 0.045 + classDelta + abilityDelta + difficultyDelta + conceptDelta));
    return stableUnitInterval(examIndex + 1, studentIndex + 1, classIndex + 1, questionIndex + 1) < threshold;
}

export function buildDemoDashboardData(now = Date.now()): DemoDashboardData {
    const rosterStudents = buildRosterStudents(now);
    const rosterGroups: RosterGroup[] = DEMO_CLASSES.map(classInfo => ({
        id: classInfo.id,
        name: classInfo.name,
        region: classInfo.region,
        count: 21,
        avgScore: classInfo.avgScore,
        color: classInfo.color,
    }));

    const exams: Exam[] = DEMO_EXAM_SPECS.map(spec => {
        const createdAt = new Date(now - spec.daysAgo * DAY_MS).toISOString();
        return {
            id: spec.id,
            title: spec.title,
            createdAt,
            updatedAt: createdAt,
            archived: spec.archived,
            durationMin: 50,
            startAt: new Date(now - (spec.daysAgo - 1) * DAY_MS).toISOString(),
            endAt: spec.archived ? new Date(now - Math.max(1, spec.daysAgo - 4) * DAY_MS).toISOString() : new Date(now + 14 * DAY_MS).toISOString(),
            accessConfig: { type: "group", groupIds: DEMO_CLASSES.map(item => item.id) },
            questions: Array.from({ length: 20 }, (_, index) => demoQuestion(spec, index)),
        };
    });

    const attempts = DEMO_EXAM_SPECS.flatMap((spec, examIndex) => {
        const exam = exams[examIndex];
        const totalScore = 100;
        return rosterStudents.slice(0, spec.attendance).map((student, rosterIndex): Attempt => {
            const classIndex = Math.floor(rosterIndex / 21);
            const studentIndex = rosterIndex % 21;
            const classInfo = DEMO_CLASSES[classIndex];
            const answers: Record<number, number> = {};
            let score = 0;

            for (const [questionIndex, question] of exam.questions.entries()) {
                const isCorrect = shouldAnswerCorrectly({ spec, examIndex, studentIndex, classIndex, question, questionIndex });
                const correctAnswer = question.answer || 1;
                answers[question.id] = isCorrect ? correctAnswer : (correctAnswer % 5) + 1;
                if (isCorrect) score += question.score || 0;
            }

            const finishedAt = now - Math.max(1, spec.daysAgo - 2) * DAY_MS + rosterIndex * 90_000;
            const elapsedMinutes = 34 + ((studentIndex * 3 + examIndex) % 16);
            return {
                id: `mock-attempt-${exam.id}-${student.id.replace(/[^a-z0-9-]/gi, "-")}`,
                examId: exam.id,
                examTitle: exam.title,
                studentName: student.name,
                studentId: student.id,
                studentProfileId: student.id,
                classId: classInfo.id,
                groupId: classInfo.id,
                groupName: classInfo.name,
                regionId: classInfo.region,
                regionName: classInfo.region,
                identityType: "registered",
                startedAt: new Date(finishedAt - elapsedMinutes * MINUTE_MS).toISOString(),
                finishedAt: new Date(finishedAt).toISOString(),
                score,
                totalScore,
                status: "completed",
                answers,
                tabFociLostCount: (studentIndex + examIndex) % 5 === 0 ? 1 : 0,
                questionTimings: exam.questions.map((question, questionIndex) => ({
                    questionId: question.id,
                    questionNumber: question.number,
                    totalTimeSec: (question.tags?.expectedTimeSec || 90) + ((studentIndex + questionIndex * 7) % 31) - 15,
                    visitCount: questionIndex % 6 === 0 ? 2 : 1,
                    revisitCount: questionIndex % 6 === 0 ? 1 : 0,
                    answerChangeCount: (studentIndex + questionIndex) % 9 === 0 ? 1 : 0,
                })),
            };
        });
    });

    return { exams, attempts, rosterStudents, rosterGroups };
}
