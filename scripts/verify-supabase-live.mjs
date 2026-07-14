import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const container = `omr-postgres-verify-${process.pid}`;
const password = "omr-live-test-password";

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: options.capture ? "pipe" : "inherit",
    });
    if (result.status !== 0 && !options.allowFailure) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
        throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
    }
    return result;
}

function psqlFile(path) {
    run("docker", [
        "exec", container,
        "psql", "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1",
        "-f", `/workspace/${path}`,
    ]);
}

const dockerCheck = run("docker", ["info"], { capture: true, allowFailure: true });
if (dockerCheck.status !== 0) {
    throw new Error("Docker engine is required for live PostgreSQL verification. Start Docker Desktop and retry.");
}

try {
    run("docker", [
        "run", "--detach", "--rm",
        "--name", container,
        "--env", `POSTGRES_PASSWORD=${password}`,
        "--volume", `${root}:/workspace:ro`,
        "postgres:17-alpine",
    ]);

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = run("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
            capture: true,
            allowFailure: true,
        });
        if (probe.status === 0) {
            ready = true;
            break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready) throw new Error("PostgreSQL container did not become ready in time.");

    psqlFile("supabase/live-test-prelude.sql");
    psqlFile("supabase/schema.sql");

    const migrations = readdirSync(resolve(root, "supabase/migrations"))
        .filter(name => name.endsWith(".sql"))
        .sort();
    for (const migration of migrations) {
        psqlFile(`supabase/migrations/${migration}`);
    }

    psqlFile("supabase/production-rls.sql");
    psqlFile("supabase/live-test-assertions.sql");
} finally {
    run("docker", ["rm", "--force", container], { capture: true, allowFailure: true });
}
