import {
    accessSync,
    constants,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const container = `omr-postgres-verify-${process.pid}`;
const password = "omr-live-test-password";
const migrationOwner = "postgres";
const localDatabase = "omr_live_verify";
const requiredPostgresBinaries = ["initdb", "pg_ctl", "createdb", "psql", "postgres"];
const dockerInfoTimeoutMs = 5_000;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: options.capture ? "pipe" : "inherit",
        env: options.env || process.env,
        timeout: options.timeout,
    });
    if (result.status !== 0 && !options.allowFailure) {
        const detail = [
            result.error?.message,
            result.stdout,
            result.stderr,
        ].filter(Boolean).join("\n");
        throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
    }
    return result;
}

function runSqlMatrix(psqlFile) {
    psqlFile("supabase/live-test-prelude.sql");
    psqlFile("supabase/schema.sql");

    const migrations = readdirSync(resolve(root, "supabase/migrations"))
        .filter(name => name.endsWith(".sql"))
        .sort();
    for (const migration of migrations) {
        psqlFile(`supabase/migrations/${migration}`);
    }

    psqlFile("supabase/production-server-boundary.sql");
    psqlFile("supabase/live-test-assertions.sql");
}

function postgresBinCandidates() {
    const pathDirectories = (process.env.PATH || "").split(delimiter).filter(Boolean);
    return [
        process.env.OMR_POSTGRES_BIN,
        ...pathDirectories,
        "/opt/homebrew/opt/postgresql@17/bin",
        "/usr/local/opt/postgresql@17/bin",
        "/home/linuxbrew/.linuxbrew/opt/postgresql@17/bin",
    ].filter(Boolean);
}

function hasRequiredPostgresBinaries(directory) {
    return requiredPostgresBinaries.every(binary => {
        try {
            accessSync(resolve(directory, binary), constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

function isPostgres17Directory(directory) {
    const version = run(postgresBinary(directory, "postgres"), ["--version"], {
        capture: true,
        allowFailure: true,
    });
    return version.status === 0 && /\bPostgreSQL\)\s+17\./.test(version.stdout);
}

function findPostgresBinDirectory() {
    const directories = [...new Set(postgresBinCandidates())];
    const directory = directories.find(directory => hasRequiredPostgresBinaries(directory) && isPostgres17Directory(directory));
    if (directory) return directory;

    throw new Error(
        "PostgreSQL 17 binaries are required for the local fallback. " +
        "Set OMR_POSTGRES_BIN to a directory containing initdb, pg_ctl, createdb, psql, and postgres. " +
        `Checked: ${directories.join(", ")}`,
    );
}

function postgresBinary(directory, name) {
    return resolve(directory, name);
}

function getFreePort(host) {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen({ host, port: 0, exclusive: true }, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error(`Unable to reserve a free PostgreSQL port on ${host}.`));
                return;
            }
            server.close(error => {
                if (error) reject(error);
                else resolvePort(address.port);
            });
        });
    });
}

function runDockerVerification() {
    function psqlFile(path) {
        run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            "-f", `/workspace/${path}`,
        ]);
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
            const probe = run("docker", ["exec", container, "pg_isready", "-U", migrationOwner], {
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

        runSqlMatrix(psqlFile);
    } finally {
        run("docker", ["rm", "--force", container], { capture: true, allowFailure: true });
    }
}

async function runLocalVerification() {
    const postgresBin = findPostgresBinDirectory();
    const version = run(postgresBinary(postgresBin, "postgres"), ["--version"], { capture: true });
    if (!/\bPostgreSQL\)\s+17\./.test(version.stdout)) {
        throw new Error(`Local fallback requires PostgreSQL 17; found: ${version.stdout.trim()}`);
    }

    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "omr-postgres-verify-"));
    try {
        const dataDirectory = resolve(temporaryDirectory, "data");
        const socketDirectory = resolve(temporaryDirectory, "socket");
        const logPath = resolve(temporaryDirectory, "postgres.log");
        const passwordPath = resolve(temporaryDirectory, "pwfile");
        const port = await getFreePort("127.0.0.1");
        const localEnv = { ...process.env, PGPASSWORD: password };
        mkdirSync(socketDirectory, { mode: 0o700 });
        writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });

        function psqlFile(path) {
            run(postgresBinary(postgresBin, "psql"), [
                "-h", "127.0.0.1",
                "-p", String(port),
                "-U", migrationOwner,
                "-d", localDatabase,
                "-v", "ON_ERROR_STOP=1",
                "-f", resolve(root, path),
            ], { env: localEnv });
        }

        run(postgresBinary(postgresBin, "initdb"), [
            "-D", dataDirectory,
            "-U", migrationOwner,
            "--auth-local=trust",
            "--auth-host=scram-sha-256",
            "--pwfile", passwordPath,
            "--encoding=UTF8",
            "--no-locale",
            "--no-instructions",
        ]);
        rmSync(passwordPath, { force: true });

        run(postgresBinary(postgresBin, "pg_ctl"), [
            "-D", dataDirectory,
            "-l", logPath,
            "-o", `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
            "-w", "start",
        ]);
        run(postgresBinary(postgresBin, "createdb"), [
            "-h", "127.0.0.1",
            "-p", String(port),
            "-U", migrationOwner,
            localDatabase,
        ], { env: localEnv });

        runSqlMatrix(psqlFile);
    } finally {
        run(postgresBinary(postgresBin, "pg_ctl"), [
            "-D", resolve(temporaryDirectory, "data"),
            "-m", "immediate",
            "-w", "stop",
        ], { capture: true, allowFailure: true });
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

async function main() {
    const requestedBackend = process.env.OMR_SUPABASE_LIVE_BACKEND || "auto";
    if (!["auto", "docker", "local"].includes(requestedBackend)) {
        throw new Error(
            `OMR_SUPABASE_LIVE_BACKEND must be auto, docker, or local; received ${requestedBackend}.`,
        );
    }

    const dockerCheck = requestedBackend === "local"
        ? { status: 1 }
        : run("docker", ["info"], {
            capture: true,
            allowFailure: true,
            timeout: dockerInfoTimeoutMs,
        });
    if (requestedBackend === "docker" && dockerCheck.status !== 0) {
        throw new Error("Docker backend was requested, but the Docker engine is not responsive.");
    }

    if (dockerCheck.status === 0) {
        console.log("Supabase live verification backend: Docker PostgreSQL 17");
        runDockerVerification();
        return;
    }

    console.log("Supabase live verification backend: ephemeral local PostgreSQL 17");
    await runLocalVerification();
}

await main();
