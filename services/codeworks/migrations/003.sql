-- ABOUTME: Хранит однократно удостоверенные exact CI attempts независимо от retention Actions.
-- ABOUTME: Только owner verifier пишет evidence; agent/NATS API не принимает эти записи.
CREATE TABLE codeworks.verified_ci (
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  run_id text NOT NULL CHECK(run_id ~ '^[1-9][0-9]*$'),
  attempt text NOT NULL CHECK(attempt ~ '^[1-9][0-9]*$'),
  policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[0-9a-f]{64}$'),
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,run_id,attempt,policy_sha256)
);
COMMENT ON TABLE codeworks.verified_ci IS 'Append-only evidence owner verifier: exact Actions identity и проверенные immutable composition/component digests.';
