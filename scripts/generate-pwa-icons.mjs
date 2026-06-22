import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "canvas";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");
const iconsDir = path.join(publicDir, "icons");
const appDir = path.join(rootDir, "src", "app");
const baseSize = 1024;

const transparentIconSizes = [48, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512];
const faviconSizes = [16, 32, 48];

const colors = {
  blue: "#4285f4",
  red: "#ea4335",
  yellow: "#fbbc05",
  green: "#34a853",
  grey: "#9aa0a6",
  sheet: "#ffffff",
  launcherBackground: "#f8fafc",
};

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawBubble(context, x, y, radius, fill) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  if (fill) {
    context.fillStyle = fill;
    context.fill();
    return;
  }

  context.strokeStyle = colors.grey;
  context.lineWidth = 16;
  context.stroke();
}

function drawLogoMark(context, size = baseSize) {
  const scale = size / baseSize;
  context.save();
  context.scale(scale, scale);

  roundedRect(context, 72, 72, 880, 880, 176);
  context.save();
  context.clip();
  context.fillStyle = colors.blue;
  context.fillRect(72, 72, 440, 440);
  context.fillStyle = colors.red;
  context.fillRect(512, 72, 440, 440);
  context.fillStyle = colors.yellow;
  context.fillRect(72, 512, 440, 440);
  context.fillStyle = colors.green;
  context.fillRect(512, 512, 440, 440);
  context.restore();

  roundedRect(context, 192, 178, 664, 700, 72);
  context.fillStyle = colors.sheet;
  context.fill();

  const rows = [330, 456, 582];
  const labelX = 262;
  const bubbleXs = [426, 556, 686];
  const filled = new Map([
    ["0:1", colors.blue],
    ["1:0", colors.red],
    ["2:1", colors.yellow],
  ]);

  rows.forEach((y, row) => {
    context.lineCap = "round";
    context.strokeStyle = "#b7bcc2";
    context.lineWidth = 20;
    context.beginPath();
    context.moveTo(labelX, y);
    context.lineTo(labelX + 72, y);
    context.stroke();

    bubbleXs.forEach((x, column) => {
      drawBubble(context, x, y, 34, filled.get(`${row}:${column}`));
    });
  });

  context.beginPath();
  context.arc(760, 752, 158, 0, Math.PI * 2);
  context.fillStyle = colors.green;
  context.fill();

  context.beginPath();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = colors.sheet;
  context.lineWidth = 60;
  context.moveTo(690, 748);
  context.lineTo(744, 802);
  context.lineTo(842, 696);
  context.stroke();

  context.restore();
}

function createTransparentIcon(size) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  drawLogoMark(context, size);
  return canvas;
}

async function createOpaqueLauncherIcon(size, sourceImage, paddingRatio = 0.09) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  const padding = Math.round(size * paddingRatio);
  const imageSize = size - padding * 2;

  context.fillStyle = colors.launcherBackground;
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(sourceImage, padding, padding, imageSize, imageSize);

  return canvas;
}

function encodeSinglePngIco(pngBuffer, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size === 256 ? 0 : size, 6);
  header.writeUInt8(size === 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuffer.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuffer]);
}

async function writePng(filePath, canvas) {
  await writeFile(filePath, canvas.toBuffer("image/png", { compressionLevel: 9 }));
}

async function generatePwaIcons() {
  await Promise.all([
    mkdir(iconsDir, { recursive: true }),
    mkdir(appDir, { recursive: true }),
  ]);

  const sourceCanvas = createTransparentIcon(baseSize);
  const sourceBuffer = sourceCanvas.toBuffer("image/png", { compressionLevel: 9 });
  const sourceImage = await loadImage(sourceBuffer);

  await Promise.all([
    writeFile(path.join(publicDir, "logo.png"), sourceBuffer),
    writeFile(path.join(appDir, "icon.png"), sourceBuffer),
    ...transparentIconSizes.map(size => writePng(path.join(iconsDir, `icon-${size}.png`), createTransparentIcon(size))),
    ...faviconSizes.map(size => writePng(path.join(iconsDir, `favicon-${size}.png`), createTransparentIcon(size))),
  ]);

  const appleIcon = await createOpaqueLauncherIcon(180, sourceImage, 0.08);
  const maskableIcon = await createOpaqueLauncherIcon(512, sourceImage, 0.14);
  const msTileIcon = await createOpaqueLauncherIcon(150, sourceImage, 0.12);
  const faviconCanvas = createTransparentIcon(16);
  const faviconPng = faviconCanvas.toBuffer("image/png", { compressionLevel: 9 });

  await Promise.all([
    writePng(path.join(publicDir, "apple-touch-icon.png"), appleIcon),
    writePng(path.join(iconsDir, "apple-touch-icon.png"), appleIcon),
    writePng(path.join(iconsDir, "maskable-icon-512.png"), maskableIcon),
    writePng(path.join(iconsDir, "mstile-150.png"), msTileIcon),
    writeFile(path.join(appDir, "favicon.ico"), encodeSinglePngIco(faviconPng, 16)),
  ]);

  console.log("Generated flat PWA icon set from the OMR Maker logo mark");
}

generatePwaIcons().catch(error => {
  console.error(error);
  process.exit(1);
});
