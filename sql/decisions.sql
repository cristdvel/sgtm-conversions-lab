-- Tabla de decisiones de la etiqueta Data Manager (una fila por compra procesada).
-- Sustituye `PROYECTO.lab` por el proyecto y dataset reales.
CREATE TABLE IF NOT EXISTS `PROYECTO.lab.datamanager_decisions` (
  logged_at      TIMESTAMP NOT NULL,
  destination    STRING    NOT NULL,
  transaction_id STRING,
  sent           BOOL      NOT NULL,
  reason         STRING    NOT NULL,  -- sent | consent_not_granted | missing_transaction_id | no_identifiers | api_error | http_error
  validate_only  BOOL,
  http_status    INT64,
  identifiers    STRING,              -- tipos, no valores: gclid,email,phone,address
  gcs            STRING
)
PARTITION BY DATE(logged_at)
OPTIONS (partition_expiration_days = 90);
