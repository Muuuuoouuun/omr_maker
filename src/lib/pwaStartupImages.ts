import startupImageSpecs from "./pwaStartupImages.json";

export type PwaStartupImageOrientation = "portrait" | "landscape";

export interface PwaStartupImageSpec {
    device: string;
    cssHeight: number;
    cssWidth: number;
    orientation: PwaStartupImageOrientation;
    pixelRatio: number;
}

export interface PwaStartupImage extends PwaStartupImageSpec {
    height: number;
    media: string;
    url: string;
    width: number;
}

function renderedSize(spec: PwaStartupImageSpec): { height: number; width: number } {
    const isPortrait = spec.orientation === "portrait";

    return {
        height: (isPortrait ? spec.cssHeight : spec.cssWidth) * spec.pixelRatio,
        width: (isPortrait ? spec.cssWidth : spec.cssHeight) * spec.pixelRatio,
    };
}

function startupImageUrl(spec: PwaStartupImageSpec, size: { height: number; width: number }): string {
    return `/startup/${spec.device}-${size.width}x${size.height}-${spec.orientation}.png`;
}

function startupImageMedia(spec: PwaStartupImageSpec): string {
    return `(device-width: ${spec.cssWidth}px) and (device-height: ${spec.cssHeight}px) and (-webkit-device-pixel-ratio: ${spec.pixelRatio}) and (orientation: ${spec.orientation})`;
}

export const PWA_STARTUP_IMAGES: PwaStartupImage[] = (startupImageSpecs as PwaStartupImageSpec[]).map(spec => {
    const size = renderedSize(spec);

    return {
        ...spec,
        ...size,
        media: startupImageMedia(spec),
        url: startupImageUrl(spec, size),
    };
});

export const PWA_STARTUP_IMAGE_LINKS = PWA_STARTUP_IMAGES.map(({ media, url }) => ({ media, url }));
