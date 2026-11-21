-- Cuadre: de las compras que ve GA4 (exportación a BigQuery), cuántas llegaron
-- a Google Ads por el servidor, cuántas no y por qué, y con qué identificadores.
-- Sustituye PROYECTO, analytics_XXXX y las fechas.
DECLARE desde DATE DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);

WITH ga4 AS (
  SELECT DISTINCT ecommerce.transaction_id
  FROM `PROYECTO.analytics_XXXX.events_*`
  WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', desde)
    AND event_name = 'purchase'
    AND ecommerce.transaction_id IS NOT NULL
),
servidor AS (
  -- Última decisión por transacción (reintentos o duplicados cuentan una vez).
  SELECT * EXCEPT (rn) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY transaction_id ORDER BY logged_at DESC) AS rn
    FROM `PROYECTO.lab.datamanager_decisions`
    WHERE DATE(logged_at) >= desde AND destination = 'google_ads_data_manager'
  ) WHERE rn = 1
)
SELECT
  COUNT(*)                                                    AS compras_ga4,
  COUNTIF(s.transaction_id IS NULL)                           AS sin_decision_en_servidor,
  COUNTIF(s.sent)                                             AS enviadas,
  COUNTIF(s.reason = 'consent_not_granted')                   AS sin_consentimiento,
  COUNTIF(s.reason = 'no_identifiers')                        AS sin_identificadores,
  COUNTIF(s.reason IN ('api_error', 'http_error'))            AS errores,
  COUNTIF(s.sent AND STRPOS(s.identifiers, 'email') > 0)      AS enviadas_con_email,
  COUNTIF(s.sent AND STRPOS(s.identifiers, 'gclid') > 0)      AS enviadas_con_gclid,
  SAFE_DIVIDE(COUNTIF(s.sent), COUNT(*))                      AS cobertura
FROM ga4 g
LEFT JOIN servidor s USING (transaction_id);
