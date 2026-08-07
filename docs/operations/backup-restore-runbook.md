# DB·Private Storage 백업/복원 훈련 Runbook

이 절차는 운영 백업을 별도 Supabase staging 프로젝트에 복원한 뒤 DB 37개 canonical 테이블의 정확한 행 수와 모든 private Storage object 본문의 크기·SHA-256을 비교합니다. 프로덕션 프로젝트로의 restore verify는 코드에서 거부됩니다.

## 목표와 책임

- 기본 RPO: 60분. 복원 시작 시각 기준 백업 생성 시각이 60분 이내여야 합니다.
- 기본 RTO: 120분. 복원 시작부터 검증 증거 생성까지 120분 이내여야 합니다.
- 운영 책임자: 쓰기·asset GC 중지와 백업 생성.
- 복구 책임자: 격리 staging 생성, 복원, 검증.
- 보안 책임자: 암호화 저장소, key 접근, 증거와 임시 credential 폐기 확인.

조직 요구치가 더 엄격하면 CLI의 `--rpo-minutes`, `--rto-minutes`를 낮춥니다. 높이려면 사전 위험 승인이 필요합니다.

## 1. 백업 생성

1. production 쓰기와 `/api/internal/asset-gc` 스케줄을 중지합니다.
2. leased cleanup row가 0인지 확인합니다.
3. 새 0700 디렉터리로 백업합니다. 이 디렉터리는 전체 학생 DB·PDF·필기를 포함하므로 OS 권한만 믿지 말고 KMS가 적용된 암호화 볼륨에 두며 전송 전 별도 암호화합니다.

```sh
npm run ops:backup:create -- \
  --confirm-source-project-ref="$PRODUCTION_PROJECT_REF" \
  --confirm-writes-paused="$PRODUCTION_PROJECT_REF" \
  --confirm-asset-gc-paused="$PRODUCTION_PROJECT_REF" \
  --output="$ABSOLUTE_NEW_BACKUP_DIRECTORY"
```

`.COMPLETE`, `manifest.json`, `database/{roles,schema,data}.sql`, `storage/`가 모두 있어야 합니다. `.INCOMPLETE`가 남은 백업은 폐기합니다. 생성 후 쓰기와 GC 재개 시각을 기록합니다.

## 2. 격리 staging 복원

1. production과 다른 새 Supabase project ref를 사용합니다. 기존 공용 staging도 덮어쓰지 않습니다.
2. 외부 이메일·카카오·결제·운영 webhook을 비활성 test sink로 바꿉니다.
3. PostgreSQL 17 `psql`로 roles/schema/data를 순서대로 복원하고 private bucket object를 원래 path로 업로드합니다.
4. 같은 커밋의 `production-server-boundary.sql`을 적용하고 앱 tier를 `staging`으로 배포합니다.
5. 복원 시작 시각을 canonical UTC ISO 값으로 기록합니다. 예: `2026-08-07T00:30:00.000Z`.

## 3. Fail-closed 검증

다음 값은 operator machine에만 둡니다.

- `OMR_DEPLOYMENT_TIER=staging`
- `OMR_RESTORE_TARGET_SUPABASE_URL`, `OMR_RESTORE_TARGET_SERVICE_ROLE_KEY`
- `OMR_PRODUCTION_SUPABASE_URL` — target과 같으면 즉시 실패
- `OMR_RESTORE_TARGET_DB_HOST/PORT/USER/NAME/PASSWORD`
- `OMR_POSTGRES_BIN` — PostgreSQL 17 binary directory

```sh
npm run ops:restore:verify -- \
  --verify \
  --backup="$ABSOLUTE_BACKUP_DIRECTORY" \
  --confirm-target-project-ref="$RESTORE_STAGING_PROJECT_REF" \
  --started-at="$RESTORE_STARTED_AT_UTC" \
  --rpo-minutes=60 \
  --rto-minutes=120 \
  --output="$ABSOLUTE_NEW_EVIDENCE_JSON"
```

성공은 exit 0과 `status=verified`가 함께 있을 때뿐입니다. credential 누락, source=target, production=target, non-staging tier, 손상 manifest/artifact, RPO/RTO 초과, 테이블 누락·행 수 차이, object 누락·추가, 본문 크기·SHA·MIME 차이는 exit 1 또는 예외로 끝나며 증거를 만들지 않습니다.

## 4. 복원 smoke와 폐기

검증 뒤 staging에서 강사 로그인, 시험 상세, 학생 제출, 피드백 조회를 읽기 중심으로 확인합니다. 실제 학생에게 메시지를 보내지 않습니다. evidence JSON의 SHA-256과 실행 로그 위치를 릴리스 증거에 기록한 뒤 staging credential을 회수하고 프로젝트와 평문 임시 파일을 보존 정책에 따라 폐기합니다.

훈련 실패 시 production을 수정하지 않습니다. 원인을 분리하고 새 staging과 새 evidence path로 처음부터 다시 실행합니다.
