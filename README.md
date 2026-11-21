# sgtm-conversions-lab

Laboratorio de conversiones server-side: el mismo `purchase` sale del navegador
y del servidor (sGTM) hacia Google Ads y Meta, y cada plataforma lo cuenta una
sola vez. Todo con consentimiento previo y datos personales con hash.

```
navegador ──(GA4 + transaction_id / event_id)──▶ sGTM
   │                                              ├─▶ Google Ads · Data Manager API (esta plantilla)
   │                                              ├─▶ Meta · Conversions API (plantilla oficial de Meta)
   └─ etiquetas de navegador (Ads, Pixel)         └─▶ BigQuery · registro para cuadrar navegador vs servidor
```

## Piezas

| Pieza | Estado |
|---|---|
| Plantilla de etiqueta sGTM para la Data Manager API (`src/`, `template.tpl`) | Escrita; 18/18 tests en Node |
| Tienda de prueba con banner, `dataLayer` y `transaction_id` / `event_id` | Pendiente |
| Meta Conversions API con deduplicación por `event_id` | Pendiente |
| Registro en BigQuery y consulta de cuadre (deduplicación, cobertura de identificadores) | Pendiente |

## Plantilla Data Manager API

Envía `POST https://datamanager.googleapis.com/v1/events:ingest` con las
credenciales del servicio de Cloud Run (`getGoogleAuth`, scope
`https://www.googleapis.com/auth/datamanager`). Sin plantillas de terceros.

Decide **no enviar** (y lo registra, sin marcar fallo) cuando:

- no hay consentimiento: el campo `ad_user_data` dice denegado, o está vacío y
  `gcs` trae `ad_storage` denegado, o no se puede saber;
- falta `transaction_id`: sin él Google no puede deduplicar frente a la etiqueta
  del navegador y contaría dos veces;
- no hay ningún identificador (`gclid`/`gbraid`/`wbraid` ni datos de usuario).

Normaliza según la guía de formato de la API: email en minúsculas (y sin puntos
ni sufijo `+` en Gmail), teléfono en E.164 (sin prefijo internacional se
descarta en vez de adivinar el país), nombre y apellidos en minúsculas; SHA-256
en hex. País y código postal van sin hash, y la dirección solo se envía con los
cuatro campos. Arranca con `validateOnly: true`.

```
node test/run.js   # 18 casos
node build.js      # genera template.tpl
```

## Sin verificar todavía

- Importación y escenarios en el editor de plantillas de GTM (permisos incluidos).
- Una llamada real con `validateOnly` contra una cuenta de Google Ads.
- El valor `CONSENT_DENIED` del enum de consentimiento (la documentación leída
  solo muestra `CONSENT_GRANTED`).
- Cómo se da acceso a la cuenta de Google Ads a la cuenta de servicio de Cloud Run.
