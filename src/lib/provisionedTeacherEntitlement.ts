/** An explicit recovery mode admits only the operator-backed legacy owner shape.
 * Database gateways remain authoritative for active provenance and entitlement. */
export type ProvisionedTeacherEntitlementMode = "permanent_demo" | "legacy_recovery";

export const LEGACY_RECOVERY_ORGANIZATION_PATTERN = /^teacher_[a-z0-9]{7,16}$/;

export function isProvisionedOrganizationShape(organizationId: string, mode: unknown): boolean {
    if (mode === "legacy_recovery") return LEGACY_RECOVERY_ORGANIZATION_PATTERN.test(organizationId);
    if (mode === "permanent_demo") return /^demo_org_[a-f0-9]{24}$/.test(organizationId);
    return mode === undefined && /^(?:pilot_org_|demo_org_)[a-f0-9]{24}$/.test(organizationId);
}

export function isLegacyRecoveryOwner(mode: unknown, role: unknown, plan: unknown): boolean {
    return mode !== "legacy_recovery" || (role === "owner" && plan === "academy");
}
