import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateDataLayer, compilePlan } from '../tracking-plan/validate.mjs';

const validators = compilePlan();
const rules = (entries) => validateDataLayer(entries, validators).map((v) => v.rule);

// --- Validador sin navegador: cada regla se dispara con su caso roto ----------

const consentDefault = { 0: 'consent', 1: 'default', 2: { ad_storage: 'denied' } };
const clear = { ecommerce: null };
const item = { item_id: 'SKU-001', item_name: 'Taza de cerámica', price: 14.5, quantity: 2 };
const purchase = (o = {}) => ({
  event: 'purchase',
  event_id: 'purchase.LAB-ABC1',
  user_data: { email_address: 'ana@empresa.example' },
  ecommerce: { transaction_id: 'LAB-ABC1', currency: 'EUR', value: 29, items: [item] },
  ...o,
});

test('una secuencia correcta no tiene violaciones', () => {
  expect(rules([consentDefault, clear, purchase()])).toEqual([]);
});

test('evento fuera del plan', () => {
  expect(rules([consentDefault, { event: 'compra_ok' }])).toEqual(['unknown_event']);
});

test('evento antes del consent default, y GTM antes del consent default', () => {
  expect(rules([clear, purchase(), consentDefault])).toEqual(['consent_order']);
  expect(rules([{ event: 'gtm.js' }, consentDefault])).toEqual(['consent_order']);
});

test('value que no cuadra con los artículos', () => {
  expect(rules([consentDefault, clear, purchase({ ecommerce: { ...purchase().ecommerce, value: 14.5 } })])).toEqual(['value_sum']);
});

test('ecommerce sin limpiar el objeto anterior', () => {
  expect(rules([consentDefault, purchase()])).toEqual(['ecommerce_clear']);
});

test('purchase repetido con el mismo transaction_id', () => {
  expect(rules([consentDefault, clear, purchase(), clear, purchase()])).toEqual(['duplicate_purchase']);
});

test('event_id que no corresponde al transaction_id rompe la deduplicación con Meta', () => {
  expect(rules([consentDefault, clear, purchase({ event_id: 'purchase.LAB-OTRO' })])).toEqual(['dedup_keys']);
});

test('tipos y campos: precio como texto, moneda en minúsculas, campo no previsto', () => {
  const bad = purchase({
    ecommerce: { transaction_id: 'LAB-ABC1', currency: 'eur', value: 29, items: [{ ...item, price: '14.50' }] },
    page_type: 'gracias',
  });
  const v = validateDataLayer([consentDefault, clear, bad], validators);
  expect(v.every((x) => x.rule === 'schema' || x.rule === 'value_sum')).toBe(true);
  const msgs = v.map((x) => x.message).join('\n');
  expect(msgs).toContain('/ecommerce/currency');
  expect(msgs).toContain('/ecommerce/items/0/price');
  expect(msgs).toContain('additional properties');
});

// --- Tienda real en el navegador ----------------------------------------------

// Captura cada push del dataLayer en todas las páginas, también los de gtag().
async function recordDataLayer(page) {
  const log = [];
  await page.exposeBinding('__recordPush', (_src, entry) => log.push(entry));
  await page.addInitScript(() => {
    const dl = (window.dataLayer = window.dataLayer || []);
    const push = dl.push.bind(dl);
    dl.push = (...args) => {
      for (const a of args) {
        const plain = Object.prototype.toString.call(a) === '[object Arguments]' ? { ...Array.from(a) } : a;
        window.__recordPush(JSON.parse(JSON.stringify(plain)));
      }
      return push(...args);
    };
  });
  return log;
}

async function buy(page, choice) {
  await page.goto('/index.html');
  await page.getByRole('button', { name: choice }).click();
  await page.getByRole('link', { name: /Taza/ }).click();
  await page.getByRole('button', { name: 'Añadir al carrito' }).click();
  await page.getByRole('button', { name: 'Añadir al carrito' }).click();
  await page.goto('/product.html?sku=SKU-002');
  await page.getByRole('button', { name: 'Añadir al carrito' }).click();
  await page.goto('/checkout.html');
  await page.getByLabel('Email').fill('ana.prueba@empresa.example');
  await page.getByLabel(/Teléfono/).fill('+34 600 000 000');
  await page.getByLabel('Nombre').fill('Ana');
  await page.getByLabel('Apellidos').fill('Prueba');
  await page.getByLabel('Código postal').fill('28013');
  await page.getByRole('button', { name: /Pagar/ }).click();
  await expect(page.locator('#order-id')).toHaveText(/^LAB-/);
}

test('aceptar y comprar: el dataLayer cumple el plan de principio a fin', async ({ page }) => {
  const log = await recordDataLayer(page);
  await buy(page, 'Aceptar');
  expect(validateDataLayer(log, validators)).toEqual([]);
  const names = log.filter((e) => e.event && !e.event.startsWith('gtm.')).map((e) => e.event);
  expect(names).toEqual(['consent_update', 'view_item', 'add_to_cart', 'add_to_cart', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
  const p = log.find((e) => e.event === 'purchase');
  expect(p.ecommerce.value).toBe(38.9); // 2 × 14,50 + 9,90
  expect(p.event_id).toBe(`purchase.${p.ecommerce.transaction_id}`);
  expect(log.find((e) => e.event === 'consent_update').consent.ad_user_data).toBe('granted');
});

test('rechazar y comprar: mismo contrato, consentimiento denegado', async ({ page }) => {
  const log = await recordDataLayer(page);
  await buy(page, 'Rechazar');
  expect(validateDataLayer(log, validators)).toEqual([]);
  expect(log.find((e) => e.event === 'consent_update').consent).toEqual({
    ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  });
});

test('recargar la página de gracias no repite la compra', async ({ page }) => {
  const log = await recordDataLayer(page);
  await buy(page, 'Aceptar');
  await page.reload();
  expect(log.filter((e) => e.event === 'purchase')).toHaveLength(1);
});

test('un cambio que rompe el contrato se detecta antes de llegar a los informes', async ({ page }) => {
  // Simula el despliegue de un cambio con un fallo típico que no rompe la página:
  // alguien renombra item_id a id en el catálogo.
  const original = readFileSync(new URL('../shop/app.js', import.meta.url), 'utf8');
  const broken = original.replace("'SKU-001': { item_id: 'SKU-001'", "'SKU-001': { id: 'SKU-001'");
  expect(broken).not.toBe(original);
  await page.route('**/app.js', (route) => route.fulfill({ contentType: 'text/javascript', body: broken }));
  const log = await recordDataLayer(page);
  await page.goto('/product.html?sku=SKU-001');
  await page.getByRole('button', { name: 'Aceptar' }).click();
  const v = validateDataLayer(log, validators);
  const msgs = v.filter((x) => x.rule === 'schema').map((x) => x.message);
  expect(msgs.some((m) => m.startsWith('view_item/ecommerce/items/0') && m.includes('item_id'))).toBe(true);
});
