// Constructor de referencia: de un `purchase` del dataLayer a un evento de la
// Conversions API de Meta. No envía nada: define el contrato que la etiqueta
// oficial de Meta en sGTM debe cumplir y que los tests comprueban.
// Reglas de normalización de la documentación de Meta (ver docs/meta-capi.md).
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const nonEmpty = (v) => (v === undefined || v === null ? '' : String(v)).trim();

export const normalize = {
  em: (v) => nonEmpty(v).toLowerCase(),
  // Solo dígitos, con prefijo de país; se descartan símbolos, letras y ceros iniciales.
  ph: (v) => nonEmpty(v).replace(/[^0-9]/g, '').replace(/^0+/, ''),
  name: (v) => nonEmpty(v).toLowerCase().replace(/[.,;:'"\-_()]/g, ''),
  zp: (v) => nonEmpty(v).toLowerCase().replace(/[\s-]/g, ''),
  country: (v) => nonEmpty(v).toLowerCase(),
};

const hashed = (norm, v) => {
  const n = norm(v);
  return n ? sha(n) : undefined;
};

// ctx: lo que solo conoce el servidor o el navegador y no va en el dataLayer.
export function buildPurchase(entry, ctx) {
  const ud = entry.user_data || {};
  const addr = Array.isArray(ud.address) ? ud.address[0] : ud.address || {};
  const user_data = {
    em: hashed(normalize.em, ud.email_address),
    ph: hashed(normalize.ph, ud.phone_number),
    fn: hashed(normalize.name, addr.first_name),
    ln: hashed(normalize.name, addr.last_name),
    zp: hashed(normalize.zp, addr.postal_code),
    country: hashed(normalize.country, addr.country),
    // Sin hash por norma de Meta: IP, user agent y las cookies _fbp / _fbc.
    client_ip_address: ctx.ip,
    client_user_agent: ctx.userAgent,
    fbp: ctx.fbp,
    fbc: ctx.fbc,
  };
  for (const k of Object.keys(user_data)) if (user_data[k] === undefined || user_data[k] === '') delete user_data[k];

  const items = entry.ecommerce.items;
  return {
    event_name: 'Purchase',
    event_time: Math.floor(ctx.nowMs / 1000),
    // event_id + event_name idénticos a los del píxel: Meta conserva la primera copia.
    event_id: entry.event_id,
    action_source: 'website',
    event_source_url: ctx.url,
    user_data,
    custom_data: {
      currency: entry.ecommerce.currency,
      value: entry.ecommerce.value,
      order_id: entry.ecommerce.transaction_id,
      content_type: 'product',
      content_ids: items.map((i) => i.item_id),
      contents: items.map((i) => ({ id: i.item_id, quantity: i.quantity, item_price: i.price })),
      num_items: items.reduce((n, i) => n + i.quantity, 0),
    },
  };
}

// Reglas que Meta rechaza o penaliza; devuelve la lista de problemas.
export function checkEvent(ev, nowMs) {
  const problems = [];
  for (const f of ['event_name', 'event_time', 'action_source', 'user_data']) if (!ev[f]) problems.push(`falta ${f}`);
  if (ev.action_source === 'website') {
    if (!ev.event_source_url) problems.push('falta event_source_url (obligatorio en web)');
    if (!ev.user_data?.client_user_agent) problems.push('falta client_user_agent (obligatorio en web)');
  }
  if (!Number.isInteger(ev.event_time)) problems.push('event_time debe ser un entero en segundos');
  else if (nowMs - ev.event_time * 1000 > 7 * 86400e3) problems.push('event_time de hace más de 7 días: Meta rechaza toda la petición');
  const hashedFields = ['em', 'ph', 'fn', 'ln', 'zp', 'country'];
  for (const f of hashedFields) {
    const v = ev.user_data?.[f];
    if (v !== undefined && !/^[0-9a-f]{64}$/.test(v)) problems.push(`${f} sin hash SHA-256`);
  }
  for (const f of ['client_ip_address', 'client_user_agent', 'fbp', 'fbc']) {
    if (/^[0-9a-f]{64}$/.test(ev.user_data?.[f] || '')) problems.push(`${f} no debe ir con hash`);
  }
  if (!ev.event_id) problems.push('falta event_id: sin él no hay deduplicación con el píxel');
  return problems;
}
