import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { buildPurchase, checkEvent, normalize } from '../meta/capi.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const NOW = Date.UTC(2026, 10, 23, 10, 0, 0);

const entry = {
  event: 'purchase',
  event_id: 'purchase.LAB-ABC1',
  user_data: {
    email_address: '  Ana.Prueba@Empresa.Example ',
    phone_number: '+34 (600) 00-00-00',
    address: { first_name: 'Ana', last_name: "O'Brien-Pérez", postal_code: ' M1 1AE ', country: 'ES' },
  },
  ecommerce: {
    transaction_id: 'LAB-ABC1', currency: 'EUR', value: 38.9,
    items: [
      { item_id: 'SKU-001', item_name: 'Taza', price: 14.5, quantity: 2 },
      { item_id: 'SKU-002', item_name: 'Cuaderno', price: 9.9, quantity: 1 },
    ],
  },
};
const ctx = { nowMs: NOW, url: 'https://lab.example/gracias.html', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (test)', fbp: 'fb.1.1700000000000.1116446470', fbc: 'fb.1.1700000000000.AbCdEf' };

test('los ejemplos de la documentación de Meta dan el mismo hash', () => {
  // Ejemplos publicados por Meta para em, ph, fn y country.
  expect(sha(normalize.em('John_Smith@gmail.com'))).toBe('62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f');
  expect(sha(normalize.ph('(650)555-1212').replace(/^/, '1'))).toBe('e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176');
  expect(sha(normalize.name('Mary'))).toBe('6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec');
  expect(sha(normalize.country('US'))).toBe('79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621');
});

test('normalización: teléfono con país, apellido sin puntuación, CP sin espacios', () => {
  expect(normalize.ph('+34 (600) 00-00-00')).toBe('34600000000');
  expect(normalize.ph('0034 600 000 000')).toBe('34600000000');
  expect(normalize.name("O'Brien-Pérez")).toBe('obrienpérez');
  expect(normalize.zp(' M1 1AE ')).toBe('m11ae');
});

test('purchase del dataLayer → evento de Meta completo y deduplicable', () => {
  const ev = buildPurchase(entry, ctx);
  expect(ev.event_name).toBe('Purchase');
  expect(ev.event_id).toBe('purchase.LAB-ABC1');
  expect(ev.event_time).toBe(1795428000); // 2026-11-23T10:00:00Z, comprobado con `date -u -d`
  expect(ev.action_source).toBe('website');
  expect(ev.user_data.em).toBe(sha('ana.prueba@empresa.example'));
  expect(ev.user_data.ph).toBe(sha('34600000000'));
  expect(ev.user_data.fn).toBe(sha('ana'));
  expect(ev.user_data.ln).toBe(sha('obrienpérez'));
  expect(ev.user_data.zp).toBe(sha('m11ae'));
  expect(ev.user_data.country).toBe(sha('es'));
  expect(ev.custom_data).toEqual({
    currency: 'EUR', value: 38.9, order_id: 'LAB-ABC1', content_type: 'product',
    content_ids: ['SKU-001', 'SKU-002'], num_items: 3,
    contents: [{ id: 'SKU-001', quantity: 2, item_price: 14.5 }, { id: 'SKU-002', quantity: 1, item_price: 9.9 }],
  });
  expect(checkEvent(ev, NOW)).toEqual([]);
});

test('IP, user agent, fbp y fbc van sin hash; los datos personales no se filtran en claro', () => {
  const ev = buildPurchase(entry, ctx);
  expect([ev.user_data.client_ip_address, ev.user_data.client_user_agent, ev.user_data.fbp, ev.user_data.fbc])
    .toEqual([ctx.ip, ctx.userAgent, ctx.fbp, ctx.fbc]);
  const raw = JSON.stringify(ev.user_data);
  for (const pii of ['ana.prueba', 'empresa.example', '600', 'brien', 'M1 1AE']) expect(raw).not.toContain(pii);
});

test('sin teléfono ni dirección: se omiten los campos, no se envían vacíos', () => {
  const ev = buildPurchase({ ...entry, user_data: { email_address: 'ana@empresa.example' } }, { ...ctx, fbp: undefined, fbc: '' });
  expect(Object.keys(ev.user_data).sort()).toEqual(['client_ip_address', 'client_user_agent', 'em']);
});

test('checkEvent señala lo que Meta rechaza o penaliza', () => {
  const ok = buildPurchase(entry, ctx);
  expect(checkEvent({ ...ok, user_data: { ...ok.user_data, em: 'ana@empresa.example' } }, NOW)).toContain('em sin hash SHA-256');
  expect(checkEvent({ ...ok, user_data: { ...ok.user_data, client_ip_address: sha('1.2.3.4') } }, NOW)).toContain('client_ip_address no debe ir con hash');
  expect(checkEvent({ ...ok, event_id: undefined }, NOW)).toContain('falta event_id: sin él no hay deduplicación con el píxel');
  expect(checkEvent({ ...ok, event_time: ok.event_time - 8 * 86400 }, NOW)[0]).toContain('más de 7 días');
  expect(checkEvent({ ...ok, event_time: 1795428000.5 }, NOW)).toContain('event_time debe ser un entero en segundos');
  const noUa = { ...ok, user_data: { ...ok.user_data, client_user_agent: undefined } };
  expect(checkEvent(noUa, NOW)).toContain('falta client_user_agent (obligatorio en web)');
  expect(checkEvent({ ...ok, event_source_url: undefined }, NOW)).toContain('falta event_source_url (obligatorio en web)');
});

test('la clave de deduplicación coincide con la del dataLayer de la tienda', () => {
  const ev = buildPurchase(entry, ctx);
  expect(ev.event_id).toBe(`purchase.${entry.ecommerce.transaction_id}`);
});
