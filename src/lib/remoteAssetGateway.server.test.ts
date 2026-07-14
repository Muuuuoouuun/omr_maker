import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    createStaffRemoteAssetSignedUrlWithGateway,
    createStudentProblemPdfSignedUrlWithGateway,
    uploadRemoteAssetWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "./remoteAssetGateway.server";

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
        from(table: "omr_remote_assets") {
            expect(table).toBe("omr_remote_assets");
            return {
                async upsert(row: Record<string, unknown>) {
                    if (options.metadataError) return { data: null, error: { message: options.metadataError } };
                    rows.set(String(row.id), row);
                    return { data: row, error: null };
                },
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
    it("uploads a private immutable object and stores organization-scoped metadata", async () => {
        const { client, uploaded, rows } = mockClient();
        const result = await uploadRemoteAssetWithGateway(client, {
            organizationId: "org-1",
            examId: "exam-1",
            kind: "problem_pdf",
            body: new Uint8Array([1, 2, 3]),
            originalName: "중간고사.pdf",
            createdByUserId: "teacher-1",
        }, {
            assetId: "asset-1",
            now: "2026-07-14T00:00:00.000Z",
        });

        expect(result).toMatchObject({
            status: "uploaded",
            asset: {
                id: "asset-1",
                organizationId: "org-1",
                examId: "exam-1",
                kind: "problem_pdf",
                objectPath: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
                sha256Hex: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            },
        });
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0].options).toMatchObject({
            contentType: "application/pdf",
            cacheControl: "300",
            upsert: false,
        });
        expect(rows.get("asset-1")).toMatchObject({
            organization_id: "org-1",
            exam_id: "exam-1",
            attempt_id: null,
            storage_bucket: "omr-private-assets",
        });
    });

    it("removes an uploaded object when metadata persistence fails", async () => {
        const { client, removed } = mockClient({ metadataError: "db unavailable" });
        const result = await uploadRemoteAssetWithGateway(client, {
            organizationId: "org-1",
            attemptId: "attempt-1",
            kind: "attempt_handwriting",
            body: new TextEncoder().encode('{"1":["M0 0"]}'),
        }, { assetId: "asset-handwriting" });

        expect(result).toEqual({ status: "metadata_unavailable", error: "db unavailable" });
        expect(removed).toEqual([["organizations/org-1/attempts/attempt-1/handwriting/asset-handwriting.json"]]);
    });

    it("signs student downloads only for the exact problem PDF organization and exam scope", async () => {
        const { client, signed } = mockClient();
        await uploadRemoteAssetWithGateway(client, {
            organizationId: "org-1",
            examId: "exam-1",
            kind: "problem_pdf",
            body: new Uint8Array([1]),
            originalName: "문제지.pdf",
        }, { assetId: "asset-problem" });
        await uploadRemoteAssetWithGateway(client, {
            organizationId: "org-1",
            examId: "exam-1",
            kind: "answer_key_pdf",
            body: new Uint8Array([2]),
        }, { assetId: "asset-answer" });

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
        const { client } = mockClient();
        await uploadRemoteAssetWithGateway(client, {
            organizationId: "org-1",
            attemptId: "attempt-1",
            kind: "attempt_handwriting",
            body: new TextEncoder().encode("{}"),
        }, { assetId: "asset-writing" });

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
