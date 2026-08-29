UPDATE audit_events
SET exchange_status = CASE
  WHEN principal_type = 'agent' THEN 'not_attempted'
  ELSE 'not_applicable'
END
WHERE exchange_status = '';
