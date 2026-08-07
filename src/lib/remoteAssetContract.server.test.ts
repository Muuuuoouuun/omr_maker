import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    REMOTE_ASSET_MAX_SIGNED_URL_TTL_SECONDS,
    REMOTE_ASSET_SIGNED_URL_TTL_SECONDS,
    REMOTE_HANDWRITING_MAX_BYTES,
    REMOTE_PDF_MAX_BYTES,
    buildRemoteAssetObjectPath,
    isRemoteAssetUploadByteSizeAllowed,
    normalizeRemoteAssetSignedUrlTtl,
    remoteAssetRecordFromRow,
    validateRemoteAssetUpload,
    buildTeacherRemoteAssetUploadIdentity,
    validateTeacherRemoteAssetUploadDeclaration,
} from "./remoteAssetContract.server";

describe("remote asset server contract", () => {
    it("builds immutable organization-scoped paths for each private asset kind", () => {
        expect(buildRemoteAssetObjectPath({
            organizationId: "teacher_abc1234",
            examId: "exam-1",
            kind: "problem_pdf",
            assetId: "asset-1",
        })).toBe("organizations/teacher_abc1234/exams/exam-1/problem/asset-1.pdf");
        expect(buildRemoteAssetObjectPath({
            organizationId: "teacher_abc1234",
            examId: "exam-1",
            kind: "answer_key_pdf",
            assetId: "asset-2",
        })).toBe("organizations/teacher_abc1234/exams/exam-1/answer-key/asset-2.pdf");
        expect(buildRemoteAssetObjectPath({
            organizationId: "teacher_abc1234",
            attemptId: "attempt-1",
            kind: "attempt_handwriting",
            assetId: "asset-3",
        })).toBe("organizations/teacher_abc1234/attempts/attempt-1/handwriting/asset-3.json");
    });

    it("rejects traversal, ambiguous owners, empty bodies, and oversized handwriting", () => {
        const byte = new Uint8Array([1]);
        expect(buildRemoteAssetObjectPath({
            organizationId: "../other",
            examId: "exam-1",
            kind: "problem_pdf",
            assetId: "asset-1",
        })).toBeNull();
        expect(validateRemoteAssetUpload({
            organizationId: "org-1",
            examId: "exam-1",
            attemptId: "attempt-1",
            kind: "problem_pdf",
            body: byte,
        })).toEqual({ ok: false, error: "invalid_owner" });
        expect(validateRemoteAssetUpload({
            organizationId: "org-1",
            examId: "exam-1",
            kind: "problem_pdf",
            body: new Uint8Array(),
        })).toEqual({ ok: false, error: "invalid_body" });
        expect(validateRemoteAssetUpload({
            organizationId: "org-1",
            attemptId: "attempt-1",
            kind: "attempt_handwriting",
            body: new Uint8Array(10 * 1024 * 1024 + 1),
        })).toEqual({ ok: false, error: "asset_too_large" });
    });

    it("exposes allocation-free upload size checks for server action preflight", () => {
        expect(isRemoteAssetUploadByteSizeAllowed("problem_pdf", REMOTE_PDF_MAX_BYTES)).toBe(true);
        expect(isRemoteAssetUploadByteSizeAllowed("answer_key_pdf", REMOTE_PDF_MAX_BYTES + 1)).toBe(false);
        expect(isRemoteAssetUploadByteSizeAllowed("attempt_handwriting", REMOTE_HANDWRITING_MAX_BYTES)).toBe(true);
        expect(isRemoteAssetUploadByteSizeAllowed("attempt_handwriting", 0)).toBe(false);
    });

    it("sanitizes display names without using them in object paths", () => {
        const result = validateRemoteAssetUpload({
            organizationId: "org-1",
            examId: "exam-1",
            kind: "problem_pdf",
            body: new Uint8Array([1]),
            originalName: "../중간/고사.pdf",
        });
        expect(result).toMatchObject({
            ok: true,
            originalName: ".._중간_고사.pdf",
            mimeType: "application/pdf",
        });
    });

    it("clamps signed URL lifetime to a short server-defined window", () => {
        expect(normalizeRemoteAssetSignedUrlTtl()).toBe(REMOTE_ASSET_SIGNED_URL_TTL_SECONDS);
        expect(normalizeRemoteAssetSignedUrlTtl(1)).toBe(60);
        expect(normalizeRemoteAssetSignedUrlTtl(86_400)).toBe(REMOTE_ASSET_MAX_SIGNED_URL_TTL_SECONDS);
    });

    it("rejects metadata rows whose bucket or path escapes the organization scope", () => {
        const base = {
            id: "asset-1",
            organization_id: "org-1",
            kind: "problem_pdf",
            exam_id: "exam-1",
            attempt_id: null,
            storage_bucket: "omr-private-assets",
            object_path: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
            mime_type: "application/pdf",
            byte_size: 100,
            sha256_hex: "a".repeat(64),
            created_at: "2026-07-14T00:00:00.000Z",
            updated_at: "2026-07-14T00:00:00.000Z",
        };
        expect(remoteAssetRecordFromRow(base)).toMatchObject({ id: "asset-1", organizationId: "org-1" });
        expect(remoteAssetRecordFromRow({ ...base, storage_bucket: "public" })).toBeNull();
        expect(remoteAssetRecordFromRow({
            ...base,
            object_path: "organizations/org-2/exams/exam-1/problem/asset-1.pdf",
        })).toBeNull();
    });

    it("does not expose the removed remote clone/delete lifecycle while preserving upload and signing", () => {
        const action = readFileSync(resolve(process.cwd(), "src/app/actions/remoteAssets.ts"), "utf8");
        const gateway = readFileSync(resolve(process.cwd(), "src/lib/remoteAssetGateway.server.ts"), "utf8");
        expect(action).not.toContain("cloneTeacherExamAsset");
        expect(action).not.toContain("deleteTeacherExamAssetClone");
        expect(gateway).not.toContain("cloneRemoteExamAssetWithGateway");
        expect(gateway).not.toContain("deleteRemoteExamAssetCloneWithGateway");
        expect(action).not.toContain("uploadTeacherExamAsset(");
        expect(action).not.toContain("formData: FormData");
        expect(action).not.toContain("file.arrayBuffer()");
        expect(action).not.toContain("error instanceof Error ? error.message");
        expect(action).toContain('errorCode: "upload_unavailable"');
        expect(action).toContain("prepareTeacherExamAssetUpload");
        expect(action).toContain("finalizeTeacherExamAssetUpload");
        expect(action).toContain("getTeacherRemoteAssetUrl");
        expect(gateway).toContain("uploadRemoteAssetWithGateway");
        expect(gateway).toContain("createStaffRemoteAssetSignedUrlWithGateway");
    });
});

describe("teacher direct remote asset declarations", () => {
    it("binds an idempotency key to one stable asset id and immutable path", () => {
        const declaration = {
            organizationId: "org-1",
            examId: "exam-1",
            kind: "problem_pdf" as const,
            byteSize: 7 * 1024 * 1024,
            mimeType: "application/pdf" as const,
            sha256Hex: "a".repeat(64),
            originalName: "중간고사.pdf",
            idempotencyKey: "upload-01JABCDEF0123456789",
            createdByUserId: "teacher-1",
        };

        expect(validateTeacherRemoteAssetUploadDeclaration(declaration)).toMatchObject({
            ok: true,
            byteSize: declaration.byteSize,
            sha256Hex: declaration.sha256Hex,
        });
        const first = buildTeacherRemoteAssetUploadIdentity(declaration);
        const retry = buildTeacherRemoteAssetUploadIdentity({ ...declaration });
        expect(retry).toEqual(first);
        expect(buildTeacherRemoteAssetUploadIdentity({
            ...declaration,
            createdByUserId: "teacher-2",
        }).assetId).not.toBe(first.assetId);
        expect(first.assetId).toMatch(/^asset_[a-f0-9]{32}$/);
        expect(first.objectPath).toBe(
            `organizations/org-1/exams/exam-1/problem/${first.assetId}.pdf`,
        );
    });

    it("rejects non-PDF declarations, invalid hashes, unsafe idempotency keys, and oversized files", () => {
        const valid = {
            organizationId: "org-1",
            examId: "exam-1",
            kind: "answer_key_pdf" as const,
            byteSize: 123,
            mimeType: "application/pdf" as const,
            sha256Hex: "b".repeat(64),
            idempotencyKey: "upload-01JABCDEF0123456789",
        };
        expect(validateTeacherRemoteAssetUploadDeclaration({ ...valid, mimeType: "text/plain" as never }))
            .toEqual({ ok: false, error: "invalid_mime_type" });
        expect(validateTeacherRemoteAssetUploadDeclaration({ ...valid, sha256Hex: "bad" }))
            .toEqual({ ok: false, error: "invalid_sha256" });
        expect(validateTeacherRemoteAssetUploadDeclaration({ ...valid, idempotencyKey: "../escape" }))
            .toEqual({ ok: false, error: "invalid_idempotency_key" });
        expect(validateTeacherRemoteAssetUploadDeclaration({ ...valid, byteSize: REMOTE_PDF_MAX_BYTES + 1 }))
            .toEqual({ ok: false, error: "asset_too_large" });
    });
});
