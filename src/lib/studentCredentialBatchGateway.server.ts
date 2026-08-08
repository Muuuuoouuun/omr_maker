import "next/dist/compiled/server-only";

import { pbkdf2, randomBytes } from "node:crypto";
import { STUDENT_START_CODE_HASH_ITERATIONS } from "./studentCredentialVerifier";

export interface StudentCredentialBatchGatewayClient {
    rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type IssuedStudentCredential = { studentId: string; startCode: string };

export type IssueStudentCredentialBatchResult =
    | { status: "issued"; credentials: IssuedStudentCredential[]; idempotencyKey: string }
    | { status: "already_applied"; error: "replayed_without_credentials"; idempotencyKey: string }
    | { status: "outcome_unknown"; error: "outcome_unknown"; idempotencyKey: string }
    | { status: "rejected"; error: "invalid_input" | "forbidden" | "capacity_exceeded" | "conflict" }
    | { status: "unavailable"; error: "dependency_unavailable" };

export interface IssueStudentCredentialBatchInput {
    sessionAuthority: unknown;
    accountId: unknown;
    accountSessionGeneration: unknown;
    organizationId: unknown;
    actorUserId: unknown;
    studentIds: unknown;
    idempotencyKey?: unknown;
}

export type CredentialBatchValidationResult =
    | { ok: true; studentIds: string[] }
    | { ok: false; error: "invalid_input" | "capacity_exceeded" };

export interface StudentCredentialBatchDependencies {
    generateCode(): string;
    hashCode(code: string): Promise<string>;
    generateIdempotencyKey(): string;
    hashConcurrency: number;
}

const FORBIDDEN_STUDENT_ID_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u;
const PROVISIONED_ACCOUNT_PATTERN = /^teacher_[a-f0-9]{16}$/;
const LEGACY_ACCOUNT_PATTERN = /^teacher_[a-z0-9]{16}$/;
const LEGACY_ACTOR_PATTERN = /^teacher_[a-z0-9]{7,16}$/;
const PILOT_ORGANIZATION_PATTERN = /^pilot_org_[a-f0-9]{24}$/;
const LEGACY_ORGANIZATION_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16})$/;
const IDEMPOTENCY_PATTERN = /^batch_[A-Za-z0-9_-]{32,122}$/;
const VERIFIER_PATTERN = /^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/;
const START_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const START_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_HASH_CONCURRENCY = 4;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function validateCredentialBatch(value: unknown): CredentialBatchValidationResult {
    if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, error: "invalid_input" };
    }
    if (value.length > 100) return { ok: false, error: "capacity_exceeded" };
    const studentIds: string[] = [];
    const unique = new Set<string>();
    for (const raw of value) {
        if (typeof raw !== "string") return { ok: false, error: "invalid_input" };
        const studentId = raw.trim();
        if (
            raw !== studentId
            || !studentId
            || Buffer.byteLength(studentId, "utf8") > 256
            || FORBIDDEN_STUDENT_ID_CHARACTERS.test(studentId)
            || unique.has(studentId)
        ) return { ok: false, error: "invalid_input" };
        unique.add(studentId);
        studentIds.push(studentId);
    }
    return { ok: true, studentIds };
}

export function validateCredentialBatchIdempotencyKey(value: unknown): value is string {
    return typeof value === "string" && value === clean(value) && IDEMPOTENCY_PATTERN.test(value);
}

function defaultGenerateCode(): string {
    const alphabetLength = START_CODE_ALPHABET.length;
    const unbiasedLimit = 256 - (256 % alphabetLength);
    let result = "";
    while (result.length < 6) {
        const bytes = randomBytes(12);
        for (const byte of bytes) {
            if (byte >= unbiasedLimit) continue;
            result += START_CODE_ALPHABET[byte % alphabetLength];
            if (result.length === 6) break;
        }
    }
    return result;
}

function defaultHashCode(code: string): Promise<string> {
    const salt = randomBytes(16);
    return new Promise((resolve, reject) => {
        pbkdf2(code, salt, STUDENT_START_CODE_HASH_ITERATIONS, 32, "sha256", (error, hash) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(
                `pbkdf2-sha256:${STUDENT_START_CODE_HASH_ITERATIONS}:${salt.toString("hex")}:${hash.toString("hex")}`,
            );
        });
    });
}

function defaultGenerateIdempotencyKey(): string {
    return `batch_${randomBytes(24).toString("base64url")}`;
}

const DEFAULT_DEPENDENCIES: StudentCredentialBatchDependencies = {
    generateCode: defaultGenerateCode,
    hashCode: defaultHashCode,
    generateIdempotencyKey: defaultGenerateIdempotencyKey,
    hashConcurrency: DEFAULT_HASH_CONCURRENCY,
};

async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    const output = new Array<R>(values.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            output[index] = await mapper(values[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return output;
}

function exactPlainRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
        if (Object.getPrototypeOf(value) !== Object.prototype) return null;
        const keys = Reflect.ownKeys(value);
        if (
            keys.length !== expectedKeys.length
            || keys.some(key => typeof key !== "string")
            || (keys as string[]).sort().some((key, index) => key !== [...expectedKeys].sort()[index])
        ) return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const snapshot: Record<string, unknown> = {};
        for (const key of expectedKeys) {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
            snapshot[key] = descriptor.value;
        }
        return snapshot;
    } catch {
        return null;
    }
}

function exactSuccessEnvelope(
    value: unknown,
    expectedStudentIds: readonly string[],
): "issued" | "already_applied" | null {
    const record = exactPlainRecord(value, ["status", "count", "studentIds"]);
    if (!record || (record.status !== "issued" && record.status !== "already_applied")) return null;
    const returnedIds = exactDenseStringArray(record.studentIds, expectedStudentIds.length);
    if (record.count !== expectedStudentIds.length || !returnedIds) return null;
    if (returnedIds.length !== expectedStudentIds.length) return null;
    if (returnedIds.some((studentId, index) => studentId !== expectedStudentIds[index])) return null;
    return record.status;
}

function exactDenseStringArray(value: unknown, expectedLength: number): string[] | null {
    if (!Array.isArray(value)) return null;
    try {
        if (Object.getPrototypeOf(value) !== Array.prototype) return null;
        const ownKeys = Reflect.ownKeys(value);
        const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
        const lengthDescriptor = descriptors["length"];
        if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
            return null;
        }
        const length = lengthDescriptor.value as number;
        if (length !== expectedLength || length < 1 || length > 100) return null;
        const expectedKeys = [
            ...Array.from({ length }, (_, index) => String(index)),
            "length",
        ];
        if (
            ownKeys.length !== expectedKeys.length
            || ownKeys.some(key => typeof key !== "string")
            || (ownKeys as string[]).sort().some((key, index) => key !== [...expectedKeys].sort()[index])
        ) return null;
        const snapshot: string[] = [];
        for (let index = 0; index < length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (
                !descriptor
                || !("value" in descriptor)
                || !descriptor.enumerable
                || typeof descriptor.value !== "string"
            ) return null;
            snapshot.push(descriptor.value);
        }
        return snapshot;
    } catch {
        return null;
    }
}

function mappedDatabaseStatus(value: unknown): IssueStudentCredentialBatchResult | null {
    const record = exactPlainRecord(value, ["status"]);
    if (!record) return null;
    if (record.status === "invalid_request" || record.status === "student_unavailable") {
        return { status: "rejected", error: "invalid_input" };
    }
    if (record.status === "unauthorized") return { status: "rejected", error: "forbidden" };
    if (record.status === "idempotency_conflict") return { status: "rejected", error: "conflict" };
    if (record.status === "capacity_exceeded") return { status: "rejected", error: "capacity_exceeded" };
    return null;
}

function validateIdentity(input: IssueStudentCredentialBatchInput): {
    sessionAuthority: "account" | "legacy_account";
    accountId: string;
    accountSessionGeneration: number;
    organizationId: string;
    actorUserId: string;
} | null {
    const sessionAuthority = clean(input.sessionAuthority);
    const accountId = clean(input.accountId).toLowerCase();
    const organizationId = clean(input.organizationId).toLowerCase();
    const actorUserId = clean(input.actorUserId).toLowerCase();
    const generation = input.accountSessionGeneration;
    if (
        (sessionAuthority !== "account" && sessionAuthority !== "legacy_account")
        || !Number.isSafeInteger(generation)
        || (generation as number) < 1
    ) return null;
    if (sessionAuthority === "account" && (
        !PROVISIONED_ACCOUNT_PATTERN.test(accountId)
        || actorUserId !== accountId
        || !PILOT_ORGANIZATION_PATTERN.test(organizationId)
    )) return null;
    if (sessionAuthority === "legacy_account" && (
        !LEGACY_ACCOUNT_PATTERN.test(accountId)
        || !LEGACY_ACTOR_PATTERN.test(actorUserId)
        || !LEGACY_ORGANIZATION_PATTERN.test(organizationId)
    )) return null;
    return {
        sessionAuthority,
        accountId,
        accountSessionGeneration: generation as number,
        organizationId,
        actorUserId,
    };
}

export async function issueStudentCredentialBatch(
    input: IssueStudentCredentialBatchInput,
    client: StudentCredentialBatchGatewayClient,
    dependencies: StudentCredentialBatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<IssueStudentCredentialBatchResult> {
    const identity = validateIdentity(input);
    const batch = validateCredentialBatch(input.studentIds);
    const concurrency = dependencies.hashConcurrency;
    if (
        !identity
        || !batch.ok
        || !Number.isSafeInteger(concurrency)
        || concurrency < 1
        || concurrency > 8
    ) {
        if (!batch.ok && batch.error === "capacity_exceeded") {
            return { status: "rejected", error: "capacity_exceeded" };
        }
        return { status: "rejected", error: "invalid_input" };
    }
    let idempotencyKey: string;
    const credentials: IssuedStudentCredential[] = [];
    try {
        const candidateKey = input.idempotencyKey === undefined
            ? dependencies.generateIdempotencyKey()
            : input.idempotencyKey;
        if (!validateCredentialBatchIdempotencyKey(candidateKey)) {
            return input.idempotencyKey === undefined
                ? { status: "unavailable", error: "dependency_unavailable" }
                : { status: "rejected", error: "invalid_input" };
        }
        idempotencyKey = candidateKey;
        const usedCodes = new Set<string>();
        for (const studentId of batch.studentIds) {
            let startCode = "";
            for (let attempt = 0; attempt < 32 && (!startCode || usedCodes.has(startCode)); attempt += 1) {
                startCode = dependencies.generateCode();
                if (!START_CODE_PATTERN.test(startCode)) startCode = "";
            }
            if (!startCode || usedCodes.has(startCode)) {
                return { status: "unavailable", error: "dependency_unavailable" };
            }
            usedCodes.add(startCode);
            credentials.push({ studentId, startCode });
        }
    } catch {
            return { status: "unavailable", error: "dependency_unavailable" };
    }

    let verifiers: string[];
    try {
        verifiers = await mapWithConcurrency(
            credentials,
            concurrency,
            async credential => dependencies.hashCode(credential.startCode),
        );
    } catch {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
    if (verifiers.some(verifier => !VERIFIER_PATTERN.test(verifier))) {
        return { status: "unavailable", error: "dependency_unavailable" };
    }

    const sortedItems = credentials
        .map((credential, index) => ({ studentId: credential.studentId, verifier: verifiers[index] }))
        .sort((left, right) => Buffer.compare(
            Buffer.from(left.studentId, "utf8"),
            Buffer.from(right.studentId, "utf8"),
        ));
    const sortedStudentIds = sortedItems.map(item => item.studentId);
    try {
        const result = await client.rpc("omr_issue_student_start_code_batch_v1", {
            p_session_authority: identity.sessionAuthority,
            p_account_id: identity.accountId,
            p_session_generation: identity.accountSessionGeneration,
            p_organization_id: identity.organizationId,
            p_actor_user_id: identity.actorUserId,
            p_items: sortedItems,
            p_idempotency_key: idempotencyKey,
        });
        if (result.error) {
            return { status: "outcome_unknown", error: "outcome_unknown", idempotencyKey };
        }
        const status = exactSuccessEnvelope(result.data, sortedStudentIds);
        if (status === "issued") {
            return { status: "issued", credentials, idempotencyKey };
        }
        if (status === "already_applied") {
            return { status: "already_applied", error: "replayed_without_credentials", idempotencyKey };
        }
        const rejected = mappedDatabaseStatus(result.data);
        if (rejected) return rejected;
        return { status: "outcome_unknown", error: "outcome_unknown", idempotencyKey };
    } catch {
        return { status: "outcome_unknown", error: "outcome_unknown", idempotencyKey };
    }
}
