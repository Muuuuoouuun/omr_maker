import { describe, expect, it } from "vitest";
import type { RemoteAssetSupabaseGatewayClient } from "./remoteAssetGateway.server";
import {
    archiveStudentAttemptHandwritingWithGateway,
    canonicalAttemptHandwritingAssetId,
} from "./studentAttemptHandwritingGateway.server";

function mockGateway(options: { attachFailures?: number; prepareResponseLosses?: number } = {}) {
    const calls: string[] = [];
    const preparedAssetIds: string[] = [];
    const uploadedPaths = new Set<string>();
    let attached = false;
    let attachFailures = options.attachFailures || 0;
    let prepareResponseLosses = options.prepareResponseLosses || 0;
    let reservedAsset: Record<string, unknown> | null = null;
    const client = {
        storage: {
            from() {
                return {
                    async upload(path: string) {
                        calls.push("upload");
                        if (uploadedPaths.has(path)) return { data: null, error: { message: "already exists" } };
                        uploadedPaths.add(path);
                        return { data: {}, error: null };
                    },
                    async remove() { return { data: {}, error: null }; },
                    async createSignedUrl() { return { data: null, error: null }; },
                    async info(path: string) {
                        return uploadedPaths.has(path)
                            ? { data: { size: 2, contentType: "application/json" }, error: null }
                            : { data: null, error: { message: "not found" } };
                    },
                };
            },
        },
        async rpc(name: string, params?: Record<string, unknown>) {
            calls.push(name);
            if (name === "omr_prepare_attempt_handwriting_asset_v1") {
                const candidate = params?.p_asset as Record<string, unknown>;
                preparedAssetIds.push(String(candidate.id));
                reservedAsset ||= {
                    ...candidate,
                    created_by_user_id: null,
                    created_at: "2026-08-06T00:00:00.000Z",
                    updated_at: "2026-08-06T00:00:00.000Z",
                };
                if (prepareResponseLosses > 0) {
                    prepareResponseLosses -= 1;
                    return { data: null, error: { message: "response lost" } };
                }
                return {
                    data: {
                        status: attached ? "attached" : "reserved",
                        objectRequired: !uploadedPaths.has(String(reservedAsset.object_path)),
                        asset: reservedAsset,
                    },
                    error: null,
                };
            }
            if (name === "omr_save_remote_asset_metadata_v1") return { data: reservedAsset, error: null };
            if (name === "omr_attach_attempt_handwriting_v1") {
                if (attachFailures > 0) {
                    attachFailures -= 1;
                    return { data: null, error: { message: "attach failed" } };
                }
                attached = true;
                return { data: {}, error: null };
            }
            if (name === "omr_discard_attempt_handwriting_asset_v1") {
                reservedAsset = null;
                return { data: true, error: null };
            }
            return { data: null, error: { message: "unexpected" } };
        },
        from() {
            return {
                select() {
                    const query = {
                        eq() { return query; },
                        async maybeSingle() { return { data: reservedAsset, error: null }; },
                    };
                    return query;
                },
            };
        },
    } as unknown as RemoteAssetSupabaseGatewayClient;
    return { client, calls, preparedAssetIds };
}

const input = {
    sessionId: "session-1",
    organizationId: "org-1",
    attemptId: "attempt-1",
    attachmentTicketId: "ticket-1",
    body: new TextEncoder().encode("{}"),
    originalName: "handwriting.json",
};

describe("durable attempt handwriting archive gateway", () => {
    it("uses a nonce generation so re-uploading identical bytes cannot reuse a late-delete path", async () => {
        const { client, preparedAssetIds } = mockGateway({ attachFailures: 1 });

        await expect(archiveStudentAttemptHandwritingWithGateway(client, input))
            .resolves.toEqual({ status: "service_unavailable" });
        await expect(archiveStudentAttemptHandwritingWithGateway(client, input))
            .resolves.toMatchObject({ status: "uploaded" });

        expect(preparedAssetIds).toHaveLength(2);
        expect(preparedAssetIds[0]).not.toBe(preparedAssetIds[1]);
        expect(preparedAssetIds[0]).toBe(canonicalAttemptHandwritingAssetId("session-1", preparedAssetIds[0]!.split("_").at(-1)!));
    });

    it("replays the authoritative reservation after a prepare response is lost", async () => {
        const { client, calls, preparedAssetIds } = mockGateway({ prepareResponseLosses: 1 });

        await expect(archiveStudentAttemptHandwritingWithGateway(client, input))
            .resolves.toEqual({ status: "service_unavailable" });
        await expect(archiveStudentAttemptHandwritingWithGateway(client, input))
            .resolves.toMatchObject({ status: "uploaded" });

        expect(preparedAssetIds).toHaveLength(2);
        expect(preparedAssetIds[0]).not.toBe(preparedAssetIds[1]);
        expect(calls.filter(call => call === "upload")).toHaveLength(1);
    });

    it("reuses one authoritative immutable reservation after attachment", async () => {
        const { client, calls } = mockGateway();
        await expect(archiveStudentAttemptHandwritingWithGateway(client, input)).resolves.toMatchObject({ status: "uploaded" });
        await expect(archiveStudentAttemptHandwritingWithGateway(client, input)).resolves.toMatchObject({ status: "uploaded" });
        expect(calls.filter(call => call === "upload")).toHaveLength(1);
        expect(calls.filter(call => call === "omr_attach_attempt_handwriting_v1")).toHaveLength(1);
    });

    it("discards the registry reservation when canonical attachment fails", async () => {
        const { client, calls } = mockGateway({ attachFailures: 1 });
        await expect(archiveStudentAttemptHandwritingWithGateway(client, input)).resolves.toEqual({ status: "service_unavailable" });
        expect(calls).toContain("omr_discard_attempt_handwriting_asset_v1");
    });
});
