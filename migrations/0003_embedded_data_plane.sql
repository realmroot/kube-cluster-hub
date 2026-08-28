UPDATE clusters
SET api_server_url = CASE
      WHEN connector_url <> '' THEN connector_url
      ELSE api_server_url
    END,
    enabled = 0,
    resource_version = resource_version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE access_mode = 'connector';

DROP TABLE IF EXISTS connector_statuses;

ALTER TABLE clusters DROP COLUMN access_mode;
ALTER TABLE clusters DROP COLUMN connector_id;
ALTER TABLE clusters DROP COLUMN connector_url;
ALTER TABLE clusters DROP COLUMN inventory_status;
ALTER TABLE clusters DROP COLUMN inventory_error;
