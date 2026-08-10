import { describe, expect, it } from "vitest";
import {
    saveKakaoCandidateReviewWithGateway,
    saveKakaoSimulationDispatchWithGateway,
    type KakaoReminderGatewayClient,
} from "./kakaoReminderGateway.server";

const workspace = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    organizationName: "운영 조직",
    actorUserId: "teacher_0123456789abcdef",
    accountId: "teacher_0123456789abcdef",
    accountSessionGeneration: 4,
    sessionAuthority: "account" as const,
    memberRole: "owner" as const,
};

const reviewRow = {
    id: "kakao:missing:exam-1",
    organization_id: "attacker-org",
    exam_id: "exam-1",
    candidate_kind: "missing_exam",
    channel: "kakao",
    status: "ready",
    title: "미응시 확인",
    target_count: 2,
    student_ids: ["student-1", "student-2"],
    student_names: ["김학생", "이학생"],
    group_names: ["A반"],
    region_names: ["서울"],
    message_preview: "미응시 확인이 필요합니다.",
    reason: "마감 임박",
    href: "/dashboard?exam=exam-1",
    reviewed_by_user_id: "attacker-user",
    reviewed_at: "2099-01-01T00:00:00.000Z",
    payload: { secret: "attacker" },
};

const dispatchRow = {
    id: "kakao:dispatch:kakao:missing:exam-1:2026-08-09T01:00:00.000Z",
    organization_id: "attacker-org",
    review_id: reviewRow.id,
    exam_id: "exam-1",
    channel: "kakao",
    provider: "simulation",
    status: "queued",
    provider_message_id: null,
    error_message: null,
    payload: { secret: "attacker" },
};

function clientReturning(data: unknown, error: { message?: string } | null = null) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: KakaoReminderGatewayClient = {
        async rpc(name, args) {
            calls.push({ name, args });
            return { data, error };
        },
    };
    return { client, calls };
}

describe("Kakao reminder server gateway", () => {
    it("sends only a bounded review command and exact teacher identity to the atomic RPC", async () => {
        const { client, calls } = clientReturning({ status: "saved" });

        await expect(saveKakaoCandidateReviewWithGateway(client, reviewRow, workspace))
            .resolves.toEqual({ status: "saved" });

        expect(calls).toEqual([{
            name: "omr_save_kakao_candidate_review_v1",
            args: {
                p_session_authority: "account",
                p_account_id: workspace.accountId,
                p_session_generation: 4,
                p_organization_id: workspace.organizationId,
                p_actor_user_id: workspace.actorUserId,
                p_review: {
                    id: reviewRow.id,
                    examId: "exam-1",
                    candidateKind: "missing_exam",
                    status: "ready",
                    title: "미응시 확인",
                    targetCount: 2,
                    studentIds: ["student-1", "student-2"],
                    studentNames: ["김학생", "이학생"],
                    groupNames: ["A반"],
                    regionNames: ["서울"],
                    messagePreview: "미응시 확인이 필요합니다.",
                    reason: "마감 임박",
                    href: "/dashboard?exam=exam-1",
                },
            },
        }]);
        expect(JSON.stringify(calls[0])).not.toContain("attacker");
        expect(JSON.stringify(calls[0])).not.toContain("2099-01-01");
    });

    it("sends only simulation transition intent to the dispatch RPC", async () => {
        const { client, calls } = clientReturning({ status: "saved" });

        await expect(saveKakaoSimulationDispatchWithGateway(client, dispatchRow, workspace))
            .resolves.toEqual({ status: "saved" });

        expect(calls[0]).toEqual({
            name: "omr_save_kakao_simulation_dispatch_v1",
            args: expect.objectContaining({
                p_organization_id: workspace.organizationId,
                p_dispatch: {
                    id: dispatchRow.id,
                    reviewId: reviewRow.id,
                    examId: "exam-1",
                    status: "queued",
                    providerMessageId: null,
                    errorMessage: null,
                },
            }),
        });
        expect(JSON.stringify(calls[0])).not.toContain("attacker");
    });

    it("fails closed for invalid identity, unsafe payloads, Free plan, and legacy reconciliation", async () => {
        const invalid = clientReturning({ status: "saved" });
        const unsafe = clientReturning({ status: "saved" });
        const free = clientReturning({ status: "plan_denied" });
        const legacy = clientReturning({ status: "legacy_reconciliation_required" });

        await expect(saveKakaoCandidateReviewWithGateway(
            invalid.client,
            reviewRow,
            { ...workspace, accountSessionGeneration: 0 },
        )).resolves.toEqual({ status: "invalid_request" });
        await expect(saveKakaoCandidateReviewWithGateway(
            unsafe.client,
            { ...reviewRow, href: "//attacker.example/path" },
            workspace,
        )).resolves.toEqual({ status: "invalid_request" });
        await expect(saveKakaoCandidateReviewWithGateway(free.client, reviewRow, workspace))
            .resolves.toEqual({ status: "plan_denied" });
        await expect(saveKakaoCandidateReviewWithGateway(legacy.client, reviewRow, workspace))
            .resolves.toEqual({ status: "legacy_reconciliation_required" });

        expect(invalid.calls).toHaveLength(0);
        expect(unsafe.calls).toHaveLength(0);
    });

    it("does not leak service-role errors", async () => {
        const failed = clientReturning(null, { message: "relation secret_internal does not exist" });
        const result = await saveKakaoCandidateReviewWithGateway(failed.client, reviewRow, workspace);
        expect(result).toEqual({ status: "service_unavailable" });
        expect(JSON.stringify(result)).not.toContain("secret_internal");
    });
});
