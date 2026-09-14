# DB·Private Storage 백업/복원 훈련 Runbook

이 절차는 운영 백업을 별도 Supabase staging 프로젝트에 복원한 뒤 DB canonical 47개 테이블의 정확한 행 수와 모든 private Storage object 본문의 크기·SHA-256을 비교합니다. canonical manifest는 `schema.sql baseline + sorted migrations = final schema` 규칙으로 계산합니다. 프로덕션 프로젝트로의 restore verify는 코드에서 거부됩니다.

## 목표와 책임

- 기본 RPO: 60분. 복원 시작 시각 기준 백업 생성 시각이 60분 이내여야 합니다.
- 기본 RTO: 120분. 복원 시작부터 검증 증거 생성까지 120분 이내여야 합니다. evidence의
  `verifiedAt`/`recoveryMinutes`는 qualification 뒤 원래 `.INCOMPLETE`를 원자 소비한 publication fence
  시각을 기록합니다. complete marker의 evidence SHA는 이 exact timestamp를 포함한 bytes에 결속되고,
  rename·fsync·publication 검증 뒤 현재 시각이 같은 RTO 안인지 다시 확인합니다.
- 운영 책임자: 쓰기·asset GC 중지와 백업 생성.
- 복구 책임자: 격리 staging 생성, 복원, 검증.
- 보안 책임자: 암호화 저장소, key 접근, 증거와 임시 credential 폐기 확인.

조직 요구치가 더 엄격하면 CLI의 `--rpo-minutes`, `--rto-minutes`를 낮춥니다. 높이려면 사전 위험 승인이 필요합니다.

## 1. 백업 생성

1. production 쓰기를 중지하고 Vercel asset-GC cron/scheduler trigger를 명시적으로 pause합니다.
   백업·cutover·qualification 동안에는 protected workflow가 실행하는 verifier one-shot 외의
   `/api/internal/asset-gc` claim을 허용하지 않습니다.
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
3. exact build checkout의 `scripts/apply-backup-to-restore-target.mjs`로 PostgreSQL 17
   `psql`에 roles→schema→data를 한 번에 하나씩 streaming하고 private bucket object를 bounded concurrency로
   원래 manifest path에 업로드합니다. SQL 전체를 Buffer/string으로 만들지 않습니다.
4. 백업 manifest의 `gitCommit`과 정확히 같은 checkout에서 `production-server-boundary.sql`을 적용하고 앱 tier를 `staging`으로 배포합니다.
5. 복원 시작 시각을 canonical UTC ISO 값으로 기록합니다. 예: `2026-08-07T00:30:00.000Z`.
6. 새 0700 검증 디렉터리를 만들고 기존 `.INCOMPLETE`, `.RESTORE_COMPLETE`, evidence JSON이 없는지 확인합니다.

## 3. Fail-closed 검증

다음 값은 operator machine에만 둡니다.

- `OMR_DEPLOYMENT_TIER=staging`
- `OMR_RESTORE_TARGET_APP_URL` — 복원 앱의 exact HTTPS origin
- `OMR_RESTORE_TARGET_SUPABASE_URL`, `OMR_RESTORE_TARGET_SERVICE_ROLE_KEY`
- `OMR_PRODUCTION_SUPABASE_URL`, `OMR_PRODUCTION_APP_URL` — target과 같으면 즉시 실패
- `OMR_RESTORE_TARGET_DB_HOST/PORT/USER/NAME/PASSWORD`
- `OMR_POSTGRES_BIN` — PostgreSQL 17 binary directory
- `OMR_RESTORE_EXPECTED_BUILD` — backup manifest의 lowercase 40자 `gitCommit`과 정확히 같아야 함
- `OMR_RESTORE_EXPECTED_BOUNDARY_SHA256` — exact build의 `production-server-boundary.sql` SHA-256

apply와 verifier checkout은 모두 `OMR_RESTORE_EXPECTED_BUILD`이어야 합니다. 두 명령은 apply core/CLI,
repository smoke runner, smoke orchestrator, verifier, backup/storage/strict-JSON core와 production boundary의
repo-owned exact 파일 목록을 `git show <build>:<path>`와 byte-for-byte 비교하고 같은 aggregate source SHA에
결속합니다. apply가 만든 동일 0700 output directory의 0600 `.INCOMPLETE` marker만 verifier가 소비하며,
verifier가 별도 marker나 외부 runner bytes를 만들지 않습니다.

repository smoke runner는 source 검증 뒤 path를 다시 열지 않고 이미 import한 operation을 in-process로
실행합니다. 각 Supabase request와 전체 operation은 abort/join timeout으로 제한되고 browser는 abort 시
닫힙니다. operation은 `create-teacher`, 두 번의 `create-student`, `browser-journey`,
`revoke-teacher`, 두 번의 `revoke-student` 순서입니다. create/revoke는 요청 actor와 같은 ID를 담은
exact `{"status":"created","actorId":"<requested actor>"}` /
`{"status":"revoked","actorId":"<requested actor>"}`를 반환합니다. `browser-journey`는 target 앱의
`/api/healthz` own-data 응답과 build가 expected build와 정확히 같은지 먼저 확인합니다. 이어 fresh 학생
context에서 생성된 invite URL을 열고 그 same context의 invite handoff로 로그인해 disposable 데이터의
create→publish→invite→solve→submit→feedback을 실제 브라우저에서 완료한 뒤 다음 exact 결과를 반환합니다.

```json
{
  "status": "passed",
  "buildSha": "<OMR_RESTORE_EXPECTED_BUILD>",
  "environmentDigest": "<runner env OMR_RESTORE_ENVIRONMENT_DIGEST>",
  "targetDigest": "<runner env OMR_RESTORE_TARGET_DIGEST>",
  "startedAt": "<canonical UTC ISO>",
  "completedAt": "<canonical UTC ISO>",
  "actorIds": ["<teacher>", "<student 1>", "<student 2>"],
  "steps": {
    "create": "passed",
    "publish": "passed",
    "invite": "passed",
    "solve": "passed",
    "submit": "passed",
    "feedback": "passed"
  }
}
```

runner는 실제 메일·메신저·webhook을 호출하지 않고 provider mode를 disabled로 고정합니다. 외부 환경이
없으면 성공으로 skip하지 말고 `unverified`로 종료합니다. disposable 학생은 같은 교사 run ID의
`omr_save_roster_v3` CAS와 credential batch RPC로 만들고, 폐기는 같은 idempotency request 재시도가 가능한
credential replacement로 수행합니다. replacement 뒤에는 이전 account/generation session 검증이 반드시
거부되고 credential row가 새 account/generation/hash로 교체됐는지 확인합니다.

먼저 새 0700 verification directory에 backup을 실제 적용합니다.

```sh
node scripts/apply-backup-to-restore-target.mjs \
  --apply \
  --backup="$ABSOLUTE_BACKUP_DIRECTORY" \
  --output-dir="$ABSOLUTE_NEW_VERIFICATION_DIRECTORY" \
  --confirm-target-project-ref="$RESTORE_STAGING_PROJECT_REF" \
  --confirm-boundary-sha256="$OMR_RESTORE_EXPECTED_BOUNDARY_SHA256" \
  --started-at="$RESTORE_STARTED_AT_UTC"
```

성공 status는 한 줄의 allowlisted JSON이며 `.INCOMPLETE`가 남아 있어야 합니다. artifact는 symlink/hardlink,
pre/post inode·size·SHA 변경을 거부합니다. timeout, hash mismatch 또는 upload 실패 뒤 target은 부분 적용될
수 있으므로 같은 target에 이어서 실행하지 말고 새 disposable target과 새 output directory로 다시 시작합니다.

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

성공은 exit 0, `status=verified`, 0600 `.RESTORE_COMPLETE`가 모두 있을 때뿐입니다. verifier는
apply가 남긴 exact `.INCOMPLETE`를 검증하고 exact table count/object body hash, RPO/RTO, boundary, browser
smoke, 교사 1명과 학생 2명의 credential 폐기를 모두 확인한 뒤에만 atomic rename으로
`.RESTORE_COMPLETE`를 게시합니다. Storage 목록과 object body는 request timeout/Abort, bounded concurrency,
manifest의 per-object/aggregate byte cap 안에서 streaming SHA-256으로 검증합니다. publish 직전에는 원래
`.INCOMPLETE` inode/content를 fence 경로로 원자 이동해 다시 검증하고 현재 RTO도 재확인합니다. 어느
단계든 실패하거나 complete rename·fsync·검증 뒤 RTO를 넘으면 evidence JSON과 `.RESTORE_COMPLETE`를
제거하고 원래 fence를 `.INCOMPLETE`로 복원합니다. 정상 완료 전에는 evidence JSON과 `.RESTORE_COMPLETE`를
게시하지 않고 `.INCOMPLETE`를 보존합니다. credential 누락, source=target, production=target,
non-staging tier, wrong build/environment/target digest, 손상 manifest/artifact, RPO/RTO 초과, 테이블
누락·행 수 차이, object 누락·추가, 본문 크기·SHA·MIME 차이, boundary/smoke/폐기 실패는 모두
exit 1과 stable `unverified`입니다.

evidence에는 raw app/Supabase/project identifier 대신 domain-separated digest만 기록합니다. 또한
safe status/count/UTC timestamp, build SHA, boundary result SHA, browser result SHA, disposable actor
digest만 허용합니다. start code, password, cookie, token, 이름, 답안, feedback 본문, provider 원문,
runner stdout/stderr는 evidence나 public 오류에 기록하지 않습니다.

## 4. 복원 smoke와 폐기

브라우저 단계가 성공하거나 실패해도 verifier는 `finally`에서 disposable 교사 credential 1개와 학생
credential 2개를 모두 폐기합니다. 한 개라도 폐기 확인이 실패하면 smoke 전체가 실패합니다. 실제
학생에게 메시지를 보내지 않습니다. `.RESTORE_COMPLETE`가 참조하는 evidence JSON SHA-256과 safe
운영 로그 위치를 릴리스 증거에 기록한 뒤 staging project와 평문 임시 파일을 보존 정책에 따라
폐기합니다.

훈련 실패 시 production을 수정하지 않습니다. 원인을 분리하고 새 staging과 새 evidence path로 처음부터 다시 실행합니다.
