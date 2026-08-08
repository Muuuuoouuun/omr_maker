export type StudentCredentialCsvRow = {
    studentId: string;
    name: string;
    group: string;
    startCode: string;
};

export const STUDENT_CREDENTIAL_CSV_MAX_ROWS = 100;
export const STUDENT_CREDENTIAL_CSV_MAX_FIELD_BYTES = 256;
export const STUDENT_CREDENTIAL_CSV_MAX_BYTES = 48 * 1024;

const START_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const FORBIDDEN_STUDENT_ID_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u;
const DANGEROUS_SPREADSHEET_PREFIX = /^(?:[\s\uFEFF\u0001-\u001F\u007F-\u009F]*[=+\-@]|[\s\uFEFF]*[\u0000-\u001F\u007F-\u009F])/u;

function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function exactField(value: unknown, label: string): string {
    if (
        typeof value !== "string"
        || !value.trim()
        || value.includes("\0")
        || byteLength(value) > STUDENT_CREDENTIAL_CSV_MAX_FIELD_BYTES
    ) {
        throw new Error(`invalid ${label}`);
    }
    return value;
}

function spreadsheetSafe(value: string): string {
    return DANGEROUS_SPREADSHEET_PREFIX.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
    const safe = spreadsheetSafe(value.replace(/\r\n|\r|\n/gu, "\r\n"));
    return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function serializeStudentCredentialCsv(
    rows: readonly StudentCredentialCsvRow[],
): string {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > STUDENT_CREDENTIAL_CSV_MAX_ROWS) {
        throw new Error("invalid student credential row count");
    }

    const seenStudentIds = new Set<string>();
    const lines = ["student_id,name,group,start_code"];
    for (const candidate of rows) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("invalid student credential row");
        }
        const studentId = exactField(candidate.studentId, "student id");
        const name = exactField(candidate.name, "student name");
        const group = exactField(candidate.group, "student group");
        const startCode = exactField(candidate.startCode, "start code");
        if (
            studentId !== studentId.trim()
            || FORBIDDEN_STUDENT_ID_CHARACTERS.test(studentId)
            || !START_CODE_PATTERN.test(startCode)
        ) {
            throw new Error("invalid student credential row");
        }
        if (seenStudentIds.has(studentId)) throw new Error("duplicate student credential row");
        seenStudentIds.add(studentId);
        lines.push([
            csvField(studentId),
            csvField(name),
            csvField(group),
            csvField(startCode),
        ].join(","));
    }

    const csv = `\uFEFF${lines.join("\r\n")}\r\n`;
    if (byteLength(csv) > STUDENT_CREDENTIAL_CSV_MAX_BYTES) {
        throw new Error("student credential CSV size exceeded");
    }
    return csv;
}
