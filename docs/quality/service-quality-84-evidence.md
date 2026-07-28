# 서비스 품질 84점 게이트 검증 증빙

평가일: 2026-07-29  
브랜치: `codex/service-quality-84`  
기준 커밋: `a04c067abd9129860fab3b8eab210169d3c98186`

## 자동 검증

| 검증 | 명령 | 결과 |
|---|---|---|
| 깨끗한 의존성 설치 | `npm ci` | 성공, 788 packages 설치 |
| 단위·계약 테스트 | `npm test` | 172 files, 1,324 tests 통과 |
| 린트 | `npm run lint` | 성공 |
| 타입 검사 | `npx tsc --noEmit` | 성공 |
| 운영 의존성 보안 | `npm audit --omit=dev --audit-level=high` | 취약점 0건 |
| 핵심 의존성 | `npm ls next postcss sharp` | Next 16.2.12, PostCSS 8.5.23, Sharp 0.35.3 정상 |
| 운영 빌드 | `npm run build` | 성공, 정적 페이지 16/16 생성 |
| 실제 DB 경계 | `npm run test:supabase:live` | PostgreSQL 17에서 성공 |
| CI 전체 브라우저 | `CI=1 PLAYWRIGHT_ENABLE_WEBKIT=1 npm run test:e2e` | exit 0, 321 통과·4 재시도 통과·29 의도적 제외 |
| 운영 E2E | `npm run test:e2e:prod` | exit 0, 2 통과·30 운영 환경상 제외 |
| 운영 PWA | `npm run test:pwa:prod` | exit 0, installability 오류 0건·offline/service worker·풀이 smoke 통과 |
| 데스크톱 패키징 | `npm run desktop:pack` | exit 0, macOS arm64 앱 생성 |
| 패키지 실행 smoke | `npm run desktop:smoke:packaged` | exit 0, `DESKTOP_PACKAGE_SMOKE_OK` |

실제 DB 검증의 최종 출력:

```text
                 result
-----------------------------------------
 OMR live PostgreSQL verification passed
(1 row)
```

검증기는 Docker를 짧게 탐색한 뒤 사용할 수 없으면 loopback 전용 임시 PostgreSQL 17 클러스터를 만들고, `ON_ERROR_STOP`으로 schema → 순차 migration → production boundary → live assertions를 실행한다. 종료 시 서버와 임시 디렉터리를 제거한다.

## 수동 브라우저 검토

로컬 앱을 실제 브라우저에서 데스크톱과 모바일로 확인했다.

- 랜딩의 교사/학생 역할 선택은 데스크톱 2열과 모바일 1열에서 동일한 강조 수준을 유지한다.
- 교사 로그인, 대시보드, 설정 화면은 주요 CTA·상태·다음 행동의 위계가 명확하다.
- 모바일에서 가로 overflow 없이 본문이 읽히고 주요 터치 대상이 유지된다.
- 검토 후 viewport와 브라우저 탭을 원래 상태로 복구했다.

재현 가능한 캡처:

- [교사 대시보드 데스크톱](screenshots/teacher-dashboard-desktop.png)
- [시험 제작 모바일](screenshots/create-mobile.png)
- [학생 풀이 태블릿](screenshots/solve-tablet.png)
- [결과 검토 모바일](screenshots/review-mobile.png)

캡처 명령:

```bash
QUALITY_SCREENSHOT_BASE_URL=http://localhost:3003 \
  node scripts/capture-quality-screenshots.mjs
```

## CI 브라우저 판정 상세

최종 354개 시나리오는 Chromium, Desktop Safari/WebKit, iPad WebKit, Android/iOS 유사 PWA, 실제 iOS WebKit PWA, 교사 모바일·태블릿 프로젝트를 포함한다.

- 321건은 첫 실행에서 통과했다.
- 4건은 재시도에서 통과했다. 장시간 로컬 dev 서버의 WebKit 초기 탐색 2건과 전역 검색 단축키 이벤트 2건이다.
- 29건은 운영 fixture 또는 특정 프로젝트 전용이라 이유를 명시하고 제외됐다.
- 이전에 실패했던 태블릿 PWA 패널 기하, iPad 가로 제작 터치 목표, 교사 결과 상세 1열/2열 계약은 최종 전체 실행에서 모두 통과했다.

## 구현 증거

- 질문 outbox 소유자 스코프·자동 복구: `src/lib/studentQuestionOutbox.ts`, `src/components/SyncFlusher.tsx`
- 제출·질문 소유권 시뮬레이션: `src/lib/studentSubmissionSimulation.ts`
- 교사 mutation 역할 경계: `src/lib/teacherMutationAuthorization.ts`
- PBKDF2 입력 제한: `src/lib/teacherAuth.ts`
- Electron 외부 탐색 제한: `electron/navigation-policy.mjs`
- CSP: `next.config.ts`
- 본문 바로가기: `src/components/SkipToMainContent.tsx`, `src/components/TeacherHeader.tsx`
- 실제 PostgreSQL 검증기: `scripts/verify-supabase-live.mjs`
- RLS/RPC 실검증: `supabase/live-test-assertions.sql`

## 의도적 제외와 남은 운영 확인

- 배포 fixture가 필요한 한국어 운영 데이터 시나리오는 로컬 CI matrix에서 의도적으로 제외된다.
- 운영 Supabase 프로젝트에 최종 migration을 적용하고 production readiness probe를 다시 실행해야 한다.
- 실제 HTTPS 도메인에서 PWA 설치·standalone 실행을 기기별로 확인해야 한다.
- 원격 CI에서 최종 커밋 SHA를 대상으로 동일 명령이 통과해야 한다.
- 실결제·실카카오 연동, 공유형 rate limiter, 중앙 관측성은 별도 운영 작업이다.
- macOS 배포에는 Developer ID 코드 서명·notarization과 전용 앱 아이콘이 추가로 필요하다.

따라서 이 문서는 저장소 릴리스 후보의 품질 증빙이며 운영 배포 승인서는 아니다.
