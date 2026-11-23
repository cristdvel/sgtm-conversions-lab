# Meta Conversions API: contrato de la tienda de laboratorio

Qué debe enviar el servidor a Meta para que cada compra cuente una sola vez y
con la mejor coincidencia posible. El constructor de referencia está en
`meta/capi.mjs` y sus tests en `tests/meta-capi.spec.js`. El envío real lo hace
la etiqueta oficial de Meta para sGTM (no se reescribe aquí).

Fuente: documentación de Meta para desarrolladores (parámetros de información
del cliente, evento de servidor, datos personalizados y buenas prácticas),
leída el 23 nov 2026. Se anotan los huecos.

## De `purchase` del dataLayer a evento de Meta

| dataLayer (`tracking-plan/`) | Meta | Tratamiento |
|---|---|---|
| `event: 'purchase'` | `event_name: 'Purchase'` | Debe ser idéntico al del píxel del navegador |
| `event_id` (`purchase.LAB-…`) | `event_id` | Con `event_name`, es la clave de deduplicación |
| `ecommerce.transaction_id` | `custom_data.order_id` | |
| `ecommerce.value`, `currency` | `custom_data.value`, `currency` | Número y código ISO 4217 |
| `ecommerce.items[]` | `content_ids`, `contents`, `num_items` | `content_type: 'product'` |
| `user_data.email_address` | `user_data.em` | trim + minúsculas → SHA-256 |
| `user_data.phone_number` | `user_data.ph` | solo dígitos con prefijo de país, sin ceros iniciales → SHA-256 |
| `address.first_name` / `last_name` | `fn` / `ln` | minúsculas, sin puntuación → SHA-256 |
| `address.postal_code` | `zp` | minúsculas, sin espacios ni guiones → SHA-256 |
| `address.country` | `country` | ISO 3166-1 alfa-2 en minúsculas → SHA-256 |
| cookie `_fbp`, `_fbc` | `fbp`, `fbc` | **sin hash** |
| IP y user agent de la petición | `client_ip_address`, `client_user_agent` | **sin hash**; el user agent es obligatorio en web |
| URL de la página | `event_source_url` | obligatorio en web |
| — | `action_source: 'website'`, `event_time` | entero en segundos UTC |

## Reglas que el test comprueba

- Hash solo en `em ph fn ln zp country`; nunca en IP, user agent, `fbp`, `fbc`.
- Un campo sin valor se **omite**, no se envía vacío.
- Ningún dato personal aparece en claro en el evento.
- `event_time` entero y de menos de 7 días: si un solo evento es más antiguo,
  Meta rechaza toda la petición.
- Sin `event_id` no hay deduplicación con el píxel.
- Los hashes de los ejemplos publicados por Meta (correo, teléfono, nombre y
  país) coinciden con los que calcula `meta/capi.mjs`.

## Deduplicación

Meta compara `event_name` + `event_id` entre el navegador y el servidor. Si
coinciden en 48 horas se queda con la primera copia; si llegan con menos de unos
5 minutos de diferencia prefiere la del navegador. La alternativa
(`external_id` + `fbp`) existe, pero el laboratorio usa `event_id`.

## Qué no se ha podido confirmar

- La página específica de deduplicación y el artículo del Centro de ayuda no se
  leyeron; las reglas de arriba salen de las páginas de evento de servidor y
  buenas prácticas.
- Meta no fija en la prosa el algoritmo de hash (solo muestra ejemplos SHA-256
  en hexadecimal) ni si `value` es número o texto, ni la capitalización de
  `currency`: el constructor usa número y el código tal como llega (`EUR`).
- Nada de esto se ha enviado a Meta todavía: falta el portfolio, el dataset y
  el código de eventos de prueba.
