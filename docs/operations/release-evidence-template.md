# 프로덕션 릴리스 증거

이 문서는 한 번의 프로덕션 승인을 위한 기록입니다. 빈 항목, `unverified`, 수동 추정은 승인 증거가 아닙니다.

## 변경 식별

- 릴리스 일시(UTC):
- 승인자:
- 배포 Git SHA(40자):
- GitHub Actions 실행 URL:
- `production-readiness-<SHA>` artifact SHA-256:
- production host:
- 대상 Supabase project ref SHA-256(원문 ref 금지):
- production boundary SQL SHA-256:

## 자동 검증 결과

- `ops:verify:production` 상태: `verified` / `unverified`
- `/api/healthz` build와 배포 SHA 일치: 예 / 아니오
- `/api/readyz` 상태: `ready` / 그 외
- readiness version: `202608080005` / 그 외
- scheduler pause confirmation hash (target-bound; 원문/secret 제외):
- observability: `ready` / 그 외
- teacher account delivery probe: 통과 / 실패
- anon canonical table 직접 읽기: 거부 / 성공
- authenticated canonical table 직접 읽기: 거부 / 성공
- service-role readiness RPC: 통과 / 실패

## 변경형 여정과 운영 증거

- 강사 생성→배포→학생 제출→강사 피드백 반환 증거 위치:
- asset cleanup 최근 heartbeat와 dead queue 0 증거:
- 100명 staging 부하 evidence bundle 위치:
- 최근 staging 복원 훈련 evidence 위치:
- 실제 Android/iOS 다중 기기 증거 위치:

## 승인 판정

- 최종 판정: GO / NO-GO
- 남은 예외와 만료 시각:
- 롤백 담당자와 기준:

`verified` JSON에는 토큰, URL query, 학생 정보, row ID, Storage object path를 복사하지 않습니다.
