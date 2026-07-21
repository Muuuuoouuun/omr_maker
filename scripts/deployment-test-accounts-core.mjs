import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

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
        || iterations < 1_000
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

export function studentMetadata(code, studentId, organizationId, secret, now) {
    const normalized = typeof code === "string" ? code.replace(/\s/g, "").toUpperCase() : "";
    if (!normalized || !studentId || !organizationId || !secret || !now) {
        throw new Error("Student metadata inputs are required");
    }
    const hash = createHmac("sha256", secret)
        .update(`${organizationId}\u0000${studentId}\u0000${normalized}`, "utf8")
        .digest("hex");
    return {
        source: "deployment_test_fixture",
        group: "테스트반",
        region: "서울",
        studentAccessCode: { version: 1, hash, updatedAt: now },
    };
}

export function buildDeploymentFixture({ studentSessionSecret, now = new Date().toISOString() }) {
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
        passwordHash: teacherPasswordHash(TEACHER_LOGIN_PASSWORDS[teacher.id]),
        organizationId: SHARED_ORGANIZATION_ID,
        organizationName: SHARED_ORGANIZATION_NAME,
    }));
    const actorRows = teachers.map(teacher => ({
        ...teacher,
        userId: `teacher_${stableWorkspaceHash(teacher.id)}`,
    }));
    const students = Object.entries(STUDENT_START_CODES).map(([loginId, code], index) => {
        const id = studentProfileId(loginId);
        return {
            id,
            organization_id: SHARED_ORGANIZATION_ID,
            display_name: `학생 ${index + 1}`,
            external_id: loginId,
            email: `${loginId}@omr.test`,
            status: "active",
            metadata: studentMetadata(code, id, SHARED_ORGANIZATION_ID, studentSessionSecret, now),
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
            start_code_hash: studentStartCodeHash(STUDENT_START_CODES[row.external_id]),
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
