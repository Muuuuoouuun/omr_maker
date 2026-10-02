"use client";

import { sha256 } from "@noble/hashes/sha256";
import type { UploadOptions } from "tus-js-client";
import type { StoredDataRef } from "@/types/omr";

export interface TeacherDirectUploadPrepared {
    status: "prepared";
    uploadId: string;
    assetId: string;
    organizationId: string;
    examId: string;
    kind: "problem_pdf" | "answer_key_pdf";
    bucket: "omr-private-assets";
    objectPath: string;
    byteSize: number;
    mimeType: "application/pdf";
    sha256Hex: string;
    originalName?: string;
    signedUrl: string;
    token: string;
    mode: "standard" | "tus";
    expiresAt: string;
}

type PrepareResult = TeacherDirectUploadPrepared
    | {
        status: "local_only" | "unauthorized" | "invalid_asset" | "service_unavailable";
        error?: string;
        errorCode?: string;
    };
type FinalizeResult = { status: "uploaded"; ref: StoredDataRef }
    | {
        status: "unauthorized" | "invalid_asset" | "service_unavailable";
        error?: string;
        errorCode?: string;
    };

interface TeacherDirectUploadActions {
    prepare(input: {
        examId: string;
        kind: "problem_pdf" | "answer_key_pdf";
        byteSize: number;
        mimeType: "application/pdf";
        sha256Hex: string;
        idempotencyKey: string;
        originalName: string;
    }): Promise<PrepareResult>;
    finalize(input: {
        uploadId: string;
        examId: string;
        kind: "problem_pdf" | "answer_key_pdf";
        objectPath: string;
        byteSize: number;
        mimeType: "application/pdf";
        sha256Hex: string;
        originalName?: string;
    }): Promise<FinalizeResult>;
}

interface TeacherDirectUploadTransports {
    standard(file: File, prepared: TeacherDirectUploadPrepared): Promise<void>;
    tus(file: File, prepared: TeacherDirectUploadPrepared): Promise<void>;
}

interface TusUploadInstance {
    start(): void;
}

type TusUploadConstructor = new (file: File, options: UploadOptions) => TusUploadInstance;

function errorText(result: { status: string; error?: string }): string {
    return result.error || `Teacher PDF upload failed (${result.status})`;
}

const DEFAULT_FILE_HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Hash a File without materializing the complete payload. At the default size,
 * browser-visible peak input memory is bounded to one 1 MiB slice plus the
 * hash implementation's small fixed state. Yielding between slices keeps
 * large iPad uploads from monopolizing the main thread.
 */
export async function sha256FileHex(
    file: File,
    options: {
        chunkBytes?: number;
        yieldControl?: () => Promise<void>;
    } = {},
): Promise<string> {
    const requestedChunkBytes = Number.isFinite(options.chunkBytes)
        ? Math.floor(options.chunkBytes as number)
        : DEFAULT_FILE_HASH_CHUNK_BYTES;
    const chunkBytes = Math.max(1, Math.min(DEFAULT_FILE_HASH_CHUNK_BYTES, requestedChunkBytes));
    const yieldControl = options.yieldControl || (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const hash = sha256.create();
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
        const end = Math.min(file.size, offset + chunkBytes);
        hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
        if (end < file.size) await yieldControl();
    }
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256TextHex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function isPdfFileByMagic(file: File): Promise<boolean> {
    if (file.size < 5) return false;
    const prefix = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    return prefix[0] === 0x25
        && prefix[1] === 0x50
        && prefix[2] === 0x44
        && prefix[3] === 0x46
        && prefix[4] === 0x2d;
}

export function tusEndpointFromSignedUploadUrl(signedUrl: string): string {
    const url = new URL(signedUrl);
    const hostname = url.hostname;
    if (hostname.endsWith(".supabase.co") && !hostname.endsWith(".storage.supabase.co")) {
        const projectRef = hostname.slice(0, -".supabase.co".length);
        url.hostname = `${projectRef}.storage.supabase.co`;
    }
    url.pathname = "/storage/v1/upload/resumable";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

export async function uploadStandardSignedTeacherAsset(
    file: File,
    prepared: TeacherDirectUploadPrepared,
): Promise<void> {
    const body = new FormData();
    body.append("cacheControl", "300");
    body.append("metadata", JSON.stringify({
        sha256Hex: prepared.sha256Hex,
        uploadId: prepared.uploadId,
    }));
    body.append("", file);
    const response = await fetch(prepared.signedUrl, {
        method: "PUT",
        headers: { "x-upsert": "false" },
        body,
    });
    if (!response.ok) throw new Error(`Signed Storage upload failed (${response.status})`);
}

export async function uploadTusSignedTeacherAsset(
    file: File,
    prepared: TeacherDirectUploadPrepared,
    UploadOverride?: TusUploadConstructor,
): Promise<void> {
    const Upload = UploadOverride || (await import("tus-js-client")).Upload;
    await new Promise<void>((resolve, reject) => {
        const upload = new Upload(file, {
            endpoint: tusEndpointFromSignedUploadUrl(prepared.signedUrl),
            headers: { "x-signature": prepared.token },
            chunkSize: 6 * 1024 * 1024,
            retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
            uploadDataDuringCreation: true,
            removeFingerprintOnSuccess: true,
            metadata: {
                bucketName: prepared.bucket,
                objectName: prepared.objectPath,
                contentType: prepared.mimeType,
                cacheControl: "300",
                metadata: JSON.stringify({
                    sha256Hex: prepared.sha256Hex,
                    uploadId: prepared.uploadId,
                }),
            },
            onError: reject,
            onSuccess: () => resolve(),
        });
        upload.start();
    });
}

const defaultTransports: TeacherDirectUploadTransports = {
    standard: uploadStandardSignedTeacherAsset,
    tus: uploadTusSignedTeacherAsset,
};

export async function uploadTeacherPdfDirect(
    input: {
        file: File;
        examId: string;
        kind: "problem_pdf" | "answer_key_pdf";
        attemptNonce: string;
        rotateAttemptNonce?: () => string;
    },
    actions: TeacherDirectUploadActions,
    transports: TeacherDirectUploadTransports = defaultTransports,
): Promise<{ status: "uploaded"; ref: StoredDataRef } | { status: "local_only" }> {
    const browserMimeAccepted = input.file.type === "application/pdf"
        || input.file.type === ""
        || input.file.type === "application/x-pdf";
    if (
        !browserMimeAccepted
        || input.file.size <= 0
        || !(await isPdfFileByMagic(input.file))
    ) {
        throw new Error("Only a valid PDF with content can be uploaded");
    }
    const uploadFile = input.file.type === "application/pdf"
        ? input.file
        : new File([input.file], input.file.name, {
            type: "application/pdf",
            lastModified: input.file.lastModified,
        });
    const sha256Hex = await sha256FileHex(uploadFile);
    const examHash = await sha256TextHex(input.examId);
    const upload = async (
        attemptNonce: string,
        mayRotateExpired: boolean,
    ): Promise<{ status: "uploaded"; ref: StoredDataRef } | { status: "local_only" }> => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/.test(attemptNonce)) {
            throw new Error("Invalid persisted PDF upload nonce");
        }
        const prepared = await actions.prepare({
            examId: input.examId,
            kind: input.kind,
            byteSize: uploadFile.size,
            mimeType: "application/pdf",
            sha256Hex,
            idempotencyKey: `upload-${input.kind}-${examHash.slice(0, 16)}-${sha256Hex.slice(0, 16)}-${attemptNonce}`,
            originalName: input.file.name,
        });
        if (prepared.status === "local_only") return { status: "local_only" };
        if (prepared.status !== "prepared") {
            if (
                prepared.errorCode === "upload_intent_expired"
                && mayRotateExpired
                && input.rotateAttemptNonce
            ) {
                return upload(input.rotateAttemptNonce(), false);
            }
            throw new Error(errorText(prepared));
        }
        if (
            prepared.examId !== input.examId
            || prepared.kind !== input.kind
            || prepared.byteSize !== uploadFile.size
            || prepared.mimeType !== uploadFile.type
            || prepared.sha256Hex !== sha256Hex
        ) {
            throw new Error("Signed upload declaration does not match the selected PDF");
        }

        let transportError: unknown;
        try {
            await transports[prepared.mode](uploadFile, prepared);
        } catch (error) {
            // A browser may lose the response after Storage committed the object.
            // Finalize is exact and idempotent, so it is the authoritative retry check.
            transportError = error;
        }
        const finalized = await actions.finalize({
            uploadId: prepared.uploadId,
            examId: prepared.examId,
            kind: prepared.kind,
            objectPath: prepared.objectPath,
            byteSize: prepared.byteSize,
            mimeType: prepared.mimeType,
            sha256Hex: prepared.sha256Hex,
            originalName: prepared.originalName,
        });
        if (finalized.status !== "uploaded") {
            if (
                finalized.errorCode === "upload_intent_expired"
                && mayRotateExpired
                && input.rotateAttemptNonce
            ) {
                return upload(input.rotateAttemptNonce(), false);
            }
            if (transportError instanceof Error) throw transportError;
            throw new Error(errorText(finalized));
        }
        return finalized;
    };
    return upload(input.attemptNonce, true);
}
