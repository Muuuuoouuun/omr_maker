function requireBoundPort(getBoundPort) {
  const port = getBoundPort();
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`Desktop server did not expose a valid bound port: ${port}`);
  }
  return port;
}

export async function selectDesktopServerPort({
  getBoundPort,
  persistPort,
  preferredPort,
  readPersistedPort,
  smokeEnabled,
  tryListen,
}) {
  if (smokeEnabled) {
    await tryListen(0);
    return requireBoundPort(getBoundPort);
  }

  const candidates = [...new Set([readPersistedPort(), preferredPort].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      await tryListen(candidate);
      persistPort(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }

  await tryListen(0);
  const port = requireBoundPort(getBoundPort);
  persistPort(port);
  return port;
}
