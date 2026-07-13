# 모바일 앱 (Android / iOS)

OMR Maker의 모바일 실행 경로는 PWA와 Capacitor Android 개발 셸로 나뉩니다.

| 방식 | 목적 | 서버 | 현재 상태 |
|---|---|---|---|
| PWA | 실제 사용자 설치·배포 | HTTPS 서버(오프라인 앱 셸 지원) | 구성 완료 |
| Capacitor Android | Windows에서 WebView·키보드·안전영역 실기기 검증 | Windows 개발 서버 | 개발 셸 구성 완료 |

## 1. PWA — 현재 운영 배포 경로

`src/app/manifest.ts`, `public/sw.js`, `PWARegister`, `MobileInstallPrompt`에 설치와 오프라인 앱 셸이 구성되어 있습니다.

- Android Chrome: 앱 URL → 앱 설치
- iOS Safari: 공유 → 홈 화면에 추가
- 실기기 검증: 배포 HTTPS URL의 `/pwa-check`
- 업데이트: 서버 배포만으로 반영되며 앱스토어 심사가 필요하지 않음

## 2. Windows → Android 개발 셸

현재 앱은 Next.js 서버 액션, 서명 쿠키, Supabase 서버 접근을 사용하므로 정적 파일만 담은 독립 APK로 변환할 수 없습니다. Capacitor 프로젝트는 운영 앱을 원격 WebView로 포장하기 위한 것이 아니라, Android 실기기에서 기존 웹 앱을 개발·검증하기 위한 셸입니다.

### 준비물

- Node.js 22 이상
- Android Studio 2025.2.1 이상
- Android SDK 및 Platform-Tools(ADB)
- API 24 이상의 에뮬레이터 또는 USB 디버깅을 켠 Android 기기

설치 상태를 확인합니다.

```powershell
npm run android:doctor
```

Android Studio의 SDK Manager에서 Android SDK Platform과 Android SDK Platform-Tools를 설치한 뒤, 자동 감지가 되지 않으면 현재 PowerShell 세션에 경로를 지정합니다.

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path += ";$env:ANDROID_HOME\platform-tools"
```

### USB 실기기 실행

1. Android의 개발자 옵션과 USB 디버깅을 켭니다.
2. Windows PC에 USB로 연결하고 기기의 RSA 디버깅 허용 창을 승인합니다.
3. 연결 상태와 대상 목록을 확인합니다.

```powershell
adb devices
npm run android:list
```

4. 개발 서버와 Android 앱을 함께 실행합니다.

```powershell
npm run android:dev
```

이 명령은 Next 개발 서버를 `127.0.0.1:3003`에 열고, Capacitor의 `--forwardPorts 3003:3003`으로 `adb reverse`를 적용합니다. LAN 전체에 개발 서버를 노출하거나 PC의 사설 IP를 설정 파일에 커밋할 필요가 없습니다.

### Android Studio 사용

```powershell
npm run android:sync
npm run android:open
```

웹 코드를 실시간으로 확인할 때는 Android Studio의 단독 Run보다 `npm run android:dev`를 사용합니다. 아이콘이나 스플래시 원본을 바꿨다면 아래 순서로 다시 생성합니다.

```powershell
npm run android:assets
npm run android:sync
```

## 3. 원격 개발 APK (내부 테스트만)

`server.url`은 Capacitor 공식 문서상 라이브 리로드용이며 운영용이 아닙니다. 네트워크가 분리된 내부 디버깅 등 USB 실행이 불가능한 경우에만 명시적 개발 플래그와 서버 URL을 설정할 수 있습니다.

```powershell
$env:CAP_ALLOW_REMOTE_DEV = "1"
$env:CAP_SERVER_URL = "http://192.168.0.10:3003"
npm run mobile:apk
```

- HTTP를 지정했을 때만 생성 설정에 `cleartext`가 들어갑니다.
- `CAP_ALLOW_REMOTE_DEV=1` 없이 `CAP_SERVER_URL`만 지정하면 설정 로딩이 중단됩니다.
- `CAP_SERVER_URL`, `cleartext`, `allowNavigation`과 개인 LAN IP를 저장소에 커밋하지 않습니다.
- `mobile:apk:release`는 Gradle 산출 확인용일 뿐 Google Play 제출 준비를 의미하지 않습니다. 서명·업데이트·링크 검증 정책이 별도로 필요합니다.

## 4. Android 운영 패키지가 필요한 경우

현재 서버 기능을 유지하면서 Play Store 배포가 필요하면 배포 도메인과 서명 인증서를 확정한 후 Trusted Web Activity(TWA)를 별도 설계해야 합니다. Capacitor `server.url`을 운영 URL로 고정하는 방식은 사용하지 않습니다.

## 5. iOS

Windows에서는 iOS 네이티브 빌드를 만들 수 없습니다. macOS와 Xcode가 준비되기 전까지 iOS는 PWA 홈 화면 설치 경로를 사용합니다.

## 문제 해결

- `adb`를 찾지 못함: SDK Manager에서 Platform-Tools를 설치하고 `ANDROID_HOME`과 `Path`를 확인합니다.
- `unauthorized`: Android 화면에서 RSA 허용을 승인한 뒤 `adb devices`를 다시 실행합니다.
- 연결 거부: `adb reverse --list`에 `tcp:3003 tcp:3003`이 있는지 확인합니다.
- 네이티브 변경이 반영되지 않음: `npm run android:sync` 후 다시 실행합니다.
