export type StudentCredentialIssuanceResult<T> =
    | { started: false }
    | { started: true; value: T };

export async function withStudentCredentialIssuanceLock<T>(
    locks: Set<string>,
    studentId: string,
    operation: () => Promise<T>,
): Promise<StudentCredentialIssuanceResult<T>> {
    const normalizedStudentId = studentId.trim();
    if (!normalizedStudentId || locks.has(normalizedStudentId)) return { started: false };
    locks.add(normalizedStudentId);
    try {
        return { started: true, value: await operation() };
    } finally {
        locks.delete(normalizedStudentId);
    }
}
