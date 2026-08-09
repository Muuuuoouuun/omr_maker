# 초기 운영 qualification runbook

이 절차는 최대 100명 운영 후보를 **격리 staging**에서 검증합니다. 결제 provider 연결은 범위 밖입니다.
성공은 protected GitHub environment `initial-operations-staging`의 승인, exact SHA checkout, 모든 hard gate의
exit 0, pre-promotion release score `go`, 그리고 `QUALIFICATION_COMPLETE` 게시가 함께 확인된 경우뿐입니다.
secret·외부 환경·복원 대상이 없으면 `unverified` 실패이며 skip이나 수동 추정으로 대체하지 않습니다.
이 결과의 `qualificationPhase`는 정확히 `pre_promotion`이며 production release 완료 증거가 아닙니다.

## 1. 실행 전 경계

1. workflow가 있는 기본 브랜치의 lowercase 40자리 SHA를 immutable staging preview에 배포합니다.
   workflow dispatch의 `build_sha`와 workflow revision은 같아야 하며 checkout 후 `HEAD`도 정확히 같아야 합니다.
2. `OMR_STAGING_BASE_URL`/`OMR_STAGING_SUPABASE_URL`은 production app/project와 달라야 합니다.
   protected confirmation host/project ref가 실제 URL에서 얻은 값과 정확히 같아야 합니다.
3. staging 쓰기와 asset-GC scheduler를 중지하고 exact staging project ref로 두 pause confirmation을 설정합니다.
   production을 정지했다는 의미가 아니며 workflow는 production workload path를 호출하지 않습니다.
4. 별도의 disposable restore Supabase project와 staging app을 준비합니다. restore target은 production과
   workload staging 양쪽과 달라야 합니다. 해당 target에는 같은 실행에서 생성한 backup을 복원한 뒤
   Task 4 verifier가 접근할 수 있어야 합니다. 외부 복원 준비가 없거나 아직 완료되지 않았으면 실행은
   `unverified`로 끝내며 기존 target을 통과로 재사용하지 않습니다.
5. alert endpoint 네 개는 실제 외부 sink/receipt/ack/resolve 경로여야 합니다. localhost, private IP,
   mock response는 통과하지 않습니다.

## 2. Protected environment 계약

GitHub repository environment 이름은 정확히 `initial-operations-staging`이고 required reviewer와 staging
branch deployment rule을 설정합니다. workflow 권한은 `contents: read`뿐이며 environment secret은 다른
job에 전달하지 않습니다.

필수 target/identity 값:

- `OMR_STAGING_BASE_URL`, `OMR_PRODUCTION_BASE_URL`
- `OMR_STAGING_SUPABASE_URL`, `OMR_PRODUCTION_SUPABASE_URL`
- `OMR_STAGING_HOST_CONFIRMATION`, `OMR_STAGING_PROJECT_CONFIRMATION`
- `OMR_STAGING_WRITES_PAUSED_PROJECT_REF`, `OMR_STAGING_ASSET_GC_PAUSED_PROJECT_REF`
- `OMR_STAGING_ENVIRONMENT_REVISION`(protected variable), `OMR_STAGING_INFRA_DIGEST`(lowercase SHA-256 variable)
- preview deployment ID, `sha256:<64 hex>` artifact digest, HMAC attestation signature와
  `OMR_RELEASE_ATTESTATION_SECRET`
- `OMR_STAGING_SUPABASE_ANON_KEY`, authenticated JWT, service-role key, readiness/load/asset-GC token,
  provisioned teacher canary account ID

초기 부하에는 `OMR_INITIAL_OPS_TOKEN`, `OMR_INITIAL_OPS_RUN_CHALLENGE`, `OMR_READINESS_TOKEN`을 사용합니다.
기존 production 값과 같거나 약한 credential은 harness가 거부합니다. workload fixture confirmation은
정확히 `initial-ops-100`입니다.

실제 immutable preview browser proof에는 별도의 disposable hosted credential fixture가 필요합니다.
`OMR_STUDENT_CREDENTIAL_*` protected secrets는 정확한 fixture ID, 두 학생 ID/이름, spreadsheet-safe expected
name, group/invite URL, provisioned teacher login, cleanup URL/token을 제공해야 합니다. workflow는 staging
origin과 production origin 불일치를 다시 검증하고 mutation/non-production opt-in을 고정하며, `finally`
cleanup이 실패하면 production E2E source를 만들지 않습니다.

backup에는 staging DB host/port/user/name/password와 service-role key가 필요합니다. restore에는
`OMR_RESTORE_TARGET_APP_URL`, target Supabase/DB credential, target project confirmation, 그리고 Task 4의
self-contained smoke runner와 실제 backup 적용 runner가 필요합니다. runner bytes는
`OMR_RESTORE_SMOKE_RUNNER_B64`/`OMR_RESTORE_PREPARE_RUNNER_B64`로 제공하고 각각의 lowercase SHA-256
protected secret과 일치해야 합니다. prepare runner는 바로 앞 단계가 만든 exact manifest SHA와 disposable
project hash에 결속된 bounded strict envelope
`{schemaVersion,status,buildSha,backupManifestSha256,targetProjectRefHash,restoreStartedAt,completedAt}`를
반환해야 합니다. `status`는 `restored`이며 canonical timestamps는 120분 RTO 안이어야 합니다. workflow는
private `0700` 공간에만 materialize하며
실행 뒤 삭제합니다. alert secret 계약은 [release evidence template](operations/release-evidence-template.md)의
다섯 distinct credential 및 bounded HTTPS 규칙을 그대로 따릅니다.

## 3. 실행

GitHub Actions의 **Initial operations qualification**을 수동 실행하고 다음 값을 입력합니다.

- `build_sha`: workflow/default-branch revision 및 immutable preview와 같은 lowercase 40자리 SHA
- `preview_deployment_id`, `preview_artifact_digest`, `preview_attestation_signature`
- `expected_readiness_version`: 현재 exact contract version(기본 `202608080010`)

workflow는 `set -euo pipefail`로 다음을 순서대로 수행합니다.

1. protected 값 존재, staging/production host·project 불일치, disposable restore 불일치를 검증하고
   raw identifier 대신 domain-separated host/project/environment digest를 기록합니다.
2. exact SHA checkout, Node `22.13.0`, PostgreSQL 17 tools, `npm ci`, production/desktop dependency audit,
   secret-shaped tracked value scan, lint, typecheck, 전체 unit test를 실행합니다.
3. 고정 core spec 집합을 Chromium workers 1/retries 0으로 **10회 연속** 실행하며 실행 순서를 교대로
   바꿉니다. 10개 bounded report가 모두 같은 positive test inventory, zero failure/flaky/skip/retry이고
   domain-separated report digest 10개가 있어야 합니다. WebKit core도 workers 1/retries 0으로 실행합니다.
   build budget 및 PostgreSQL 17 live contract도 검증합니다.
4. immutable staging preview의 health build SHA, readiness exact version, Supabase boundary/denial, canary,
   preview attestation을 검증합니다. 이어 같은 preview에서 disposable provision→CSV login→credential
   rotation→old-session denial E2E를 실제 실행하고 cleanup 성공까지 확인합니다. teacher canary는 이
   production E2E proof를 대신하지 않습니다.
5. production과 같은 경로에서 exact **80 students + 10 teacher live pollers + 10 teacher uploaders**,
   80 simultaneous submissions와 10 max-PDF uploads를 실행합니다. 임의 축소는 허용하지 않습니다.
6. 외부 alert roundtrip과 staging backup을 만든 뒤 SHA-pinned prepare runner로 그 exact backup을 disposable
   target에 실제 적용합니다. runner가 반환한 시작 시각을 사용해 count/hash/boundary/browser/credential
   revocation/RPO/RTO restore verification을 수행합니다.
7. fixed 10 dimensions/100 atomic checks/12 hard gates manifest를 생성하고 현재 checkout의 scorer를 실행한 뒤,
   exported exact-path validator로 같은 `0700` parent의 score를 즉시 재검증합니다.

어느 명령도 `continue-on-error`를 사용하지 않습니다. 실패 후 실행되는 것은 private cleanup과
`if: always()` evidence upload뿐이며 upload 성공이 qualification failure를 성공으로 바꾸지 않습니다.

## 4. Evidence, freshness, 성공 marker

artifact bundle 이름은 `initial-operations-qualification-<build_sha>`, retention은 90일입니다.
`actions/upload-artifact`는 immutable commit으로 pin되어 있고 action이 반환한 lowercase SHA-256 digest를
job summary에 build SHA와 environment digest와 함께 기록합니다.

bundle의 공개 가능한 구조는 다음과 같습니다.

```text
qualification-identity.json
.INCOMPLETE | QUALIFICATION_COMPLETE
raw/                         # safe preflight identity only
release/bundle-index.json
release/source-provenance.json
release/sources/source-<fixed-id>.json
release/release-quality-manifest.json
release/evidence-<fixed-dimension>.json
release/release-quality-score.json
```

`raw/`에는 safe preflight identity만 들어갑니다. backup DB/Storage bytes, initial-load run challenge가 든 원본
bundle, prepare/smoke runner, unit/browser JSON, command log, token, cookie, 답안, provider stdout/stderr는
업로드하지 않습니다. 해당 private material은 runner 임시 공간에서만 사용하고 항상 cleanup합니다. 실패 시
지금까지 생성된 allowlisted safe source attestation과 `.INCOMPLETE`만 업로드합니다.

`release/source-provenance.json`은 fixed 100 atomic checks 각각을 exact source attestation ID와 실제 검증된
metric predicate에 연결합니다. `release/bundle-index.json`은 exact 13개 source descriptor와 provenance hash,
fixed evidence descriptor를 포함합니다. 두 파일의 `qualificationPhase`는 `pre_promotion`입니다. identity,
provenance, index는 모두 `qualifiedPreviewHostDigest`, bounded `qualifiedPreviewDeploymentId`, prefix 없는
lowercase 64-hex `qualifiedPreviewArtifactDigest`를 포함합니다. host digest는 정확히
`sha256("omr.initial-operations.qualified-preview-host:v1\n" + lowercaseHost)`이며 값 뒤 newline은 없습니다.

source/unit/browser/hosted artifact의 `freshUntil`은 `generatedAt + 24h`, restore는 정확히 `+30d`입니다.
environment digest는 build, staging host/project, protected environment revision, infrastructure digest,
preview artifact digest에 결속되므로 앱·DB·환경·infra 변경 즉시 hosted evidence가 무효입니다.

`QUALIFICATION_COMPLETE`는 mode `0600`이며 score가 `go`이고 exact-path 검증까지 통과한 뒤에만 게시됩니다.
marker가 없거나 `.INCOMPLETE`가 있거나 action conclusion이 failure/cancelled이면 결과는 `unverified`입니다.
업로드된 score는 원래 runner parent inode/path에 결속되어 있으므로 다른 job의 승인 증거가 아닙니다.
promotion job은 GitHub artifact digest와 bundle index를 검증하고 private `0700` 경로에서 artifact descriptor
path를 재결속해 scorer를 다시 실행한 뒤 그 exact path에서 즉시 소비해야 합니다.

pre-promotion에서는 `hosted_deployment_promotion_lineage`와 `recovery_release_rollback_evidence` 두 weighted
check만 명시적으로 `unverified`(0점)입니다. 둘은 이 phase의 hard gate가 아니며 숨기거나 `passed`로 바꾸지
않습니다. 후속 production workflow는 실제 promotion lineage와 rollback proof로 두 evidence를 갱신하고,
새 final manifest/score를 별도 exact path에 생성·소비해야만 production release를 완료할 수 있습니다.

## 5. 실패와 재실행

- missing secret/variable, malformed SHA/timestamp/digest: protected environment를 고친 뒤 새 run으로 재실행
- staging=production 또는 restore target collision: 실행 중단, 새 isolated target을 준비
- load/alert/restore cleanup·revocation 실패: incident로 기록하고 disposable credential을 별도 확인·폐기
- backup/restore RPO·RTO/hash 불일치: `.INCOMPLETE`를 보존하고 새 backup과 새 restore target으로 처음부터 재실행
- score `no_go`/`unverified`: marker 없이 원인을 고친 뒤 새 evidence timestamp로 전체 qualification 재실행

실패 artifact를 부분 성공으로 합치거나 freshness를 연장하지 않습니다. production promotion과 rollback은
후속 protected workflow의 별도 승인 범위입니다.
