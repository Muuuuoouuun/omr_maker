# 모바일 앱 (Android / iOS)

OMR Maker의 모바일 배포는 **두 갈래**다.

| 방식 | 산출물 | 앱스토어 | 서버 | 현재 상태 |
|---|---|---|---|---|
| **PWA** | 홈 화면 설치(standalone) | 불필요 | 서버 필요(온라인) | ✅ 구성됨 |
| **Capacitor(네이티브)** | `.apk`(Android) / `.ipa`(iOS) | 등록 가능 | 서버 필요(server.url) | ✅ Android 스캐폴드 완료 (빌드는 SDK 필요) |

데스크톱의 Electron(`.exe`)에 대응하는 게 모바일의 이 두 방식이다.

---

## 1. PWA (권장 · 가장 간단)

이미 구성돼 있다(`src/app/manifest.ts`, `public/sw.js`, `PWARegister`, `MobileInstallPrompt`).

- **설치**: 폰 브라우저에서 앱 URL 접속 → Android Chrome "앱 설치" / iOS Safari "홈 화면에 추가"
- **요건**: **HTTPS**(또는 `localhost`). LAN http 주소로는 설치/서비스워커가 막힌다.
- **검증**: 앱 내 `/pwa-check` 페이지가 실기기 설치·standalone 실행을 리포트로 확인시켜 준다.

앱스토어 심사 없이 링크만으로 배포·업데이트되므로 학교 환경에 실무적으로 가장 적합하다.

---

## 2. Capacitor 네이티브 (Android `.apk`)

이 앱은 **Next.js 서버 액션·동적 라우트** 기반이라 정적 export가 불가능하다. 그래서 네이티브 셸(WebView)이 **실행 중인 서버 URL을 로드**하도록 구성했다(Electron 개발 셸이 `127.0.0.1:3003`을 로드하는 것과 동일한 모델).

### 구성
- `capacitor.config.ts` — `appId: com.omrmaker.app`, `server.url`(= `CAP_SERVER_URL` 환경변수, 기본은 LAN 개발 주소), http일 때만 `cleartext`.
- `android/` — 생성된 네이티브 Gradle 프로젝트(커밋됨). 빌드 산출물(`build/`, `*.apk`, 복사된 web 자산)은 `android/.gitignore`로 제외.
- `mobile/www/index.html` — 서버 연결 전/실패 시 보이는 브랜드 스플래시(webDir 폴백).

### `.apk` 빌드 방법

> **선행 요건(이 PC에 아직 없음)**: Android SDK. JDK 17은 이미 설치돼 있다.

1. **Android SDK 설치** (택1)
   - Android Studio 설치(권장) → SDK Manager에서 *Android SDK Platform 36* + *Build-Tools* + *Platform-Tools* 설치, 또는
   - command line tools만: `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`
2. **환경변수** 설정
   ```
   setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
   ```
   (새 셸에서 적용)
3. **서버 URL 지정** — 폰이 접근할 주소
   - LAN 테스트: PC에서 `npm start`(:3003) 실행, 폰과 같은 Wi-Fi. 기본값이 LAN http라 `cleartext` 허용됨.
   - 배포: `set CAP_SERVER_URL=https://<배포주소>` 후 빌드(https면 cleartext 자동 해제).
4. **빌드**
   ```
   npm run mobile:apk
   ```
   → `android/app/build/outputs/apk/debug/app-debug.apk` 생성. 폰에 설치(`adb install` 또는 파일 전송).
   - Android Studio로 열려면: `npm run mobile:open`
   - 웹/설정 변경 반영: `npm run mobile:sync`

### 주의
- `server.url` 방식은 앱이 **온라인 서버에 연결**되어야 동작한다(완전 오프라인 번들 아님). 오프라인 네이티브가 필요하면 서버 액션 제거 + 정적 export라는 별도 대규모 작업이 필요하다.
- 릴리스 `.apk`(`mobile:apk:release`)는 서명 키스토어 설정이 추가로 필요하다.

---

## 3. iOS (`.ipa`)

**윈도우에서는 빌드 불가** — Apple 툴체인(**macOS + Xcode**)이 필수다. 맥이 있으면:
```
npm i -D @capacitor/ios
npx cap add ios
npx cap open ios     # Xcode에서 서명·빌드
```
`capacitor.config.ts`의 `server.url` 구성은 iOS에도 그대로 적용된다. 맥이 없다면 iOS는 **PWA(홈 화면 추가)** 로 대체하는 것이 현실적이다.
