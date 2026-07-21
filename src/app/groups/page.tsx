import { redirect } from "next/navigation";

/**
 * Legacy `/groups` route — superseded by the consolidated teacher console
 * at `/teacher/users` which has a dedicated "반 · 그룹" tab.
 * Keep the public URL compatible, but redirect on the server so this legacy
 * route does not ship a client component or briefly render an intermediate
 * loading screen before the teacher auth gate runs.
 */
export default function LegacyGroupsRedirect() {
    redirect("/teacher/users?tab=groups");
}
