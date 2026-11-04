'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate } = require('../src/webshare');
const { classifyError } = require('../src/viewer');

test('username templates', () => {
  const t = '{user}[-{country}]-rotate';
  assert.equal(renderTemplate(t, { user: 'abc', country: '' }), 'abc-rotate');
  assert.equal(renderTemplate(t, { user: 'abc', country: 'US' }), 'abc-US-rotate');
  assert.equal(renderTemplate('{user}[-{country}]-{session}', { user: 'abc', country: 'DE', session: '42' }), 'abc-DE-42');
  assert.equal(renderTemplate('{user}[-country-{country}][-session-{session}]', { user: 'abc', session: '9' }), 'abc-session-9');
});

test('error classification', () => {
  assert.equal(classifyError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED at x')).retry, true);
  assert.equal(classifyError(new Error('page.goto: Timeout 45000ms exceeded.')).code, 'TIMEOUT');
  assert.equal(classifyError(new Error('net::ERR_INVALID_AUTH_CREDENTIALS')).retry, false);
  assert.equal(classifyError(new Error('net::ERR_NAME_NOT_RESOLVED')).code, 'DNS');
});
