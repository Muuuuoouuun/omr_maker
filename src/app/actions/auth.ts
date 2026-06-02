"use server";

/**
 * Server action to verify teacher password securely without exposing it to client-side code bundles.
 */
export async function verifyTeacherPassword(password: string): Promise<{ success: boolean; token?: string; error?: string }> {
    // In production, this would read from process.env.TEACHER_PASSWORD or a DB.
    // For now we securely verify it server-side.
    const CORRECT_PASSWORD = process.env.TEACHER_PASSWORD || "admin123";

    if (password === CORRECT_PASSWORD) {
        // Mint a mock secure session token to provide to the client
        const randomHex = Math.random().toString(16).substring(2, 10);
        const timestamp = Date.now().toString(36);
        const token = `tkn_${timestamp}_${randomHex}`;

        return {
            success: true,
            token,
        };
    }

    return {
        success: false,
        error: "비밀번호가 올바르지 않습니다.",
    };
}
