import { afterEach, describe, expect, it, vi } from "vitest";
import type { KakaoNotificationCandidate } from "@/lib/kakaoNotificationQueue";
import {
    KAKAO_DISPATCH_LOG_STORAGE_KEY,
    kakaoDispatchLogFromSupabaseRow,
    kakaoDispatchLogToSupabaseRow,
    kakaoCandidateReviewFromSupabaseRow,
    kakaoCandidateReviewToSupabaseRow,
    queueKakaoDispatchSimulation,
    readKakaoDispatchLogs,
    saveKakaoCandidateReview,
    summarizeKakaoDispatchLogs,
    updateKakaoDispatchLogStatus,
} from "./kakaoCandidateReviewPersistence";

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

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("kakao candidate review persistence", () => {
    it("maps reviewed Kakao candidates to Supabase rows for DB sync", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const localStorage = storage();
        const result = await saveKakaoCandidateReview(
            localStorage,
            candidate(),
            "ready",
            new Date("2026-06-16T10:00:00.000Z"),
        );

        const row = kakaoCandidateReviewToSupabaseRow(result.record, candidate(), "2026-06-16T10:01:00.000Z");

        expect(row).toMatchObject({
            id: "kakao:missing:exam-1",
            organization_id: null,
            exam_id: "exam-1",
            candidate_kind: "missing_exam",
            channel: "kakao",
            status: "ready",
            title: "카카오 미응시 결과 확인 후보",
            target_count: 2,
            student_ids: ["class-a::김학생", "class-a::이학생"],
            student_names: ["김학생", "이학생"],
            group_names: ["A반"],
            region_names: ["서울"],
            message_preview: "[6월 중간] 김학생, 이학생 미응시 확인이 필요합니다. 제출 여부를 확인해 주세요.",
            reason: "응시 기간 종료 후 미제출 학생",
            href: "/teacher/exam/exam-1",
            reviewed_at: "2026-06-16T10:00:00.000Z",
            updated_at: "2026-06-16T10:01:00.000Z",
        });
        expect(row.payload.review.status).toBe("ready");
        expect(kakaoCandidateReviewFromSupabaseRow(row)).toEqual(result.record);
    });

    it("keeps local review state when Supabase is not configured", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const localStorage = storage();

        const result = await saveKakaoCandidateReview(
            localStorage,
            candidate({ id: "kakao:retake:exam-1:grammar", kind: "retake_recommendation" }),
            "hold",
            new Date("2026-06-16T10:00:00.000Z"),
        );

        expect(result).toMatchObject({
            localSaved: true,
            remoteSaved: false,
            record: {
                candidateId: "kakao:retake:exam-1:grammar",
                status: "hold",
                kind: "retake_recommendation",
                examId: "exam-1",
            },
        });
        expect(localStorage.data.omr_kakao_candidate_reviews).toContain("kakao:retake:exam-1:grammar");
        expect(localStorage.data.omr_kakao_candidate_reviews).toContain("\"status\":\"hold\"");
    });

    it("queues simulated Kakao dispatch logs locally before provider integration", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const localStorage = storage();
        const review = await saveKakaoCandidateReview(
            localStorage,
            candidate(),
            "ready",
            new Date("2026-06-16T10:00:00.000Z"),
        );

        const queued = await queueKakaoDispatchSimulation(
            localStorage,
            review.record,
            candidate(),
            new Date("2026-06-16T10:05:00.000Z"),
        );

        expect(queued).toMatchObject({
            localSaved: true,
            remoteSaved: false,
            log: {
                id: "kakao:dispatch:kakao:missing:exam-1:2026-06-16T10:05:00.000Z",
                reviewId: "kakao:missing:exam-1",
                examId: "exam-1",
                channel: "kakao",
                provider: "simulation",
                status: "queued",
                targetCount: 2,
                studentIds: ["class-a::김학생", "class-a::이학생"],
                studentNames: ["김학생", "이학생"],
                messagePreview: "[6월 중간] 김학생, 이학생 미응시 확인이 필요합니다. 제출 여부를 확인해 주세요.",
                createdAt: "2026-06-16T10:05:00.000Z",
            },
        });
        expect(localStorage.data[KAKAO_DISPATCH_LOG_STORAGE_KEY]).toContain("kakao:missing:exam-1");
        expect(readKakaoDispatchLogs(localStorage)).toHaveLength(1);
        expect(summarizeKakaoDispatchLogs(queued.logs, ["kakao:missing:exam-1"])).toMatchObject({
            total: 1,
            queued: 1,
            sent: 0,
            failed: 0,
        });
    });

    it("maps simulated dispatch logs to Supabase dispatch rows", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const localStorage = storage();
        const selectedCandidate = candidate({ id: "kakao:class-retake:exam-1:A:grammar", kind: "class_retake_recommendation" });
        const review = await saveKakaoCandidateReview(
            localStorage,
            selectedCandidate,
            "ready",
            new Date("2026-06-16T10:00:00.000Z"),
        );
        const queued = await queueKakaoDispatchSimulation(
            localStorage,
            review.record,
            selectedCandidate,
            new Date("2026-06-16T10:05:00.000Z"),
        );

        const row = kakaoDispatchLogToSupabaseRow(queued.log, review.record, selectedCandidate);

        expect(row).toMatchObject({
            id: "kakao:dispatch:kakao:class-retake:exam-1:A:grammar:2026-06-16T10:05:00.000Z",
            organization_id: null,
            review_id: "kakao:class-retake:exam-1:A:grammar",
            exam_id: "exam-1",
            channel: "kakao",
            provider: "simulation",
            status: "queued",
            target_count: 2,
            student_ids: ["class-a::김학생", "class-a::이학생"],
            message_preview: "[6월 중간] A반 · 서울 취약 유형 보완 재시험 후보가 준비되었습니다.",
            provider_message_id: null,
            error_message: null,
            created_at: "2026-06-16T10:05:00.000Z",
            sent_at: null,
        });
        expect(row.payload.review.status).toBe("ready");
        expect(row.payload.log.status).toBe("queued");
        expect(kakaoDispatchLogFromSupabaseRow(row)).toEqual(queued.log);
    });

    it("updates queued dispatch logs to sent, failed, or cancelled states", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const localStorage = storage();
        const review = await saveKakaoCandidateReview(
            localStorage,
            candidate(),
            "ready",
            new Date("2026-06-16T10:00:00.000Z"),
        );
        const queued = await queueKakaoDispatchSimulation(
            localStorage,
            review.record,
            candidate(),
            new Date("2026-06-16T10:05:00.000Z"),
        );

        const sent = updateKakaoDispatchLogStatus(localStorage, queued.log.id, "sent", {
            now: new Date("2026-06-16T10:06:00.000Z"),
            providerMessageId: "simulation:message-1",
        });

        expect(sent.log).toMatchObject({
            id: queued.log.id,
            status: "sent",
            providerMessageId: "simulation:message-1",
            sentAt: "2026-06-16T10:06:00.000Z",
        });
        expect(summarizeKakaoDispatchLogs(sent.logs, ["kakao:missing:exam-1"])).toMatchObject({
            queued: 0,
            sent: 1,
            failed: 0,
            cancelled: 0,
        });

        const secondQueued = await queueKakaoDispatchSimulation(
            localStorage,
            review.record,
            candidate(),
            new Date("2026-06-16T10:07:00.000Z"),
        );
        const failed = updateKakaoDispatchLogStatus(localStorage, secondQueued.log.id, "failed", {
            now: new Date("2026-06-16T10:08:00.000Z"),
            errorMessage: "provider timeout",
        });

        expect(failed.log).toMatchObject({
            id: secondQueued.log.id,
            status: "failed",
            errorMessage: "provider timeout",
        });

        const cancelled = updateKakaoDispatchLogStatus(localStorage, secondQueued.log.id, "cancelled", {
            now: new Date("2026-06-16T10:09:00.000Z"),
        });

        expect(cancelled.log).toMatchObject({
            id: secondQueued.log.id,
            status: "cancelled",
            errorMessage: "provider timeout",
        });
        expect(readKakaoDispatchLogs(localStorage).map(log => log.status)).toEqual(["cancelled", "sent"]);
    });
});
