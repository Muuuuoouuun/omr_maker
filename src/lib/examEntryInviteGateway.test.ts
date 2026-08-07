import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    resolveExamEntryInviteWithGateway,
    rotateExamEntryInviteWithGateway,
    type ExamEntryInviteRpcClient,
} from "./examEntryInviteGateway";

const context = {
    organizationId: "org-alpha",
    organizationName: "Alpha",
    actorUserId: "teacher-1",
};

describe("opaque exam entry invite gateway", () => {
    it("rotates through the ownership-checking RPC and never persists the bearer token", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: ExamEntryInviteRpcClient = {
            async rpc(name, params) {
                calls.push({ name, params });
                return { data: { status: "issued", expiresAt: params.p_expires_at }, error: null };
            },
        };
        const result = await rotateExamEntryInviteWithGateway(client, context, "exam-1", 1_800_000, 1_000);

        expect(result.status).toBe("issued");
        if (result.status !== "issued") throw new Error("invite was not issued");
        expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(calls).toEqual([expect.objectContaining({
            name: "omr_rotate_exam_entry_invite_v1",
            params: expect.objectContaining({
                p_organization_id: "org-alpha",
                p_exam_id: "exam-1",
                p_actor_user_id: "teacher-1",
                p_token_hash: createHash("sha256").update(result.token).digest("hex"),
            }),
        })]);
        expect(JSON.stringify(calls[0].params)).not.toContain(result.token);
    });

    it("resolves only an exact, live exam-scoped token and keeps the organization server-only", async () => {
        const token = "a".repeat(43);
        const client: ExamEntryInviteRpcClient = {
            async rpc(name, params) {
                expect(name).toBe("omr_resolve_exam_entry_invite_v1");
                expect(params).toEqual({
                    p_token_hash: createHash("sha256").update(token).digest("hex"),
                    p_exam_id: "exam-1",
                });
                return {
                    data: {
                        status: "resolved",
                        organizationId: "org-alpha",
                        examId: "exam-1",
                        groupIds: ["group-1"],
                        expiresAt: "2026-08-08T00:00:00.000Z",
                    },
                    error: null,
                };
            },
        };
        await expect(resolveExamEntryInviteWithGateway(client, "exam-1", token, Date.parse("2026-08-07T00:00:00Z")))
            .resolves.toEqual({
                status: "resolved",
                scope: {
                    organizationId: "org-alpha",
                    examId: "exam-1",
                    groupIds: ["group-1"],
                    expiresAt: "2026-08-08T00:00:00.000Z",
                },
            });
    });

    it("adds database-clock transit headroom at the minimum TTL boundary", async () => {
        let expiresAt = "";
        const client: ExamEntryInviteRpcClient = {
            async rpc(_name, params) {
                expiresAt = String(params.p_expires_at);
                return { data: { status: "issued", expiresAt }, error: null };
            },
        };
        const now = Date.parse("2026-08-07T00:00:00Z");
        await rotateExamEntryInviteWithGateway(client, context, "exam-1", 15 * 60 * 1000, now);
        expect(Date.parse(expiresAt) - now).toBe(16 * 60 * 1000);
    });

    it("fails closed before RPC for malformed bearer tokens", async () => {
        const client: ExamEntryInviteRpcClient = { async rpc() { throw new Error("must not be called"); } };
        await expect(resolveExamEntryInviteWithGateway(client, "exam-1", "raw-workspace-id"))
            .resolves.toEqual({ status: "invalid" });
    });

    it.each([
        { examId: "exam-other", groupIds: ["group-1"], expiresAt: "2026-08-08T00:00:00Z" },
        { examId: "exam-1", groupIds: [], expiresAt: "2026-08-08T00:00:00Z" },
        { examId: "exam-1", groupIds: ["group-1"], expiresAt: "2026-08-06T00:00:00Z" },
    ])("fails closed on a malformed or cross-scope resolver response", async response => {
        const client: ExamEntryInviteRpcClient = {
            async rpc() {
                return { data: { status: "resolved", organizationId: "org-alpha", ...response }, error: null };
            },
        };
        await expect(resolveExamEntryInviteWithGateway(
            client,
            "exam-1",
            "b".repeat(43),
            Date.parse("2026-08-07T00:00:00Z"),
        )).resolves.toEqual({ status: "invalid" });
    });

    it("returns a sanitized outage result without reflecting RPC errors", async () => {
        const client: ExamEntryInviteRpcClient = {
            async rpc() { return { data: null, error: { message: `secret ${"c".repeat(43)}` } }; },
        };
        await expect(resolveExamEntryInviteWithGateway(client, "exam-1", "c".repeat(43)))
            .resolves.toEqual({ status: "service_unavailable" });
    });
});
