import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";

const rootDir = process.cwd();
const startupDir = path.join(rootDir, "public", "startup");
const specsPath = path.join(rootDir, "src", "lib", "pwaStartupImages.json");
const logoPath = path.join(rootDir, "public", "logo.png");

function renderedSize(spec) {
    const isPortrait = spec.orientation === "portrait";

    return {
        height: (isPortrait ? spec.cssHeight : spec.cssWidth) * spec.pixelRatio,
        width: (isPortrait ? spec.cssWidth : spec.cssHeight) * spec.pixelRatio,
    };
}

function startupImagePath(spec, size) {
    return path.join(startupDir, `${spec.device}-${size.width}x${size.height}-${spec.orientation}.png`);
}

async function generateStartupImages() {
    const specs = JSON.parse(await readFile(specsPath, "utf8"));
    const logo = await loadImage(logoPath);

    await mkdir(startupDir, { recursive: true });

    await Promise.all(specs.map(async spec => {
        const size = renderedSize(spec);
        const canvas = createCanvas(size.width, size.height);
        const context = canvas.getContext("2d");
        const logoSize = Math.min(Math.round(Math.min(size.width, size.height) * 0.34), 560);
        const logoX = Math.round((size.width - logoSize) / 2);
        const logoY = Math.round((size.height - logoSize) / 2);

        context.fillStyle = "#f8fafc";
        context.fillRect(0, 0, size.width, size.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(logo, logoX, logoY, logoSize, logoSize);

        await writeFile(startupImagePath(spec, size), canvas.toBuffer("image/png", { compressionLevel: 9 }));
    }));

    console.log(`Generated ${specs.length} iOS startup images in ${startupDir}`);
}

generateStartupImages().catch(error => {
    console.error(error);
    process.exit(1);
});
