---
title: "Un plan de medición que falla el build: cómo paro un cambio que rompe el dataLayer antes de que llegue a GA4"
description: "Un plan de medición escrito como esquemas JSON y reglas de negocio, comprobado en CI contra el dataLayer real de una tienda de pruebas. Qué detecta, un fallo simulado y qué no cubre."
pubDate: 2026-12-03
eyebrow: "CALIDAD DE DATOS"
draft: true
faq:
  - q: "¿Qué diferencia hay entre un plan de medición en una hoja de cálculo y uno como código?"
    a: "La hoja describe lo que debería pasar y depende de que alguien la revise. El plan como código se ejecuta: cada cambio en la web lanza una prueba que recorre el sitio y falla si un evento no cumple su esquema. La hoja envejece sin avisar; el build, no."
  - q: "¿Sustituye a una herramienta de gobierno de datos?"
    a: "No. Es una versión pequeña y sin servicio de la misma idea. Cubre el contrato del dataLayer en el momento del cambio, no la monitorización en producción ni el trabajo con muchos equipos."
---

> Borrador. No está en el repositorio de la web: se revisa y se mueve a mano. Ver «Antes de publicar» al final.

La mayoría de los fallos de medición que he visto no eran un error de configuración en la herramienta. Eran un cambio en la web que rompía un evento y que nadie vio hasta semanas después, cuando un informe dejó de cuadrar. Un campo renombrado, un precio que pasa de número a texto, un `purchase` que se dispara dos veces al recargar.

Para mostrar cómo se evita, monté una tienda de pruebas con datos ficticios y un plan de medición que se ejecuta. Esto es lo que hace, un fallo simulado y lo que no cubre.

## El plan es un fichero que se ejecuta

Cada evento del `dataLayer` tiene un esquema JSON: qué campos exige, de qué tipo y con qué formato. Un evento que no está en el plan es un error, igual que un campo de más. Ese es el primer nivel.

El segundo nivel son las reglas que un esquema no puede expresar:

- El `consent default` va antes de cualquier evento y antes de que arranque GTM.
- Cada evento de ecommerce va precedido de `{ ecommerce: null }`, para no heredar datos del anterior.
- `value` es la suma de `price × quantity` de los artículos.
- No se repite un `purchase` con el mismo `transaction_id`.
- El `event_id` corresponde al `transaction_id`. Si no, la deduplicación con Meta falla sin avisar.

## Cómo se comprueba

Un test de Playwright abre la tienda en Chromium, acepta o rechaza las cookies, añade productos, rellena el pago y llega a la página de gracias. Mientras, captura cada entrada que la página mete en el `dataLayer`, incluidas las de `gtag()`. Esa secuencia pasa por el validador. Se prueba con las dos decisiones de consentimiento, y también que recargar la página de gracias no repite la compra.

Todo corre en CI en cada pull request, junto con las pruebas de la etiqueta de servidor.

## Un fallo simulado

Para comprobar que el plan sirve, simulé un cambio que no rompe la página: alguien renombra `item_id` a `id` en el catálogo. La tienda sigue funcionando, el carrito suma bien y el pago se completa. Un recorrido manual no vería nada.

El validador sí: `view_item` ya no cumple su esquema porque falta `item_id` en el artículo. El build falla antes de que ese cambio llegue a producción y de que GA4 empiece a recibir artículos sin identificador.

Este fallo lo provoqué yo a propósito, en una tienda que he escrito yo. No es un caso real de un cliente ni prueba que esto atrape todo lo que se rompe en una web de verdad.

## Qué no cubre

- **Producción.** Valida el contrato en el momento del cambio. No vigila que el evento llegue a GA4 con ese formato ni detecta una etiqueta de GTM mal configurada después.
- **Un sitio real.** La tienda es mínima. En una web grande el reto es mantener el plan al día entre varios equipos, y eso lo resuelven mejor los productos de gobierno de datos como Snowplow o Avo, que ofrecen validación y monitorización como servicio.
- **El contenedor de GTM.** Los esquemas comprueban lo que la web mete en el `dataLayer`, no lo que GTM hace con ello.

## Para qué sirve igualmente

Convierte «¿cómo sabes que tus datos están bien?» en algo que se puede enseñar y repetir. El plan está en Git, se revisa en cada cambio y falla en rojo. Es una pieza pequeña, pero cambia la conversación con el equipo de desarrollo: dejar de pedir que alguien se acuerde de revisar y pasar a un contrato que el propio build hace cumplir.

## Antes de publicar

- Confirmar con el usuario si se publica el repositorio `sgtm-conversions-lab` y enlazarlo; ahora es privado.
- Ajustar la fecha de `pubDate` y generar la versión en inglés.
- Si se menciona Snowplow o Avo con más detalle, verificar sus funciones actuales: aquí solo se citan como ejemplo de la categoría.
- No contiene nombres de clientes ni de tiendas.
