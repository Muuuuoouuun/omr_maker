const INVALID_JSON_CODE = "AI_INVALID_JSON_RESPONSE";

export function extractAnswerJsonArrayPayload(text: string): string {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\[\s*{[\s\S]*}\s*\]/);
    return jsonMatch ? jsonMatch[0] : cleaned;
}

export function invalidAiJsonError(responseLength: number): Error {
    const error = new Error(INVALID_JSON_CODE) as Error & { responseLength?: number };
    error.name = "AIAnswerParseError";
    error.responseLength = Math.max(0, Math.floor(Number.isFinite(responseLength) ? responseLength : 0));
    return error;
}

function categorizeAiAnswerError(message: string): string {
    const lower = message.toLowerCase();
    if (message === INVALID_JSON_CODE || lower.includes("유효한 정답 형식")) return "invalid_json";
    if (lower.includes("api key") || lower.includes("apikey") || lower.includes("api 키") || lower.includes("권한") || lower.includes("401") || lower.includes("403")) return "auth";
    if (lower.includes("quota") || lower.includes("rate") || lower.includes("429") || lower.includes("resource_exhausted") || lower.includes("사용량") || lower.includes("요청 제한")) return "quota";
    if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout") || lower.includes("네트워크")) return "network";
    return "unknown";
}

export function safeAiAnswerErrorMessage(error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const category = categorizeAiAnswerError(rawMessage);

    if (category === "invalid_json") {
        return "AI가 유효한 정답 형식을 반환하지 않았습니다. 이미지가 선명한지 확인해주세요.";
    }
    if (category === "auth") {
        return "Gemini API 키 또는 권한을 확인해주세요.";
    }
    if (category === "quota") {
        return "Gemini API 사용량 또는 요청 제한을 확인해주세요.";
    }
    if (category === "network") {
        return "네트워크 연결 상태를 확인한 뒤 다시 시도해주세요.";
    }

    return "AI 인식 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
}

export function safeAiAnswerLogMeta(error: unknown, extra: Record<string, unknown> = {}) {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const responseLength = typeof (error as { responseLength?: unknown } | null)?.responseLength === "number"
        ? (error as { responseLength: number }).responseLength
        : undefined;

    return {
        ...extra,
        category: categorizeAiAnswerError(rawMessage),
        errorName: error instanceof Error ? error.name : typeof error,
        messageLength: rawMessage.length,
        ...(responseLength !== undefined ? { responseLength } : {}),
    };
}
