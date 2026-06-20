import { describe, expect, it } from "vitest";
import type { KakaoNotificationCandidate } from "@/lib/kakaoNotificationQueue";
import {
    KAKAO_CANDIDATE_REVIEW_STORAGE_KEY,
    buildKakaoCandidateMessagePreview,
    parseKakaoCandidateReviews,
    readKakaoCandidateReviews,
    setKakaoCandidateReview,
    summarizeKakaoCandidateReviews,
} from "./kakaoCandidateReview";

function storage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem(key: string) {
            return data[key] ?? null;
        },
        setItem(key: string, value: string) {
            data[key] = value;
        },
    };
}

function candidate(overrides: Partial<KakaoNotificationCandidate> = {}): KakaoNotificationCandidate {
    return {
        id: "kakao:missing:exam-1",
        kind: "missing_exam",
        channel: "kakao",
        status: "candidate",
        title: "카카오 미응시 결과 확인 후보",
        message: "6월 중간 미응시 2명",
        href: "/teacher/exam/exam-1",
        examId: "exam-1",
        examTitle: "6월 중간",
        targetCount: 2,
        studentIds: ["class-a::김학생", "class-a::이학생"],
        studentNames: ["김학생", "이학생"],
        groupNames: ["A반"],
        regionNames: ["서울"],
        reason: "응시 기간 종료 후 미제출 학생",
        ...overrides,
    };
}

describe("kakao candidate review", () => {
    it("persists the latest pre-send review status by candidate id", () => {
        const localStorage = storage();
        const reviews = setKakaoCandidateReview(localStorage, candidate(), "ready", new Date("2026-06-16T10:00:00.000Z"));

        expect(reviews["kakao:missing:exam-1"]).toMatchObject({
            candidateId: "kakao:missing:exam-1",
            status: "ready",
            channel: "kakao",
            kind: "missing_exam",
            examId: "exam-1",
            title: "카카오 미응시 결과 확인 후보",
            targetCount: 2,
            studentNames: ["김학생", "이학생"],
            updatedAt: "2026-06-16T10:00:00.000Z",
        });
        expect(readKakaoCandidateReviews(localStorage)["kakao:missing:exam-1"].status).toBe("ready");
    });

    it("ignores malformed stored review rows", () => {
        const reviews = parseKakaoCandidateReviews(JSON.stringify({
            ok: {
                candidateId: "kakao:retake:exam-1:grammar",
                status: "hold",
                kind: "retake_recommendation",
                examId: "exam-1",
                title: "카카오 재시험 안내 후보",
                targetCount: 1,
                studentIds: ["class-a::김학생"],
                studentNames: ["김학생"],
                updatedAt: "2026-06-16T10:00:00.000Z",
            },
            badStatus: {
                candidateId: "bad",
                status: "sent",
                kind: "missing_exam",
                examId: "exam-1",
                title: "bad",
                updatedAt: "2026-06-16T10:00:00.000Z",
            },
        }));

        expect(Object.keys(reviews)).toEqual(["kakao:retake:exam-1:grammar"]);
        expect(reviews["kakao:retake:exam-1:grammar"].status).toBe("hold");
    });

    it("summarizes unreviewed, ready, hold, and excluded candidates for the dashboard", () => {
        const first = candidate();
        const second = candidate({ id: "kakao:retake:exam-1:grammar", kind: "retake_recommendation" });
        const third = candidate({ id: "kakao:class-retake:exam-1:A:grammar", kind: "class_retake_recommendation" });

        expect(summarizeKakaoCandidateReviews([first, second, third], {
            [first.id]: {
                candidateId: first.id,
                status: "ready",
                channel: "kakao",
                kind: first.kind,
                examId: first.examId,
                title: first.title,
                targetCount: first.targetCount,
                studentIds: first.studentIds,
                studentNames: first.studentNames,
                updatedAt: "2026-06-16T10:00:00.000Z",
            },
            [third.id]: {
                candidateId: third.id,
                status: "excluded",
                channel: "kakao",
                kind: third.kind,
                examId: third.examId,
                title: third.title,
                targetCount: third.targetCount,
                studentIds: third.studentIds,
                studentNames: third.studentNames,
                updatedAt: "2026-06-16T10:00:00.000Z",
            },
        })).toEqual({
            unreviewed: 1,
            ready: 1,
            hold: 0,
            excluded: 1,
        });
    });

    it("builds message previews without implying live Kakao sending", () => {
        expect(buildKakaoCandidateMessagePreview(candidate())).toBe("[6월 중간] 김학생, 이학생 미응시 확인이 필요합니다. 제출 여부를 확인해 주세요.");
        expect(buildKakaoCandidateMessagePreview(candidate({
            id: "kakao:class-retake:exam-1:A:grammar",
            kind: "class_retake_recommendation",
            title: "카카오 반별 재시험 안내 후보",
        }))).toBe("[6월 중간] A반 · 서울 취약 유형 보완 재시험 후보가 준비되었습니다.");
        expect(buildKakaoCandidateMessagePreview(candidate({
            id: "kakao:retake:exam-1:grammar",
            kind: "retake_recommendation",
            title: "카카오 재시험 안내 후보",
            groupNames: [],
        }))).not.toContain("발송 완료");
    });

    it("uses a dedicated local storage key for the later DB migration boundary", () => {
        expect(KAKAO_CANDIDATE_REVIEW_STORAGE_KEY).toBe("omr_kakao_candidate_reviews");
    });
});
