import { RevalleFinanceAccountChangedTemplate } from '@documenso/email/templates/revalle-finance-account-changed';
import { prisma } from '@documenso/prisma';
import { RevalleFinanceStatus } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { normalizeEmail } from '../../../revalle/email-domain';
import { buildAccountChangeNotice, formatInvoiceAccount } from '../../../revalle/finance/account-change';
import { invoiceViewPath } from '../../../revalle/finance/finance-status';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendFinanceAccountChangedEmailJobDefinition } from './revalle-send-finance-account-changed-email';

export const buildAccountChangedSubject = (title: string) =>
  `Conta contábil da nota fiscal alterada pelo Financeiro: ${title}`;

const DEFER_LABEL = 'a definir pelo Financeiro';

/**
 * Um e-mail por pessoa (sem expor os endereços dos outros): o dono e todos os destinatários das duas versões, sem
 * repetir e-mail. Cada envio é uma tarefa do job: no retry, quem já recebeu não recebe de novo. A versão antiga
 * pendente está excluída (escondida das listas) e é lida mesmo assim.
 */
export const run = async ({
  payload,
  io,
}: {
  payload: TRevalleSendFinanceAccountChangedEmailJobDefinition;
  io: JobRunIO;
}) => {
  const { oldEnvelopeId, newEnvelopeId } = payload;

  const select = {
    title: true,
    teamId: true,
    documentMeta: true,
    user: { select: { name: true, email: true } },
    recipients: { select: { name: true, email: true } },
    revalleInvoice: {
      select: {
        financeStatus: true,
        choiceCode: true,
        choiceDefer: true,
        supersedeReason: true,
        supersededByEnvelopeId: true,
      },
    },
  } as const;

  const [previous, next] = await Promise.all([
    prisma.envelope.findUnique({ where: { id: oldEnvelopeId }, select }),
    prisma.envelope.findUnique({ where: { id: newEnvelopeId }, select }),
  ]);

  const previousRow = previous?.revalleInvoice;
  const nextCode = next?.revalleInvoice?.choiceCode;

  if (
    !previous ||
    !next ||
    !nextCode ||
    previousRow?.financeStatus !== RevalleFinanceStatus.SUPERSEDED ||
    previousRow.supersededByEnvelopeId !== newEnvelopeId ||
    !previousRow.supersedeReason
  ) {
    io.logger.warn({
      msg: 'Troca de conta sem as duas versões ligadas; aviso não enviado',
      oldEnvelopeId,
      newEnvelopeId,
    });

    return;
  }

  const codes = [previousRow.choiceCode, nextCode].filter((code): code is string => Boolean(code));
  const names = new Map(
    (
      await prisma.revalleAccountingAccount.findMany({
        where: { code: { in: codes } },
        select: { code: true, name: true },
      })
    ).map((account) => [account.code, account.name]),
  );

  const notice = buildAccountChangeNotice({
    title: previous.title,
    from:
      previousRow.choiceCode && !previousRow.choiceDefer
        ? formatInvoiceAccount(previousRow.choiceCode, names.get(previousRow.choiceCode))
        : DEFER_LABEL,
    to: formatInvoiceAccount(nextCode, names.get(nextCode)),
    reason: previousRow.supersedeReason,
  });

  const people = new Map<string, string>();

  for (const person of [previous.user, ...previous.recipients, ...next.recipients]) {
    const email = normalizeEmail(person.email);

    if (email && !people.has(email)) {
      people.set(email, person.name ?? '');
    }
  }

  // E-mail interno: sai mesmo com os e-mails do documento desligados (quem assina precisa saber que a versão mudou).
  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: previous.teamId },
    meta: previous.documentMeta,
  });

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  const template = createElement(RevalleFinanceAccountChangedTemplate, {
    documentName: previous.title,
    newDocumentName: next.title,
    notice,
    // A página da nova versão (só leitura): remetente e destinatários das duas versões abrem.
    invoiceUrl: `${assetBaseUrl}${invoiceViewPath(newEnvelopeId)}`,
    assetBaseUrl,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  for (const [address, name] of people) {
    await io.runTask(`send-account-changed-${address}`, async () => {
      await emailTransport.sendMail({
        to: { name, address },
        from: senderEmail,
        subject: buildAccountChangedSubject(previous.title),
        html,
        text,
      });
    });
  }
};
