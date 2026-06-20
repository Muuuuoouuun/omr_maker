import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export { TEACHER_AUTH_ERROR } from "./teacherAuthMessages";

export interface TeacherCredential {
    id: string;
    email: string;
    name: string;
    password: string;
}

export interface TeacherLoginIdentity {
    teacherId: string;
    email: string;
    displayName: string;
}

export interface TeacherLoginVerification {
    success: boolean;
    teacher?: TeacherLoginIdentity;
}

type TeacherAuthEnv = {
    NODE_ENV?: string;
    TEACHER_ACCOUNTS?: string;
    OMR_TEACHER_ACCOUNTS?: string;
    TEACHER_LOGIN_ID?: string;
    TEACHER_EMAIL?: string;
    TEACHER_NAME?: string;
    TEACHER_PASSWORD?: string;
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
