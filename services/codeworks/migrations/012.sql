-- ABOUTME: Даёт приложению узкую блокировку доверенных подтверждений доставки.
-- ABOUTME: Функция не меняет данные и не расширяет права записи на доказательства.
CREATE FUNCTION codeworks.lock_publication_evidence(p_project text, p_operation uuid, p_evidence uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM codeworks.installed i
    JOIN codeworks.deployments d ON d.operation_id=i.operation_id AND d.project_id=i.project_id AND d.target=i.target
    JOIN codeworks.deployment_evidence e ON e.project_id=i.project_id AND e.target=i.target
      AND e.commit_sha=d.commit_sha AND e.evidence_url=d.receipt->>'evidence_url'
    WHERE i.project_id=p_project AND i.target='dev' AND i.operation_id=p_operation AND e.id=p_evidence
    FOR SHARE OF i,e;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION codeworks.lock_publication_evidence(text,uuid,uuid) FROM PUBLIC;
COMMENT ON FUNCTION codeworks.lock_publication_evidence(text,uuid,uuid) IS 'Удерживает две доверенные строки до завершения транзакции без передачи приложению права их изменения.';
