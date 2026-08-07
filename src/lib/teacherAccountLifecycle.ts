import { createHash, pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const TEACHER_ACCOUNT_PASSWORD_MIN_LENGTH = 12;
export const TEACHER_ACCOUNT_PASSWORD_MAX_LENGTH = 128;
export const TEACHER_ACCOUNT_EMAIL_MAX_LENGTH = 254;
export const TEACHER_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 80;
export const TEACHER_ACCOUNT_PASSWORD_ITERATIONS = 120_000;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const DUMMY_PASSWORD_HASH = `pbkdf2-sha256:${TEACHER_ACCOUNT_PASSWORD_ITERATIONS}:${"0".repeat(32)}:${"0".repeat(64)}`;

export type TeacherAccountTokenPurpose = "email_verify" | "password_reset";

export function isTeacherBootstrapLoginEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.NODE_ENV !== "production" || env.OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN === "true";
}

export type TeacherSignupValidation =
    | { ok: true; value: { email: string; displayName: string; password: string } }
    | { ok: false; error: "invalid_email" | "invalid_display_name" | "invalid_password" };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeTeacherAccountEmail(value: unknown): string {
    return clean(value).toLowerCase();
}

function validEmail(email: string): boolean {
    if (!email || email.length > TEACHER_ACCOUNT_EMAIL_MAX_LENGTH || /[\s\u0000-\u001f]/.test(email)) return false;
    const at = email.indexOf("@");
    return at > 0
        && at === email.lastIndexOf("@")
        && at < email.length - 3
        && email.slice(at + 1).includes(".");
}

export function isValidTeacherAccountEmail(value: unknown): boolean {
    return validEmail(normalizeTeacherAccountEmail(value));
}

export function validateTeacherSignupInput(input: {
    email?: unknown;
    displayName?: unknown;
    password?: unknown;
}): TeacherSignupValidation {
    const email = normalizeTeacherAccountEmail(input.email);
    const displayName = clean(input.displayName);
    const password = typeof input.password === "string" ? input.password : "";
    if (!validEmail(email)) return { ok: false, error: "invalid_email" };
    if (!displayName || displayName.length > TEACHER_ACCOUNT_DISPLAY_NAME_MAX_LENGTH) {
        return { ok: false, error: "invalid_display_name" };
    }
    if (
        password.length < TEACHER_ACCOUNT_PASSWORD_MIN_LENGTH
        || password.length > TEACHER_ACCOUNT_PASSWORD_MAX_LENGTH
    ) return { ok: false, error: "invalid_password" };
    return { ok: true, value: { email, displayName, password } };
}

export function hashTeacherAccountPassword(
    password: string,
    salt: Buffer = randomBytes(PASSWORD_SALT_BYTES),
): string {
    if (salt.length !== PASSWORD_SALT_BYTES) throw new Error("Teacher password salt must be 16 bytes");
    const hash = pbkdf2Sync(
        password,
        salt,
        TEACHER_ACCOUNT_PASSWORD_ITERATIONS,
        PASSWORD_HASH_BYTES,
        "sha256",
    );
    return `pbkdf2-sha256:${TEACHER_ACCOUNT_PASSWORD_ITERATIONS}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function pbkdf2Async(
    password: string,
    salt: Buffer,
    iterations: number,
    bytes: number,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        pbkdf2(password, salt, iterations, bytes, "sha256", (error, derivedKey) => {
            if (error) reject(error);
            else resolve(derivedKey);
        });
    });
}

export async function hashTeacherAccountPasswordAsync(
    password: string,
    salt: Buffer = randomBytes(PASSWORD_SALT_BYTES),
): Promise<string> {
    if (salt.length !== PASSWORD_SALT_BYTES) throw new Error("Teacher password salt must be 16 bytes");
    const hash = await pbkdf2Async(
        password,
        salt,
        TEACHER_ACCOUNT_PASSWORD_ITERATIONS,
        PASSWORD_HASH_BYTES,
    );
    return `pbkdf2-sha256:${TEACHER_ACCOUNT_PASSWORD_ITERATIONS}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function isSupportedTeacherAccountPasswordHash(encodedHash: unknown): encodedHash is string {
    if (typeof encodedHash !== "string") return false;
    const [algorithm, iterationsRaw, saltHex, hashHex, ...rest] = encodedHash.split(":");
    const iterations = Number(iterationsRaw);
    return !(
        rest.length > 0
        || algorithm !== "pbkdf2-sha256"
        || iterations !== TEACHER_ACCOUNT_PASSWORD_ITERATIONS
        || !/^[a-f0-9]{32}$/i.test(saltHex || "")
        || !/^[a-f0-9]{64}$/i.test(hashHex || "")
    );
}

export function verifyTeacherAccountPassword(password: unknown, encodedHash: unknown): boolean {
    if (typeof password !== "string" || !isSupportedTeacherAccountPasswordHash(encodedHash)) return false;
    const [, iterationsRaw, saltHex, hashHex] = encodedHash.split(":");
    const iterations = Number(iterationsRaw);
    const expected = Buffer.from(hashHex, "hex");
    const actual = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, expected.length, "sha256");
    return timingSafeEqual(actual, expected);
}

/**
 * Verifies one valid PBKDF2 hash even when lookup did not return an account.
 * The fixed dummy value is not a credential; it only removes the cheap
 * unknown/disabled-account branch from the public login boundary.
 */
export function verifyTeacherAccountPasswordConstantWork(
    password: unknown,
    encodedHash: unknown,
): boolean {
    if (typeof password !== "string") return false;
    const supported = isSupportedTeacherAccountPasswordHash(encodedHash);
    const matches = verifyTeacherAccountPassword(password, supported ? encodedHash : DUMMY_PASSWORD_HASH);
    return supported && matches;
}

export async function verifyTeacherAccountPasswordConstantWorkAsync(
    password: unknown,
    encodedHash: unknown,
): Promise<boolean> {
    if (typeof password !== "string") return false;
    const supported = isSupportedTeacherAccountPasswordHash(encodedHash);
    const candidateHash = supported ? encodedHash : DUMMY_PASSWORD_HASH;
    const [, iterationsRaw, saltHex, hashHex] = candidateHash.split(":");
    const expected = Buffer.from(hashHex, "hex");
    const actual = await pbkdf2Async(
        password,
        Buffer.from(saltHex, "hex"),
        Number(iterationsRaw),
        expected.length,
    );
    return supported && timingSafeEqual(actual, expected);
}

export function hashTeacherAccountToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createTeacherAccountToken(
    purpose: TeacherAccountTokenPurpose,
    now = Date.now(),
    random = randomBytes,
): {
    purpose: TeacherAccountTokenPurpose;
    token: string;
    tokenHash: string;
    expiresAt: number;
} {
    const token = random(32).toString("base64url");
    const ttlMs = purpose === "email_verify" ? 24 * 60 * 60 * 1_000 : 30 * 60 * 1_000;
    return {
        purpose,
        token,
        tokenHash: hashTeacherAccountToken(token),
        expiresAt: now + ttlMs,
    };
}
