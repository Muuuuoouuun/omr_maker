import { SETTINGS_STORAGE_KEY } from "@/lib/geminiApiKey";
import { MAX_QUESTION_COUNT } from "@/lib/questionCount";
import { DEFAULT_CHOICE_COUNT } from "@/types/omr";

export interface AppSettings {
    profile: { name: string; email: string; school: string; subject: string; publicProfile: boolean };
    notifications: { email: boolean; push: boolean; weekly: boolean; autoRemind: boolean; quietStart: string; quietEnd: string };
    examDefaults: { questions: number; duration: number; scorePerQ: number; choices: 4 | 5; autosaveSec: number };
    grading: { negative: boolean; partial: boolean; autoRelease: boolean; rounding: "half" | "up" | "down" | "none" };
    api: { geminiKey: string };
    theme: { mode: "light" | "dark" | "auto"; accent: string; density: "comfortable" | "compact"; motion: boolean };
    security: { twoFactor: boolean; loginAlerts: boolean };
}

export const DEFAULT_SETTINGS: AppSettings = {
    profile: { name: "김선생", email: "teacher@school.ac.kr", school: "한빛고등학교", subject: "수학 · 과학", publicProfile: true },
    notifications: { email: true, push: true, weekly: false, autoRemind: true, quietStart: "22:00", quietEnd: "07:00" },
    examDefaults: { questions: 20, duration: 50, scorePerQ: 5, choices: DEFAULT_CHOICE_COUNT, autosaveSec: 30 },
    grading: { negative: false, partial: true, autoRelease: false, rounding: "half" },
    api: { geminiKey: "" },
    theme: { mode: "light", accent: "#4f46e5", density: "comfortable", motion: true },
    security: { twoFactor: false, loginAlerts: true },
};

type ExamDefaults = AppSettings["examDefaults"];
const SETTINGS_SECTION_KEYS = [
    "profile",
    "notifications",
    "examDefaults",
    "grading",
    "api",
    "theme",
    "security",
] as const satisfies readonly (keyof AppSettings)[];

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isCompleteSettingsExport(value: unknown): value is AppSettings {
    if (!isObject(value) || !SETTINGS_SECTION_KEYS.every(key => isObject(value[key]))) return false;
    const profile = asObject(value.profile);
    const notifications = asObject(value.notifications);
    const examDefaults = asObject(value.examDefaults);
    const grading = asObject(value.grading);
    const api = asObject(value.api);
    const theme = asObject(value.theme);
    const security = asObject(value.security);

    return typeof profile.name === "string"
        && typeof profile.email === "string"
        && typeof profile.school === "string"
        && typeof profile.subject === "string"
        && typeof profile.publicProfile === "boolean"
        && typeof notifications.email === "boolean"
        && typeof notifications.push === "boolean"
        && typeof notifications.weekly === "boolean"
        && typeof notifications.autoRemind === "boolean"
        && typeof notifications.quietStart === "string"
        && typeof notifications.quietEnd === "string"
        && isFiniteNumber(examDefaults.questions)
        && isFiniteNumber(examDefaults.duration)
        && isFiniteNumber(examDefaults.scorePerQ)
        && (examDefaults.choices === 4 || examDefaults.choices === 5)
        && isFiniteNumber(examDefaults.autosaveSec)
        && typeof grading.negative === "boolean"
        && typeof grading.partial === "boolean"
        && typeof grading.autoRelease === "boolean"
        && ["half", "up", "down", "none"].includes(grading.rounding as string)
        && typeof api.geminiKey === "string"
        && ["light", "dark", "auto"].includes(theme.mode as string)
        && typeof theme.accent === "string"
        && /^#[0-9a-f]{6}$/i.test(theme.accent)
        && ["comfortable", "compact"].includes(theme.density as string)
        && typeof theme.motion === "boolean"
        && typeof security.twoFactor === "boolean"
        && typeof security.loginAlerts === "boolean";
}

function finiteNumber(value: unknown, fallback: number): number {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
    const number = finiteNumber(value, fallback);
    if (number < 1) return fallback;
    return Math.min(max, Math.floor(number));
}

function positiveNumber(value: unknown, fallback: number): number {
    const number = finiteNumber(value, fallback);
    return number > 0 ? number : fallback;
}

function autosaveSeconds(value: unknown, fallback: number): number {
    const number = finiteNumber(value, fallback);
    return [0, 10, 30, 60].includes(number) ? number : fallback;
}

export function normalizeExamDefaults(value: unknown): ExamDefaults {
    const raw = asObject(value);
    return {
        questions: positiveInt(raw.questions, DEFAULT_SETTINGS.examDefaults.questions, MAX_QUESTION_COUNT),
        duration: positiveInt(raw.duration, DEFAULT_SETTINGS.examDefaults.duration, 360),
        scorePerQ: positiveNumber(raw.scorePerQ, DEFAULT_SETTINGS.examDefaults.scorePerQ),
        choices: raw.choices === 4 ? 4 : DEFAULT_CHOICE_COUNT,
        autosaveSec: autosaveSeconds(raw.autosaveSec, DEFAULT_SETTINGS.examDefaults.autosaveSec),
    };
}

export function mergeSettings(parsed: Partial<AppSettings> | null | undefined): AppSettings {
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
        profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
        notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications ?? {}) },
        examDefaults: normalizeExamDefaults(parsed.examDefaults),
        grading: { ...DEFAULT_SETTINGS.grading, ...(parsed.grading ?? {}) },
        api: { ...DEFAULT_SETTINGS.api, ...(parsed.api ?? {}) },
        theme: { ...DEFAULT_SETTINGS.theme, ...(parsed.theme ?? {}) },
        security: { ...DEFAULT_SETTINGS.security, ...(parsed.security ?? {}) },
    };
}

/**
 * Settings imports are destructive, so only accept the complete object shape
 * produced by this app's export action. Stored settings stay backward
 * compatible through parseStoredSettings, which intentionally accepts partial
 * objects written by older app versions.
 */
export function parseImportedSettings(value: unknown): AppSettings | null {
    return isCompleteSettingsExport(value) ? mergeSettings(value) : null;
}

export function parseStoredSettings(rawSettings: string | null | undefined): AppSettings {
    if (!rawSettings) return DEFAULT_SETTINGS;
    try {
        return mergeSettings(JSON.parse(rawSettings) as Partial<AppSettings>);
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export function readStoredSettings(): AppSettings {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return parseStoredSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY));
}

export function readStoredExamDefaults(): ExamDefaults {
    return readStoredSettings().examDefaults;
}
