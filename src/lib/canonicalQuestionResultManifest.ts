import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import { sha256HexUtf8 } from "@/lib/sha256";

const DEFINITION_DOMAIN = "omr:canonical-question-definition-manifest:v1\n";
const EVIDENCE_DOMAIN = "omr:canonical-question-result-evidence:v1\n";
const MAX_CANONICAL_QUESTION_RESULTS = 500;
const MAX_CANONICAL_VALUE_DEPTH = 5;
const MAX_CANONICAL_ARRAY_ITEMS = 500;
const CANONICAL_NUMBER_TAG = "omr:canonical-number:micro6:v1";
const CANONICAL_NUMBER_SCALE = 1_000_000;
const MAX_CANONICAL_NUMBER = 9_000_000_000;

function invalid(code: string): TypeError {
    return new TypeError(code);
}

interface CanonicalEvidenceAttestation {
    questionResults: readonly QuestionResult[];
    scopeFingerprint: string;
    questionResultsQuestionCount: number;
    questionResultsDefinitionManifestHash: string;
    questionResultsFullEvidenceHash: string;
}

const canonicalEvidenceAttestations = new WeakMap<object, CanonicalEvidenceAttestation>();

export interface CanonicalQuestionResultManifest {
    questionResultsQuestionCount: number;
    questionResultsDefinitionManifestHash: string;
}

export interface CanonicalQuestionResultEvidence extends CanonicalQuestionResultManifest {
    questionResultsFullEvidenceHash: string;
}

export type CanonicalQuestionResultEvidenceScope = Pick<Attempt,
    | "id"
    | "examId"
    | "organizationId"
    | "classId"
    | "assignmentId"
    | "assignmentRevision"
    | "studentProfileId"
    | "studentId"
    | "identityType"
    | "studentName"
    | "groupId"
    | "groupName"
    | "regionId"
    | "regionName"
    | "startedAt"
    | "finishedAt"
    | "score"
    | "totalScore"
    | "status"
    | "retake"
>;

const FULL_RESULT_FIELDS = [
    "schemaVersion", "attemptId", "examId", "examTitle", "organizationId", "classId",
    "assignmentId", "assignmentRevision", "studentProfileId", "studentName", "studentId",
    "groupId", "groupName", "regionId", "regionName", "identityType", "questionId",
    "questionNumber", "canonicalQuestionId", "label", "score", "earnedScore",
    "selectedAnswer", "correctAnswer", "status", "isCorrect", "isWrong", "isUnanswered",
    "subject", "unit", "concept", "skill", "source", "difficulty", "cognitiveLevel",
    "mistakeTypes", "prerequisites", "expectedTimeSec", "pdfPage", "pdfLocation",
    "pdfRegion", "passagePdfRegions", "timeSec", "visitCount", "revisitCount",
    "answerChangeCount", "handwritingStrokeCount", "handwritingPage", "retakeSourceAttemptId",
    "retakeMode", "answeredAt", "finishedAt",
] as const satisfies readonly (keyof QuestionResult)[];

function ownDataValue(record: object, key: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
        throw invalid(`data:${String(key)}`);
    }
    return descriptor.value;
}

function optionalOwnDataValue(record: object, key: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor) || descriptor.get || descriptor.set) {
        throw invalid(`accessor:${String(key)}`);
    }
    return descriptor.value;
}

function stableValue(value: unknown, depth = 0): unknown {
    if (depth > MAX_CANONICAL_VALUE_DEPTH) throw invalid("depth");
    if (value === undefined || value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw invalid("number");
        }
        if (Math.abs(value) > MAX_CANONICAL_NUMBER) {
            throw invalid("range");
        }
        const fixed = value.toFixed(6);
        if (Number(fixed) !== value) {
            throw invalid("precision");
        }
        const negative = fixed.startsWith("-");
        const unsigned = negative ? fixed.slice(1) : fixed;
        const [whole, fraction = ""] = unsigned.split(".");
        const microUnits = BigInt(whole) * BigInt(CANONICAL_NUMBER_SCALE)
            + BigInt(fraction.padEnd(6, "0"));
        return [CANONICAL_NUMBER_TAG, `${negative ? "-" : ""}${microUnits}`];
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_CANONICAL_ARRAY_ITEMS) throw invalid("size");
        const next: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(value, index)) throw invalid("sparse");
            next.push(stableValue(ownDataValue(value, index), depth + 1));
        }
        return next;
    }
    if (typeof value !== "object") throw invalid("type");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid("proto");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw invalid("symbol");
    const next: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
        next[key] = stableValue(ownDataValue(value, key), depth + 1);
    }
    return next;
}

function hash(domain: string, value: unknown): string {
    return `sha256:${sha256HexUtf8(domain + JSON.stringify(stableValue(value)))}`;
}

function stableRows(rows: readonly QuestionResult[]): QuestionResult[] {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_CANONICAL_QUESTION_RESULTS) {
        throw invalid("count");
    }
    const copied = rows.map((row, index) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("row");
        if (!Object.prototype.hasOwnProperty.call(rows, index)) throw invalid("sparse");
        // Snapshot all own fields before sorting so accessors/proxies cannot be
        // consulted incrementally while a digest is being assembled.
        for (const key of Reflect.ownKeys(row)) ownDataValue(row, key);
        return row;
    });
    copied.sort((left, right) => {
        const leftId = ownDataValue(left, "questionId");
        const rightId = ownDataValue(right, "questionId");
        if (!Number.isSafeInteger(leftId) || Number(leftId) <= 0 || !Number.isSafeInteger(rightId) || Number(rightId) <= 0) {
            throw invalid("id");
        }
        return Number(leftId) - Number(rightId);
    });
    const ids = new Set(copied.map(row => Number(ownDataValue(row, "questionId"))));
    if (ids.size !== copied.length) throw invalid("duplicate");
    return copied;
}

function definitionTuple(row: QuestionResult): readonly unknown[] {
    const questionId = ownDataValue(row, "questionId");
    const questionNumber = ownDataValue(row, "questionNumber");
    const score = ownDataValue(row, "score");
    const correctAnswer = optionalOwnDataValue(row, "correctAnswer");
    if (!Number.isSafeInteger(questionId) || Number(questionId) <= 0
        || !Number.isSafeInteger(questionNumber) || Number(questionNumber) <= 0
        || typeof score !== "number" || !Number.isFinite(score) || score < 0 || Object.is(score, -0)
        || (correctAnswer !== undefined && (!Number.isSafeInteger(correctAnswer) || Number(correctAnswer) <= 0))) {
        throw invalid("definition");
    }
    return [questionId, questionNumber, score, correctAnswer ?? null];
}

export function buildCanonicalQuestionResultManifest(
    questionResults: readonly QuestionResult[],
): CanonicalQuestionResultManifest {
    const rows = stableRows(questionResults);
    return {
        questionResultsQuestionCount: rows.length,
        questionResultsDefinitionManifestHash: hash(DEFINITION_DOMAIN, rows.map(definitionTuple)),
    };
}

/** Server boundary helper; callers must never expose this answer-key-bearing digest to pre-completion student Flight. */
export function buildCanonicalExamDefinitionManifest(
    exam: Pick<Exam, "questions">,
): CanonicalQuestionResultManifest {
    return buildCanonicalQuestionResultManifest(exam.questions.map(question => ({
        questionId: question.id,
        questionNumber: question.number,
        score: question.score || 0,
        ...(typeof question.answer === "number" ? { correctAnswer: question.answer } : {}),
    } as QuestionResult)));
}

function evidenceScopeTuple(scope: CanonicalQuestionResultEvidenceScope): readonly unknown[] {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw invalid("scope");
    const assignmentId = optionalOwnDataValue(scope, "assignmentId");
    const assignmentRevision = optionalOwnDataValue(scope, "assignmentRevision");
    if (Boolean(typeof assignmentId === "string" && assignmentId.trim())
        !== (Number.isSafeInteger(assignmentRevision) && Number(assignmentRevision) > 0)) {
        throw invalid("assignment");
    }
    const retake = optionalOwnDataValue(scope, "retake");
    return [
        ownDataValue(scope, "id"), ownDataValue(scope, "examId"),
        optionalOwnDataValue(scope, "organizationId") ?? null,
        optionalOwnDataValue(scope, "classId") ?? null,
        assignmentId ?? null, assignmentRevision ?? null,
        optionalOwnDataValue(scope, "studentProfileId") ?? null,
        optionalOwnDataValue(scope, "studentId") ?? null,
        optionalOwnDataValue(scope, "identityType") ?? null,
        optionalOwnDataValue(scope, "studentName") ?? null,
        optionalOwnDataValue(scope, "groupId") ?? null,
        optionalOwnDataValue(scope, "groupName") ?? null,
        optionalOwnDataValue(scope, "regionId") ?? null,
        optionalOwnDataValue(scope, "regionName") ?? null,
        optionalOwnDataValue(scope, "startedAt") ?? null,
        optionalOwnDataValue(scope, "finishedAt") ?? null,
        optionalOwnDataValue(scope, "score") ?? null,
        optionalOwnDataValue(scope, "totalScore") ?? null,
        optionalOwnDataValue(scope, "status") ?? null,
        retake ?? null,
    ];
}

export function buildCanonicalQuestionResultEvidence(
    scope: CanonicalQuestionResultEvidenceScope,
    questionResults: readonly QuestionResult[],
): CanonicalQuestionResultEvidence {
    const rows = stableRows(questionResults);
    const manifest = buildCanonicalQuestionResultManifest(rows);
    const evidenceRows = rows.map(row => FULL_RESULT_FIELDS.map(field => optionalOwnDataValue(row, field) ?? null));
    return {
        ...manifest,
        questionResultsFullEvidenceHash: hash(EVIDENCE_DOMAIN, [evidenceScopeTuple(scope), evidenceRows]),
    };
}

function scopeFingerprint(scope: CanonicalQuestionResultEvidenceScope): string {
    return JSON.stringify(stableValue(evidenceScopeTuple(scope)));
}

function deepFreezeCanonicalValue(value: unknown, seen = new Set<object>()): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreezeCanonicalValue(ownDataValue(value, key), seen);
    }
    Object.freeze(value);
}

/**
 * Fully verifies declared hashes, then records a process-private attestation.
 * The marker is never serialized: immutable evidence rows are frozen and the
 * mutable attempt scope is fingerprinted again before any fast-path use.
 */
export function attestCanonicalQuestionResultEvidence(
    scope: CanonicalQuestionResultEvidenceScope & CanonicalQuestionResultEvidence,
    questionResults: readonly QuestionResult[],
): CanonicalQuestionResultEvidence {
    const computed = buildCanonicalQuestionResultEvidence(scope, questionResults);
    if (scope.questionResultsQuestionCount !== computed.questionResultsQuestionCount
        || scope.questionResultsDefinitionManifestHash !== computed.questionResultsDefinitionManifestHash
        || scope.questionResultsFullEvidenceHash !== computed.questionResultsFullEvidenceHash) {
        throw invalid("hash");
    }
    deepFreezeCanonicalValue(questionResults);
    canonicalEvidenceAttestations.set(scope, {
        questionResults,
        scopeFingerprint: scopeFingerprint(scope),
        ...computed,
    });
    return computed;
}

export function hasCanonicalQuestionResultEvidenceAttestation(
    scope: CanonicalQuestionResultEvidenceScope & Partial<CanonicalQuestionResultEvidence>,
    questionResults: readonly QuestionResult[],
): boolean {
    try {
        const attestation = canonicalEvidenceAttestations.get(scope);
        return !!attestation
            && attestation.questionResults === questionResults
            && Object.isFrozen(questionResults)
            && scope.questionResultsQuestionCount === attestation.questionResultsQuestionCount
            && scope.questionResultsDefinitionManifestHash === attestation.questionResultsDefinitionManifestHash
            && scope.questionResultsFullEvidenceHash === attestation.questionResultsFullEvidenceHash
            && scopeFingerprint(scope) === attestation.scopeFingerprint;
    } catch {
        return false;
    }
}
