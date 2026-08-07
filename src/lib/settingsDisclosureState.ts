export type SettingsSectionKey =
    | "profile"
    | "notifications"
    | "exam-defaults"
    | "grading"
    | "api"
    | "theme"
    | "data"
    | "security";

const ADVANCED_SETTINGS_SECTIONS = new Set<SettingsSectionKey>([
    "profile",
    "api",
    "data",
    "security",
]);

export function resolveSectionAfterAdvancedToggle(
    section: SettingsSectionKey,
    disclosureOpen: boolean,
): SettingsSectionKey {
    if (!disclosureOpen && ADVANCED_SETTINGS_SECTIONS.has(section)) {
        return "exam-defaults";
    }
    return section;
}
