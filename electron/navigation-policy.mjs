const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function isSafeExternalUrl(value) {
  try {
    return SAFE_EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
