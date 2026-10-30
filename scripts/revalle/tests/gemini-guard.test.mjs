// Guarda dos testes contra chamadas pagas ao Gemini (helpers.mjs): teste puro, não precisa da stack.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAKE_GEMINI_BASE_URL, paidGeminiGuardMessage } from './helpers.mjs';

test('sem chave no app: segue', () => {
  assert.equal(paidGeminiGuardMessage({ apiKey: '', baseUrl: '' }), null);
  assert.equal(paidGeminiGuardMessage({ apiKey: '  ', baseUrl: 'https://x' }), null);
});

test('chave no app apontando para o servidor falso: segue', () => {
  assert.equal(paidGeminiGuardMessage({ apiKey: 'test-key', baseUrl: FAKE_GEMINI_BASE_URL }), null);
});

test('chave no app sem o servidor falso: para, com a explicação', () => {
  for (const baseUrl of ['', 'https://generativelanguage.googleapis.com/v1beta', 'http://fake-gemini:8787']) {
    const message = paidGeminiGuardMessage({ apiKey: 'chave-real', baseUrl });

    assert.ok(message, baseUrl);
    assert.match(message, /GEMINI_API_KEY/);
    assert.match(message, /REVALLE_TEST_GEMINI_API_KEY/);
    assert.match(message, /compose\.test\.yml/);
    assert.ok(!message.includes('chave-real'), 'a mensagem não pode mostrar a chave');
  }
});

test('a guarda não tem exceção: chave + endereço do Google sempre para', () => {
  assert.equal(paidGeminiGuardMessage.length, 1);
  assert.ok(
    paidGeminiGuardMessage({ apiKey: 'chave-real', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
  );
});
