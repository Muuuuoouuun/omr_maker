# Windows Installer

This branch adds an Electron wrapper around the existing Next.js app so Windows users can install OMR Maker with an NSIS `.exe` installer.

## Build

```bash
npm install
npm run desktop:dist:win
```

The installer is written to `release/OMR Maker-Setup-0.1.0-x64.exe`.

## Local Desktop Smoke Test

```bash
npm run desktop:dev
```

The development command starts the existing Next.js dev server on port `3003`, waits for it, and then opens the Electron shell.

## Notes

- The packaged app starts a local Next.js server inside Electron, so current server actions and browser storage behavior stay intact.
- `release/` is ignored because it contains generated installer artifacts.
- The installer is unsigned. Windows SmartScreen may warn until a code-signing certificate is added.
