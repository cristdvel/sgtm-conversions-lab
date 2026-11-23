// Genera template.tpl (importable en GTM, contenedor de servidor) a partir de
// src/datamanager_tag.js. Uso: node build.cjs
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, 'src', 'datamanager_tag.js'), 'utf8').trimEnd();

const info = {
  type: 'TAG',
  id: 'cvt_datamanager_conversions',
  version: 1,
  securityGroups: [],
  displayName: 'Google Ads conversions (Data Manager API)',
  categories: ['ADVERTISING', 'CONVERSIONS'],
  brand: { id: 'cristdvel', displayName: 'Cristhian Velásquez' },
  description:
    'Envía conversiones web a Google Ads por la Data Manager API con deduplicación por ' +
    'transaction_id, datos de usuario con hash y sin envío si no hay consentimiento. Arranca en validación.',
  containerContexts: ['SERVER'],
};

const params = [
  {
    type: 'TEXT', name: 'operatingAccountId', displayName: 'ID de cliente de Google Ads',
    simpleValueType: true, valueValidators: [{ type: 'NON_EMPTY' }],
    help: 'La cuenta donde está la acción de conversión. Se admite con o sin guiones.',
  },
  {
    type: 'TEXT', name: 'loginAccountId', displayName: 'ID de la cuenta de administrador (opcional)',
    simpleValueType: true,
    help: 'Solo si el acceso se concede a través de una cuenta de administrador (MCC).',
  },
  {
    type: 'TEXT', name: 'conversionActionId', displayName: 'ID de la acción de conversión',
    simpleValueType: true, valueValidators: [{ type: 'NON_EMPTY' }],
    help: 'Acción de tipo Sitio web. Debe ser la misma que usa la etiqueta del navegador para que ' +
      'Google deduplique por transaction_id.',
  },
  {
    type: 'TEXT', name: 'adUserData', displayName: 'Consentimiento ad_user_data (granted / denied)',
    simpleValueType: true,
    help: 'Vacío: se deduce de ad_storage en el parámetro gcs. Si no se puede saber, no se envía.',
  },
  {
    type: 'TEXT', name: 'adPersonalization', displayName: 'Consentimiento ad_personalization (granted / denied)',
    simpleValueType: true, help: 'Vacío equivale a denegado.',
  },
  {
    type: 'CHECKBOX', name: 'validateOnly', checkboxText: 'Solo validar (validateOnly): no registra conversiones',
    simpleValueType: true, defaultValue: true,
  },
  {
    type: 'GROUP', name: 'bqGroup', displayName: 'Registro en BigQuery (opcional)', groupStyle: 'ZIPPY_CLOSED',
    subParams: [
      { type: 'TEXT', name: 'bqProjectId', displayName: 'Proyecto', simpleValueType: true },
      { type: 'TEXT', name: 'bqDatasetId', displayName: 'Dataset', simpleValueType: true },
      { type: 'TEXT', name: 'bqTableId', displayName: 'Tabla', simpleValueType: true,
        help: 'Una fila por decisión (enviado o no y por qué), sin datos personales. Esquema en sql/decisions.sql.' },
    ],
  },
];

const permission = (publicId, param) => ({
  instance: { key: { publicId, versionId: '1' }, param },
  clientAnnotations: { isEditedByUser: true },
  isRequired: true,
});
const str = (s) => ({ type: 1, string: s });
const list = (items) => ({ type: 2, listItem: items.map(str) });

const permissions = [
  permission('read_event_data', [{ key: 'eventDataAccess', value: str('any') }]),
  permission('send_http', [
    { key: 'allowedUrls', value: str('specific') },
    { key: 'urls', value: list(['https://datamanager.googleapis.com/v1/events:ingest']) },
  ]),
  permission('use_google_credentials', [
    { key: 'allowedScopes', value: list(['https://www.googleapis.com/auth/datamanager']) },
  ]),
  permission('logging', [{ key: 'environments', value: str('debug') }]),
  // Comodines: se ajustan a la tabla real en el editor al importar.
  permission('access_bigquery', [
    { key: 'allowedTables', value: { type: 2, listItem: [{
      type: 3,
      mapKey: [str('projectId'), str('datasetId'), str('tableId'), str('operation')],
      mapValue: [str('*'), str('*'), str('*'), str('write')],
    }] } },
  ]),
];

const base = {
  event_name: 'purchase', transaction_id: 'T-1001', value: 59.9, currency: 'EUR',
  'x-ga-gcs': 'G111', page_location: 'https://tienda.example/gracias?gclid=CjwKCAtest',
};
const fields = { operatingAccountId: '123-456-7890', conversionActionId: '987654321', validateOnly: true };

const scenarios = [
  ['Con consentimiento y gclid llama a la API', base, true],
  ['Con ad_storage denegado no llama a la API', Object.assign({}, base, { 'x-ga-gcs': 'G101' }), false],
  ['Sin transaction_id no llama a la API', Object.assign({}, base, { transaction_id: '' }), false],
  ['Sin identificadores no llama a la API', Object.assign({}, base, { page_location: 'https://tienda.example/gracias' }), false],
];

const q = (v) => JSON.stringify(v);
const scenario = ([name, ev, called]) => [
  '- name: ' + q(name),
  '  code: |-',
  '    const Promise = require(\'Promise\');',
  '    mock(\'getAllEventData\', ' + q(ev) + ');',
  '    mock(\'getGoogleAuth\', {});',
  '    mock(\'sendHttpRequest\', function () {',
  '      return Promise.create(function (resolve) { resolve({ statusCode: 200, body: \'{}\' }); });',
  '    });',
  '    runCode(' + q(fields) + ');',
  '    assertApi(\'sendHttpRequest\').' + (called ? 'wasCalled' : 'wasNotCalled') + '();',
  called ? '' : '    assertApi(\'gtmOnSuccess\').wasCalled();',
].filter(Boolean).join('\n');

// Fechas fijas: el sandbox de GTM no evaluó una expresión aritmética como Node
// (ver el comentario de toRfc3339), así que la fecha se comprueba en el propio
// editor con el reloj simulado. El resultado esperado sale de Date en Node.
const dateCases = [
  ['Fecha del dia del fallo del sandbox', Date.UTC(2026, 10, 23, 9, 57, 53)],
  ['Fecha en dia bisiesto', Date.UTC(2028, 1, 29, 23, 59, 59)],
  ['Fecha en fin de ano', Date.UTC(2026, 11, 31, 0, 0, 0)],
  ['Fecha en marzo', Date.UTC(2026, 2, 1, 0, 0, 0)],
  ['Fecha en enero', Date.UTC(2000, 0, 1, 12, 30, 5)],
].map(([name, ms]) => ({ name, ms, iso: new Date(ms).toISOString().replace('.000Z', 'Z') }));

const dateScenario = (c) => [
  '- name: ' + q(c.name),
  '  code: |-',
  '    const Promise = require(\'Promise\');',
  '    const JSON = require(\'JSON\');',
  '    mock(\'getAllEventData\', ' + q(base) + ');',
  '    mock(\'getGoogleAuth\', {});',
  '    mock(\'getTimestampMillis\', ' + c.ms + ');',
  '    mock(\'sendHttpRequest\', function (url, options, body) {',
  '      assertThat(JSON.parse(body).events[0].eventTimestamp).isEqualTo(' + q(c.iso) + ');',
  '      return Promise.create(function (resolve) { resolve({ statusCode: 200, body: \'{}\' }); });',
  '    });',
  '    runCode(' + q(fields) + ');',
  '    assertApi(\'sendHttpRequest\').wasCalled();',
].join('\n');

const out = [
  '___INFO___', '', JSON.stringify(info, null, 2), '',
  '___TEMPLATE_PARAMETERS___', '', JSON.stringify(params, null, 2), '',
  '___SANDBOXED_JS_FOR_SERVER___', '', code, '',
  '___SERVER_PERMISSIONS___', '', JSON.stringify(permissions, null, 2), '',
  '___TESTS___', '', 'scenarios:', scenarios.map(scenario).concat(dateCases.map(dateScenario)).join('\n'), '',
  '___NOTES___', '', 'Generado con build.cjs a partir de src/datamanager_tag.js.', '',
].join('\n');

fs.writeFileSync(path.join(__dirname, 'template.tpl'), out);
console.log('template.tpl generado (' + (scenarios.length + dateCases.length) + ' escenarios de prueba)');
