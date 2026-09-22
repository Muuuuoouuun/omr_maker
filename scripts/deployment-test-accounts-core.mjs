import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const SHARED_ORGANIZATION_ID = "teacher_sharedqa";
export const SHARED_ORGANIZATION_NAME = "OMR Maker 테스트";
export const SHARED_CLASS_ID = "teacher_sharedqa_test_class";
export const TEACHER_LOGIN_PASSWORDS = Object.freeze({
    admin: "admin1234",
    teacher1: "teacher1234",
    teacher2: "teacher1234",
    teacher3: "teacher1234",
});
export const STUDENT_START_CODES = Object.freeze({
    student1: "ABC234",
    student2: "BCD345",
    student3: "CDE456",
});

/** Public fixtures are dry-run/unit-test data, never deployed credentials. */
export function deploymentCredentials(env) {
    let teacherPasswords, studentStartCodes;
    try {
        teacherPasswords = JSON.parse(env.OMR_QA_TEACHER_PASSWORDS || "null");
        studentStartCodes = JSON.parse(env.OMR_QA_STUDENT_START_CODES || "null");
    } catch { throw new Error("QA credential settings must be valid JSON objects"); }
    if (!teacherPasswords || !studentStartCodes) throw new Error("Private QA credentials are required before deployment");
    for (const id of Object.keys(TEACHER_LOGIN_PASSWORDS)) {
        const value = teacherPasswords[id];
        if (typeof value !== "string" || value.length < 16 || value.length > 128) {
            throw new Error("Every QA teacher requires a private 16–128 character password");
        }
    }
    for (const id of Object.keys(STUDENT_START_CODES)) {
        const value = studentStartCodes[id];
        if (typeof value !== "string" || !/^[A-HJ-NP-Z2-9]{6}$/.test(value)
            || Object.values(STUDENT_START_CODES).includes(value)) {
            throw new Error("Every QA student requires a private six-character start code");
        }
    }
    if (new Set(Object.keys(TEACHER_LOGIN_PASSWORDS).map(id => teacherPasswords[id])).size !== 4
        || new Set(Object.keys(STUDENT_START_CODES).map(id => studentStartCodes[id])).size !== 3) {
        throw new Error("QA credentials must be unique per account");
    }
    return { teacherPasswords, studentStartCodes };
}

/** QA may never share the production data plane, even under another URL path. */
export function assertQaDatabaseIsolation(environments) {
    const origin = (env) => {
        const url = new URL((env?.SUPABASE_URL || env?.NEXT_PUBLIC_SUPABASE_URL || "").trim());
        if (url.protocol !== "https:" || url.username || url.password || url.port
            || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) {
            throw new Error("QA isolation requires valid production and preview Supabase project URLs");
        }
        return url.origin;
    };
    if (origin(environments.production) === origin(environments.preview)) {
        throw new Error("QA fixtures require a preview Supabase project separate from production");
    }
}

export function vercelReadableEnvArgs(name, target) {
    if (typeof name !== "string" || !name.trim()) throw new Error("Vercel environment variable name is required");
    if (!new Set(["preview", "development"]).has(target)) {
        throw new Error("Vercel environment target is invalid");
    }
    return ["env", "add", name, target, "--force", "--no-sensitive"];
}

const HASH_ALGORITHM = "pbkdf2-sha256";
const HASH_ITERATIONS = 120_000;
const HASH_BYTES = 32;

function encodedPbkdf2(value, iterations = HASH_ITERATIONS, salt = randomBytes(16)) {
    const hash = pbkdf2Sync(value, salt, iterations, HASH_BYTES, "sha256");
    return `${HASH_ALGORITHM}:${iterations}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function parseEncodedPbkdf2(encoded) {
    if (typeof encoded !== "string") return null;
    const [algorithm, iterationsRaw, saltHex, hashHex, ...rest] = encoded.split(":");
    const iterations = Number(iterationsRaw);
    if (
        rest.length > 0
        || algorithm !== HASH_ALGORITHM
        || !Number.isSafeInteger(iterations)
        || iterations < HASH_ITERATIONS
        || iterations > 1_000_000
        || !/^[a-f0-9]{32}$/i.test(saltHex || "")
        || !/^[a-f0-9]{64}$/i.test(hashHex || "")
    ) {
        return null;
    }
    return { iterations, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

function verifyEncodedPbkdf2(value, encoded) {
    const parsed = parseEncodedPbkdf2(encoded);
    if (!parsed) return false;
    const actual = pbkdf2Sync(value, parsed.salt, parsed.iterations, parsed.hash.length, "sha256");
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

function stableWorkspaceHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
}

function studentProfileId(loginId) {
    return `${SHARED_ORGANIZATION_ID}_${loginId}`;
}

export function teacherPasswordHash(password) {
    if (typeof password !== "string" || !password) throw new Error("Teacher password is required");
    return encodedPbkdf2(password);
}

export function studentStartCodeHash(code) {
    const normalized = typeof code === "string" ? code.replace(/\s/g, "").toUpperCase() : "";
    if (!normalized) throw new Error("Student start code is required");
    return encodedPbkdf2(normalized);
}

export function buildDeploymentFixture({ studentSessionSecret, now = new Date().toISOString(), teacherPasswords = TEACHER_LOGIN_PASSWORDS, studentStartCodes = STUDENT_START_CODES }) {
    if (typeof studentSessionSecret !== "string" || !studentSessionSecret.trim()) {
        throw new Error("studentSessionSecret is required");
    }
    const teachers = [
        { id: "admin", name: "관리자", email: "admin@omr.test", memberRole: "admin", plan: "academy" },
        { id: "teacher1", name: "강사 1", email: "teacher1@omr.test", memberRole: "teacher", plan: "free" },
        { id: "teacher2", name: "강사 2", email: "teacher2@omr.test", memberRole: "teacher", plan: "pro" },
        { id: "teacher3", name: "강사 3", email: "teacher3@omr.test", memberRole: "teacher", plan: "academy" },
    ];
    const teacherAccounts = teachers.map(teacher => ({
        ...teacher,
        passwordHash: teacherPasswordHash(teacherPasswords[teacher.id]),
        organizationId: SHARED_ORGANIZATION_ID,
        organizationName: SHARED_ORGANIZATION_NAME,
    }));
    const actorRows = teachers.map(teacher => ({
        ...teacher,
        userId: `teacher_${stableWorkspaceHash(teacher.id)}`,
    }));
    const students = Object.keys(STUDENT_START_CODES).map((loginId, index) => {
        const id = studentProfileId(loginId);
        return {
            id,
            organization_id: SHARED_ORGANIZATION_ID,
            display_name: `학생 ${index + 1}`,
            external_id: loginId,
            email: `${loginId}@omr.test`,
            status: "active",
            metadata: {
                source: "deployment_test_fixture",
                group: "테스트반",
                region: "서울",
            },
            updated_at: now,
        };
    });

    return {
        teacherAccounts,
        organization: {
            id: SHARED_ORGANIZATION_ID,
            name: SHARED_ORGANIZATION_NAME,
            plan: "academy",
            metadata: { source: "deployment_test_fixture" },
            updated_at: now,
        },
        userProfiles: actorRows.map(row => ({
            user_id: row.userId,
            email: row.email,
            display_name: row.name,
            locale: "ko-KR",
            timezone: "Asia/Seoul",
            status: "active",
            metadata: { source: "deployment_test_fixture" },
            updated_at: now,
        })),
        members: actorRows.map(row => ({
            organization_id: SHARED_ORGANIZATION_ID,
            user_id: row.userId,
            email: row.email,
            display_name: row.name,
            role: row.memberRole,
            status: "active",
            updated_at: now,
        })),
        teacherProfiles: actorRows.map(row => ({
            organization_id: SHARED_ORGANIZATION_ID,
            user_id: row.userId,
            display_name: row.name,
            status: "active",
            metadata: { source: "deployment_test_fixture" },
            updated_at: now,
        })),
        classRow: {
            id: SHARED_CLASS_ID,
            organization_id: SHARED_ORGANIZATION_ID,
            name: "테스트반",
            campus: "서울",
            status: "active",
            metadata: { source: "deployment_test_fixture" },
            updated_at: now,
        },
        students,
        enrollments: students.map(row => ({
            class_id: SHARED_CLASS_ID,
            organization_id: SHARED_ORGANIZATION_ID,
            student_profile_id: row.id,
            enrollment_status: "active",
        })),
        studentCredentials: students.map(row => ({
            organization_id: SHARED_ORGANIZATION_ID,
            student_profile_id: row.id,
            start_code_hash: studentStartCodeHash(studentStartCodes[row.external_id]),
            updated_at: now,
        })),
    };
}

export function redactFixtureSummary(fixture) {
    return {
        organization: { id: fixture.organization.id, plan: fixture.organization.plan },
        teachers: fixture.teacherAccounts.map(({ id, memberRole, plan }) => ({ id, memberRole, plan })),
        class: { id: fixture.classRow.id, name: fixture.classRow.name },
        students: fixture.students.map(({ external_id, display_name }) => ({ loginId: external_id, name: display_name })),
        counts: {
            teachers: fixture.teacherAccounts.length,
            students: fixture.students.length,
            enrollments: fixture.enrollments.length,
            credentials: fixture.studentCredentials.length,
        },
    };
}

export function verifyTeacherPasswordHash(password, encoded) {
    return verifyEncodedPbkdf2(password, encoded);
}

export function verifyStudentStartCodeHash(code, encoded) {
    const normalized = typeof code === "string" ? code.replace(/\s/g, "").toUpperCase() : "";
    return verifyEncodedPbkdf2(normalized, encoded);
}
