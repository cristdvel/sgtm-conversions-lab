// Ejecuta src/datamanager_tag.js con un `require` simulado del sandbox de
// servidor de GTM y comprueba la petición que construye. Sin dependencias:
//   node test/run.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'datamanager_tag.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const NOW = Date.UTC(2026, 10, 21, 9, 5, 7); // 2026-11-21T09:05:07Z

function runTag(eventData, fields, httpStatus = 200) {
  const calls = { http: [], logs: [], success: 0, failure: 0, auth: null };
  const sandboxRequire = (name) => {
    switch (name) {
      case 'getAllEventData': return () => eventData;
      case 'getTimestampMillis': return () => NOW;
      case 'getGoogleAuth': return (o) => { calls.auth = o; return { token: 'mock' }; };
      case 'sha256Sync': return (s, o) => { if (o.outputEncoding !== 'hex') throw new Error('encoding'); return sha(s); };
      case 'parseUrl': return (u) => {
        try {
          const x = new URL(u);
          const sp = {};
          x.searchParams.forEach((v, k) => { sp[k] = v; });
          return { searchParams: sp };
        } catch (e) { return undefined; }
      };
      case 'sendHttpRequest': return (url, opts, body) => {
        calls.http.push({ url, opts, body: JSON.parse(body) });
        return Promise.resolve({ statusCode: httpStatus, body: '{"requestId":"r-1"}' });
      };
      case 'makeString': return (v) => (v === undefined || v === null ? '' : String(v));
      case 'makeNumber': return (v) => Number(v);
      case 'getType': return (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
      case 'logToConsole': return (s) => calls.logs.push(JSON.parse(s));
      case 'JSON': return { stringify: JSON.stringify, parse: JSON.parse };
      case 'Math': return Math;
      default: throw new Error('API no simulada: ' + name);
    }
  };
  const data = Object.assign({
    operatingAccountId: '123-456-7890',
    conversionActionId: '987654321',
    gtmOnSuccess: () => { calls.success++; },
    gtmOnFailure: () => { calls.failure++; },
  }, fields);
  new Function('require', 'data', code)(sandboxRequire, data);
  return new Promise((r) => setImmediate(() => r(calls)));
}

const purchase = (extra = {}) => Object.assign({
  event_name: 'purchase',
  transaction_id: 'T-1001',
  value: '59.90',
  currency: 'eur',
  'x-ga-gcs': 'G111',
  page_location: 'https://tienda.example/gracias?gclid=CjwKCAtest',
}, extra);

const cases = [];
const t = (name, fn) => cases.push({ name, fn });
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(what + '\n       esperado: ' + JSON.stringify(b) + '\n       obtenido: ' + JSON.stringify(a));
  }
};

t('compra con gclid y consentimiento: petición completa en modo validación', async () => {
  const c = await runTag(purchase(), {});
  eq(c.http.length, 1, 'llamadas');
  eq(c.http[0].url, 'https://datamanager.googleapis.com/v1/events:ingest', 'endpoint');
  eq(c.auth, { scopes: ['https://www.googleapis.com/auth/datamanager'] }, 'scope');
  const b = c.http[0].body;
  eq(b.validateOnly, true, 'validateOnly por defecto');
  eq(b.encoding, 'HEX', 'encoding');
  eq(b.destinations, [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '987654321' }], 'destino');
  eq(b.events[0], {
    transactionId: 'T-1001',
    eventTimestamp: '2026-11-21T09:05:07Z',
    eventSource: 'WEB',
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
    conversionValue: 59.9,
    currency: 'EUR',
    adIdentifiers: { gclid: 'CjwKCAtest' },
  }, 'evento');
  eq([c.success, c.failure], [1, 0], 'resultado');
});

t('validateOnly desmarcado envía en real', async () => {
  const c = await runTag(purchase(), { validateOnly: false });
  eq(c.http[0].body.validateOnly, false, 'validateOnly');
});

t('cuenta de administrador opcional como loginAccount', async () => {
  const c = await runTag(purchase(), { loginAccountId: '111-222-3333' });
  eq(c.http[0].body.destinations[0].loginAccount, { accountType: 'GOOGLE_ADS', accountId: '1112223333' }, 'loginAccount');
});

t('gcs con ad_storage denegado: no se envía y no es un fallo', async () => {
  const c = await runTag(purchase({ 'x-ga-gcs': 'G101' }), {});
  eq(c.http.length, 0, 'llamadas');
  eq(c.logs[0], { sent: false, reason: 'consent_not_granted' }, 'motivo');
  eq([c.success, c.failure], [1, 0], 'resultado');
});

t('sin gcs ni campo de consentimiento: estado desconocido, no se envía', async () => {
  const e = purchase();
  delete e['x-ga-gcs'];
  const c = await runTag(e, {});
  eq(c.http.length, 0, 'llamadas');
  eq(c.logs[0].reason, 'consent_not_granted', 'motivo');
});

t('el campo de consentimiento manda sobre gcs', async () => {
  const denied = await runTag(purchase(), { adUserData: 'denied' });
  eq(denied.http.length, 0, 'denegado explícito');
  const granted = await runTag(purchase({ 'x-ga-gcs': 'G100' }), { adUserData: 'granted', adPersonalization: 'granted' });
  eq(granted.http.length, 1, 'concedido explícito');
  eq(granted.http[0].body.events[0].consent.adPersonalization, 'CONSENT_GRANTED', 'personalización');
});

t('sin transaction_id no se envía (no habría deduplicación)', async () => {
  const c = await runTag(purchase({ transaction_id: '  ' }), {});
  eq(c.http.length, 0, 'llamadas');
  eq(c.logs[0].reason, 'missing_transaction_id', 'motivo');
});

t('sin gclid ni datos de usuario no hay identificadores', async () => {
  const c = await runTag(purchase({ page_location: 'https://tienda.example/gracias' }), {});
  eq(c.http.length, 0, 'llamadas');
  eq(c.logs[0].reason, 'no_identifiers', 'motivo');
});

t('gbraid como parámetro de evento cuando no hay gclid', async () => {
  const c = await runTag(purchase({ page_location: 'https://tienda.example/gracias', gbraid: '0AAAAAtest' }), {});
  eq(c.http[0].body.events[0].adIdentifiers, { gbraid: '0AAAAAtest' }, 'gbraid');
});

t('email de Gmail: minúsculas, sin puntos ni sufijo +, y hash', async () => {
  const c = await runTag(purchase({ user_data: { email_address: '  Cloudy.SanFrancisco+shopping@Gmail.com ' } }), {});
  eq(c.http[0].body.events[0].userData, { userIdentifiers: [{ emailAddress: sha('cloudysanfrancisco@gmail.com') }] }, 'email');
});

t('email de otro dominio conserva puntos y +', async () => {
  const c = await runTag(purchase({ user_data: { email_address: 'Ana.Lopez+web@Empresa.es' } }), {});
  eq(c.http[0].body.events[0].userData.userIdentifiers[0].emailAddress, sha('ana.lopez+web@empresa.es'), 'email');
});

t('email ya hasheado por el cliente GA4 se pasa tal cual', async () => {
  const h = sha('ana@empresa.es').toUpperCase();
  const c = await runTag(purchase({ user_data: { sha256_email_address: h } }), {});
  eq(c.http[0].body.events[0].userData.userIdentifiers[0].emailAddress, h.toLowerCase(), 'email');
});

t('teléfono: E.164 con 00 o +; sin prefijo internacional se descarta', async () => {
  const a = await runTag(purchase({ user_data: { phone_number: '0034 600 11-22-33' } }), {});
  eq(a.http[0].body.events[0].userData.userIdentifiers, [{ phoneNumber: sha('+34600112233') }], '00');
  const b = await runTag(purchase({ user_data: { phone_number: '(+34) 600.112.233' } }), {});
  eq(b.http[0].body.events[0].userData, undefined, 'paréntesis antes del +: no se adivina');
  const c = await runTag(purchase({ user_data: { phone_number: '600112233' } }), {});
  eq(c.http[0].body.events[0].userData, undefined, 'sin prefijo');
});

t('dirección: los cuatro campos o ninguno; país y CP sin hash', async () => {
  const full = await runTag(purchase({ user_data: { address: [{ first_name: ' Ana ', last_name: 'LÓPEZ', country: 'es', postal_code: ' 28013 ' }] } }), {});
  eq(full.http[0].body.events[0].userData.userIdentifiers, [{ address: { givenName: sha('ana'), familyName: sha('lópez'), regionCode: 'ES', postalCode: '28013' } }], 'completa');
  const partial = await runTag(purchase({ user_data: { address: { first_name: 'Ana', country: 'ES', postal_code: '28013' } } }), {});
  eq(partial.http[0].body.events[0].userData, undefined, 'incompleta');
});

t('solo datos de usuario, sin gclid, basta como identificador', async () => {
  const c = await runTag(purchase({ page_location: 'https://tienda.example/gracias', user_data: { email_address: 'ana@empresa.es' } }), {});
  eq(c.http.length, 1, 'llamadas');
  eq(c.logs[0].identifiers, ['email'], 'identificadores');
});

t('valor no numérico: se omiten valor y moneda', async () => {
  const c = await runTag(purchase({ value: 'abc' }), {});
  const ev = c.http[0].body.events[0];
  eq([ev.conversionValue, ev.currency], [undefined, undefined], 'valor');
});

t('respuesta 4xx de la API: gtmOnFailure', async () => {
  const c = await runTag(purchase(), {}, 400);
  eq([c.success, c.failure], [0, 1], 'resultado');
});

t('fechas RFC 3339: bisiesto y fin de año', async () => {
  // Se comprueba la función a través de una ejecución con otro reloj.
  const check = async (ms, want) => {
    const src = code.replace("require('getTimestampMillis')", '(function(){return function(){return ' + ms + ';};})()');
    const calls = { http: [] };
    const req = (n) => (n === 'sendHttpRequest'
      ? (u, o, b) => { calls.http.push(JSON.parse(b)); return Promise.resolve({ statusCode: 200 }); }
      : n === 'getAllEventData' ? () => purchase()
      : n === 'getGoogleAuth' ? () => ({})
      : n === 'logToConsole' ? () => {}
      : n === 'parseUrl' ? () => ({ searchParams: { gclid: 'x' } })
      : n === 'makeString' ? (v) => (v === undefined || v === null ? '' : String(v))
      : n === 'makeNumber' ? Number
      : n === 'getType' ? (v) => (Array.isArray(v) ? 'array' : typeof v)
      : n === 'JSON' ? JSON : n === 'Math' ? Math : () => '');
    new Function('require', 'data', src)(req, { operatingAccountId: '1', conversionActionId: '2', gtmOnSuccess() {}, gtmOnFailure() {} });
    await new Promise((r) => setImmediate(r));
    eq(calls.http[0].events[0].eventTimestamp, want, String(ms));
  };
  await check(Date.UTC(2028, 1, 29, 23, 59, 59), '2028-02-29T23:59:59Z');
  await check(Date.UTC(2026, 11, 31, 0, 0, 0), '2026-12-31T00:00:00Z');
  await check(Date.UTC(2000, 0, 1, 12, 30, 5), '2000-01-01T12:30:05Z');
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log('OK    ' + c.name);
    } catch (e) {
      failed++;
      console.log('FALLA ' + c.name + '\n       ' + e.message);
    }
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' casos correctos');
  process.exit(failed ? 1 : 0);
})();
