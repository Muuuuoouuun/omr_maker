"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect } from "react";

const NATIVE_PLATFORM_ATTRIBUTE = "data-native-platform";

export default function NativePlatformSync() {
    useEffect(() => {
        const platform = Capacitor.getPlatform();
        if (platform === "web") return;

        const root = document.documentElement;
        root.setAttribute(NATIVE_PLATFORM_ATTRIBUTE, platform);

        return () => {
            if (root.getAttribute(NATIVE_PLATFORM_ATTRIBUTE) === platform) {
                root.removeAttribute(NATIVE_PLATFORM_ATTRIBUTE);
            }
        };
    }, []);

    return null;
}
