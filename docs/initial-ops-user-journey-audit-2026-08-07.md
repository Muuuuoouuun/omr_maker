# 초기 운영 사용자 여정·백엔드 감사

평가일: 2026-08-07  
대상 브랜치: `codex/initial-ops-100`  
가정: 초기 활성 학생 100명 이하, 결제 실연동은 범위 밖

## 결론

저장소의 릴리스 후보는 학생 응시와 강사 시험 운영의 핵심 흐름을 폭넓게 구현했고,
로컬 브라우저·PostgreSQL 검증도 강하다. 그러나 처음 보는 실제 사용자가 운영 환경에서
회원가입부터 알림과 여러 물리 기기까지 끝내는 제품으로는 아직 `NO-GO`다.

- 학생 여정: **7.9/10**
- 강사 여정: **7.8/10**
- 백엔드 코드·데이터 무결성: **9.1/10**
- 실제 운영 준비도: **5.8/10**

낮은 점수의 주원인은 핵심 시험 기능의 실패가 아니라 실제 카카오/Web Push/이메일 수신 증거 부재, 운영 Supabase 적용 증거 부재,
물리적 두 기기 검증 부재, 부하·관측성·복구 훈련 부재다. 기존의 8점대 품질 점수표는 저장소 품질 게이트이고,
실사용 운영 준비 점수로 재사용하면 안 된다.

## 2차 개선 결과 (같은 날)

위 점수는 이번 보강 전 기준선이다. 결함 수정 뒤 **초기 100명·앱 내 알림·결제 제외** 범위의 코드 기반 핵심 여정은
학생 **8.6**, 강사 **8.7**, 백엔드 **9.4**로 재평가한다. 다만 실제 운영 준비도는 hosted credential, staging 복구 훈련,
100명 부하 실행 증거가 없어 **6.8**이며, 요청한 평균 8.9/최저 8.4의 운영 완료 판정은 아직 내리지 않는다.

추가로 닫은 공백은 HttpOnly 학생 세션 복원, 불가능한 bare 로그인 제거, 그룹 초대 게스트 루프 제거,
다른 기기의 제출 필기 열람, 제출 후 정답·해설, 배정 명단 기반 미응시 집계, 강사 화면의 원격 오류·재시도,
hosted 배포 검증, staging 복구 검증, 결제 공급자 연결용 서버 계약이다.

## 3차 가혹 재감사 결과 (같은 날)

추가 서브에이전트 재감사에서 P0는 없었고 P1 다섯 건을 찾았다. 이 중 진행 중 필기 takeover,
기존 QR을 무고지 폐기하던 초대 회전, 2,001번째 attempt에서 강사 화면 전체가 실패하던 용량 cliff,
강사 인증 폼의 모드 불일치, 인앱 알림 읽음·삭제의 기기별 불일치를 수정했다. 중앙 이벤트 sink도 동일
이벤트 ID로 일시 오류를 한 번 재시도하도록 보강했다. 코드 기반 점수는 학생 **8.8**, 강사 **8.9**,
백엔드 **9.5**로 재평가한다. 실제 운영 준비도는 hosted/staging/물리 기기 증거가 없어 **6.8**을 유지한다.

남은 핵심 P1은 개별 학생 배포다. 같은 반 A/B 중 A만 지정하는 UI·원자 assignment target gateway가 없으며,
`omr_assignment_targets`의 student target은 아직 실제 앱 쓰기/읽기 흐름에 연결되지 않았다. 또한 2,000건을
넘은 화면은 최근 기록임을 표시하지만, 정확한 전체 aggregate/export RPC와 과거 페이지 추가 로딩은 후속 과제다.

## 4차 사용자 순서 재감사 및 수정 결과 (같은 날)

3차에 남았던 두 핵심 P1을 닫았다. 강사는 활성 명단에서 학생 1~100명을 직접 골라 원시험 또는 재시험을
배정할 수 있고, 학생은 자기 assignment에만 접근한다. 배정 생성·수정·재활성화와 시험의 `targeted` 전환은
한 PostgreSQL 트랜잭션에서 처리한다. 공개/그룹으로 돌아갈 때도 대상 제거·assignment 보관·시험 접근 모드
변경을 한 RPC에서 처리하며, 진행 중 응시·낡은 revision·비활성 학생/반·무료 플랜 재시험은 fail-closed다.

강사 집계는 전체 제출 수·고유 응시자·재시험을 DB에서 정확히 계산한다. CSV는 화면의 최근 2,000건을
재사용하지 않고 aggregate와 최대 5,000개의 PII-free 행을 단일 STABLE RPC/동일 statement snapshot으로
받는다. 시험 상세가 부분 목록이면 `전체 N · 최근 N`이라고 표시하고 부분 자료로 최고점을 확정하지 않는다.

초기 100명·앱 내 알림·결제 제외라는 코드 범위에서는 학생 **9.0**, 강사 **9.1**, 백엔드 **9.6**으로
재평가한다. 핵심 코드 품질 평균은 약 **9.2**, 최저 **9.0**이다. 다만 실제 운영 준비도는 **6.8 / NO-GO**다.
공개 배포의 일반 페이지는 열렸지만 `/api/healthz`와 `/api/readyz`가 모두 404였고, 확인된 배포본은 이
릴리스 후보보다 오래됐다. hosted Supabase·staging 부하/복구·물리 기기·외부 알림 증거는 여전히 없다.

## 5차 초기 운영 qualification 보강 결과 (2026-08-10)

저장소 소유의 릴리스 증거 경계를 추가로 보강했다. 브라우저와 PostgreSQL atomic proof는 실제 report/SQL
assertion marker에서만 파생되며 generic all-green 결과를 여러 항목으로 재사용하지 않는다. full journey는
authoritative Next Action fixture를 통해 생성→배포→제출→재시험→통계를 연결한다. canonical evidence migration은
배포 lock 대기 상한, deterministic lock order, contention rollback, 즉시 reapply를 PostgreSQL 17에서 검증한다.

복원 절차는 외부 B64 runner를 제거하고 repository-owned roles→schema→data streaming apply, bounded private
Storage upload, exact health/build, fresh invite context, submit/feedback, disposable credential revocation을 사용한다.
verifier는 manifest와 동일한 Storage metadata를 복원 전후 두 PostgreSQL snapshot과 streaming body SHA로
검사하고, 원래 apply marker·RTO·evidence SHA를 원자 publication에 결속한다.

이 보강은 강한 로컬 릴리스 후보의 코드·증거 품질을 높였지만 외부 증거를 생성하지는 않는다. 현재 exact-SHA
immutable staging deployment, hosted **80+10+10** 부하, external alert roundtrip, disposable restore rehearsal,
Vercel promotion lineage, 실제 Android/iOS, operator approvals는 모두 **`UNVERIFIED`**다. 따라서 공식 판정은
계속 **`NO-GO`**이며, 로컬 결과를 평균 9.3/최저 8.7의 운영 점수로 substitute하지 않는다.

## 증거 등급

| 등급 | 의미 |
|---|---|
| 브라우저 로컬 | 실제 UI를 Playwright로 조작했지만 기본적으로 localStorage/로컬 제출 시뮬레이션 사용 |
| 백엔드 계약 | 서버 액션, 게이트웨이, CAS, rate limit 등을 단위·계약 테스트로 검증 |
| 로컬 PostgreSQL | PostgreSQL 17에 schema→모든 migration→production boundary→rollback→재적용 |
| 운영 빌드 스모크 | `next build/start`와 production 전용 비변경 보안 테스트 |
| 미검증 | 실제 호스팅 DB, 실제 메시지 채널, 물리 기기 또는 실부하 증거 없음 |

## 학생 여정

| 순서 | 점수 | 판정 | 실제 사용자 기준 평가 |
|---|---:|---|---|
| 1. 회원가입 | 0.0 | 부재 | 학생 self-signup 화면/API가 없다. 교사가 명단과 시작 코드를 발급하는 provisioning 모델이다. |
| 2. 로그인 | 7.5 | 브라우저 로컬 + 백엔드 계약 | 학생번호/이메일, 동명이인, 시작 코드, 서버 세션, identifier별·전역 durable rate limit을 지원한다. 운영 Auth 실연결은 미검증이다. |
| 3. 게스트 입장 | 8.4 | 백엔드 통합 | 공개 시험 ticket의 조직에만 guest session을 결합해 open→checkpoint→submit을 검증했다. 그룹 시험은 URL fragment의 opaque token을 즉시 지우고 서버에서 시험·조직·반·만료·폐기를 재검증한다. |
| 4. 시험 보기 | 8.5 | 브라우저 로컬 | 데스크톱·320/375/390px·태블릿, OMR, PDF, 필기 도구, 접근 제어, 시간·이탈 기록을 검증했다. |
| 5. 제출 | 8.8 | 브라우저 로컬 + 백엔드 계약 | 확인, exactly-once 영수증, 체크포인트 revision/lease CAS와 owner-bound IndexedDB secure outbox가 있다. 탭 간 claim·backoff·수동 재시도·손상/만료 안내를 검증했다. |
| 6. 필기 파일 | 8.7 | UI/계약 + 브라우저 | private Storage, 직접 업로드, 보관·첨삭·정리 outbox가 있다. 진행 중 필기는 정규화된 64KiB 체크포인트를 최소 20초 간격으로 동기화하고 takeover 기기에서 복원한다. 제출 후 업로드 실패 원본도 7일간 보관·재시도한다. |
| 7. 리뷰 | 8.6 | 브라우저 로컬 + 백엔드 계약 | 점수, 문항 결과, 설명, 질문·답변, 반환 필기와 다운그레이드 후 read-only 열람을 지원한다. |
| 8. 재시험 | 8.8 | 브라우저 로컬 + PostgreSQL | 강사가 개별 학생의 실제 원시험 오답을 기준으로 재시험을 배정하며, 학생 완료 표시는 assignment와 source attempt가 모두 일치할 때만 성립한다. 무료 플랜 우회는 UI·서버·DB에서 막는다. |
| 9. 알림 | 4.5 | 앱 내 일부 | 앱을 열면 피드백·답변·상태를 볼 수 있다. OS Web Push, 이메일, 실제 카카오 발송은 없다. |
| 10. 여러 기기 | 8.5 | 백엔드 계약 | heartbeat, lease, takeover, 답안·필기 checkpoint와 탭 간 제출 outbox claim이 있다. 새 기기는 마지막 안전 필기를 복원하고 구기기 lease는 거부된다. 두 물리 기기 E2E 증거는 아직 없다. |

학생에게는 “회원가입”이 아니라 “교사가 발급한 계정으로 참여”라고 명확히 안내해야 한다.
self-signup이 제품 요구라면 현재는 미구현이다.

## 강사 여정

| 순서 | 점수 | 판정 | 실제 사용자 기준 평가 |
|---|---:|---|---|
| 1. 회원가입 | 8.0 | UI + 백엔드 계약 | signup/login/reset/reset-complete가 하나의 모드 인식 form에서 올바른 필드·Enter·CTA를 사용하고, 이메일 확인·일회용 토큰 경계가 있다. 실제 이메일 provider 수신은 미검증이며 MFA는 없다. |
| 2. 로그인 | 7.8 | 브라우저 로컬 + 서버 세션 | 서명 쿠키, PBKDF2 hash, durable rate limit이 있다. 운영 평문 비밀번호와 짧은 secret은 fail-closed다. |
| 3. 시험 생성 | 8.5 | 브라우저 로컬 + 게이트웨이 | 생성→배포→학생 제출→통계까지 연결된다. 최초 배포 URL 전환 때 편집 상태가 사라지던 실제 버그도 수정했다. |
| 4. 학생 분배 | 9.1 | 브라우저 + PostgreSQL | 전체 공개·그룹·개별 학생 선택을 지원한다. 개별 배정의 접근 전환과 대상 저장/해제는 원자적이며, 동시 수정·활성 응시·비활성 명단을 서버가 거절한다. |
| 5. 공유 | 8.9 | 브라우저 로컬 + 백엔드 계약 | 링크·QR·복사, localhost 경고, 시험별 초대 회전·폐기·만료 시각 표시가 있다. 기존 QR을 무효화하는 재발급은 명시 경고와 확인 뒤에만 실행된다. |
| 6. 제출·시험지 확인 | 8.0 | UI + 백엔드 계약 | 답안, 필기, 피드백, 리포트, 분석 허브와 feedback CAS/replay가 있다. 무료 플랜도 bounded text 피드백 저장·반환·읽음 확인이 되고 마크업/PDF만 유료다. |
| 7. 알림 | 8.4 | 앱 내 polling | 최근 제출·질문과 읽음·개별 삭제·전체 읽음·전체 삭제를 조직+교사 범위 서버 상태로 동기화한다. 다른 기기는 포커스 복귀 또는 60초 안에 반영된다. 외부 Push/카카오는 없다. |
| 8. 통계 | 9.2 | 브라우저 + PostgreSQL | 시험/학생/문항 분석, summary/detail 분리, stale response fencing이 있다. 전체 aggregate는 최근 목록 상한과 분리해 정확히 계산하고, 부분 목록을 명시한다. |
| 9. 내보내기 | 8.8 | CSV + PostgreSQL | 통계 CSV, 정오표 CSV, 명단 CSV, JSON 백업을 지원한다. attempt CSV는 aggregate와 행을 단일 snapshot에서 읽고 5,000건을 넘으면 조용히 자르지 않고 거절한다. XLSX는 없다. |
| 10. 프리미엄 | 6.5 | 일부 실사용 | 서버 기준 quota/entitlement, 필기 보관·첨삭·고급 분석이 있다. live checkout은 차단 상태이고 다중 교사·SSO·감사 로그 등은 planned다. |

## 이번 감사에서 확인·수정한 실제 결함

1. 최초 시험 저장 후 `new → edit:id` 전환이 편집 내용과 배포 결과를 초기화하던 문제.
2. 편집기 초기화 중 정답 인식 버튼을 누르면 모달 open 상태가 덮이는 race.
3. 공통 헤더 테마 버튼만 40×40px여서 모바일 최소 터치 목표에 못 미친 문제.
4. 실시간 화면의 3초 polling이 3초보다 느린 응답을 영구 stale 처리하던 starvation과 loading 깜빡임.
5. attempt checkpoint의 `NULL expectedRevision/expectedLeaseEpoch`가 PostgreSQL CAS 비교를 우회하던 문제.
6. 학생 로그인 반·프로필·소속 조회가 DB 상한 없이 커질 수 있던 문제.
7. 두 기기의 전체 로스터 snapshot 저장이 last-write-wins로 앞 변경을 덮던 문제.
8. 운영에서 짧은 서명 secret과 평문 교사 비밀번호가 충분히 강하게 차단되지 않던 문제.
9. 대시보드 rich analytics cache, 선택 시험 detail 요청, 필기 summary count의 stale/누락 문제.
10. 피드백 replay, cleanup lease generation, 세션 정리의 동시성·재시도 경계.
11. 공개 guest가 조직 없는 쿠키 때문에 durable open/checkpoint/submit에서 차단되던 문제.
12. 배포 준비 검사가 계정 전달 webhook의 URL/secret만 확인하고 DNS·timeout·5xx를 놓치던 문제.
13. 배포 모달이 서버 canonical 명단을 읽지 않고 로컬 명단만 사용하던 문제와 로딩 중 mutation race.
14. 무료 플랜의 텍스트 피드백 저장·반환까지 마크업과 함께 잘못 paywall되던 문제.
15. 공식 서버 리뷰가 지원하지 않는 custom/similar 재시험을 노출하던 문제.
16. 취약한 PDF.js 5.x와 worker 수명 누수. 6.2.108 고정, worker 동기화, loading task 정리로 교체했다.
17. 그룹 공유 URL이 새 브라우저에서 안정된 workspace ID를 요구하던 문제. fragment opaque invite와 서버 해시 registry로 교체했다.
18. 서버 제출이 네트워크 단절 뒤 앱 종료에 취약하던 문제. immutable owner-bound IndexedDB outbox와 탭 간 원자 claim을 추가했다.
19. 제출 성공 뒤 필기 업로드 실패 원본에 명시적 복구 UI와 전역 만료 정리가 없던 문제.
20. 초대 rotate/resolve의 DB 잠금 순서 역전과 rollback 시 SECURITY DEFINER 초대 RPC가 브라우저 역할에 열릴 수 있던 문제.
21. 로컬 학생 세션까지 서버 쿠키 검증 대상으로 넓혀 로컬 시험 여정을 로그인 화면으로 되돌리던 회귀.
22. 가장 무거운 강사 명단·학생 리뷰 라우트가 production bundle 성능 예산에서 빠져 있던 문제.
23. 강사 signup/reset 화면의 보이는 모드와 Enter 제출 handler·필드·CTA가 일치하지 않던 문제.
24. 강사 인앱 알림 읽음·삭제가 localStorage에만 있어 기기마다 다시 나타나던 문제.
25. 진행 중 시험을 다른 기기로 takeover하면 답안만 복원되고 필기는 구기기에 남던 문제.
26. 기존 그룹 시험 링크를 다시 생성할 때 인쇄·배포한 QR을 무고지로 즉시 폐기하던 문제.
27. 조직 attempt가 2,001건이 되면 강사 목록·통계가 전체 `service_unavailable`이 되던 문제와 hosted `max_rows` 절단 오판 가능성.
28. 중앙 이벤트 sink의 단일 일시 오류가 유일한 오류 이벤트를 영구 유실시키던 문제.
29. targeted 시험에서 `assignment_id=NULL` 세션·제출과 `identity_type=NULL`이 접근 검사를 우회할 수 있던 문제.
30. 개별 배정이 비활성 학생 또는 비활성 반 등록을 대상으로 삼을 수 있던 문제.
31. 배정 대상 변경과 시험 접근 모드 변경이 두 요청으로 나뉘어 중간 실패 시 노출 범위가 어긋날 수 있던 문제.
32. 여러 기기에서 배정 revision 충돌 후 사용자의 오래된 선택이 최신 상태를 다시 덮을 수 있던 문제.
33. 재시험 완료율이 해당 assignment/source가 아닌 같은 시험의 다른 제출로 완료 처리될 수 있던 문제.
34. 재시험 분모와 통계 CSV 분모가 실제 고유 배정 대상이 아닌 전체 명단으로 계산되던 문제.
35. 전체 통계와 CSV가 최근 2,000건 목록에 묶이고, 다중 페이지 export가 하나의 DB snapshot이 아니던 문제.
36. guest 통계의 고유 사용자 키가 aggregate와 export에서 달라 숫자가 어긋날 수 있던 문제.
37. 정확 집계 RPC를 붙인 뒤 서버가 없는 로컬/오프라인 작업공간의 통계 CSV까지 중단되던 회귀. 운영은 fail-closed로 유지하고 `local_only`에서만 현재 로컬 snapshot을 내보내도록 분리했다.

## 백엔드·최적화 판정

### 검증된 것

- 100명 초기 운영 상한을 중앙 정책으로 관리한다. attempt 목록은 250건씩 안정된 최신순으로 최대 2,001건만 읽고, 초과 시 최근 2,000건과 partial metadata를 반환한다.
- canonical 테이블은 production boundary에서 브라우저 권한을 회수하고 service-role RPC만 허용한다.
- 조직 격리 preflight, 43개 canonical 테이블 FORCE RLS, private Storage 경계를 PostgreSQL에서 검사한다.
- 시험·제출·피드백·세션·로스터에 revision/receipt/lease 기반 CAS와 replay 방어가 있다.
- 로스터 load/save는 동일 advisory lock의 원자 RPC를 사용하고 stale writer를 거절한다.
- 학생 로그인 조회는 활성·조직 범위와 DB 상한을 적용하고 overflow 시 credential work 전에 중단한다.
- 대시보드는 summary/detail 읽기를 분리하고, rich detail은 필요할 때만 읽는다.
- 실시간 selected-exam polling은 요청 완료 후 다음 poll을 예약하고 background refresh 중 기존 데이터를 유지한다.
- Storage cleanup은 bounded claim, lease, backoff, dead-letter, generation fence를 사용한다.
- readiness `202608090001`은 NULL checkpoint CAS, secure submission replay marker, 학생 세션 generation 및 원자적 credential batch 경계,
  제출 세션 안전 시험 삭제, roster snapshot CAS, 학생 질문 원자 저장과 무료 코어 피드백 경계를 요구한다.
- `/api/readyz`는 치명적 배포 설정뿐 아니라 계정 전달 webhook에 HMAC 서명된 무부작용
  `HEAD`를 보내 DNS·timeout·5xx를 fail-closed로 처리한다.
- PDF.js는 보안 수정 버전 `6.2.108`에 정확히 고정했고 dependency audit은 취약점 0건이다.
- 그룹 시험 링크는 원본 token을 DB·URL query·로그에 남기지 않고 service-role RPC만 해시를 해석한다. resolve/rotate는 동일한 exam→invite 잠금 순서를 쓴다.
- 인앱 알림 상태는 조직+교사+canonical event ID로 격리된 RPC-only 테이블에 최대 64행/14일로 저장하고, 브라우저 및 service-role 직접 CRUD를 모두 차단한다.
- 진행 중 필기는 geometry만 정규화한 64KiB 체크포인트를 최소 20초 간격으로 저장해 100명 연속 필기 요청 body를 이론상 약 320KiB/s로 제한한다.
- 운영 이벤트 sink는 `x-omr-event-id`를 유지한 채 일시 오류를 한 번 재시도하며 수집기 측 멱등 처리를 요구한다.
- production build 후 핵심 8개 라우트의 raw/gzip JS 예산을 fail-closed로 검사하며, 초기 운영 검증은 immutable static asset의 실제 `Content-Encoding`도 요구한다.
- migration `032`는 개별 학생 배정의 활성 명단·조직·identity·assignment 결속을 trigger와 RPC에서 재검증한다. assign/clear는 같은 advisory lock과 행 잠금 순서를 사용한다.
- 재시험 원본 조회용 복합 partial index와 assignment target FK 역방향 index를 추가해 초기 100명 범위의 쓰기·조회 비용을 제한한다.
- migration `033`은 조직/시험별 완료 attempt partial index를 사용하고, 기간 필터를 필기 JSON 해석 전에 적용한다.
- 정확한 CSV export는 최대 5,000건을 한 service-role RPC로 반환해 브라우저 왕복과 snapshot drift를 줄이며, 초과 시 명시적으로 실패한다.

### 코드만 있고 운영 증거가 없는 것

- 대상 Supabase 프로젝트에 같은 커밋의 migration과 production boundary가 실제 적용됐다는 증거.
- `/api/readyz` 200, 실제 anon/authenticated 공격 거부, 정책 해시와 CI URL을 묶은 릴리스 기록.
- asset cleanup cron의 실제 실행, dead queue 경보, 실패율·지연 metric과 중앙 error sink.
- DB/Storage backup·restore 실행기와 runbook은 추가됐으나, 실제 staging restore drill 증거.
- 100 mixed users gate는 구현됐으나, 실제 staging의 p95/RSS/5xx/query-time 결과.

### 명백히 없거나 아직 끊긴 것

- 실제 카카오, Web Push, 이메일 발송.
- 운영 결제·checkout. provider-neutral 서버 seam은 준비됐지만 실제 adapter는 의도적으로 연결하지 않았다.
- 실물 Android/iOS 두 기기의 설치·동시 세션·필기·피드백 증거.
- 학생 self-signup. 현재 제품은 교사 provisioning 모델이며 의도적으로 제공하지 않는다.

## 최종 검증 결과

- 전체 Vitest: **322 files, 2,331 tests passed**
- ESLint: **0 errors, 4 existing test-only warnings**
- TypeScript: **passed**
- Next production build: **passed**, 18 static pages generated
- Chromium·WebKit·WebKit iPad 전체 여정: **42/42 passed**
- PostgreSQL 17: schema→migrations→boundary→rollback→reapply 및 동시성 assertions **passed**
- 운영 의존성 `npm audit --omit=dev`: **0 vulnerabilities**
- 핵심 8개 경로 JS 번들 예산: **8/8 passed**
- 정적 자산 압축 헤더 검사는 운영 스크립트에 포함했지만, 실제 CDN 배포 증거는 **미검증**
- PWA 실기기 proof: 입력 보고서가 없어 **미검증**
- staging 100명 검증은 자격증명 누락으로 **`unverified / invalid_staging_config`**이며 통과로 계산하지 않음

응답 시간은 로컬 단일 요청 스모크일 뿐 100명 용량 증거가 아니다.

## 운영 전 필수 게이트

1. 대상 Supabase에 같은 SHA의 033까지의 migration과 production boundary를 적용하고 `/readyz` 200 증거를 남긴다. 현재 공개 배포의 `/api/healthz`, `/api/readyz`는 모두 404다.
2. 실제 HTTPS 주소에서 강사 생성→학생 제출→강사 피드백 반환을 변경형 E2E로 통과시킨다.
3. cleanup cron, dead queue·5xx·지연 경보와 중앙 오류 수집을 연결한다.
4. DB+Storage 복원 훈련을 실행하고 RPO/RTO를 기록한다.
5. Android/iOS 두 물리 기기에서 설치, 동시 takeover, 필기, 제출, 피드백을 확인한다.
6. 회원가입을 만들지 않을 경우 provisioning 모델을 첫 화면과 도움말에 명확히 설명한다.
7. 알림 범위를 앱 내 알림으로 명시하거나 실제 채널 하나를 연결한다.
8. 구현된 100명 혼합 부하 gate를 실제 staging에서 실행해 p95, 오류율, 메모리, DB query time 예산을 통과시킨다.
9. 실제 호스팅 새 브라우저에서 opaque 그룹 초대의 발급·회전·만료·학생 로그인을 확인한다.
10. 실제 기기에서 네트워크 단절→앱 종료→제출·필기 복구를 확인한다.
11. ~~개별 학생 assignment target의 원자 생성·학생 소유 조회·응시 ticket 결속과 선택 UI를 구현한다.~~ **이번 수정에서 완료.**
12. ~~2,000건 초과 전체 통계/CSV용 서버 aggregate·원자 export를 구현하고 부분 목록을 명시한다.~~ **이번 수정에서 완료.**

이 게이트가 없으면 “초기 100명 운영 완료”가 아니라 “강한 로컬 릴리스 후보”라고 표현하는 것이 정확하다.
