import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
    createInitialOperationsLoadGateway,
    type InitialOperationsLoadClient,
} from "./initialOperationsLoadGateway.server";

const RUN_ID = "run-20260807-live";
const SUFFIX = createHash("sha256").update(RUN_ID).digest("hex").slice(0, 16);
const context = {
    runId: RUN_ID,
    runChallenge: "b".repeat(32),
    requestId: `${RUN_ID}:request:1`,
    actorId: `student_${SUFFIX}_001`,
};
const fixture = { organizationId: `teacher_${SUFFIX}`, examId: `initial_ops_exam_${SUFFIX}` };
const unusedFrom = () => vi.fn() as unknown as InitialOperationsLoadClient["from"];

describe("initial-operations Supabase load gateway", () => {
    it("executes run-scoped fixture and operation RPCs and removes every cleanup object", async () => {
        const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
            data: name === "omr_initial_ops_fixture_v1" && args.p_action === "finalize_cleanup"
                ? { status: "cleaned", remaining: { sessions: 0, attempts: 0, assets: 0, uploadIntents: 0, cleanupQueue: 0, members: 0, objects: 0 } }
                : name === "omr_initial_ops_fixture_v1" && args.p_action === "cleanup"
                ? { status: "cleanup_pending", objectPaths: [`organizations/${fixture.organizationId}/exams/${fixture.examId}/problem/a.pdf`], remaining: { sessions: 0, attempts: 0, assets: 0, uploadIntents: 0, cleanupQueue: 0, members: 0, objects: 1 } }
                : name === "omr_initial_ops_fixture_v1"
                    ? { status: "created", organizationId: fixture.organizationId, examId: fixture.examId }
                    : {
                        session_id: `${RUN_ID}:session:${context.actorId}`,
                        status: "in_progress",
                        revision: 2,
                        lease_epoch: 1,
                        started_at: "2026-08-07T00:00:00.000Z",
                        deadline_at: "2026-08-07T01:00:00.000Z",
                        server_now: "2026-08-07T00:00:01.000Z",
                        answers: { 1: 1 },
                        sub_question_answers: {},
                        progress_payload: {},
                        allowed_question_ids: Array.from({ length: 45 }, (_, index) => index + 1),
                    },
            error: null,
        }));
        const remove = vi.fn(async () => ({ data: [], error: null }));
        const exists = vi.fn(async () => ({ data: false, error: null }));
        const client = { rpc, storage: { from: vi.fn(() => ({ remove, exists })) }, from: unusedFrom() };
        const gateway = createInitialOperationsLoadGateway(client);

        await expect(gateway.mutateFixture("create", context, fixture)).resolves.toMatchObject({ status: "created" });
        await expect(gateway.executeOperation("checkpoint", context, {
            fixture, revision: 1, expectedRevision: 1, expectedLeaseEpoch: 1,
        })).resolves.toMatchObject({
            status: "ok",
            revision: 2,
            workloadPaths: ["rpc:omr_checkpoint_attempt_session_v1"],
        });
        await expect(gateway.mutateFixture("cleanup", context, fixture)).resolves.toEqual({
            status: "cleaned",
            remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 },
        });
        expect(remove).toHaveBeenCalledWith([`organizations/${fixture.organizationId}/exams/${fixture.examId}/problem/a.pdf`]);
        expect(exists).toHaveBeenCalledWith(`organizations/${fixture.organizationId}/exams/${fixture.examId}/problem/a.pdf`);
        expect(rpc).toHaveBeenCalledWith("omr_checkpoint_attempt_session_v1", expect.objectContaining({
            p_organization_id: fixture.organizationId,
            p_owner_student_id: context.actorId,
            p_expected_revision: 1,
        }));
    });

    it("fails cleanup closed when a Storage object still exists after deletion", async () => {
        const objectPath = `organizations/${fixture.organizationId}/exams/${fixture.examId}/problem/a.pdf`;
        const rpc = vi.fn(async () => ({
            data: {
                status: "cleanup_pending",
                objectPaths: [objectPath],
                remaining: { sessions: 0, attempts: 0, assets: 0, uploadIntents: 0, cleanupQueue: 0, members: 0, objects: 1 },
            },
            error: null,
        }));
        const remove = vi.fn(async () => ({ data: [], error: null }));
        const exists = vi.fn(async () => ({ data: true, error: null }));
        const client = { rpc, storage: { from: vi.fn(() => ({ remove, exists })) }, from: unusedFrom() };
        const gateway = createInitialOperationsLoadGateway(client);

        await expect(gateway.mutateFixture("cleanup", context, fixture))
            .resolves.toEqual({ status: "service_unavailable" });
        expect(remove).toHaveBeenCalledWith([objectPath]);
    });

    it("prepares and finalizes a canonical 50 MiB staging Storage object", async () => {
        const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
            data: name === "omr_prepare_teacher_asset_upload_v1"
                ? { ...(args.p_upload as Record<string, unknown>), status: "pending" }
                : name === "omr_authorize_teacher_asset_finalize_v1"
                    ? {
                        id: args.p_upload_id,
                        organization_id: args.p_organization_id,
                        exam_id: (args.p_declaration as Record<string, unknown>).exam_id,
                        kind: (args.p_declaration as Record<string, unknown>).kind,
                        created_by_user_id: args.p_created_by_user_id,
                        storage_bucket: (args.p_declaration as Record<string, unknown>).storage_bucket,
                        object_path: (args.p_declaration as Record<string, unknown>).object_path,
                        mime_type: (args.p_declaration as Record<string, unknown>).mime_type,
                        byte_size: (args.p_declaration as Record<string, unknown>).byte_size,
                        sha256_hex: (args.p_declaration as Record<string, unknown>).sha256_hex,
                        status: "pending",
                    }
                    : name === "omr_finalize_teacher_asset_upload_v1"
                        ? {
                            id: args.p_upload_id,
                            organization_id: args.p_organization_id,
                            exam_id: fixture.examId,
                            kind: "problem_pdf",
                            created_by_user_id: args.p_created_by_user_id,
                            storage_bucket: "omr-private-assets",
                            object_path: (args.p_observation as Record<string, unknown>).object_path,
                            mime_type: "application/pdf",
                            byte_size: 50 * 1024 * 1024,
                            sha256_hex: "c".repeat(64),
                            created_at: "2026-08-07T00:00:00.000Z",
                            updated_at: "2026-08-07T00:00:01.000Z",
                        }
                        : null,
            error: null,
        }));
        const createSignedUploadUrl = vi.fn(async (path: string) => ({
            data: { signedUrl: `https://stagingprojectref.supabase.co/storage/v1/upload/${path}?token=upload`, token: "upload" },
            error: null,
        }));
        const createSignedUrl = vi.fn(async (path: string) => ({
            data: { signedUrl: `https://stagingprojectref.supabase.co/storage/v1/read/${path}?token=read` },
            error: null,
        }));
        const info = vi.fn(async () => ({
            data: {
                size: 50 * 1024 * 1024,
                contentType: "application/pdf",
                metadata: { sha256Hex: "c".repeat(64) },
            },
            error: null,
        }));
        const client = { rpc, storage: { from: vi.fn(() => ({ createSignedUploadUrl, createSignedUrl, info, remove: vi.fn() })) }, from: unusedFrom() };
        const gateway = createInitialOperationsLoadGateway(client, {
            fetchImpl: vi.fn(async () => new Response(new TextEncoder().encode("%PDF-"), {
                status: 206,
                headers: { "content-range": `bytes 0-4/${50 * 1024 * 1024}` },
            })),
        });
        const uploader = { ...context, actorId: `uploader_${SUFFIX}_01` };
        const declaration = {
            fixture,
            byteSize: 50 * 1024 * 1024,
            sha256Hex: "c".repeat(64),
            idempotencyKey: `${RUN_ID}:upload:01`,
        };

        const prepared = await gateway.executeOperation("teacher-max-pdf-upload-prepare", uploader, declaration);
        expect(prepared).toMatchObject({
            status: "prepared",
            objectPath: expect.stringMatching(new RegExp(`^organizations/${fixture.organizationId}/exams/${fixture.examId}/problem/asset_[a-f0-9]{32}\\.pdf$`)),
            uploadUrl: expect.stringContaining("stagingprojectref.supabase.co"),
            mode: "tus",
        });
        expect(rpc).toHaveBeenCalledWith("omr_prepare_teacher_asset_upload_v1", expect.objectContaining({
            p_upload: expect.objectContaining({
                organization_id: fixture.organizationId,
                exam_id: fixture.examId,
                object_path: prepared.objectPath,
                byte_size: declaration.byteSize,
            }),
        }));
        expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(createSignedUploadUrl.mock.invocationCallOrder[0]);
        const finalized = await gateway.executeOperation("teacher-max-pdf-upload-finalize", uploader, {
            ...declaration,
            objectPath: prepared.objectPath,
            expectedBytes: declaration.byteSize,
            expectedSha256: declaration.sha256Hex,
        });
        expect(finalized).toMatchObject({ status: "finalized", readbackUrl: expect.stringContaining("token=read") });
        expect(info).toHaveBeenCalledWith(prepared.objectPath);
    });

    it("does not issue signed URLs when the database rejects an inactive, foreign-role, or over-quota run", async () => {
        const rpc = vi.fn(async () => ({ data: { status: "rejected" }, error: null }));
        const createSignedUploadUrl = vi.fn();
        const createSignedUrl = vi.fn();
        const client = {
            rpc,
            storage: { from: vi.fn(() => ({ createSignedUploadUrl, createSignedUrl, remove: vi.fn() })) },
            from: unusedFrom(),
        };
        const gateway = createInitialOperationsLoadGateway(client);
        const uploader = { ...context, actorId: `uploader_${SUFFIX}_01` };

        await expect(gateway.executeOperation("teacher-max-pdf-upload-prepare", uploader, {
            fixture,
            byteSize: 50 * 1024 * 1024,
            sha256Hex: "c".repeat(64),
            idempotencyKey: `${RUN_ID}:upload:01`,
        })).resolves.toEqual({ status: "service_unavailable" });
        expect(createSignedUploadUrl).not.toHaveBeenCalled();
        expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it("fails closed on RPC, storage, or instrumentation errors", async () => {
        const client = {
            rpc: vi.fn(async () => ({ data: null, error: { message: "secret backend detail" } })),
            storage: { from: vi.fn(() => ({ remove: vi.fn() })) },
            from: unusedFrom(),
        };
        const gateway = createInitialOperationsLoadGateway(client);
        await expect(gateway.executeOperation("checkpoint", context, { fixture, revision: 1 }))
            .resolves.toEqual({ status: "service_unavailable" });
        await expect(gateway.collectDatabase("after", context))
            .resolves.toEqual({ status: "service_unavailable" });
    });

    it("rejects unknown or malformed operation success payloads", async () => {
        const rpc = vi.fn(async (name: string) => ({
            data: name === "omr_list_active_attempt_sessions_v1"
                ? [{}]
                : { status: "unknown", revision: 2 },
            error: null,
        }));
        const client = { rpc, storage: { from: vi.fn(() => ({ remove: vi.fn() })) }, from: unusedFrom() };
        const gateway = createInitialOperationsLoadGateway(client);

        await expect(gateway.executeOperation("checkpoint", context, { fixture, revision: 1 }))
            .resolves.toEqual({ status: "service_unavailable" });
        await expect(gateway.executeOperation("teacher-live-read", {
            ...context,
            actorId: `poller_${SUFFIX}_01`,
        }, { fixture })).resolves.toEqual({ status: "service_unavailable" });
    });
});
