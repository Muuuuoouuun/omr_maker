import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, parse, sep } from "node:path";

const DEFAULT_FS = Object.freeze({ lstat, link, open, realpath, unlink });

function unsafe() {
    throw new Error("unsafe private artifact path");
}

function exactAbsolutePath(path) {
    if (
        typeof path !== "string"
        || !isAbsolute(path)
        || normalize(path) !== path
        || path.endsWith(sep)
        || path.includes("\0")
    ) unsafe();
    return path;
}

async function privateParentBoundary(filePath, fs = DEFAULT_FS) {
    exactAbsolutePath(filePath);
    const parentPath = dirname(filePath);
    const uid = process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid < 0) unsafe();
    const root = parse(parentPath).root;
    let parent;
    try {
        const segments = parentPath.slice(root.length).split(sep).filter(Boolean);
        let current = root;
        for (const segment of ["", ...segments]) {
            if (segment) current = current === root ? `${root}${segment}` : `${current}${sep}${segment}`;
            const stats = await fs.lstat(current);
            if (
                !stats.isDirectory()
                || stats.isSymbolicLink()
                || (stats.mode & 0o022) !== 0
                || (stats.uid !== 0 && stats.uid !== uid)
            ) unsafe();
            if (current === parentPath) parent = stats;
        }
        if (await fs.realpath(parentPath) !== parentPath) unsafe();
    } catch {
        unsafe();
    }
    if (!parent || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) unsafe();
    return Object.freeze({ parentPath, realpath: parentPath, dev: parent.dev, ino: parent.ino, uid });
}

async function sameParentBoundary(boundary, fs = DEFAULT_FS) {
    try {
        const stats = await fs.lstat(boundary.parentPath);
        return stats.isDirectory()
            && !stats.isSymbolicLink()
            && stats.dev === boundary.dev
            && stats.ino === boundary.ino
            && stats.uid === boundary.uid
            && (stats.mode & 0o777) === 0o700
            && await fs.realpath(boundary.parentPath) === boundary.realpath;
    } catch {
        return false;
    }
}

function samePrivateFile(stats, opened, uid, maximumBytes, allowEmpty = false) {
    return stats.isFile()
        && !stats.isSymbolicLink()
        && stats.dev === opened.dev
        && stats.ino === opened.ino
        && stats.uid === uid
        && stats.nlink === 1
        && (stats.mode & 0o777) === 0o600
        && stats.size === opened.size
        && stats.size <= maximumBytes
        && (allowEmpty || stats.size >= 2);
}

export async function readPrivateArtifact(inputPath, maximumBytes = 16 * 1024, fs = DEFAULT_FS) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2) unsafe();
    const boundary = await privateParentBoundary(inputPath, fs);
    let before;
    let handle;
    try {
        before = await fs.lstat(inputPath);
        if (
            !before.isFile()
            || before.isSymbolicLink()
            || before.uid !== boundary.uid
            || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600
            || before.size < 2
            || before.size > maximumBytes
        ) unsafe();
        handle = await fs.open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!samePrivateFile(before, opened, boundary.uid, maximumBytes)) unsafe();
        const bytes = await handle.readFile();
        const stats = await handle.stat();
        if (
            stats.dev !== opened.dev
            || stats.ino !== opened.ino
            || !samePrivateFile(stats, opened, boundary.uid, maximumBytes)
            || bytes.byteLength !== stats.size
            || !await sameParentBoundary(boundary, fs)
        ) unsafe();
        return bytes;
    } catch {
        unsafe();
    } finally {
        if (handle) await handle.close();
    }
}

async function outputBoundary(outputPath, fs = DEFAULT_FS) {
    const boundary = await privateParentBoundary(outputPath, fs);
    try {
        await fs.lstat(outputPath);
        unsafe();
    } catch (error) {
        if (error instanceof Error && error.message === "unsafe private artifact path") throw error;
        if (!error || error.code !== "ENOENT") unsafe();
    }
    return boundary;
}

export async function publishPrivateArtifact(outputPath, bytes, fs = DEFAULT_FS) {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > 16 * 1024) unsafe();
    const boundary = await outputBoundary(outputPath, fs);
    const temporaryPath = `${boundary.parentPath}${sep}.${basename(outputPath)}.${randomBytes(16).toString("hex")}.tmp`;
    let handle;
    let directoryHandle;
    let opened;
    let temporaryPresent = false;
    let outputPresent = false;
    let closed = false;
    try {
        handle = await fs.open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
        );
        temporaryPresent = true;
        const created = await fs.lstat(temporaryPath);
        opened = await handle.stat();
        if (!samePrivateFile(created, opened, boundary.uid, 16 * 1024, true) || opened.size !== 0) unsafe();
        await handle.chmod(0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        const stats = await handle.stat();
        if (
            stats.dev !== opened.dev
            || stats.ino !== opened.ino
            || stats.uid !== boundary.uid
            || (stats.mode & 0o777) !== 0o600
            || stats.size !== bytes.byteLength
        ) unsafe();
        await handle.close();
        closed = true;
        if (!await sameParentBoundary(boundary, fs)) unsafe();
        await fs.link(temporaryPath, outputPath);
        outputPresent = true;
        const published = await fs.lstat(outputPath);
        if (
            !published.isFile()
            || published.isSymbolicLink()
            || published.dev !== opened.dev
            || published.ino !== opened.ino
            || published.uid !== boundary.uid
            || (published.mode & 0o777) !== 0o600
            || published.size !== bytes.byteLength
        ) unsafe();
        await fs.unlink(temporaryPath);
        temporaryPresent = false;
        const finalStats = await fs.lstat(outputPath);
        if (finalStats.dev !== opened.dev || finalStats.ino !== opened.ino || finalStats.nlink !== 1) unsafe();
        if (!await sameParentBoundary(boundary, fs)) unsafe();
        directoryHandle = await fs.open(
            boundary.parentPath,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const directoryStats = await directoryHandle.stat();
        if (
            !directoryStats.isDirectory()
            || directoryStats.dev !== boundary.dev
            || directoryStats.ino !== boundary.ino
            || directoryStats.uid !== boundary.uid
        ) unsafe();
        await directoryHandle.sync();
        await directoryHandle.close();
        directoryHandle = undefined;
    } catch {
        if (handle && !closed) {
            try { await handle.close(); } catch {}
        }
        if (directoryHandle) {
            try { await directoryHandle.close(); } catch {}
        }
        if (outputPresent && opened) {
            try {
                const stats = await fs.lstat(outputPath);
                if (stats.dev === opened.dev && stats.ino === opened.ino) await fs.unlink(outputPath);
            } catch {}
        }
        if (temporaryPresent && opened) {
            try {
                const stats = await fs.lstat(temporaryPath);
                if (stats.dev === opened.dev && stats.ino === opened.ino) await fs.unlink(temporaryPath);
            } catch {}
        }
        unsafe();
    }
}
