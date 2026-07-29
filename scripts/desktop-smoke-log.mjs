const fatalLogPattern = /(^|[^A-Za-z0-9_])(UnhandledPromiseRejectionWarning|UnhandledPromiseRejection|unhandledRejection|uncaughtException|OMR_DESKTOP_SMOKE_FAILED)(?=$|[^A-Za-z0-9_])/m;

export function findDesktopSmokeFatalLog(output) {
  return fatalLogPattern.exec(output)?.[2] || null;
}
