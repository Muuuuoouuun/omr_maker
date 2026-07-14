import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export { TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR, TEACHER_AUTH_ERROR } from "./teacherAuthMessages";

export interface TeacherCredential {
    id: string;
    email: string;
    name: string;
    password?: string;
    passwordHash?: string;
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

export type TeacherAuthConfigIssueKey =
    | "missing-production-teacher-account"
    | "invalid-teacher-accounts-json"
    | "empty-teacher-accounts"
    | "duplicate-teacher-identifier"
    | "invalid-teacher-password-hash";

export type TeacherAuthConfigWarningKey =
    | "plaintext-production-teacher-password";

export interface TeacherAuthConfigIssue {
    key: TeacherAuthConfigIssueKey;
    label: string;
    detail: string;
}

export interface TeacherAuthConfigWarning {
    key: TeacherAuthConfigWarningKey;
    label: string;
    detail: string;
}

export interface TeacherAuthConfigReadiness {
    ready: boolean;
    credentialCount: number;
    issues: TeacherAuthConfigIssue[];
    warnings: TeacherAuthConfigWarning[];
}

type TeacherAuthEnv = {
    NODE_ENV?: string;
    TEACHER_ACCOUNTS?: string;
    OMR_TEACHER_ACCOUNTS?: string;
    TEACHER_LOGIN_ID?: string;
    TEACHER_EMAIL?: string;
    TEACHER_NAME?: string;
    TEACHER_PASSWORD?: string;
    TEACHER_PASSWORD_HASH?: string;
    OMR_TEACHER_PASSWORD_HASH?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
};

const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeIdentifier(value: unknown): string {
    return clean(value).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

interface ParsedPasswordHash {
    iterations: number;
    salt: Buffer;
    hash: Buffer;
}

function isHex(value: string): boolean {
    return value.length > 0 && value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value);
}

function parsePasswordHash(raw: string): ParsedPasswordHash | null {
    const [algorithm, iterationsRaw, saltHex, hashHex, ...rest] = clean(raw).split(":");
    if (rest.length > 0 || algorithm !== PASSWORD_HASH_ALGORITHM) return null;

    const iterations = Number(iterationsRaw);
    if (!Number.isSafeInteger(iterations) || iterations <= 0) return null;
    if (!isHex(saltHex) || !isHex(hashHex)) return null;

    return {
        iterations,
        salt: Buffer.from(saltHex, "hex"),
        hash: Buffer.from(hashHex, "hex"),
    };
}

function isSupportedPasswordHash(raw: string): boolean {
    return !!parsePasswordHash(raw);
}

function passwordHashFromRecord(value: Record<string, unknown>): string {
    return clean(value.passwordHash) || clean(value.password_hash);
}

function credentialFromRecord(value: unknown): TeacherCredential | null {
    if (!isRecord(value)) return null;

    const email = clean(value.email).toLowerCase();
    const id = clean(value.id) || clean(value.loginId) || email;
    const password = clean(value.password);
    const passwordHash = passwordHashFromRecord(value);
    if (!id || (!password && !passwordHash)) return null;

    const credential = {
        id,
        email,
        name: clean(value.name) || clean(value.displayName) || email || id,
    };

    if (passwordHash && isSupportedPasswordHash(passwordHash)) {
        return {
            ...credential,
            passwordHash,
        };
    }

    if (!password) return null;

    return {
        ...credential,
        password,
    };
}

function parseTeacherAccountRows(raw: string | undefined): unknown[] {
    if (!raw?.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
}

function parseTeacherAccounts(raw: string | undefined): TeacherCredential[] {
    if (!raw?.trim()) return [];
    try {
        return parseTeacherAccountRows(raw).map(credentialFromRecord).filter((item): item is TeacherCredential => !!item);
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

function teacherAccountsInputHasInvalidPasswordHash(raw: string | undefined): boolean {
    if (!raw?.trim()) return false;
    try {
        return parseTeacherAccountRows(raw).some(row => {
            if (!isRecord(row)) return false;
            const passwordHash = passwordHashFromRecord(row);
            return !!passwordHash && !isSupportedPasswordHash(passwordHash);
        });
    } catch {
        return false;
    }
}

function teacherAccountsInputHasPlaintextPassword(raw: string | undefined): boolean {
    if (!raw?.trim()) return false;
    try {
        return parseTeacherAccountRows(raw).some(row => isRecord(row) && !!clean(row.password));
    } catch {
        return false;
    }
}

function resolveTeacherPasswordHash(env: TeacherAuthEnv = process.env): string | null {
    for (const candidate of [env.TEACHER_PASSWORD_HASH, env.OMR_TEACHER_PASSWORD_HASH]) {
        const passwordHash = clean(candidate);
        if (passwordHash && isSupportedPasswordHash(passwordHash)) return passwordHash;
    }

    return null;
}

function hasSingleTeacherCredentialInput(env: TeacherAuthEnv): boolean {
    return !!(clean(env.TEACHER_PASSWORD) || resolveTeacherPasswordHash(env));
}

function hasInvalidPasswordHashInput(env: TeacherAuthEnv): boolean {
    const hasInvalidSingleTeacherHash = [env.TEACHER_PASSWORD_HASH, env.OMR_TEACHER_PASSWORD_HASH]
        .some(candidate => {
            const passwordHash = clean(candidate);
            return !!passwordHash && !isSupportedPasswordHash(passwordHash);
        });

    return hasInvalidSingleTeacherHash
        || teacherAccountsInputHasInvalidPasswordHash(env.TEACHER_ACCOUNTS)
        || teacherAccountsInputHasInvalidPasswordHash(env.OMR_TEACHER_ACCOUNTS);
}

function hasProductionPlaintextCredentialInput(env: TeacherAuthEnv): boolean {
    if (env.NODE_ENV !== "production") return false;

    return !!clean(env.TEACHER_PASSWORD)
        || teacherAccountsInputHasPlaintextPassword(env.TEACHER_ACCOUNTS)
        || teacherAccountsInputHasPlaintextPassword(env.OMR_TEACHER_ACCOUNTS);
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
    if (resolveTeacherPasswordHash(env)) return null;
    return env.NODE_ENV === "production" ? null : "admin123";
}

export function resolveTeacherCredentials(env: TeacherAuthEnv = process.env): TeacherCredential[] {
    const configuredAccounts = [
        ...parseTeacherAccounts(env.TEACHER_ACCOUNTS),
        ...parseTeacherAccounts(env.OMR_TEACHER_ACCOUNTS),
    ];
    if (configuredAccounts.length > 0) return configuredAccounts;

    const configuredPasswordHash = resolveTeacherPasswordHash(env);
    const configuredPassword = clean(env.TEACHER_PASSWORD);
    if (configuredPasswordHash || configuredPassword) {
        const email = clean(env.TEACHER_EMAIL).toLowerCase();
        const id = clean(env.TEACHER_LOGIN_ID) || email || "admin";
        return [{
            id,
            email,
            name: clean(env.TEACHER_NAME) || email || id,
            ...(configuredPasswordHash ? { passwordHash: configuredPasswordHash } : { password: configuredPassword }),
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
    const warnings: TeacherAuthConfigWarning[] = [];
    const accountsInputConfigured = hasTeacherAccountsInput(env);

    if (teacherAccountsInputHasInvalidJson(env.TEACHER_ACCOUNTS) || teacherAccountsInputHasInvalidJson(env.OMR_TEACHER_ACCOUNTS)) {
        issues.push({
            key: "invalid-teacher-accounts-json",
            label: "교사 계정 JSON 오류",
            detail: "TEACHER_ACCOUNTS 또는 OMR_TEACHER_ACCOUNTS 값이 올바른 JSON 배열이 아닙니다.",
        });
    } else if (accountsInputConfigured && credentials.length === 0 && !hasSingleTeacherCredentialInput(env)) {
        issues.push({
            key: "empty-teacher-accounts",
            label: "유효한 교사 계정 없음",
            detail: "교사 계정 JSON에는 id 또는 email과 password/passwordHash가 있는 항목이 최소 1개 필요합니다.",
        });
    }

    if (hasInvalidPasswordHashInput(env)) {
        issues.push({
            key: "invalid-teacher-password-hash",
            label: "교사 비밀번호 해시 형식 오류",
            detail: "비밀번호 해시는 pbkdf2-sha256:<iterations>:<salt_hex>:<hash_hex> 형식이어야 합니다.",
        });
    }

    if (env.NODE_ENV === "production" && credentials.length === 0) {
        issues.push({
            key: "missing-production-teacher-account",
            label: "운영 교사 계정 미설정",
            detail: "운영 배포에는 TEACHER_ACCOUNTS 또는 TEACHER_LOGIN_ID/TEACHER_PASSWORD_HASH 서버 환경변수가 필요합니다.",
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

    if (hasProductionPlaintextCredentialInput(env)) {
        warnings.push({
            key: "plaintext-production-teacher-password",
            label: "운영 교사 비밀번호 plaintext 사용",
            detail: "운영 배포에서는 TEACHER_PASSWORD 또는 TEACHER_ACCOUNTS의 password 대신 passwordHash/TEACHER_PASSWORD_HASH 사용을 권장합니다.",
        });
    }

    return {
        ready: credentials.length > 0 && issues.length === 0,
        credentialCount: credentials.length,
        issues,
        warnings,
    };
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

function passwordMatches(providedPassword: string, expectedPassword: string): boolean {
    return timingSafeEqual(digest(providedPassword), digest(expectedPassword));
}

function passwordHashMatches(providedPassword: string, expectedPasswordHash: string): boolean {
    const parsed = parsePasswordHash(expectedPasswordHash);
    if (!parsed) return false;

    const actualHash = pbkdf2Sync(providedPassword, parsed.salt, parsed.iterations, parsed.hash.length, "sha256");
    return timingSafeEqual(actualHash, parsed.hash);
}

function credentialPasswordMatches(providedPassword: string, credential: TeacherCredential): boolean {
    if (credential.passwordHash) return passwordHashMatches(providedPassword, credential.passwordHash);
    if (credential.password) return passwordMatches(providedPassword, credential.password);
    return false;
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
    if (!credentialPasswordMatches(password, credential)) return { success: false };

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
    const expectedPasswordHash = resolveTeacherPasswordHash(env);
    if (expectedPasswordHash) return passwordHashMatches(password, expectedPasswordHash);

    const expectedPassword = resolveTeacherPassword(env);
    if (!expectedPassword) return false;

    return passwordMatches(password, expectedPassword);
}

export function mintTeacherToken(now = Date.now()): string {
    const timestamp = now.toString(36);
    const randomHex = randomBytes(16).toString("hex");
    return `tkn_${timestamp}_${randomHex}`;
}
