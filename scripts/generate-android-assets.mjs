import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";

const rootDir = process.cwd();
const resourcesDir = path.join(rootDir, "android", "app", "src", "main", "res");
const launcherSourcePath = path.join(rootDir, "public", "icons", "maskable-icon-512.png");
const splashSourcePath = path.join(rootDir, "public", "logo.png");
const backgroundColor = "#f8fafc";

async function pngFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return pngFiles(target);
        return entry.name.endsWith(".png") ? [target] : [];
    }));
    return nested.flat();
}

function launcherCanvas(size, source, round = false) {
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");

    if (round) {
        context.beginPath();
        context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        context.clip();
    }

    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size, size);
    return canvas;
}

function foregroundCanvas(size, source) {
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size, size);
    return canvas;
}

function splashCanvas(width, height, source) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    const logoSize = Math.round(Math.min(width, height) * 0.34);

    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, Math.round((width - logoSize) / 2), Math.round((height - logoSize) / 2), logoSize, logoSize);
    return canvas;
}

async function writeCanvas(target, canvas) {
    await writeFile(target, canvas.toBuffer("image/png", { compressionLevel: 9 }));
}

async function generateAndroidAssets() {
    const [launcherSource, splashSource] = await Promise.all([
        loadImage(launcherSourcePath),
        loadImage(splashSourcePath),
    ]);
    const files = await pngFiles(resourcesDir);

    await Promise.all(files.map(async target => {
        const filename = path.basename(target);
        const current = await loadImage(target);

        if (filename === "ic_launcher.png") {
            await writeCanvas(target, launcherCanvas(current.width, launcherSource));
        } else if (filename === "ic_launcher_round.png") {
            await writeCanvas(target, launcherCanvas(current.width, launcherSource, true));
        } else if (filename === "ic_launcher_foreground.png") {
            await writeCanvas(target, foregroundCanvas(current.width, launcherSource));
        } else if (filename === "splash.png") {
            await writeCanvas(target, splashCanvas(current.width, current.height, splashSource));
        }
    }));

    console.log("Generated OMR Maker Android launcher and splash assets");
}

generateAndroidAssets().catch(error => {
    console.error(error);
    process.exit(1);
});
