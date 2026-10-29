// pt-BR como idioma padrão da interface e dos e-mails (Task 1, Fase 2). Sem mocks: usa o app e o Mailpit.
// O cookie `lang` sempre vence; sem cookie, a página sai em pt-BR mesmo com Accept-Language em inglês.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BASE_URL, latestMail } from './helpers.mjs';

const htmlLang = (html) => html.match(/<html[^>]*\slang="([^"]*)"/)?.[1];

const getSignin = async (headers) => {
  const res = await fetch(`${BASE_URL}/signin`, { headers });

  assert.equal(res.status, 200);

  return res.text();
};

test('sem cookie, /signin sai em pt-BR mesmo com Accept-Language em inglês', async () => {
  assert.equal(htmlLang(await getSignin({ 'Accept-Language': 'en-US' })), 'pt-BR');
  assert.equal(htmlLang(await getSignin({})), 'pt-BR');
});

// O cookie é gravado pelo seletor de idioma (POST /api/locale), no formato do app (valor codificado).
const langCookie = async (lang) => {
  const res = await fetch(`${BASE_URL}/api/locale`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin },
    body: new URLSearchParams({ lang }),
  });

  assert.equal(res.status, 200);

  return res.headers.getSetCookie()[0].split(';')[0];
};

test('o cookie lang continua mandando (troca manual de idioma)', async () => {
  assert.equal(htmlLang(await getSignin({ Cookie: await langCookie('en'), 'Accept-Language': 'pt-BR' })), 'en');
  assert.equal(htmlLang(await getSignin({ Cookie: await langCookie('de'), 'Accept-Language': 'en-US' })), 'de');
  assert.equal(htmlLang(await getSignin({ Cookie: await langCookie('pt-BR'), 'Accept-Language': 'en-US' })), 'pt-BR');
});

test('o e-mail de confirmação do cadastro sai com o catálogo pt-BR', async () => {
  const email = `locale-${randomUUID().slice(0, 8)}@revalle.com.br`;
  const origin = new URL(BASE_URL).origin;

  const res = await fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.21' },
    body: JSON.stringify({ name: 'Teste Locale', email, password: 'Senha-Forte-123!' }),
  });

  assert.ok(res.ok, `cadastro falhou (${res.status}): ${await res.text()}`);

  let mail;

  for (let i = 0; i < 20 && !mail; i++) {
    mail = await latestMail(email);
    mail ?? (await new Promise((resolve) => setTimeout(resolve, 500)));
  }

  assert.ok(mail, 'e-mail de confirmação não chegou ao Mailpit');
  assert.equal(mail.Subject, 'Por favor, confirme seu e-mail');
  assert.ok(!mail.Subject.includes('Please confirm'));
  // O corpo (HTML) também vem do catálogo pt-BR do upstream: botão e título já estão traduzidos lá.
  assert.ok(mail.HTML.includes('Confirmar e-mail'), 'botão do corpo não está em português');
  assert.ok(!mail.HTML.includes('Confirm email'), 'corpo ainda em inglês');
  // TODO(F2 Task 2): se alguma frase do corpo ficar sem msgstr no upstream, a sobreposição de tradução a habilita aqui.
});
