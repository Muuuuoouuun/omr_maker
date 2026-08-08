import { describe, expect, it } from "vitest";
import {
    buildExamHeadlineInsight,
    resolveExamAnalyticsSampleStatus,
} from "./examAnalyticsReport";

describe("exam analytics sample completeness", () => {
    it("keeps a usable paginated response explicitly partial", () => {
        expect(resolveExamAnalyticsSampleStatus({
            remoteLoaded: true,
            remotePartial: true,
        })).toBe("partial");
    });

    it("marks local-only or otherwise unsynced usable rows stale", () => {
        expect(resolveExamAnalyticsSampleStatus({
            remoteLoaded: false,
            remoteSynced: false,
        })).toBe("stale");
    });

    it("marks a complete remote response ready", () => {
        expect(resolveExamAnalyticsSampleStatus({
            remoteLoaded: true,
            remoteSynced: true,
        })).toBe("ready");
    });
});

describe("exam analytics report headline", () => {
    it("does not fabricate an action when every question lacks gradable evidence", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 8,
            hasGradableEvidence: false,
            weakConcept: "시제",
            weakConceptRate: 0,
            lowStudentCount: 8,
            riskyQuestionCount: 3,
        })).toEqual({
            tone: "observation",
            title: "채점 가능한 문항 근거가 더 필요합니다",
            detail: "미채점 문항은 취약 개념과 행동 추천에서 제외했습니다.",
        });
    });

    it("asks for more evidence when fewer than five submissions exist", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 1,
            totalSubmissionCount: 5,
            weakConcept: "시제",
            weakConceptRate: 25,
            lowStudentCount: 3,
            riskyQuestionCount: 2,
        })).toEqual({
            tone: "observation",
            title: "경향을 확정하려면 표본이 더 필요합니다",
            detail: "전체 제출 5건 중 채점 가능한 1명 기준입니다.",
        });
    });

    it("keeps zero submissions on the small-sample observation", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 0,
            weakConcept: "시제",
            lowStudentCount: 10,
            riskyQuestionCount: 2,
        })).toEqual({
            tone: "observation",
            title: "경향을 확정하려면 표본이 더 필요합니다",
            detail: "현재 0명 제출 기준입니다.",
        });
    });

    it("prioritizes a weak-concept action over risky questions and low students from the five-submission boundary", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 5,
            weakConcept: "시제",
            weakConceptRate: 69,
            lowStudentCount: 2,
            riskyQuestionCount: 3,
        })).toEqual({
            tone: "action",
            title: "‘시제’ 보강이 가장 효과적입니다",
            detail: "정답률 69% · 지원 학생 2명 · 점검 문항 3개",
        });
    });

    it("prioritizes risky questions over low students when no weak-concept action qualifies", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 8,
            weakConcept: "시제",
            weakConceptRate: 70,
            lowStudentCount: 4,
            riskyQuestionCount: 2,
        })).toEqual({
            tone: "observation",
            title: "문항별 정답률 차이를 먼저 점검해 주세요",
            detail: "재점검이 필요한 문항 2개입니다.",
        });
    });

    it("reports a positive headline when no risk signal qualifies", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 12,
            weakConcept: "시제",
            weakConceptRate: 85,
            lowStudentCount: 0,
            riskyQuestionCount: 0,
        })).toEqual({
            tone: "positive",
            title: "현재 시험에서는 뚜렷한 위험 신호가 없습니다",
            detail: "12명 제출 기준입니다.",
        });
    });

    it("reports students needing support before the positive fallback", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 5,
            weakConcept: "시제",
            weakConceptRate: 75,
            lowStudentCount: 5,
            riskyQuestionCount: 0,
        })).toEqual({
            tone: "observation",
            title: "지원이 필요한 학생을 먼저 확인해 주세요",
            detail: "60점 미만 학생 5명입니다.",
        });
    });

    it("caps the low-student count at the sanitized submission count", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 5,
            lowStudentCount: 10,
            riskyQuestionCount: 0,
        })).toEqual({
            tone: "observation",
            title: "지원이 필요한 학생을 먼저 확인해 주세요",
            detail: "60점 미만 학생 5명입니다.",
        });
    });

    it("trims the weak concept before rendering the action headline", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 5,
            weakConcept: "  문맥 어휘  ",
            weakConceptRate: 45,
            lowStudentCount: 1,
            riskyQuestionCount: 0,
        }).title).toBe("‘문맥 어휘’ 보강이 가장 효과적입니다");
    });

    it("sanitizes invalid, negative, and decimal headline metrics", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 5.9,
            weakConcept: "시제",
            weakConceptRate: 12,
            lowStudentCount: -3.8,
            riskyQuestionCount: 2.9,
        })).toEqual({
            tone: "action",
            title: "‘시제’ 보강이 가장 효과적입니다",
            detail: "정답률 12% · 지원 학생 0명 · 점검 문항 2개",
        });

        expect(buildExamHeadlineInsight({
            performanceCount: Number.NaN,
            lowStudentCount: Number.POSITIVE_INFINITY,
            riskyQuestionCount: Number.NaN,
        })).toEqual({
            tone: "observation",
            title: "경향을 확정하려면 표본이 더 필요합니다",
            detail: "현재 0명 제출 기준입니다.",
        });
    });

    it("does not trigger or render a weak-concept action when its rate is missing", () => {
        const insight = buildExamHeadlineInsight({
            performanceCount: 9,
            weakConcept: "시제",
            lowStudentCount: 2,
            riskyQuestionCount: 1,
        });

        expect(insight).toEqual({
            tone: "observation",
            title: "취약 개념의 근거 데이터를 확인해 주세요",
            detail: "‘시제’ 정답률을 계산할 수 없습니다.",
        });
        expect(insight.detail).not.toContain("undefined%");
    });

    it.each([-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY])(
        "treats an unavailable weak-concept rate of %s as non-actionable",
        weakConceptRate => {
            expect(buildExamHeadlineInsight({
                performanceCount: 9,
                weakConcept: "시제",
                weakConceptRate,
                lowStudentCount: 2,
                riskyQuestionCount: 1,
            })).toEqual({
                tone: "observation",
                title: "취약 개념의 근거 데이터를 확인해 주세요",
                detail: "‘시제’ 정답률을 계산할 수 없습니다.",
            });
        },
    );

    it("rounds a valid rate to one decimal before rendering and comparing the action threshold", () => {
        expect(buildExamHeadlineInsight({
            performanceCount: 9,
            weakConcept: "시제",
            weakConceptRate: 69.94,
            lowStudentCount: 2,
            riskyQuestionCount: 1,
        })).toEqual({
            tone: "action",
            title: "‘시제’ 보강이 가장 효과적입니다",
            detail: "정답률 69.9% · 지원 학생 2명 · 점검 문항 1개",
        });

        expect(buildExamHeadlineInsight({
            performanceCount: 9,
            weakConcept: "시제",
            weakConceptRate: 69.95,
            lowStudentCount: 2,
            riskyQuestionCount: 1,
        })).toEqual({
            tone: "observation",
            title: "문항별 정답률 차이를 먼저 점검해 주세요",
            detail: "재점검이 필요한 문항 1개입니다.",
        });
    });

    it("does not mutate the input", () => {
        const input = {
            performanceCount: 7,
            weakConcept: "  시제  ",
            weakConceptRate: 40,
            lowStudentCount: -2,
            riskyQuestionCount: 1.7,
        };
        const original = { ...input };

        buildExamHeadlineInsight(input);

        expect(input).toEqual(original);
    });
});
