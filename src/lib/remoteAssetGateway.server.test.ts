import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
    finalizeTeacherRemoteAssetUploadWithGateway,
    prepareTeacherRemoteAssetUploadWithGateway,
    createStaffRemoteAssetSignedUrlWithGateway,
    createStudentProblemPdfSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "./remoteAssetGateway.server";

type SupabaseStorageBucket = ReturnType<SupabaseClient["storage"]["from"]>;
type SupabaseStorageInfo = NonNullable<Awaited<ReturnType<SupabaseStorageBucket["info"]>>["data"]>;

function authorizedTeacherIntent(overrides: Record<string, unknown> = {}) {
    return {
        id: "asset-1",
        organization_id: "org-1",
        exam_id: "exam-new",
        kind: "problem_pdf",
        created_by_user_id: "teacher-1",
        storage_bucket: "omr-private-assets",
        object_path: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
        mime_type: "application/pdf",
        byte_size: 1024,
        sha256_hex: "c".repeat(64),
        status: "uploaded",
        expires_at: "2026-08-06T02:00:00.000Z",
        ...overrides,
    };
}

function mockClient(options: {
    uploadError?: string;
    metadataError?: string;
    signedUrlError?: string;
} = {}) {
    const uploaded: Array<{ path: string; body: Uint8Array; options: Record<string, unknown> }> = [];
    const removed: string[][] = [];
    const signed: Array<{ path: string; expiresIn: number; options?: { download?: string } }> = [];
    const rows = new Map<string, Record<string, unknown>>();

    const bucket = {
        async upload(path: string, body: Uint8Array, uploadOptions: Record<string, unknown>) {
            uploaded.push({ path, body, options: uploadOptions });
            return options.uploadError
                ? { data: null, error: { message: options.uploadError } }
                : { data: { path }, error: null };
        },
        async createSignedUrl(path: string, expiresIn: number, signedOptions?: { download?: string }) {
            signed.push({ path, expiresIn, options: signedOptions });
            return options.signedUrlError
                ? { data: null, error: { message: options.signedUrlError } }
                : { data: { signedUrl: `https://storage.test/signed/${encodeURIComponent(path)}` }, error: null };
        },
        async remove(paths: string[]) {
            removed.push(paths);
            return { data: paths, error: null };
        },
    };

    const client: RemoteAssetSupabaseGatewayClient = {
        storage: {
            from(bucketName: string) {
                expect(bucketName).toBe("omr-private-assets");
                return bucket;
            },
        },
        async rpc(name, params) {
            expect(name).toBe("omr_save_remote_asset_metadata_v1");
            const row = params.p_asset as Record<string, unknown>;
            if (options.metadataError) return { data: null, error: { message: options.metadataError } };
            const existing = rows.get(String(row.id));
            if (existing && (
                existing.organization_id !== row.organization_id
                || existing.object_path !== row.object_path
                || existing.kind !== row.kind
            )) {
                return { data: null, error: { message: "remote asset identifier belongs to another scope" } };
            }
            rows.set(String(row.id), row);
            return { data: row, error: null };
        },
        from(table: "omr_remote_assets") {
            expect(table).toBe("omr_remote_assets");
            return {
                select() {
                    const filters: Array<[string, string]> = [];
                    const query = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return query;
                        },
                        async maybeSingle() {
                            const id = filters.find(([column]) => column === "id")?.[1] || "";
                            const row = rows.get(id) || null;
                            const matches = row && filters.every(([column, value]) => String(row[column] ?? "") === value);
                            return { data: matches ? row : null, error: null };
                        },
                    };
                    return query;
                },
            };
        },
    };

    return { client, uploaded, removed, signed, rows };
}

describe("remote asset Supabase gateway", () => {
    it("signs student downloads only for the exact problem PDF organization and exam scope", async () => {
        const { client, signed, rows } = mockClient();
        rows.set("asset-problem", {
            id: "asset-problem", organization_id: "org-1", kind: "problem_pdf", exam_id: "exam-1",
            attempt_id: null, storage_bucket: "omr-private-assets",
            object_path: "organizations/org-1/exams/exam-1/problem/asset-problem.pdf",
            mime_type: "application/pdf", byte_size: 1, sha256_hex: "a".repeat(64), original_name: "문제지.pdf",
            created_by_user_id: null, created_at: "2026-07-14T00:00:00.000Z", updated_at: "2026-07-14T00:00:00.000Z",
        });
        rows.set("asset-answer", {
            id: "asset-answer", organization_id: "org-1", kind: "answer_key_pdf", exam_id: "exam-1",
            attempt_id: null, storage_bucket: "omr-private-assets",
            object_path: "organizations/org-1/exams/exam-1/answer/asset-answer.pdf",
            mime_type: "application/pdf", byte_size: 1, sha256_hex: "b".repeat(64), original_name: null,
            created_by_user_id: null, created_at: "2026-07-14T00:00:00.000Z", updated_at: "2026-07-14T00:00:00.000Z",
        });

        await expect(createStudentProblemPdfSignedUrlWithGateway(client, {
            assetId: "asset-problem",
            organizationId: "org-1",
            examId: "exam-1",
            expiresIn: 86_400,
        })).resolves.toMatchObject({ status: "signed", expiresIn: 900 });
        await expect(createStudentProblemPdfSignedUrlWithGateway(client, {
            assetId: "asset-problem",
            organizationId: "org-1",
            examId: "other-exam",
        })).resolves.toEqual({ status: "scope_denied" });
        await expect(createStudentProblemPdfSignedUrlWithGateway(client, {
            assetId: "asset-answer",
            organizationId: "org-1",
            examId: "exam-1",
        })).resolves.toEqual({ status: "scope_denied" });
        await expect(createStudentProblemPdfSignedUrlWithGateway(client, {
            assetId: "asset-problem",
            organizationId: "org-2",
            examId: "exam-1",
        })).resolves.toEqual({ status: "not_found" });
        expect(signed).toHaveLength(1);
        expect(signed[0]).toMatchObject({ expiresIn: 900, options: { download: "문제지.pdf" } });
    });

    it("lets an already-authorized staff caller sign an exact answer or handwriting asset", async () => {
        const { client, rows } = mockClient();
        rows.set("asset-writing", {
            id: "asset-writing", organization_id: "org-1", kind: "attempt_handwriting", exam_id: null,
            attempt_id: "attempt-1", storage_bucket: "omr-private-assets",
            object_path: "organizations/org-1/attempts/attempt-1/handwriting/asset-writing.json",
            mime_type: "application/json", byte_size: 2, sha256_hex: "a".repeat(64), original_name: null,
            created_by_user_id: null, created_at: "2026-07-14T00:00:00.000Z", updated_at: "2026-07-14T00:00:00.000Z",
        });

        await expect(createStaffRemoteAssetSignedUrlWithGateway(client, {
            assetId: "asset-writing",
            organizationId: "org-1",
            kind: "attempt_handwriting",
            attemptId: "attempt-1",
        })).resolves.toMatchObject({ status: "signed" });
        await expect(createStaffRemoteAssetSignedUrlWithGateway(client, {
            assetId: "asset-writing",
            organizationId: "org-1",
            kind: "attempt_handwriting",
            attemptId: "attempt-2",
        })).resolves.toEqual({ status: "scope_denied" });
    });

    it("keeps the bucket private and metadata inaccessible to browser roles", () => {
        const migration = readFileSync(join(
            process.cwd(),
            "supabase/migrations/202607140005_remote_asset_storage.sql",
        ), "utf8");
        expect(migration).toContain("'omr-private-assets'");
        expect(migration).toMatch(/public,\s*\n\s*file_size_limit/);
        expect(migration).toContain("false,\n    52428800");
        expect(migration).toContain("alter table public.omr_remote_assets enable row level security");
        expect(migration).toContain("alter table public.omr_remote_assets force row level security");
        expect(migration).toContain("revoke all on table public.omr_remote_assets from anon");
        expect(migration).toContain("revoke all on table public.omr_remote_assets from authenticated");
        expect(migration).toContain("grant select, insert, update, delete on table public.omr_remote_assets to service_role");
        expect(migration).not.toMatch(/create policy[\s\S]*to\s+(anon|authenticated)/i);
    });
});

describe("teacher direct remote asset gateway", () => {
    it.each([
        ["teacher upload intent expired", "upload_intent_expired"],
        ["upload idempotency key belongs to another request", "upload_request_conflict"],
        ["upload exam identifier belongs to another organization", "upload_scope_denied"],
        ["teacher upload prepare rate exceeded", "upload_rate_limited"],
        ["teacher upload active intent limit exceeded", "upload_limit_exceeded"],
        ["teacher upload exam reservation required", "upload_reservation_required"],
    ])("maps SQL failure %s to stable code %s without leaking raw text", async (raw, errorCode) => {
        const client = {
            storage: { from: () => ({}) },
            rpc: async () => ({ data: null, error: { message: raw } }),
        };
        const result = await prepareTeacherRemoteAssetUploadWithGateway(client as never, {
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
            idempotencyKey: "upload-01JABCDEF0123456789",
            createdByUserId: "teacher-1",
        });
        expect(result).toMatchObject({ status: "metadata_unavailable", errorCode });
        if (result.status === "prepared") throw new Error("expected prepare failure");
        expect(result.error).not.toContain(raw);
    });

    it("prepares a body-less signed upload and selects TUS above 6 MiB", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const signed: string[] = [];
        const client = {
            storage: {
                from() {
                    return {
                        async createSignedUploadUrl(path: string, options: { upsert: false }) {
                            signed.push(path);
                            expect(options).toEqual({ upsert: false });
                            return { data: { signedUrl: `https://storage.test/${path}?token=t`, path, token: "token" }, error: null };
                        },
                    };
                },
            },
            async rpc(name: string, params: Record<string, unknown>) {
                calls.push({ name, params });
                return { data: { ...(params.p_upload as Record<string, unknown>), status: "pending" }, error: null };
            },
        };

        const result = await prepareTeacherRemoteAssetUploadWithGateway(client as never, {
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            byteSize: 7 * 1024 * 1024,
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
            originalName: "problem.pdf",
            idempotencyKey: "upload-01JABCDEF0123456789",
            createdByUserId: "teacher-1",
        }, { now: "2026-08-06T00:00:00.000Z" });

        expect(result).toMatchObject({
            status: "prepared",
            mode: "tus",
            token: "token",
            expiresAt: "2026-08-06T02:00:00.000Z",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe("omr_prepare_teacher_asset_upload_v2");
        expect(signed).toHaveLength(1);
    });

    it("returns the authoritative stored expiry on an idempotent prepare retry", async () => {
        const client = {
            storage: { from: () => ({
                createSignedUploadUrl: async (path: string) => ({
                    data: { signedUrl: `https://storage.test/${path}?token=t`, path, token: "token" },
                    error: null,
                }),
            }) },
            rpc: async (_name: string, params: Record<string, unknown>) => ({
                data: {
                    ...(params.p_upload as Record<string, unknown>),
                    expires_at: "2026-08-06T01:00:00.000Z",
                    status: "pending",
                },
                error: null,
            }),
        };
        const result = await prepareTeacherRemoteAssetUploadWithGateway(client as never, {
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
            idempotencyKey: "upload-01JABCDEF0123456789",
            createdByUserId: "teacher-1",
        }, { now: "2026-08-06T00:30:00.000Z" });
        expect(result).toMatchObject({ status: "prepared", expiresAt: "2026-08-06T01:00:00.000Z" });
    });

    it("never mints a new signed upload capability for a finalized prepare replay", async () => {
        const storage = vi.fn();
        const client = {
            storage: { from: storage },
            rpc: async (_name: string, params: Record<string, unknown>) => ({
                data: {
                    ...(params.p_upload as Record<string, unknown>),
                    status: "finalized",
                    capabilityReplay: true,
                },
                error: null,
            }),
        };
        const result = await prepareTeacherRemoteAssetUploadWithGateway(client as never, {
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
            idempotencyKey: "upload-01JABCDEF0123456789",
            createdByUserId: "teacher-1",
        });
        expect(result).toMatchObject({ status: "metadata_unavailable", errorCode: "upload_request_conflict" });
        expect(storage).not.toHaveBeenCalled();
    });

    it("authorizes finalize intent scope before any Storage lookup and exposes only a stable denial", async () => {
        const events: string[] = [];
        const client = {
            storage: {
                from() {
                    events.push("storage");
                    throw new Error("Storage must not be queried before scope authorization");
                },
            },
            async rpc(name: string) {
                events.push(name);
                return {
                    data: null,
                    error: { message: "private object exists for another actor raw-object-secret" },
                };
            },
        };

        const result = await finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "c".repeat(64),
            createdByUserId: "teacher-1",
        });

        expect(events).toEqual(["omr_authorize_teacher_asset_finalize_v2"]);
        expect(result).toEqual({
            status: "metadata_unavailable",
            error: "Teacher upload scope denied",
            errorCode: "upload_scope_denied",
        });
        expect(JSON.stringify(result)).not.toContain("raw-object-secret");
    });

    it("distinguishes a finalize authorization outage from a real scope denial", async () => {
        const client = {
            storage: { from: () => { throw new Error("must not inspect Storage"); } },
            async rpc() {
                return {
                    data: null,
                    error: { message: "upstream connection timed out raw-database-host" },
                };
            },
        };

        const result = await finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "c".repeat(64),
            createdByUserId: "teacher-1",
        });

        expect(result).toEqual({
            status: "metadata_unavailable",
            error: "Teacher upload service unavailable",
            errorCode: "upload_unavailable",
        });
        expect(JSON.stringify(result)).not.toContain("raw-database-host");
    });

    it("does not expose raw Storage lookup errors after finalize preauthorization", async () => {
        const client = {
            storage: { from: () => ({
                info: async () => ({ data: null, error: { message: "bucket-internal raw-object-secret" } }),
            }) },
            rpc: async () => ({
                data: {
                    id: "asset-1",
                    organization_id: "org-1",
                    exam_id: "exam-new",
                    kind: "problem_pdf",
                    created_by_user_id: "teacher-1",
                    storage_bucket: "omr-private-assets",
                    object_path: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
                    mime_type: "application/pdf",
                    byte_size: 1024,
                    sha256_hex: "c".repeat(64),
                    status: "uploaded",
                    expires_at: "2026-08-06T02:00:00.000Z",
                },
                error: null,
            }),
        };

        const result = await finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "c".repeat(64),
            createdByUserId: "teacher-1",
        });

        expect(result).toEqual({
            status: "storage_unavailable",
            error: "Teacher upload storage unavailable",
            errorCode: "upload_unavailable",
        });
        expect(JSON.stringify(result)).not.toContain("raw-object-secret");
    });

    it("maps a thrown Storage lookup failure to the same stable public error", async () => {
        const client = {
            storage: { from: () => ({
                info: async () => { throw new Error("thrown raw-object-secret"); },
            }) },
            rpc: async () => ({ data: authorizedTeacherIntent(), error: null }),
        };

        const result = await finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "c".repeat(64),
            createdByUserId: "teacher-1",
        });

        expect(result).toEqual({
            status: "storage_unavailable",
            error: "Teacher upload storage unavailable",
            errorCode: "upload_unavailable",
        });
        expect(JSON.stringify(result)).not.toContain("raw-object-secret");
    });

    it.each(["uploaded", "finalized"])(
        "finalizes an exact %s intent, including a response-loss retry, without downloading its body",
        async authorizedStatus => {
        const rpcCalls: string[] = [];
        const storageInfo = {
            id: "storage-object-1",
            version: "1",
            name: "asset-1.pdf",
            bucketId: "omr-private-assets",
            createdAt: "2026-08-06T00:00:00.000Z",
            size: 1024,
            contentType: "application/pdf",
            metadata: {
                eTag: "etag",
                size: 1024,
                mimetype: "application/pdf",
                cacheControl: "max-age=300",
                lastModified: "2026-08-06T00:00:00.000Z",
                contentLength: 1024,
                httpStatusCode: 200,
                sha256Hex: "c".repeat(64),
            },
        } satisfies SupabaseStorageInfo;
        const bucket = {
            async createSignedUrl() {
                return { data: { signedUrl: "https://storage.test/object.pdf?token=read" }, error: null };
            },
            async info() {
                return {
                    data: storageInfo,
                    error: null,
                };
            },
        };
        const client = {
            storage: { from: () => bucket },
            async rpc(name: string) {
                rpcCalls.push(name);
                if (name === "omr_authorize_teacher_asset_finalize_v2") {
                    return { data: authorizedTeacherIntent({ status: authorizedStatus }), error: null };
                }
                return {
                    data: {
                        id: "asset-1",
                        organization_id: "org-1",
                        kind: "problem_pdf",
                        exam_id: "exam-new",
                        storage_bucket: "omr-private-assets",
                        object_path: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
                        mime_type: "application/pdf",
                        byte_size: 1024,
                        sha256_hex: "c".repeat(64),
                        original_name: "problem.pdf",
                        created_by_user_id: "teacher-1",
                        created_at: "2026-08-06T00:00:00.000Z",
                        updated_at: "2026-08-06T00:00:00.000Z",
                    },
                    error: null,
                };
            },
        };

        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(new Headers(init?.headers).get("range")).toBe("bytes=0-4");
            return new Response("%PDF-", {
                status: 206,
                headers: { "content-range": "bytes 0-4/1024" },
            });
        });
        const result = await finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "c".repeat(64),
            createdByUserId: "teacher-1",
        }, { fetchImpl: fetchImpl as typeof fetch });

        expect(result).toMatchObject({
            status: "finalized",
            asset: { id: "asset-1", originalName: "problem.pdf", createdAt: "2026-08-06T00:00:00.000Z" },
        });
        expect(rpcCalls).toEqual([
            "omr_authorize_teacher_asset_finalize_v2",
            "omr_finalize_teacher_asset_upload_v2",
        ]);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(bucket).not.toHaveProperty("download");
        },
    );

    it("rejects an object whose bounded Storage prefix is not PDF magic", async () => {
        const client = {
            storage: { from: () => ({
                createSignedUrl: async () => ({ data: { signedUrl: "https://storage.test/object?token=read" }, error: null }),
                info: async () => ({
                    data: { size: 5, contentType: "application/pdf", metadata: { sha256Hex: "e".repeat(64) } },
                    error: null,
                }),
            }) },
            rpc: async (name: string) => {
                if (name === "omr_authorize_teacher_asset_finalize_v2") {
                    return { data: authorizedTeacherIntent({ byte_size: 5, sha256_hex: "e".repeat(64) }), error: null };
                }
                throw new Error("must not finalize");
            },
        };
        await expect(finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 5,
            mimeType: "application/pdf",
            sha256Hex: "e".repeat(64),
            createdByUserId: "teacher-1",
        }, {
            fetchImpl: async () => new Response("HELLO", {
                status: 206,
                headers: { "content-range": "bytes 0-4/5" },
            }),
        })).resolves.toEqual({ status: "invalid_object", error: "storage_pdf_magic_mismatch" });
    });

    it("rejects Storage metadata that differs from the signed declaration", async () => {
        const client = {
            storage: { from: () => ({
                async info() {
                    return { data: { size: 999, contentType: "application/pdf", metadata: { sha256Hex: "d".repeat(64) } }, error: null };
                },
            }) },
            rpc: async () => ({
                data: authorizedTeacherIntent({ sha256_hex: "d".repeat(64) }),
                error: null,
            }),
        };
        await expect(finalizeTeacherRemoteAssetUploadWithGateway(client as never, {
            uploadId: "asset-1",
            organizationId: "org-1",
            examId: "exam-new",
            kind: "problem_pdf",
            objectPath: "organizations/org-1/exams/exam-new/problem/asset-1.pdf",
            byteSize: 1024,
            mimeType: "application/pdf",
            sha256Hex: "d".repeat(64),
            createdByUserId: "teacher-1",
        })).resolves.toEqual({ status: "invalid_object", error: "storage_size_mismatch" });
    });
});
