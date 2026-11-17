import { setupI18n } from '@lingui/core';
import { RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { revalleInviteReplyTo, revalleInviteSubject, revalleReminderSubject } from './invite-email';

// Catálogo vazio: o texto sai do próprio msgid (já em pt-BR).
const i18n = setupI18n({ locale: 'pt-BR', messages: { 'pt-BR': {} } });

const subject = (input: Parameters<typeof revalleInviteSubject>[0]) => i18n._(revalleInviteSubject(input));

describe('revalleInviteSubject', () => {
  it('usa o nome de quem enviou e o verbo do papel', () => {
    const base = { senderName: 'Ana Souza', teamName: 'Revalle', documentTitle: 'Contrato 12' };

    expect(subject({ ...base, role: RecipientRole.SIGNER })).toBe('Ana Souza enviou "Contrato 12" para você assinar');
    expect(subject({ ...base, role: RecipientRole.APPROVER })).toBe('Ana Souza enviou "Contrato 12" para você aprovar');
    expect(subject({ ...base, role: RecipientRole.VIEWER })).toBe('Ana Souza enviou "Contrato 12" para você ver');
    expect(subject({ ...base, role: RecipientRole.ASSISTANT })).toBe(
      'Ana Souza enviou "Contrato 12" para você preencher',
    );
  });

  it('sem o nome de quem enviou, usa o nome do time', () => {
    for (const senderName of [null, undefined, '', '   ']) {
      expect(subject({ role: RecipientRole.SIGNER, senderName, teamName: 'Revalle', documentTitle: 'X' })).toBe(
        'Revalle enviou "X" para você assinar',
      );
    }
  });
});

describe('revalleInviteReplyTo', () => {
  it('o configurado vale; sem ele, o e-mail de quem enviou', () => {
    expect(revalleInviteReplyTo('resposta@revalle.com.br', 'dono@revalle.com.br')).toBe('resposta@revalle.com.br');
    expect(revalleInviteReplyTo(undefined, 'dono@revalle.com.br')).toBe('dono@revalle.com.br');
    expect(revalleInviteReplyTo('', 'dono@revalle.com.br')).toBe('dono@revalle.com.br');
    expect(revalleInviteReplyTo(null, '')).toBeUndefined();
  });
});

describe('revalleReminderSubject', () => {
  it('põe "Lembrete: " antes do assunto', () => {
    expect(i18n._(revalleReminderSubject('Ana enviou "X" para você assinar'))).toBe(
      'Lembrete: Ana enviou "X" para você assinar',
    );
  });
});
