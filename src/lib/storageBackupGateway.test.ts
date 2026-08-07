import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    compareRegistryToStorage,
    downloadAndHashStorageObjects,
    listStorageObjectsToFixedPoint,
    readRemoteAssetRegistry,
} from "../../scripts/storage-backup-gateway.mjs";

const BUCKET = "omr-private-assets";

function sha(body: string) {
    return createHash("sha256").update(body).digest("hex");
}

function objectEntry(name: string, body = name) {
    return {
        name,
        id: `id-${name}`,
        metadata: {
            size: Buffer.byteLength(body),
            mimetype: "application/pdf",
            sha256Hex: sha(body),
        },
    };
}

function folderEntry(name: string) {
    return { name, id: null, metadata: null };
}

function treeClient(resolveEntries: (path: string, pass: number) => unknown[]) {
    let pass = 0;
    const calls: Array<{ path: string; offset: number; limit: number; pass: number }> = [];
    return {
        calls,
        storage: {
            from(bucket: string) {
                expect(bucket).toBe(BUCKET);
                return {
                    async list(path: string, options: { offset: number; limit: number }) {
                        if (path === "" && options.offset === 0) pass += 1;
                        calls.push({ path, offset: options.offset, limit: options.limit, pass });
                        const entries = resolveEntries(path, pass);
                        return {
                            data: entries.slice(options.offset, options.offset + options.limit),
                            error: null,
                        };
                    },
                };
            },
        },
    };
}

function canonicalTree(objectNames: string[]) {
    return (path: string) => {
        if (path === "") return [folderEntry("organizations")];
        if (path === "organizations") return [folderEntry("org-1")];
        if (path === "organizations/org-1") return [folderEntry("exams")];
        if (path === "organizations/org-1/exams") return [folderEntry("exam-1")];
        if (path === "organizations/org-1/exams/exam-1") return [folderEntry("problem")];
        if (path === "organizations/org-1/exams/exam-1/problem") return objectNames.map((name) => objectEntry(name));
        return [];
    };
}

describe("storage backup gateway", () => {
    it("recursively paginates more than 1,000 objects and requires two identical passes", async () => {
        const names = Array.from({ length: 1001 }, (_, index) => `asset-${String(index).padStart(4, "0")}.pdf`);
        const client = treeClient((path) => canonicalTree(names)(path));

        const objects = await listStorageObjectsToFixedPoint(client, BUCKET, { pageSize: 250, maxPasses: 3 });

        expect(objects).toHaveLength(1001);
        expect(objects[0].path).toBe("organizations/org-1/exams/exam-1/problem/asset-0000.pdf");
        expect(objects.at(-1)?.path).toBe("organizations/org-1/exams/exam-1/problem/asset-1000.pdf");
        expect(client.calls.filter((call) => call.path === "").map((call) => call.pass)).toEqual([1, 2]);
        expect(client.calls.some((call) => call.path.endsWith("/problem") && call.offset === 1000)).toBe(true);
    });

    it("waits for a mutation to converge on the third pass", async () => {
        const client = treeClient((path, pass) => canonicalTree(
            pass === 1 ? ["a.pdf"] : ["a.pdf", "b.pdf"],
        )(path));

        const objects = await listStorageObjectsToFixedPoint(client, BUCKET, { maxPasses: 3 });
        expect(objects.map((object) => object.path)).toEqual([
            "organizations/org-1/exams/exam-1/problem/a.pdf",
            "organizations/org-1/exams/exam-1/problem/b.pdf",
        ]);
        expect(client.calls.filter((call) => call.path === "")).toHaveLength(3);
    });

    it("fails closed when inventory never converges, listing fails, or the bucket differs", async () => {
        const changing = treeClient((path, pass) => canonicalTree(
            Array.from({ length: pass }, (_, index) => `${index}.pdf`),
        )(path));
        await expect(listStorageObjectsToFixedPoint(changing, BUCKET, { maxPasses: 3 }))
            .rejects.toThrow(/converge/i);

        const failed = {
            storage: {
                from: () => ({
                    async list() {
                        return { data: null, error: new Error("service role secret https://project.supabase.co") };
                    },
                }),
            },
        };
        await expect(listStorageObjectsToFixedPoint(failed, BUCKET)).rejects.toThrow("Storage inventory listing failed");
        await expect(listStorageObjectsToFixedPoint(failed, "public-assets")).rejects.toThrow(/bucket/i);
    });

    it("bounds folder-only pagination even when the provider ignores offsets", async () => {
        const client = {
            storage: {
                from: () => ({
                    async list() {
                        return { data: [folderEntry("loop")], error: null };
                    },
                }),
            },
        };
        await expect(listStorageObjectsToFixedPoint(client, BUCKET, {
            pageSize: 1,
            maxPasses: 2,
            maxListPages: 3,
        })).rejects.toThrow(/page limit/i);
    });

    it("bounds the discovered directory queue before traversing a wide folder page", async () => {
        const client = {
            storage: {
                from: () => ({
                    async list(path: string) {
                        return {
                            data: path === ""
                                ? Array.from({ length: 18 }, (_, index) => folderEntry(`folder-${index}`))
                                : [],
                            error: null,
                        };
                    },
                }),
            },
        };
        await expect(listStorageObjectsToFixedPoint(client, BUCKET, {
            pageSize: 20,
            maxObjects: 1,
        })).rejects.toThrow(/directory limit/i);
    });

    it("downloads with bounded concurrency, verifies body hashes, and writes canonical paths", async () => {
        const bodies = new Map([
            ["organizations/org-1/exams/exam-1/problem/a.pdf", "alpha"],
            ["organizations/org-1/exams/exam-1/problem/b.pdf", "beta"],
            ["organizations/org-1/exams/exam-1/problem/c.pdf", "gamma"],
        ]);
        let active = 0;
        let maxActive = 0;
        const client = {
            storage: {
                from() {
                    return {
                        async download(path: string) {
                            active += 1;
                            maxActive = Math.max(maxActive, active);
                            await new Promise((resolve) => setTimeout(resolve, 2));
                            active -= 1;
                            return { data: new Blob([bodies.get(path) ?? ""]), error: null };
                        },
                    };
                },
            },
        };
        const objects = [...bodies].map(([path, body]) => ({
            path,
            bytes: Buffer.byteLength(body),
            sha256: sha(body),
            contentType: "application/pdf",
        }));
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-"));

        const result = await downloadAndHashStorageObjects(client, BUCKET, objects, outputDir, { concurrency: 2 });

        expect(maxActive).toBeLessThanOrEqual(2);
        expect(result).toEqual({
            objectCount: 3,
            totalBytes: 14,
            objects,
        });
        await expect(readFile(join(outputDir, objects[0].path), "utf8")).resolves.toBe("alpha");
    });

    it("accepts server-uploaded objects without Storage SHA metadata and reads nested TUS SHA", async () => {
        const nestedSha = sha("nested");
        const client = treeClient((path) => {
            const tree = canonicalTree([])(path);
            if (path !== "organizations/org-1/exams/exam-1/problem") return tree;
            return [
                {
                    name: "server.pdf",
                    id: "server-id",
                    metadata: { size: 6, mimetype: "application/pdf" },
                },
                {
                    name: "tus.pdf",
                    id: "tus-id",
                    metadata: {
                        size: 6,
                        mimetype: "application/pdf",
                        metadata: { sha256Hex: nestedSha },
                    },
                },
            ];
        });

        const objects = await listStorageObjectsToFixedPoint(client, BUCKET);
        expect(objects).toEqual([
            {
                path: "organizations/org-1/exams/exam-1/problem/server.pdf",
                bytes: 6,
                contentType: "application/pdf",
            },
            {
                path: "organizations/org-1/exams/exam-1/problem/tus.pdf",
                bytes: 6,
                contentType: "application/pdf",
                sha256: nestedSha,
            },
        ]);
    });

    it("computes a body SHA for an orphan object that has no expected hash", async () => {
        const body = "orphan";
        const path = "organizations/org-1/exams/exam-1/problem/orphan.pdf";
        const client = {
            storage: { from: () => ({ async download() { return { data: new Blob([body]), error: null }; } }) },
        };
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-orphan-"));

        await expect(downloadAndHashStorageObjects(client, BUCKET, [{
            path,
            bytes: Buffer.byteLength(body),
            contentType: "application/pdf",
        }], outputDir)).resolves.toMatchObject({
            objects: [{ path, bytes: 6, sha256: sha(body), contentType: "application/pdf" }],
        });
    });

    it("does not write a body whose size or SHA differs from inventory", async () => {
        const client = {
            storage: {
                from: () => ({
                    async download() {
                        return { data: new Blob(["tampered"]), error: null };
                    },
                }),
            },
        };
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-mismatch-"));
        await expect(downloadAndHashStorageObjects(client, BUCKET, [{
            path: "organizations/org-1/exams/exam-1/problem/a.pdf",
            bytes: 5,
            sha256: sha("alpha"),
            contentType: "application/pdf",
        }], outputDir)).rejects.toThrow(/mismatch/i);
        await expect(readFile(join(outputDir, "organizations/org-1/exams/exam-1/problem/a.pdf")))
            .rejects.toMatchObject({ code: "ENOENT" });
    });

    it("sanitizes download and file-write failures, refuses overwrite, and rejects broad roots", async () => {
        const path = "organizations/org-1/exams/exam-1/problem/a.pdf";
        const object = { path, bytes: 5, sha256: sha("alpha"), contentType: "application/pdf" };
        const failedDownload = {
            storage: {
                from: () => ({
                    async download() {
                        return { data: null, error: new Error("service-role-secret https://project.supabase.co") };
                    },
                }),
            },
        };
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-errors-"));
        await expect(downloadAndHashStorageObjects(failedDownload, BUCKET, [object], outputDir))
            .rejects.toThrow("Storage object download failed");

        const validDownload = {
            storage: { from: () => ({ async download() { return { data: new Blob(["alpha"]), error: null }; } }) },
        };
        const target = join(outputDir, path);
        await mkdir(join(outputDir, "organizations/org-1/exams/exam-1/problem"), { recursive: true });
        await writeFile(target, "existing");
        await expect(downloadAndHashStorageObjects(validDownload, BUCKET, [object], outputDir))
            .rejects.toThrow("Storage backup file write failed");
        await expect(readFile(target, "utf8")).resolves.toBe("existing");
        await expect(downloadAndHashStorageObjects(validDownload, BUCKET, [], "/"))
            .rejects.toThrow(/broad output root/i);
    });

    it("rejects an intermediate symlink before writing outside the backup root", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-root-"));
        const outsideDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-outside-"));
        await symlink(outsideDir, join(outputDir, "organizations"), "dir");
        const body = "alpha";
        const client = {
            storage: { from: () => ({ async download() { return { data: new Blob([body]), error: null }; } }) },
        };
        const object = {
            path: "organizations/org-1/exams/exam-1/problem/a.pdf",
            bytes: Buffer.byteLength(body),
            sha256: sha(body),
            contentType: "application/pdf",
        };

        await expect(downloadAndHashStorageObjects(client, BUCKET, [object], outputDir))
            .rejects.toThrow(/escapes the output root/i);
        await expect(stat(join(outsideDir, "org-1")))
            .rejects.toMatchObject({ code: "ENOENT" });
    });

    it("waits for every download worker to settle before reporting a failure", async () => {
        const outputDir = await mkdtemp(join(tmpdir(), "omr-storage-backup-settle-"));
        const failedPath = "organizations/org-1/exams/exam-1/problem/fail.pdf";
        const latePath = "organizations/org-1/exams/exam-1/problem/late.pdf";
        const client = {
            storage: {
                from: () => ({
                    async download(path: string) {
                        if (path === failedPath) {
                            await new Promise((resolve) => setTimeout(resolve, 5));
                            return { data: null, error: new Error("failed") };
                        }
                        await new Promise((resolve) => setTimeout(resolve, 80));
                        return { data: new Blob(["late"]), error: null };
                    },
                }),
            },
        };
        const objects = [
            { path: failedPath, bytes: 4, sha256: sha("fail"), contentType: "application/pdf" },
            { path: latePath, bytes: 4, sha256: sha("late"), contentType: "application/pdf" },
        ];

        await expect(downloadAndHashStorageObjects(client, BUCKET, objects, outputDir, { concurrency: 2 }))
            .rejects.toThrow("Storage object download failed");
        await expect(stat(join(outputDir, latePath))).rejects.toMatchObject({ code: "ENOENT" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        await expect(stat(join(outputDir, latePath))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reads the remote asset registry with bounded pagination", async () => {
        const rows = Array.from({ length: 1001 }, (_, index) => ({
            object_path: `organizations/org-1/exams/exam-1/problem/${index}.pdf`,
            byte_size: index + 1,
            sha256_hex: sha(String(index)),
            mime_type: "application/pdf",
        }));
        const ranges: Array<[number, number]> = [];
        const client = {
            from(table: string) {
                expect(table).toBe("omr_remote_assets");
                return {
                    select(columns: string) {
                        expect(columns).toBe("object_path,byte_size,sha256_hex,mime_type");
                        return {
                            order() {
                                return {
                                    async range(from: number, to: number) {
                                        ranges.push([from, to]);
                                        return { data: rows.slice(from, to + 1), error: null };
                                    },
                                };
                            },
                        };
                    },
                };
            },
        };

        await expect(readRemoteAssetRegistry(client, { pageSize: 250 })).resolves.toHaveLength(1001);
        expect(ranges.at(-1)).toEqual([1000, 1249]);
    });

    it("separates missing, orphan, size, hash, and MIME registry differences", () => {
        const registry = [
            { path: "organizations/org-1/exams/exam-1/problem/a.pdf", bytes: 5, sha256: sha("alpha"), contentType: "application/pdf" },
            { path: "organizations/org-1/exams/exam-1/problem/b.pdf", bytes: 4, sha256: sha("beta"), contentType: "application/pdf" },
        ];
        const storage = [
            { path: registry[0].path, bytes: 6, sha256: sha("other"), contentType: "application/json" },
            { path: "organizations/org-1/exams/exam-1/problem/c.pdf", bytes: 5, sha256: sha("gamma"), contentType: "application/pdf" },
        ];

        expect(compareRegistryToStorage(registry, storage)).toEqual({
            ok: false,
            missingRegistryObjects: [registry[1].path],
            orphanStorageObjects: [storage[1].path],
            sizeMismatch: [{ path: registry[0].path, expected: 5, actual: 6 }],
            hashMismatch: [{ path: registry[0].path, expected: sha("alpha"), actual: sha("other") }],
            contentTypeMismatch: [{ path: registry[0].path, expected: "application/pdf", actual: "application/json" }],
            hashUnavailable: [],
        });
    });

    it("marks Storage hashes as unverified when only DB registry SHA is available", () => {
        const path = "organizations/org-1/exams/exam-1/problem/a.pdf";
        const registry = [{ path, bytes: 5, sha256: sha("alpha"), contentType: "application/pdf" }];
        const listed = [{ path, bytes: 5, contentType: "application/pdf" }];

        expect(compareRegistryToStorage(registry, listed)).toMatchObject({
            ok: false,
            hashUnavailable: [path],
        });
    });

    it("lets the comparator report a canonical path and observed MIME mismatch from listing", async () => {
        const path = "organizations/org-1/exams/exam-1/problem/a.pdf";
        const client = treeClient((directory) => {
            const tree = canonicalTree([])(directory);
            if (directory !== "organizations/org-1/exams/exam-1/problem") return tree;
            return [{
                name: "a.pdf",
                id: "asset-a",
                metadata: { size: 5, mimetype: "application/json", sha256Hex: sha("alpha") },
            }];
        });
        const listed = await listStorageObjectsToFixedPoint(client, BUCKET);
        const registry = [{ path, bytes: 5, sha256: sha("alpha"), contentType: "application/pdf" }];

        expect(compareRegistryToStorage(registry, listed).contentTypeMismatch).toEqual([{
            path,
            expected: "application/pdf",
            actual: "application/json",
        }]);
    });
});
