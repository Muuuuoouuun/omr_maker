import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PlanKey } from "@/types/omr";
import { normalizePlan } from "@/utils/plans";

export { TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR, TEACHER_AUTH_ERROR } from "./teacherAuthMessages";

export interface TeacherCredential {
    id: string;
    email: string;
    name: string;
    password: string;
    plan?: PlanKey;
}

export interface TeacherLoginIdentity {
    teacherId: string;
    email: string;
    displayName: string;
    plan?: PlanKey;
}

export interface TeacherLoginVerification {
    success: boolean;
    teacher?: TeacherLoginIdentity;
}

export type TeacherAuthConfigIssueKey =
    | "missing-production-teacher-account"
    | "invalid-teacher-accounts-json"
    | "empty-teacher-accounts"
    | "duplicate-teacher-identifier";

export interface TeacherAuthConfigIssue {
    key: TeacherAuthConfigIssueKey;
    label: string;
    detail: string;
}

export interface TeacherAuthConfigReadiness {
    ready: boolean;
    credentialCount: number;
    issues: TeacherAuthConfigIssue[];
}

type TeacherAuthEnv = {
    NODE_ENV?: string;
    TEACHER_ACCOUNTS?: string;
    OMR_TEACHER_ACCOUNTS?: string;
    TEACHER_LOGIN_ID?: string;
    TEACHER_EMAIL?: string;
    TEACHER_NAME?: string;
    TEACHER_PASSWORD?: string;
    TEACHER_PLAN?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
};

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeIdentifier(value: unknown): string {
    return clean(value).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function credentialFromRecord(value: unknown): TeacherCredential | null {
    if (!isRecord(value)) return null;

    const email = clean(value.email).toLowerCase();
    const id = clean(value.id) || clean(value.loginId) || email;
    const password = clean(value.password);
    if (!id || !password) return null;

    return {
        id,
        email,
        name: clean(value.name) || clean(value.displayName) || email || id,
        password,
        plan: normalizePlan(value.plan) ?? undefined,
    };
}

function parseTeacherAccounts(raw: string | undefined): TeacherCredential[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.map(credentialFromRecord).filter((item): item is TeacherCredential => !!item);
    } catch {
        return [];
    }
}

function teacherAccountsInputHasInvalidJson(raw: string | undefined): boolean {
    if (!raw?.trim()) return false;
    try {
        JSON.parse(raw);
        return false;
    } catch {
        return true;
    }
}

function hasTeacherAccountsInput(env: TeacherAuthEnv): boolean {
    return !!(clean(env.TEACHER_ACCOUNTS) || clean(env.OMR_TEACHER_ACCOUNTS));
}

function duplicateCredentialIdentifiers(credentials: TeacherCredential[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const credential of credentials) {
        const identifiers = [
            normalizeIdentifier(credential.id),
            normalizeIdentifier(credential.email),
        ].filter(Boolean);

        for (const identifier of identifiers) {
            if (seen.has(identifier)) {
                duplicates.add(identifier);
            } else {
                seen.add(identifier);
            }
        }
    }

    return [...duplicates];
}

export function resolveTeacherPassword(env: TeacherAuthEnv = process.env): string | null {
    const configuredPassword = clean(env.TEACHER_PASSWORD);
    if (configuredPassword) return configuredPassword;
    return env.NODE_ENV === "production" ? null : "admin123";
}

export function resolveTeacherCredentials(env: TeacherAuthEnv = process.env): TeacherCredential[] {
    const configuredAccounts = [
        ...parseTeacherAccounts(env.TEACHER_ACCOUNTS),
        ...parseTeacherAccounts(env.OMR_TEACHER_ACCOUNTS),
    ];
    if (configuredAccounts.length > 0) return configuredAccounts;

    const configuredPassword = clean(env.TEACHER_PASSWORD);
    if (configuredPassword) {
        const email = clean(env.TEACHER_EMAIL).toLowerCase();
        const id = clean(env.TEACHER_LOGIN_ID) || email || "admin";
        return [{
            id,
            email,
            name: clean(env.TEACHER_NAME) || email || id,
            password: configuredPassword,
            plan: normalizePlan(env.TEACHER_PLAN) ?? undefined,
        }];
    }

    if (env.NODE_ENV === "production") return [];

    return [{
        id: "admin",
        email: "admin@example.com",
        name: "Demo Admin",
        password: "admin123",
    }];
}

export function inspectTeacherAuthConfig(env: TeacherAuthEnv = process.env): TeacherAuthConfigReadiness {
    const credentials = resolveTeacherCredentials(env);
    const issues: TeacherAuthConfigIssue[] = [];
    const accountsInputConfigured = hasTeacherAccountsInput(env);

    if (teacherAccountsInputHasInvalidJson(env.TEACHER_ACCOUNTS) || teacherAccountsInputHasInvalidJson(env.OMR_TEACHER_ACCOUNTS)) {
        issues.push({
            key: "invalid-teacher-accounts-json",
            label: "교사 계정 JSON 오류",
            detail: "TEACHER_ACCOUNTS 또는 OMR_TEACHER_ACCOUNTS 값이 올바른 JSON 배열이 아닙니다.",
        });
    } else if (accountsInputConfigured && credentials.length === 0 && !clean(env.TEACHER_PASSWORD)) {
        issues.push({
            key: "empty-teacher-accounts",
            label: "유효한 교사 계정 없음",
            detail: "교사 계정 JSON에는 id 또는 email과 password가 있는 항목이 최소 1개 필요합니다.",
        });
    }

    if (env.NODE_ENV === "production" && credentials.length === 0) {
        issues.push({
            key: "missing-production-teacher-account",
            label: "운영 교사 계정 미설정",
            detail: "운영 배포에는 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD 서버 환경변수가 필요합니다.",
        });
    }

    const duplicates = duplicateCredentialIdentifiers(credentials);
    if (duplicates.length > 0) {
        issues.push({
            key: "duplicate-teacher-identifier",
            label: "중복 교사 식별자",
            detail: `교사 id 또는 email은 중복될 수 없습니다: ${duplicates.join(", ")}`,
        });
    }

    return {
        ready: credentials.length > 0 && issues.length === 0,
        credentialCount: credentials.length,
        issues,
    };
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

function passwordMatches(providedPassword: string, expectedPassword: string): boolean {
    return timingSafeEqual(digest(providedPassword), digest(expectedPassword));
}

function credentialMatchesIdentifier(credential: TeacherCredential, identifier: unknown): boolean {
    const normalizedIdentifier = normalizeIdentifier(identifier);
    if (!normalizedIdentifier) return false;
    return normalizeIdentifier(credential.id) === normalizedIdentifier
        || normalizeIdentifier(credential.email) === normalizedIdentifier;
}

export function verifyTeacherLogin(
    identifier: unknown,
    password: unknown,
    env: TeacherAuthEnv = process.env,
): TeacherLoginVerification {
    if (typeof password !== "string") return { success: false };
    const credentials = resolveTeacherCredentials(env);
    const credential = credentials.find(item => credentialMatchesIdentifier(item, identifier));
    if (!credential) return { success: false };
    if (!passwordMatches(password, credential.password)) return { success: false };

    return {
        success: true,
        teacher: {
            teacherId: credential.id,
            email: credential.email,
            displayName: credential.name,
            plan: credential.plan,
        },
    };
}

export function verifyTeacherPasswordValue(
    password: unknown,
    env: TeacherAuthEnv = process.env,
): boolean {
    if (typeof password !== "string") return false;
    const expectedPassword = resolveTeacherPassword(env);
    if (!expectedPassword) return false;

    return passwordMatches(password, expectedPassword);
}

export function mintTeacherToken(now = Date.now()): string {
    const timestamp = now.toString(36);
    const randomHex = randomBytes(16).toString("hex");
    return `tkn_${timestamp}_${randomHex}`;
}
