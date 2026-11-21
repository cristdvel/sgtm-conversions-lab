// Tienda de prueba: consentimiento (Consent Mode v2) y dataLayer según el plan
// de medición de tracking-plan/. Sin dependencias. Datos ficticios.
(function () {
  'use strict';

  var CONFIG = window.LAB_CONFIG || {};
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  var CONSENT_KEY = 'lab_consent';
  var CART_KEY = 'lab_cart';
  var CURRENCY = 'EUR';

  var PRODUCTS = {
    'SKU-001': { item_id: 'SKU-001', item_name: 'Taza de cerámica', item_category: 'Cocina', price: 14.5 },
    'SKU-002': { item_id: 'SKU-002', item_name: 'Cuaderno A5', item_category: 'Papelería', price: 9.9 },
  };

  // --- Consentimiento ---------------------------------------------------------

  var DENIED = { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
  var GRANTED = { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };

  gtag('consent', 'default', Object.assign({ wait_for_update: 500 }, DENIED));

  function readStore(store, key) {
    try { return JSON.parse(store.getItem(key)); } catch (e) { return null; }
  }
  function writeStore(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* sin almacenamiento */ }
  }

  function applyConsent(state, isNewChoice) {
    gtag('consent', 'update', state);
    if (isNewChoice) {
      window.dataLayer.push({ event: 'consent_update', consent: Object.assign({}, state) });
    }
  }

  var saved = readStore(localStorage, CONSENT_KEY);
  if (saved) applyConsent(saved, false);

  // GTM web solo si hay ID configurado (shop/config.js). Sin ID, la tienda
  // funciona igual y el dataLayer se puede validar sin enviar nada.
  if (CONFIG.gtmId) {
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(CONFIG.gtmId);
    document.head.appendChild(s);
  }

  function showBanner() {
    var b = document.getElementById('consent-banner');
    if (!b) return;
    b.hidden = false;
    b.querySelector('[data-consent="accept"]').addEventListener('click', function () { choose(GRANTED); });
    b.querySelector('[data-consent="reject"]').addEventListener('click', function () { choose(DENIED); });
    function choose(state) {
      writeStore(localStorage, CONSENT_KEY, state);
      applyConsent(state, true);
      b.hidden = true;
    }
  }

  // --- Carrito y eventos de ecommerce ----------------------------------------

  function cart() { return readStore(sessionStorage, CART_KEY) || []; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function total(items) {
    return round2(items.reduce(function (sum, it) { return sum + it.price * it.quantity; }, 0));
  }
  function ecommerceEvent(name, items, extra) {
    window.dataLayer.push({ ecommerce: null });
    window.dataLayer.push({
      event: name,
      ecommerce: Object.assign({ currency: CURRENCY, value: total(items), items: items }, extra || {}),
    });
  }

  function pageProduct() {
    var p = PRODUCTS[new URLSearchParams(location.search).get('sku')];
    if (!p) return;
    document.getElementById('product-name').textContent = p.item_name;
    document.getElementById('product-price').textContent = p.price.toFixed(2) + ' €';
    ecommerceEvent('view_item', [Object.assign({ quantity: 1 }, p)]);
    document.getElementById('add-to-cart').addEventListener('click', function () {
      var items = cart();
      var line = items.filter(function (it) { return it.item_id === p.item_id; })[0];
      if (line) line.quantity += 1; else items.push(Object.assign({ quantity: 1 }, p));
      writeStore(sessionStorage, CART_KEY, items);
      ecommerceEvent('add_to_cart', [Object.assign({ quantity: 1 }, p)]);
      document.getElementById('cart-status').textContent = 'Añadido al carrito';
    });
  }

  function pageCheckout() {
    var items = cart();
    if (!items.length) {
      document.getElementById('checkout-form').hidden = true;
      document.getElementById('empty-cart').hidden = false;
      return;
    }
    document.getElementById('order-total').textContent = total(items).toFixed(2) + ' €';
    ecommerceEvent('begin_checkout', items);
    document.getElementById('checkout-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var order = {
        items: items,
        // ID de pedido generado en "servidor": aquí, en el navegador por ser un laboratorio.
        transaction_id: 'LAB-' + Date.now().toString(36).toUpperCase(),
        user: {
          email_address: f.email.value.trim(),
          phone_number: f.phone.value.trim(),
          address: {
            first_name: f.first_name.value.trim(),
            last_name: f.last_name.value.trim(),
            postal_code: f.postal_code.value.trim(),
            country: 'ES',
          },
        },
      };
      writeStore(sessionStorage, 'lab_order', order);
      sessionStorage.removeItem(CART_KEY);
      location.href = 'gracias.html';
    });
  }

  function pageThanks() {
    var order = readStore(sessionStorage, 'lab_order');
    if (!order) return; // recarga de la página de gracias: no se repite la compra
    sessionStorage.removeItem('lab_order');
    document.getElementById('order-id').textContent = order.transaction_id;
    window.dataLayer.push({ ecommerce: null });
    window.dataLayer.push({
      event: 'purchase',
      // event_id: clave de deduplicación navegador/servidor para Meta.
      event_id: 'purchase.' + order.transaction_id,
      user_data: order.user,
      ecommerce: {
        transaction_id: order.transaction_id,
        currency: CURRENCY,
        value: total(order.items),
        items: order.items,
      },
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!readStore(localStorage, CONSENT_KEY)) showBanner();
    var page = document.body.getAttribute('data-page');
    if (page === 'product') pageProduct();
    if (page === 'checkout') pageCheckout();
    if (page === 'thanks') pageThanks();
  });
})();
