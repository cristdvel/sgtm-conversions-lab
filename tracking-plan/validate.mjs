// Valida una secuencia de entradas del dataLayer contra plan.json.
// Dos niveles: el esquema de cada evento (JSON Schema, con Ajv) y reglas de
// negocio que un esquema no puede expresar (orden, sumas, unicidad).
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';

export const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));

export function compilePlan(p = plan) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema({ $id: 'plan', defs: p.defs }, 'plan');
  const validators = {};
  for (const [name, ev] of Object.entries(p.events)) {
    const schema = JSON.parse(JSON.stringify(ev.schema).replaceAll('"#/defs/', '"plan#/defs/'));
    validators[name] = ajv.compile(schema);
  }
  return validators;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Las entradas de gtag() llegan como objetos {0: 'consent', 1: 'default', 2: {...}}.
const gtagCall = (e) => (e && typeof e === 'object' && '0' in e ? [e[0], e[1], e[2]] : null);

export function validateDataLayer(entries, validators = compilePlan()) {
  const violations = [];
  const add = (index, rule, message) => violations.push({ index, rule, message });

  let consentDefaultAt = -1;
  let ecommerceCleared = false;
  const seenTransactions = new Set();

  entries.forEach((e, i) => {
    const call = gtagCall(e);
    if (call) {
      if (call[0] === 'consent' && call[1] === 'default' && consentDefaultAt === -1) consentDefaultAt = i;
      return;
    }
    if (!e || typeof e !== 'object') return add(i, 'shape', 'entrada que no es un objeto');
    if ('ecommerce' in e && e.ecommerce === null && !('event' in e)) {
      ecommerceCleared = true;
      return;
    }
    if (typeof e.event !== 'string') return add(i, 'shape', 'push sin nombre de evento');
    if (e.event.startsWith('gtm.')) {
      if (e.event === 'gtm.js' && consentDefaultAt === -1) add(i, 'consent_order', 'GTM arranca antes del consent default');
      return;
    }

    const validate = validators[e.event];
    if (!validate) return add(i, 'unknown_event', `evento fuera del plan: ${e.event}`);
    if (consentDefaultAt === -1) add(i, 'consent_order', `${e.event} antes del consent default`);
    if (!validate(e)) {
      for (const err of validate.errors) add(i, 'schema', `${e.event}${err.instancePath} ${err.message}`);
    }

    if (e.ecommerce && typeof e.ecommerce === 'object') {
      if (!ecommerceCleared) add(i, 'ecommerce_clear', `${e.event} sin { ecommerce: null } previo`);
      ecommerceCleared = false;
      const items = Array.isArray(e.ecommerce.items) ? e.ecommerce.items : [];
      const sum = round2(items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0));
      if (typeof e.ecommerce.value === 'number' && round2(e.ecommerce.value) !== sum) {
        add(i, 'value_sum', `${e.event}: value ${e.ecommerce.value} no es la suma de los artículos (${sum})`);
      }
    }

    if (e.event === 'purchase' && e.ecommerce) {
      const tid = e.ecommerce.transaction_id;
      if (seenTransactions.has(tid)) add(i, 'duplicate_purchase', `purchase repetido para ${tid}`);
      seenTransactions.add(tid);
      if (e.event_id && tid && e.event_id !== `purchase.${tid}`) {
        add(i, 'dedup_keys', `event_id (${e.event_id}) no corresponde a transaction_id (${tid})`);
      }
    }
  });

  return violations;
}
