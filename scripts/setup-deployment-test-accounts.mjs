import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
    buildDeploymentFixture,
    redactFixtureSummary,
    SHARED_CLASS_ID,
    SHARED_ORGANIZATION_ID,
    vercelReadableEnvArgs,
} from "./deployment-test-accounts-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--apply")
    ? "apply"
    : process.argv.includes("--verify")
        ? "verify"
        : process.argv.includes("--dry-run")
            ? "dry-run"
            : null;
const targets = ["production", "preview"];

function parseEnvFile(path) {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        let value = match[2];
        if (value.startsWith('"') && value.endsWith('"')) {
            try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
        } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
        }
        env[match[1]] = value;
    }
    return env;
}

function runVercel(args, options = {}) {
    const result = spawnSync("npx", ["--yes", "vercel@latest", ...args], {
        cwd: root,
        encoding: "utf8",
        input: options.input,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
    });
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`Vercel command failed: vercel ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
    }
    return result.stdout.trim();
}

function pullEnvironment(target, directory) {
    const path = resolve(directory, `.env.${target}`);
    runVercel(["env", "pull", path, `--environment=${target}`, "--yes"]);
    return parseEnvFile(path);
}

function addEnvironmentValue(name, target, value) {
    // Vercel encrypts ordinary environment variables at rest while keeping them
    // available to authenticated `env pull` verification. The `--sensitive`
    // default is intentionally overridden because it becomes permanently unreadable.
    runVercel(vercelReadableEnvArgs(name, target), { input: `${value}\n` });
}

function serverConfig(env, target) {
    const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
    const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY || env.OMR_SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!url || !serviceRoleKey) {
        throw new Error(`${target} is missing a Supabase URL or service-role key`);
    }
    return { url, serviceRoleKey };
}

function configuredSecret(env, primary, alternate) {
    return (env[primary] || env[alternate] || "").trim();
}

function secureSecret() {
    return randomBytes(32).toString("base64url");
}

function chooseStudentSecrets(environments) {
    const secrets = Object.fromEntries(targets.map(target => [
        target,
        configuredSecret(environments[target], "STUDENT_SESSION_SECRET", "OMR_STUDENT_SESSION_SECRET") || secureSecret(),
    ]));
    const productionConfig = serverConfig(environments.production, "production");
    const previewConfig = serverConfig(environments.preview, "preview");
    if (productionConfig.url === previewConfig.url && secrets.production !== secrets.preview) {
        secrets.preview = secrets.production;
    }
    return secrets;
}

async function checkedUpsert(client, table, values, onConflict) {
    const { error } = await client.from(table).upsert(values, onConflict ? { onConflict } : undefined);
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
}

async function applyFixtureToSupabase(config, fixture) {
    const client = createClient(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    await checkedUpsert(client, "omr_organizations", fixture.organization, "id");
    await checkedUpsert(client, "omr_user_profiles", fixture.userProfiles, "user_id");
    await checkedUpsert(client, "omr_organization_members", fixture.members, "organization_id,user_id");
    await checkedUpsert(client, "omr_teacher_profiles", fixture.teacherProfiles, "organization_id,user_id");
    await checkedUpsert(client, "omr_classes", fixture.classRow, "id");
    await checkedUpsert(client, "omr_student_profiles", fixture.students, "id");
    await checkedUpsert(client, "omr_class_students", fixture.enrollments, "class_id,student_profile_id");
    await checkedUpsert(client, "omr_student_start_credentials", fixture.studentCredentials, "organization_id,student_profile_id");
}

async function queryRows(client, table, columns, filters = []) {
    let query = client.from(table).select(columns);
    for (const [column, value] of filters) query = query.eq(column, value);
    const { data, error } = await query;
    if (error) throw new Error(`${table} verification failed: ${error.message}`);
    return data || [];
}

async function verifySupabase(config) {
    const client = createClient(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const [organizations, members, classes, students, enrollments, credentials] = await Promise.all([
        queryRows(client, "omr_organizations", "id,plan", [["id", SHARED_ORGANIZATION_ID]]),
        queryRows(client, "omr_organization_members", "user_id,role", [["organization_id", SHARED_ORGANIZATION_ID]]),
        queryRows(client, "omr_classes", "id,name", [["id", SHARED_CLASS_ID]]),
        queryRows(client, "omr_student_profiles", "id,external_id,display_name", [["organization_id", SHARED_ORGANIZATION_ID]]),
        queryRows(client, "omr_class_students", "student_profile_id,enrollment_status", [["organization_id", SHARED_ORGANIZATION_ID], ["class_id", SHARED_CLASS_ID]]),
        queryRows(client, "omr_student_start_credentials", "student_profile_id", [["organization_id", SHARED_ORGANIZATION_ID]]),
    ]);
    const checks = {
        organization: organizations.length === 1 && organizations[0].plan === "academy",
        members: members.length === 4,
        class: classes.length === 1 && classes[0].name === "테스트반",
        students: students.length === 3,
        enrollments: enrollments.length === 3 && enrollments.every(row => row.enrollment_status === "active"),
        credentials: credentials.length === 3,
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length > 0) throw new Error(`Supabase fixture verification failed: ${failed.join(", ")}`);
    return checks;
}

function verifyTeacherAccounts(env, target) {
    let accounts;
    try { accounts = JSON.parse(env.TEACHER_ACCOUNTS || "[]"); } catch { accounts = []; }
    const expected = [
        ["admin", "academy", "admin"],
        ["teacher1", "free", "teacher"],
        ["teacher2", "pro", "teacher"],
        ["teacher3", "academy", "teacher"],
    ];
    const valid = expected.every(([id, plan, memberRole]) => accounts.some(account => (
        account.id === id
        && account.plan === plan
        && account.memberRole === memberRole
        && account.organizationId === SHARED_ORGANIZATION_ID
        && typeof account.passwordHash === "string"
        && account.passwordHash.startsWith("pbkdf2-sha256:")
        && !account.password
    )));
    if (!valid) throw new Error(`${target} TEACHER_ACCOUNTS does not contain the expected hashed accounts`);
}

async function apply(environments) {
    const inheritedPreviewKeys = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "STUDENT_ATTEMPT_SECRET",
        "OMR_STUDENT_ATTEMPT_SECRET",
    ];
    for (const key of inheritedPreviewKeys) {
        if (!environments.preview[key] && environments.production[key]) {
            addEnvironmentValue(key, "preview", environments.production[key]);
            environments.preview[key] = environments.production[key];
        }
    }
    const studentSecrets = chooseStudentSecrets(environments);
    const appliedDatabases = new Set();
    for (const target of targets) {
        const teacherSessionSecret = configuredSecret(environments[target], "TEACHER_SESSION_SECRET", "OMR_TEACHER_SESSION_SECRET") || secureSecret();
        const fixture = buildDeploymentFixture({ studentSessionSecret: studentSecrets[target] });
        addEnvironmentValue("TEACHER_ACCOUNTS", target, JSON.stringify(fixture.teacherAccounts));
        addEnvironmentValue("TEACHER_SESSION_SECRET", target, teacherSessionSecret);
        addEnvironmentValue("STUDENT_SESSION_SECRET", target, studentSecrets[target]);

        const config = serverConfig(environments[target], target);
        const databaseKey = `${config.url}\u0000${studentSecrets[target]}`;
        if (!appliedDatabases.has(databaseKey)) {
            await applyFixtureToSupabase(config, fixture);
            appliedDatabases.add(databaseKey);
        }
        process.stdout.write(`${target}: environment and Supabase fixture applied\n`);
    }
}

async function verify(environments) {
    const verifiedDatabases = new Set();
    for (const target of targets) {
        verifyTeacherAccounts(environments[target], target);
        if (!configuredSecret(environments[target], "TEACHER_SESSION_SECRET", "OMR_TEACHER_SESSION_SECRET")) {
            throw new Error(`${target} is missing TEACHER_SESSION_SECRET`);
        }
        if (!configuredSecret(environments[target], "STUDENT_SESSION_SECRET", "OMR_STUDENT_SESSION_SECRET")) {
            throw new Error(`${target} is missing STUDENT_SESSION_SECRET`);
        }
        const config = serverConfig(environments[target], target);
        if (!verifiedDatabases.has(config.url)) {
            await verifySupabase(config);
            verifiedDatabases.add(config.url);
        }
        process.stdout.write(`${target}: account configuration verified\n`);
    }
}

async function main() {
    if (!mode) throw new Error("Use --dry-run, --apply, or --verify");
    if (mode === "dry-run") {
        const fixture = buildDeploymentFixture({ studentSessionSecret: "dry-run-secret" });
        process.stdout.write(`${JSON.stringify(redactFixtureSummary(fixture), null, 2)}\n`);
        return;
    }

    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "omr-deployment-accounts-"));
    try {
        const environments = Object.fromEntries(targets.map(target => [target, pullEnvironment(target, temporaryDirectory)]));
        if (mode === "apply") {
            await apply(environments);
            const refreshed = Object.fromEntries(targets.map(target => [target, pullEnvironment(target, temporaryDirectory)]));
            await verify(refreshed);
        } else {
            await verify(environments);
        }
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
