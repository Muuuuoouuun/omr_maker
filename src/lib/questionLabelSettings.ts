export type QuestionLabelCandidateSource = "current" | "recent" | "default";

export interface QuestionLabelUsage {
    value: string;
    count: number;
    lastUsedAt: string;
}

export interface QuestionLabelSettings {
    schemaVersion: 1;
    recentLabels: QuestionLabelUsage[];
    recentUnits: QuestionLabelUsage[];
    recentConcepts: QuestionLabelUsage[];
    hiddenLabels: string[];
    updatedAt?: string;
}

export interface QuestionLabelCandidate {
    label: string;
    source: QuestionLabelCandidateSource;
    usageCount: number;
    lastUsedAt?: string;
}

export interface QuestionLabelSettingUsageInput {
    labels?: Array<string | undefined | null>;
    units?: Array<string | undefined | null>;
    concepts?: Array<string | undefined | null>;
}

export interface QuestionLabelSettingsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = "omr_question_label_settings_v1";
const MAX_RECENT_VALUES = 30;
const MAX_VALUE_LENGTH = 48;

export const EMPTY_QUESTION_LABEL_SETTINGS: QuestionLabelSettings = {
    schemaVersion: 1,
    recentLabels: [],
    recentUnits: [],
    recentConcepts: [],
    hiddenLabels: [],
};

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cleanQuestionLabelValue(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
}

function normalizeUsageList(value: unknown): QuestionLabelUsage[] {
    if (!Array.isArray(value)) return [];
    const byValue = new Map<string, QuestionLabelUsage>();
    for (const item of value) {
        const raw = asObject(item);
        const cleanValue = cleanQuestionLabelValue(raw.value);
        if (!cleanValue) continue;
        const previous = byValue.get(cleanValue);
        const count = Math.max(1, Math.floor(Number(raw.count) || 1));
        const lastUsedAt = typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : "";
        byValue.set(cleanValue, {
            value: cleanValue,
            count: (previous?.count || 0) + count,
            lastUsedAt: previous && previous.lastUsedAt > lastUsedAt ? previous.lastUsedAt : lastUsedAt,
        });
    }
    return sortUsageList(Array.from(byValue.values())).slice(0, MAX_RECENT_VALUES);
}

function normalizeHiddenLabels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return uniqueCleanValues(value);
}

export function normalizeQuestionLabelSettings(value: unknown): QuestionLabelSettings {
    const raw = asObject(value);
    return {
        schemaVersion: 1,
        recentLabels: normalizeUsageList(raw.recentLabels),
        recentUnits: normalizeUsageList(raw.recentUnits),
        recentConcepts: normalizeUsageList(raw.recentConcepts),
        hiddenLabels: normalizeHiddenLabels(raw.hiddenLabels),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
}

export function questionLabelSettingsStorageKey(scopeId: string | undefined | null): string {
    const safeScope = cleanQuestionLabelValue(scopeId || "default")
        .replace(/[^a-z0-9_-]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        || "default";
    return `${STORAGE_PREFIX}:${safeScope}`;
}

export function readQuestionLabelSettings(
    storage: QuestionLabelSettingsStorage | null | undefined,
    key: string,
): QuestionLabelSettings {
    if (!storage || !key) return EMPTY_QUESTION_LABEL_SETTINGS;
    try {
        const raw = storage.getItem(key);
        if (!raw) return EMPTY_QUESTION_LABEL_SETTINGS;
        return normalizeQuestionLabelSettings(JSON.parse(raw));
    } catch {
        return EMPTY_QUESTION_LABEL_SETTINGS;
    }
}

export function writeQuestionLabelSettings(
    storage: QuestionLabelSettingsStorage | null | undefined,
    key: string,
    settings: QuestionLabelSettings,
): boolean {
    if (!storage || !key) return false;
    try {
        storage.setItem(key, JSON.stringify(normalizeQuestionLabelSettings(settings)));
        return true;
    } catch {
        return false;
    }
}

function sortUsageList(values: QuestionLabelUsage[]): QuestionLabelUsage[] {
    return values.sort((a, b) => {
        if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
        if (b.count !== a.count) return b.count - a.count;
        return a.value.localeCompare(b.value, "ko");
    });
}

function uniqueCleanValues(values: Array<unknown>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const cleanValue = cleanQuestionLabelValue(value);
        if (!cleanValue || seen.has(cleanValue)) continue;
        seen.add(cleanValue);
        result.push(cleanValue);
    }
    return result;
}

function recordUsageValues(
    current: QuestionLabelUsage[],
    values: Array<string | undefined | null> | undefined,
    now: string,
): QuestionLabelUsage[] {
    const byValue = new Map(current.map(item => [item.value, item]));
    for (const value of uniqueCleanValues(values || [])) {
        const previous = byValue.get(value);
        byValue.set(value, {
            value,
            count: (previous?.count || 0) + 1,
            lastUsedAt: now,
        });
    }
    return sortUsageList(Array.from(byValue.values())).slice(0, MAX_RECENT_VALUES);
}

export function recordQuestionLabelSettingUsage(
    settings: QuestionLabelSettings,
    usage: QuestionLabelSettingUsageInput,
    now = new Date().toISOString(),
): QuestionLabelSettings {
    const labels = uniqueCleanValues(usage.labels || []);
    return normalizeQuestionLabelSettings({
        ...settings,
        recentLabels: recordUsageValues(settings.recentLabels, labels, now),
        recentUnits: recordUsageValues(settings.recentUnits, usage.units, now),
        recentConcepts: recordUsageValues(settings.recentConcepts, usage.concepts, now),
        hiddenLabels: settings.hiddenLabels.filter(label => !labels.includes(label)),
        updatedAt: now,
    });
}

export function hideQuestionLabelCandidate(
    settings: QuestionLabelSettings,
    label: string,
    now = new Date().toISOString(),
): QuestionLabelSettings {
    const cleanLabel = cleanQuestionLabelValue(label);
    if (!cleanLabel) return settings;
    return normalizeQuestionLabelSettings({
        ...settings,
        hiddenLabels: [...settings.hiddenLabels, cleanLabel],
        updatedAt: now,
    });
}

export function restoreHiddenQuestionLabelCandidates(
    settings: QuestionLabelSettings,
    now = new Date().toISOString(),
): QuestionLabelSettings {
    return normalizeQuestionLabelSettings({
        ...settings,
        hiddenLabels: [],
        updatedAt: now,
    });
}

export function questionLabelUsageValues(values: QuestionLabelUsage[], limit = 8): string[] {
    return values.slice(0, limit).map(item => item.value);
}

export function buildQuestionLabelCandidates(params: {
    currentLabels?: Array<string | undefined | null>;
    defaultLabels?: string[];
    settings: QuestionLabelSettings;
    limit?: number;
}): QuestionLabelCandidate[] {
    const limit = params.limit ?? 18;
    const candidates = new Map<string, QuestionLabelCandidate>();
    const hiddenLabels = new Set(params.settings.hiddenLabels.map(cleanQuestionLabelValue));

    for (const label of uniqueCleanValues(params.currentLabels || [])) {
        candidates.set(label, {
            label,
            source: "current",
            usageCount: 0,
        });
    }

    for (const item of params.settings.recentLabels) {
        const label = cleanQuestionLabelValue(item.value);
        if (!label || hiddenLabels.has(label) || candidates.has(label)) continue;
        candidates.set(label, {
            label,
            source: "recent",
            usageCount: item.count,
            lastUsedAt: item.lastUsedAt,
        });
    }

    for (const label of uniqueCleanValues(params.defaultLabels || [])) {
        if (hiddenLabels.has(label) || candidates.has(label)) continue;
        candidates.set(label, {
            label,
            source: "default",
            usageCount: 0,
        });
    }

    return Array.from(candidates.values()).slice(0, limit);
}
