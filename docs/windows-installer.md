# Windows Installer

This branch adds an Electron wrapper around the existing Next.js app so Windows users can install OMR Maker with an NSIS `.exe` installer.

## Build

```bash
npm install
npm run desktop:dist:win
```

The installer is written to `release/OMR Maker-Setup-0.1.0-x64.exe` only when code signing succeeds. Configure the signing certificate through the builder's secure credential environment (for example `CSC_LINK` and `CSC_KEY_PASSWORD`); never commit certificate files or passwords. A missing certificate now fails the distribution command instead of emitting an unsigned release.

## Local Desktop Smoke Test

```bash
npm run desktop:dev
```

The development command starts the existing Next.js dev server on port `3003`, waits for it, and then opens the Electron shell.

## Notes

- The packaged app starts a local Next.js server inside Electron, so current server actions and browser storage behavior stay intact.
- `release/` is ignored because it contains generated installer artifacts.
- `desktop:dist:win` enforces code signing. `desktop:pack` remains an unpacked local development artifact, not a signed release. Signing success and real Windows installation must be verified before distribution; SmartScreen reputation is not guaranteed by signing alone.
