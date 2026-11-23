// Data Manager API — etiqueta de servidor para sGTM.
// Envía conversiones web a Google Ads por events:ingest, con deduplicación por
// transactionId frente a la etiqueta del navegador.
// Código para el sandbox de plantillas de GTM: sin expresiones regulares, sin
// funciones flecha, sin Date. El mismo fichero lo ejecutan test/run.js (Node)
// y el editor de plantillas.

var getAllEventData = require('getAllEventData');
var sendHttpRequest = require('sendHttpRequest');
var getGoogleAuth = require('getGoogleAuth');
var sha256Sync = require('sha256Sync');
var parseUrl = require('parseUrl');
var getTimestampMillis = require('getTimestampMillis');
var makeString = require('makeString');
var makeNumber = require('makeNumber');
var getType = require('getType');
var logToConsole = require('logToConsole');
var JSON = require('JSON');
var Math = require('Math');

var ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';
var SCOPE = 'https://www.googleapis.com/auth/datamanager';
var DIGITS = '0123456789';
var HEX = '0123456789abcdef';

var BigQuery = require('BigQuery');

var ev = getAllEventData();
var built = buildRequest(ev);

if (!built.body) {
  // No enviar no es un fallo: es la decisión correcta (sin consentimiento, sin
  // identificadores o sin transacción). Se registra el motivo.
  record({ sent: false, reason: built.reason });
  data.gtmOnSuccess();
} else {
  var auth = getGoogleAuth({ scopes: [SCOPE] });
  sendHttpRequest(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    authorization: auth,
    timeout: 5000
  }, JSON.stringify(built.body)).then(function (res) {
    var ok = res.statusCode >= 200 && res.statusCode < 300;
    record({
      sent: ok,
      reason: ok ? 'sent' : 'api_error',
      status: res.statusCode,
      response: res.body
    });
    if (ok) data.gtmOnSuccess(); else data.gtmOnFailure();
  }, function () {
    record({ sent: false, reason: 'http_error' });
    data.gtmOnFailure();
  });
}

// Una fila por decisión, sin datos personales: qué transacción, si salió, por
// qué no, y con qué tipos de identificador. Sirve para cuadrar cobertura en
// BigQuery frente a las compras de la exportación de GA4.
function record(o) {
  var row = {
    logged_at: toRfc3339(getTimestampMillis()),
    destination: 'google_ads_data_manager',
    transaction_id: makeString(ev.transaction_id || '').trim(),
    sent: o.sent,
    reason: o.reason,
    validate_only: built.body ? built.body.validateOnly : (data.validateOnly !== false),
    http_status: o.status || null,
    identifiers: built.identifiers ? built.identifiers.join(',') : '',
    gcs: makeString(ev['x-ga-gcs'] || '')
  };
  log({ row: row, response: o.response });
  if (data.bqProjectId && data.bqDatasetId && data.bqTableId) {
    BigQuery.insert(
      { projectId: data.bqProjectId, datasetId: data.bqDatasetId, tableId: data.bqTableId },
      [row],
      { ignoreUnknownValues: true }
    ).then(function () {}, function () { log({ bigquery: 'insert_failed' }); });
  }
}

// --- Construcción de la petición ---------------------------------------------

function buildRequest(e) {
  if (consentState(e) !== 'granted') return { reason: 'consent_not_granted' };

  var transactionId = makeString(e.transaction_id || '').trim();
  if (!transactionId) return { reason: 'missing_transaction_id' };

  var event = {
    transactionId: transactionId,
    eventTimestamp: toRfc3339(getTimestampMillis()),
    eventSource: 'WEB',
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: personalization(e) }
  };

  var value = makeNumber(e.value);
  if (getType(value) === 'number' && value === value) {
    event.conversionValue = value;
    if (e.currency) event.currency = makeString(e.currency).trim().toUpperCase();
  }

  var identifiers = [];
  var ad = adIdentifiers(e);
  if (ad) {
    event.adIdentifiers = ad;
    identifiers.push(ad.gclid ? 'gclid' : (ad.gbraid ? 'gbraid' : 'wbraid'));
  }
  var ids = userIdentifiers(e.user_data);
  if (ids.length) {
    event.userData = { userIdentifiers: ids };
    for (var i = 0; i < ids.length; i++) {
      if (ids[i].emailAddress) identifiers.push('email');
      else if (ids[i].phoneNumber) identifiers.push('phone');
      else identifiers.push('address');
    }
  }
  if (!identifiers.length) return { reason: 'no_identifiers' };

  var destination = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: digitsOnly(data.operatingAccountId) },
    productDestinationId: makeString(data.conversionActionId).trim()
  };
  if (data.loginAccountId) {
    destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: digitsOnly(data.loginAccountId) };
  }

  return {
    identifiers: identifiers,
    body: {
      destinations: [destination],
      events: [event],
      encoding: 'HEX',
      validateOnly: data.validateOnly !== false
    }
  };
}

// Consentimiento: el campo de la plantilla manda; si está vacío se deduce del
// parámetro gcs que reenvía el cliente GA4 (G1 + ad_storage + analytics_storage).
// Si no se puede saber, no se envía.
function consentState(e) {
  var explicit = makeString(data.adUserData || '').trim().toLowerCase();
  if (explicit === 'granted' || explicit === 'true') return 'granted';
  if (explicit === 'denied' || explicit === 'false') return 'denied';
  var gcs = makeString(e['x-ga-gcs'] || '');
  if (gcs.length === 4 && gcs.substring(0, 2) === 'G1') {
    return gcs.substring(2, 3) === '1' ? 'granted' : 'denied';
  }
  return 'unknown';
}

function personalization(e) {
  var v = makeString(data.adPersonalization || '').trim().toLowerCase();
  return (v === 'granted' || v === 'true') ? 'CONSENT_GRANTED' : 'CONSENT_DENIED';
}

function adIdentifiers(e) {
  var keys = ['gclid', 'gbraid', 'wbraid'];
  var url = e.page_location ? parseUrl(makeString(e.page_location)) : undefined;
  var params = (url && url.searchParams) ? url.searchParams : {};
  for (var i = 0; i < keys.length; i++) {
    var v = e[keys[i]] || params[keys[i]];
    if (getType(v) === 'array') v = v[0];
    v = makeString(v || '').trim();
    if (v) {
      var out = {};
      out[keys[i]] = v;
      return out;
    }
  }
  return undefined;
}

// --- Datos de usuario: normalización y hash -----------------------------------

function userIdentifiers(ud) {
  var out = [];
  if (getType(ud) !== 'object') return out;

  var email = isSha256(ud.sha256_email_address) ? lower(ud.sha256_email_address) : hashOrNull(normalizeEmail(ud.email_address));
  if (email) out.push({ emailAddress: email });

  var phone = isSha256(ud.sha256_phone_number) ? lower(ud.sha256_phone_number) : hashOrNull(normalizePhone(ud.phone_number));
  if (phone) out.push({ phoneNumber: phone });

  var a = ud.address;
  if (getType(a) === 'array') a = a[0];
  if (getType(a) === 'object') {
    var given = isSha256(a.sha256_first_name) ? lower(a.sha256_first_name) : hashOrNull(normalizeName(a.first_name));
    var family = isSha256(a.sha256_last_name) ? lower(a.sha256_last_name) : hashOrNull(normalizeName(a.last_name));
    var region = makeString(a.country || '').trim().toUpperCase();
    var postal = makeString(a.postal_code || '').trim();
    // La API exige los cuatro campos de dirección o ninguno.
    if (given && family && region.length === 2 && postal) {
      out.push({ address: { givenName: given, familyName: family, regionCode: region, postalCode: postal } });
    }
  }
  return out;
}

function normalizeEmail(v) {
  var s = lower(v);
  var at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  var local = s.substring(0, at);
  var domain = s.substring(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    var plus = local.indexOf('+');
    if (plus !== -1) local = local.substring(0, plus);
    local = local.split('.').join('');
    if (!local) return '';
  }
  return local + '@' + domain;
}

// E.164: solo se acepta si trae prefijo internacional; sin él no se adivina el país.
function normalizePhone(v) {
  var s = makeString(v || '').trim();
  if (s.substring(0, 2) === '00') s = '+' + s.substring(2);
  if (s.substring(0, 1) !== '+') return '';
  var digits = '';
  for (var i = 1; i < s.length; i++) {
    var c = s.substring(i, i + 1);
    if (DIGITS.indexOf(c) !== -1) digits += c;
  }
  if (digits.length < 8 || digits.length > 15) return '';
  return '+' + digits;
}

function normalizeName(v) {
  return lower(v);
}

function hashOrNull(s) {
  return s ? sha256Sync(s, { outputEncoding: 'hex' }) : null;
}

function isSha256(v) {
  var s = lower(v);
  if (s.length !== 64) return false;
  for (var i = 0; i < 64; i++) {
    if (HEX.indexOf(s.substring(i, i + 1)) === -1) return false;
  }
  return true;
}

function lower(v) {
  return makeString(v === undefined || v === null ? '' : v).trim().toLowerCase();
}

function digitsOnly(v) {
  var s = makeString(v || '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.substring(i, i + 1);
    if (DIGITS.indexOf(c) !== -1) out += c;
  }
  return out;
}

// --- Fecha RFC 3339 en UTC sin Date (algoritmo civil_from_days) ----------------

// Una sola operación aritmética por sentencia, a propósito: en el editor de GTM
// (23 nov 2026) `doy - Math.floor(...) + 1` dio 21 donde Node da 23, es decir, el
// sandbox no evaluó la expresión como Node. Con un paso por línea no hay nada
// que interpretar. tests/sandbox.spec.js lo vigila y build.cjs añade escenarios
// con fechas fijas para comprobarlo en el propio editor.
function toRfc3339(ms) {
  var secs = Math.floor(ms / 1000);
  var days = Math.floor(secs / 86400);
  var dayStart = days * 86400;
  var rem = secs - dayStart;
  var h = Math.floor(rem / 3600);
  var hSecs = h * 3600;
  var remMin = rem - hSecs;
  var mi = Math.floor(remMin / 60);
  var miSecs = mi * 60;
  var s = remMin - miSecs;

  var z = days + 719468;
  var era = Math.floor(z / 146097);
  var eraDays = era * 146097;
  var doe = z - eraDays;
  var a = Math.floor(doe / 1460);
  var b = Math.floor(doe / 36524);
  var c = Math.floor(doe / 146096);
  var yoeNum = doe - a;
  yoeNum = yoeNum + b;
  yoeNum = yoeNum - c;
  var yoe = Math.floor(yoeNum / 365);
  var y = era * 400;
  y = y + yoe;
  var yearDays = yoe * 365;
  var leap4 = Math.floor(yoe / 4);
  var leap100 = Math.floor(yoe / 100);
  yearDays = yearDays + leap4;
  yearDays = yearDays - leap100;
  var doy = doe - yearDays;
  var mpNum = doy * 5;
  mpNum = mpNum + 2;
  var mp = Math.floor(mpNum / 153);
  var monthDays = mp * 153;
  monthDays = monthDays + 2;
  monthDays = Math.floor(monthDays / 5);
  var d = doy - monthDays;
  d = d + 1;
  var m = mp + 3;
  if (mp > 9) m = mp - 9;
  if (m < 3) y = y + 1;
  return y + '-' + pad(m) + '-' + pad(d) + 'T' + pad(h) + ':' + pad(mi) + ':' + pad(s) + 'Z';
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function log(o) {
  logToConsole(JSON.stringify(o));
}
