// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, POLL, PULSE, SCENE_ACTIONS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, one version everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(pkg.name, 'gladys-global-cache');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-global-cache:${manifest.version}`);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.categories.every((c) => CATEGORIES.includes(c)));
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Global|sans\s+lien\s+avec\s+Global/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+été\s+testée\s+avec\s+un\s+vrai\s+appareil/i,
    );
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no network capture, no extra container, no webhook, no widget, no trigger', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.webhooks, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.equal(manifest.scene_triggers, undefined);
});

test('the configuration matches the code; relays are off; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.ok(manifest.config_schema.every((f) => f.type !== 'secret' && f.type !== 'password'));
  assert.ok(manifest.config_schema.every((f) => !f.key.toLowerCase().startsWith('gladys_')));
  assert.equal(fields.allow_relays.default, false);
  assert.equal(fields.allow_relays.type, 'boolean');
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL.min, POLL.max, POLL.default],
  );
  assert.deepEqual(
    [fields.pulse_ms.min, fields.pulse_ms.max, fields.pulse_ms.default],
    [PULSE.min, PULSE.max, PULSE.default],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('option labels follow the rules of the core (plain text, trimmed, unique values)', () => {
  const selects = [
    ...manifest.config_schema,
    ...manifest.actions.flatMap((a) => a.fields ?? []),
    ...manifest.scene_actions.flatMap((a) => a.fields ?? []),
  ].filter((f) => f.options);
  for (const field of selects) {
    for (const option of field.options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
      for (const lang of ['en', 'fr']) {
        assert.equal(typeof option.label[lang], 'string');
        assert.equal(option.label[lang], option.label[lang].trim());
        assert.ok(option.label[lang]);
      }
    }
    assert.equal(new Set(field.options.map((o) => o.value)).size, field.options.length);
  }
});

test('the actions and scene actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  const scene = manifest.scene_actions[0];
  assert.deepEqual(
    scene.outputs.map((o) => o.key),
    ['confirmed'],
  );
  assert.ok(scene.timeout_seconds * 1000 > 12_000 + 1000);
  assert.ok(
    manifest.actions.find((a) => a.key === 'send_ir').timeout_seconds * 1000 > 12_000 + 1000,
  );
});
