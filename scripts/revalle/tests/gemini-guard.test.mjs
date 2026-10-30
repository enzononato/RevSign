// Guarda dos testes contra chamadas pagas ao Gemini (helpers.mjs): teste puro, não precisa da stack.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAKE_GEMINI_BASE_URL, paidGeminiGuardMessage } from './helpers.mjs';

test('sem chave no app: segue', () => {
  assert.equal(paidGeminiGuardMessage({ apiKey: '', baseUrl: '', optIn: '' }), null);
  assert.equal(paidGeminiGuardMessage({ apiKey: '  ', baseUrl: 'https://x', optIn: '' }), null);
});

test('chave no app apontando para o servidor falso: segue', () => {
  assert.equal(paidGeminiGuardMessage({ apiKey: 'test-key', baseUrl: FAKE_GEMINI_BASE_URL, optIn: '' }), null);
});

test('chave no app sem o servidor falso: para, com a explicação', () => {
  for (const baseUrl of ['', 'https://generativelanguage.googleapis.com/v1beta', 'http://fake-gemini:8787']) {
    const message = paidGeminiGuardMessage({ apiKey: 'chave-real', baseUrl, optIn: '' });

    assert.ok(message, baseUrl);
    assert.match(message, /GEMINI_API_KEY/);
    assert.match(message, /REVALLE_TEST_GEMINI_API_KEY/);
    assert.match(message, /compose\.test\.yml/);
    assert.ok(!message.includes('chave-real'), 'a mensagem não pode mostrar a chave');
  }
});

test('REVALLE_TEST_GEMINI_API_KEY definida: segue (chamada paga aceita de propósito)', () => {
  assert.equal(paidGeminiGuardMessage({ apiKey: 'chave-real', baseUrl: '', optIn: 'x' }), null);
});
