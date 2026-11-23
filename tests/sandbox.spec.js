import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

// El editor de plantillas de GTM ejecuta un subconjunto de ES5 y rechaza el
// resto al guardar. Este test comprueba sobre el AST del código y sobre el
// template.tpl generado lo que se sabe que el sandbox no admite, y que lo que
// la plantilla usa está declarado como parámetro y como permiso.
// Reglas tomadas de la documentación de JavaScript con sandbox de GTM; el
// editor real sigue siendo la prueba definitiva (ver README).

const source = readFileSync(new URL('../src/datamanager_tag.js', import.meta.url), 'utf8');
const tpl = readFileSync(new URL('../template.tpl', import.meta.url), 'utf8');

function section(name) {
  const m = tpl.split(/^___([A-Z_]+)___$/m);
  const i = m.indexOf(name);
  return i === -1 ? null : m[i + 1].trim();
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

// ecmaVersion 5 ya rechaza flechas, let/const, plantillas, clases y desestructuración.
const ast = acorn.parse(source, { ecmaVersion: 5, locations: true });

test('es ES5 válido (sin flechas, let/const, plantillas ni clases)', () => {
  expect(ast.type).toBe('Program');
});

test('no usa construcciones que el sandbox no admite', () => {
  const found = [];
  walk(ast, (n) => {
    const at = `línea ${n.loc.start.line}`;
    if (n.type === 'Literal' && n.regex) found.push(`${at}: expresión regular`);
    if (n.type === 'NewExpression') found.push(`${at}: new`);
    if (n.type === 'ThisExpression') found.push(`${at}: this`);
    if (n.type === 'TryStatement') found.push(`${at}: try/catch`);
    if (n.type === 'ForInStatement') found.push(`${at}: for...in`);
    if (n.type === 'WithStatement') found.push(`${at}: with`);
    if (n.type === 'ThrowStatement') found.push(`${at}: throw`);
    if (n.type === 'UpdateExpression' && n.operator === '--') return;
  });
  expect(found).toEqual([]);
});

test('no toca globales del navegador ni de Node: todo viene de require() o de data', () => {
  // Identificadores libres = usados pero no declarados (var, función, parámetro).
  const declared = new Set(['data', 'require', 'undefined', 'NaN']);
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator') declared.add(n.id.name);
    if (n.type === 'FunctionDeclaration') {
      declared.add(n.id.name);
      n.params.forEach((p) => declared.add(p.name));
    }
    if (n.type === 'FunctionExpression') n.params.forEach((p) => declared.add(p.name));
  });
  const free = new Set();
  walk(ast, (n, parent) => {
    if (n.type !== 'Identifier' || declared.has(n.name)) return;
    const isProp = parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed;
    const isKey = parent && parent.type === 'Property' && parent.key === n;
    if (!isProp && !isKey) free.add(n.name);
  });
  expect([...free]).toEqual([]);
});

test('cada require() es una API que el sandbox de servidor ofrece', () => {
  const allowed = new Set([
    'getAllEventData', 'sendHttpRequest', 'getGoogleAuth', 'sha256Sync', 'parseUrl', 'getTimestampMillis',
    'makeString', 'makeNumber', 'getType', 'logToConsole', 'JSON', 'Math', 'BigQuery',
  ]);
  const used = [];
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.name === 'require') used.push(n.arguments[0].value);
  });
  expect(used.length).toBeGreaterThan(0);
  expect(used.filter((u) => !allowed.has(u))).toEqual([]);
});

test('cada API que necesita permiso lo tiene declarado en el template.tpl', () => {
  const needs = {
    getAllEventData: 'read_event_data',
    sendHttpRequest: 'send_http',
    getGoogleAuth: 'use_google_credentials',
    logToConsole: 'logging',
    BigQuery: 'access_bigquery',
  };
  const used = [];
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.name === 'require') used.push(n.arguments[0].value);
  });
  const perms = JSON.parse(section('SERVER_PERMISSIONS')).map((p) => p.instance.key.publicId);
  const missing = used.filter((u) => needs[u] && !perms.includes(needs[u])).map((u) => needs[u]);
  expect(missing).toEqual([]);
  // Y no hay permisos de más: cada uno se usa.
  const usedPerms = used.map((u) => needs[u]).filter(Boolean);
  expect(perms.filter((p) => !usedPerms.includes(p))).toEqual([]);
});

test('el permiso de red solo permite el endpoint de la Data Manager API y el scope pedido', () => {
  const perms = JSON.parse(section('SERVER_PERMISSIONS'));
  const get = (id, key) => perms.find((p) => p.instance.key.publicId === id).instance.param.find((x) => x.key === key).value;
  expect(get('send_http', 'urls').listItem.map((i) => i.string)).toEqual(['https://datamanager.googleapis.com/v1/events:ingest']);
  expect(get('use_google_credentials', 'allowedScopes').listItem.map((i) => i.string)).toEqual(['https://www.googleapis.com/auth/datamanager']);
  // El código usa exactamente esa URL y ese scope.
  expect(source).toContain("'https://datamanager.googleapis.com/v1/events:ingest'");
  expect(source).toContain("'https://www.googleapis.com/auth/datamanager'");
});

test('cada data.X que lee el código es un parámetro de la plantilla (sin erratas)', () => {
  const used = new Set();
  walk(ast, (n) => {
    if (n.type === 'MemberExpression' && n.object.name === 'data' && !n.computed) used.add(n.property.name);
  });
  const names = new Set();
  (function collect(list) {
    for (const p of list) {
      if (p.name) names.add(p.name);
      if (p.subParams) collect(p.subParams);
    }
  })(JSON.parse(section('TEMPLATE_PARAMETERS')));
  const internal = new Set(['gtmOnSuccess', 'gtmOnFailure']);
  const unknown = [...used].filter((u) => !names.has(u) && !internal.has(u));
  expect(unknown).toEqual([]);
  // Y ningún parámetro declarado queda sin usar.
  expect([...names].filter((n) => !used.has(n) && n !== 'bqGroup')).toEqual([]);
});

// En el editor de GTM, `doy - Math.floor(...) + 1` dio 2 días menos que en Node
// (23 nov 2026). toRfc3339 se escribe con una operación +/- por sentencia y este
// test impide volver a encadenarlas allí.
test('toRfc3339 no encadena sumas y restas en una misma expresión', () => {
  const chained = [];
  walk(ast, (fn) => {
    if (fn.type !== 'FunctionDeclaration' || fn.id.name !== 'toRfc3339') return;
    walk(fn.body, (n, parent) => {
      if (n.type !== 'BinaryExpression' || !'+-'.includes(n.operator)) return;
      if (parent && parent.type === 'BinaryExpression' && '+-'.includes(parent.operator)) {
        // La concatenación de cadenas del return es la única excepción.
        let inReturn = false;
        walk(fn.body, (r) => { if (r.type === 'ReturnStatement' && r.start <= n.start && n.end <= r.end) inReturn = true; });
        if (!inReturn) chained.push(`línea ${n.loc.start.line}`);
      }
    });
  });
  expect(chained).toEqual([]);
});

// Límites que el editor de GTM aplica al importar y que se descubrieron al hacerlo
// (23 nov 2026): la descripción admite 200 caracteres y los nombres de los
// escenarios de prueba no admiten : . , @ % entre otros.
test('límites del editor: descripción de 200 caracteres y nombres de prueba sin caracteres inválidos', () => {
  expect(JSON.parse(section('INFO')).description.length).toBeLessThanOrEqual(200);
  const names = [...section('TESTS').matchAll(/^- name: (".*")$/gm)].map((m) => JSON.parse(m[1]));
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => /[:.,@%]/.test(n))).toEqual([]);
});

test('el template.tpl lleva el código fuente actual y secciones válidas', () => {
  expect(section('SANDBOXED_JS_FOR_SERVER')).toBe(source.trimEnd());
  expect(JSON.parse(section('INFO')).containerContexts).toEqual(['SERVER']);
  expect(() => JSON.parse(section('TEMPLATE_PARAMETERS'))).not.toThrow();
  expect(section('TESTS')).toContain('scenarios:');
});
