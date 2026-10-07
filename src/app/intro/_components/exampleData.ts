// One example exam threads through every /intro illustration, so the hero,
// the analytics vignette and the sample exam PDF tell the same story:
// 90 submissions, questions 5 and 8 below 50%, and on question 8 most wrong
// answers picked choice ③ (the correct answer is ②).

export const EXAMPLE_EXAM_TITLE = "2학년 수학 단원평가";

export const QUESTION_RATES = [92, 85, 78, 88, 41, 90, 73, 38, 81, 86];
export const WEAK_RATE = 50;

export const Q8_CHOICES = [
    { choice: "①", rate: 6 },
    { choice: "②", rate: 38, correct: true },
    { choice: "③", rate: 41, mostWrong: true },
    { choice: "④", rate: 9 },
    { choice: "⑤", rate: 6 },
] as const;

/** Mirrors the "빠른 정답 입력" example in the STEP 1 copy. */
export const FAST_ANSWERS = "31524 25143";

export const GROWTH_SCORES = [62, 68, 66, 74, 79, 85];

export const CONCEPT_MASTERY = [
    { concept: "연립방정식", rate: 88, note: "강점" },
    { concept: "일차함수", rate: 71 },
    { concept: "확률", rate: 46, note: "보강 필요" },
] as const;
