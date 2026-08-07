import { describe, expect, it, vi } from "vitest";
import {
    sha256FileHex,
    uploadTeacherPdfDirect,
    uploadStandardSignedTeacherAsset,
    uploadTusSignedTeacherAsset,
    type TeacherDirectUploadPrepared,
} from "./directTeacherAssetUpload.client";

function pdfFile(size = 8): File {
    const bytes = new TextEncoder().encode("%PDF-1.7");
    return new File([size === bytes.length ? bytes : new Uint8Array(size).fill(7)], "problem.pdf", { type: "application/pdf" });
}

function prepared(overrides: Partial<TeacherDirectUploadPrepared> = {}): TeacherDirectUploadPrepared {
    return {
        status: "prepared",
        uploadId: "asset-1",
        assetId: "asset-1",
        organizationId: "org-1",
        examId: "exam-1",
        kind: "problem_pdf",
        bucket: "omr-private-assets",
        objectPath: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
        byteSize: 8,
        mimeType: "application/pdf",
        sha256Hex: "86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b",
        originalName: "problem.pdf",
        signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/path?token=signed",
        token: "signed-token",
        mode: "standard",
        expiresAt: "2026-08-06T02:00:00.000Z",
        ...overrides,
    };
}

describe("teacher browser-direct PDF upload", () => {
    it("hashes large files incrementally without reading the complete File into memory", async () => {
        const bytes = new TextEncoder().encode("0123456789abcdef".repeat(1_024));
        const file = new File([bytes], "large.pdf", { type: "application/pdf" });
        const fullRead = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("full read forbidden"));
        const originalSlice = file.slice.bind(file);
        const sliceSizes: number[] = [];
        vi.spyOn(file, "slice").mockImplementation((start, end, contentType) => {
            sliceSizes.push(Number(end) - Number(start));
            return originalSlice(start, end, contentType);
        });
        const yieldControl = vi.fn(async () => undefined);

        await expect(sha256FileHex(file, {
            chunkBytes: 1_024,
            yieldControl,
        })).resolves.toBe("4ba5baf48e86e67f8c41052aea1fed7638c7c81523f1f036cb998b8d38d3483c");

        expect(fullRead).not.toHaveBeenCalled();
        expect(sliceSizes.length).toBeGreaterThan(1);
        expect(Math.max(...sliceSizes)).toBeLessThanOrEqual(1_024);
        expect(yieldControl).toHaveBeenCalled();
    });

    it("passes only a declaration through actions and sends bytes to the signed storage transport", async () => {
        const file = pdfFile();
        const prepare = vi.fn(async (input: Record<string, unknown>) => {
            void input;
            return prepared();
        });
        const finalize = vi.fn(async (input: Record<string, unknown>) => {
            void input;
            return {
                status: "uploaded" as const,
                ref: { store: "remote" as const, key: "asset-1" },
            };
        });
        const standard = vi.fn(async (fileInput: File, preparedInput: TeacherDirectUploadPrepared) => {
            void fileInput;
            void preparedInput;
        });

        await expect(uploadTeacherPdfDirect({ file, examId: "exam-1", kind: "problem_pdf", attemptNonce: "nonce-0001" }, {
            prepare,
            finalize,
        }, { standard, tus: vi.fn() })).resolves.toMatchObject({ status: "uploaded" });

        expect(prepare).toHaveBeenCalledOnce();
        expect(prepare.mock.calls[0][0]).not.toHaveProperty("file");
        expect(prepare.mock.calls[0][0]).not.toHaveProperty("body");
        expect(prepare.mock.calls[0][0]).toMatchObject({
            examId: "exam-1",
            kind: "problem_pdf",
            byteSize: file.size,
            mimeType: "application/pdf",
            sha256Hex: prepared().sha256Hex,
        });
        expect(standard).toHaveBeenCalledWith(file, expect.objectContaining({ uploadId: "asset-1" }));
        expect(finalize.mock.calls[0][0]).not.toHaveProperty("file");
    });

    it("uses signed TUS for a prepared object above the standard-upload threshold", async () => {
        const file = pdfFile();
        const tus = vi.fn(async () => undefined);
        await uploadTeacherPdfDirect({ file, examId: "exam-1", kind: "problem_pdf", attemptNonce: "nonce-0001" }, {
            prepare: async () => prepared({ mode: "tus" }),
            finalize: async () => ({ status: "uploaded", ref: { store: "remote", key: "asset-1" } }),
        }, { standard: vi.fn(), tus });
        expect(tus).toHaveBeenCalledWith(file, expect.objectContaining({ mode: "tus" }));
    });

    it("finalizes after an ambiguous upload response so a committed retry is idempotent", async () => {
        const finalize = vi.fn(async () => ({
            status: "uploaded" as const,
            ref: { store: "remote" as const, key: "asset-1" },
        }));
        await expect(uploadTeacherPdfDirect({ file: pdfFile(), examId: "exam-1", kind: "problem_pdf", attemptNonce: "nonce-0001" }, {
            prepare: async () => prepared(),
            finalize,
        }, {
            standard: async () => { throw new Error("connection reset after upload"); },
            tus: vi.fn(),
        })).resolves.toMatchObject({ status: "uploaded" });
        expect(finalize).toHaveBeenCalledOnce();
    });

    it("rejects a renamed non-PDF before preparing any server intent", async () => {
        const prepare = vi.fn();
        const renamed = new File(["not a pdf"], "fake.pdf", { type: "application/pdf" });
        await expect(uploadTeacherPdfDirect({ file: renamed, examId: "exam-1", kind: "problem_pdf", attemptNonce: "nonce-0001" }, {
            prepare,
            finalize: vi.fn(),
        } as never)).rejects.toThrow("valid PDF");
        expect(prepare).not.toHaveBeenCalled();
    });

    it.each(["", "application/x-pdf"])(
        "accepts PDF magic with legacy browser MIME %j without trusting the file extension",
        async type => {
        const bytes = new TextEncoder().encode("%PDF-1.7");
        const file = new File([bytes], "legacy-upload", { type });
        const prepare = vi.fn(async () => prepared({ originalName: file.name }));
        const standard = vi.fn(async (uploadFile: File, declaration: TeacherDirectUploadPrepared) => {
            void uploadFile;
            void declaration;
        });

        await expect(uploadTeacherPdfDirect({
            file,
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "nonce-0001",
        }, {
            prepare,
            finalize: async () => ({ status: "uploaded", ref: { store: "remote", key: "asset-1" } }),
        }, { standard, tus: vi.fn() })).resolves.toMatchObject({ status: "uploaded" });

        expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
            mimeType: "application/pdf",
            originalName: "legacy-upload",
        }));
        expect(standard.mock.calls[0][0]).toMatchObject({
            name: "legacy-upload",
            type: "application/pdf",
        });
        },
    );

    it("reuses one persisted attempt nonce on response loss but scopes it to the exam", async () => {
        const keys: string[] = [];
        const actions = {
            prepare: async (input: { idempotencyKey: string; originalName: string }) => {
                keys.push(input.idempotencyKey);
                return prepared({ originalName: input.originalName, examId: keys.length === 3 ? "exam-2" : "exam-1" });
            },
            finalize: async () => ({
                status: "uploaded" as const,
                ref: { store: "remote" as const, key: "asset-1" },
            }),
        };
        const bytes = new TextEncoder().encode("%PDF-1.7");
        const transports = { standard: async () => undefined, tus: async () => undefined };
        await uploadTeacherPdfDirect({
            file: new File([bytes], "problem.pdf", { type: "application/pdf" }),
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "persisted-nonce-1",
        }, actions, transports);
        await uploadTeacherPdfDirect({
            file: new File([bytes], "problem.pdf", { type: "application/pdf" }),
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "persisted-nonce-1",
        }, actions, transports);
        await uploadTeacherPdfDirect({
            file: new File([bytes], "problem.pdf", { type: "application/pdf" }),
            examId: "exam-2",
            kind: "problem_pdf",
            attemptNonce: "persisted-nonce-1",
        }, actions, transports);
        expect(keys).toHaveLength(3);
        expect(keys[1]).toBe(keys[0]);
        expect(keys[2]).not.toBe(keys[0]);
    });

    it("includes the content hash in idempotency identity when metadata and nonce are unchanged", async () => {
        const keys: string[] = [];
        const actions = {
            prepare: async (input: { idempotencyKey: string; sha256Hex: string }) => {
                keys.push(input.idempotencyKey);
                return prepared({ sha256Hex: input.sha256Hex });
            },
            finalize: async () => ({
                status: "uploaded" as const,
                ref: { store: "remote" as const, key: "asset-1" },
            }),
        };
        const metadata = { type: "application/pdf", lastModified: 1_000 };
        const first = new File(["%PDF-1.7"], "same.pdf", metadata);
        const changed = new File(["%PDF-2.0"], "same.pdf", metadata);
        const transports = { standard: async () => undefined, tus: async () => undefined };

        await uploadTeacherPdfDirect({
            file: first,
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "persisted-nonce-1",
        }, actions, transports);
        await uploadTeacherPdfDirect({
            file: changed,
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "persisted-nonce-1",
        }, actions, transports);

        expect(keys).toHaveLength(2);
        expect(keys[1]).not.toBe(keys[0]);
    });

    it("rotates the persisted nonce and retries once only for an explicit expired intent", async () => {
        const prepare = vi.fn(async (input: { idempotencyKey: string }) => {
            void input;
            return prepare.mock.calls.length === 1
                ? { status: "invalid_asset" as const, errorCode: "upload_intent_expired" as const }
                : prepared();
        });
        const rotateAttemptNonce = vi.fn(() => "nonce-0002");
        await expect(uploadTeacherPdfDirect({
            file: pdfFile(),
            examId: "exam-1",
            kind: "problem_pdf",
            attemptNonce: "nonce-0001",
            rotateAttemptNonce,
        }, {
            prepare,
            finalize: async () => ({ status: "uploaded", ref: { store: "remote", key: "asset-1" } }),
        }, { standard: async () => undefined, tus: async () => undefined })).resolves.toMatchObject({ status: "uploaded" });
        expect(rotateAttemptNonce).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(prepare.mock.calls[1][0].idempotencyKey).not.toBe(prepare.mock.calls[0][0].idempotencyKey);
    });

    it("configures TUS with 6 MiB chunks, direct storage hostname, immutable object name, and signed token", async () => {
        let options: Record<string, unknown> | undefined;
        class FakeUpload {
            constructor(_file: File, received: Record<string, unknown>) {
                options = received;
            }
            start() {
                (options?.onSuccess as (() => void))();
            }
        }
        await uploadTusSignedTeacherAsset(pdfFile(), prepared({ mode: "tus" }), FakeUpload as never);
        expect(options).toMatchObject({
            endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable",
            chunkSize: 6 * 1024 * 1024,
            headers: { "x-signature": "signed-token" },
            uploadDataDuringCreation: true,
            removeFingerprintOnSuccess: true,
            metadata: {
                bucketName: "omr-private-assets",
                objectName: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
                contentType: "application/pdf",
            },
        });
        expect(JSON.parse((options?.metadata as { metadata: string }).metadata)).toEqual({
            sha256Hex: prepared().sha256Hex,
            uploadId: "asset-1",
        });
    });

    it("uses a no-upsert signed PUT with exact SHA metadata for standard uploads", async () => {
        const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            void url;
            void init;
            return new Response(null, { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);
        const file = pdfFile();
        await uploadStandardSignedTeacherAsset(file, prepared());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(prepared().signedUrl);
        expect(init).toMatchObject({ method: "PUT", headers: { "x-upsert": "false" } });
        const form = init?.body as FormData;
        expect(form.get("metadata")).toBe(JSON.stringify({
            sha256Hex: prepared().sha256Hex,
            uploadId: "asset-1",
        }));
        expect(form.get("")).toBe(file);
        vi.unstubAllGlobals();
    });
});
