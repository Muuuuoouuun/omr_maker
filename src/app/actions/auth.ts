"use server";

import { mintTeacherToken, TEACHER_AUTH_ERROR, verifyTeacherPasswordValue } from "@/lib/teacherAuth";

/**
 * Server action to verify teacher password securely without exposing it to client-side code bundles.
 */
export async function verifyTeacherPassword(password: string): Promise<{ success: boolean; token?: string; error?: string }> {
    if (verifyTeacherPasswordValue(password)) {
        return {
            success: true,
            token: mintTeacherToken(),
        };
    }

    return {
        success: false,
        error: TEACHER_AUTH_ERROR,
    };
}
