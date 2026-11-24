# sgtm-conversions-lab

Laboratorio de conversiones server-side: el mismo `purchase` sale del navegador
y del servidor (sGTM) hacia Google Ads y Meta, y cada plataforma lo cuenta una
sola vez. Todo con consentimiento previo, datos personales con hash y un
contrato del `dataLayer` que se comprueba en CI.

```
tienda (shop/) ──dataLayer validado contra tracking-plan/──▶ GTM web
                                                     │
            transaction_id (Google) · event_id (Meta)│
                                                     ▼
                                                   sGTM
                       ├─▶ Google Ads · Data Manager API (plantilla propia, src/)
                       ├─▶ Meta · Conversions API (plantilla oficial de Meta)
                       └─▶ BigQuery · una fila por decisión → sql/coverage.sql
```

## Piezas

| Pieza | Estado |
|---|---|
| Plantilla sGTM para la Data Manager API (`src/`, `template.tpl`) | 19/19 tests en Node y 9/9 escenarios en el editor de GTM (importada y guardada, sin publicar) |
| Tienda de prueba con banner, Consent Mode v2 y `dataLayer` (`shop/`) | Hecha; recorrida en Chromium por los tests |
| Plan de medición como código (`tracking-plan/`) | Hecho; 12 tests en Playwright |
| Registro de decisiones en BigQuery y consulta de cobertura (`sql/`) | Escrito; sin ejecutar |
| Contrato de la Conversions API de Meta (`meta/`, `docs/meta-capi.md`) | Constructor de referencia con 7 tests; el envío real, pendiente (cuenta de Meta) |
| Compatibilidad con el sandbox de GTM (`tests/sandbox.spec.js`) | 10 comprobaciones sobre el AST y el `template.tpl`, más los escenarios del propio editor |
| Workflow de CI (`.github/workflows`) | Ejecutado en GitHub Actions el 24 nov 2026: verde, `npm test` y comprobación de que `template.tpl` coincide con el código |
| Despliegue: contenedor de servidor propio y tienda en subdominio | Pendiente |

## Plan de medición como código

`tracking-plan/plan.json` define cada evento con JSON Schema: un evento que no
esté en el plan es un error, igual que un campo de más o un tipo incorrecto.
`tracking-plan/validate.mjs` añade las reglas que un esquema no expresa:

- el `consent default` va antes de cualquier evento y antes de que arranque GTM;
- cada evento de ecommerce va precedido de `{ ecommerce: null }`;
- `value` es la suma de `price × quantity`;
- no se repite un `purchase` con el mismo `transaction_id`;
- `event_id` corresponde a `transaction_id` (si no, Meta no deduplica).

Los tests recorren la tienda en Chromium aceptando y rechazando cookies, y
simulan un despliegue con un fallo (renombrar `item_id`) para demostrar que el
contrato lo para antes de llegar a los informes. El workflow de GitHub Actions
los ejecuta en cada pull request.

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

Si se configura una tabla, escribe una fila por decisión en BigQuery con los
**tipos** de identificador usados, nunca sus valores ni sus hashes.
`sql/coverage.sql` cruza esas filas con las compras de la exportación de GA4.

## Uso

```
npm install
npm run shop       # tienda en http://127.0.0.1:4173/
npm test           # 19 casos de la plantilla + 29 pruebas (plan de medición, sandbox, Meta)
npm run build      # genera template.tpl
```

`shop/config.js` lleva `gtmId` vacío: así la tienda no carga GTM ni envía nada.

## Lo que enseñó el editor de GTM (23 nov 2026)

Al importar la plantilla en un contenedor de servidor, el editor encontró tres
cosas que Node no podía ver:

1. La descripción de la plantilla admite 200 caracteres (la mía tenía 222).
2. Los nombres de los escenarios de prueba no admiten `: . , @ %`.
3. **El sandbox no evaluó `doy - Math.floor(...) + 1` como Node**: daba el 21
   donde Node da el 23 (año, mes y todos los pasos intermedios coincidían).
   La conversión a fecha se reescribió con una operación por sentencia y la
   fecha se comprueba ahora en el propio editor con cinco escenarios de reloj
   simulado (día del fallo, bisiesto, fin de año, marzo, enero). Sin esa
   comprobación, `logged_at` habría registrado compras con dos días de retraso.

Los tres están cubiertos en `tests/sandbox.spec.js` o en los escenarios de
`build.cjs`. El motivo del tercero no se ha aislado: se sabe que el resultado
difiere, no por qué.

## Sin verificar todavía

- `x-ga-gcs` y `user_data` como claves de `getAllEventData` en un contenedor de servidor real
  (la plantilla las lee; no he comprobado en un contenedor que el cliente GA4 las exponga con ese nombre).
- El permiso de BigQuery va con comodines que hay que ajustar a la tabla real, y la
  inserción en BigQuery no se ha ejecutado (los escenarios del editor no configuran tabla).
- Una llamada real con `validateOnly` contra una cuenta de Google Ads.
- El valor `CONSENT_DENIED` del enum de consentimiento (la documentación leída
  solo muestra `CONSENT_GRANTED`).
- Cómo se da acceso a la cuenta de Google Ads a la cuenta de servicio de Cloud Run.
- Las consultas de `sql/` contra BigQuery.
