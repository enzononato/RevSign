import { RevalleFinanceAccountChangedTemplate } from '@documenso/email/templates/revalle-finance-account-changed';
import { prisma } from '@documenso/prisma';
import { RecipientRole, RevalleFinanceStatus, RevalleSupersedeKind } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { normalizeEmail } from '../../../revalle/email-domain';
import {
  buildVersionChangeNotice,
  formatInvoiceAccount,
  type VersionChangeDocument,
} from '../../../revalle/finance/account-change';
import { invoiceViewPath } from '../../../revalle/finance/finance-status';
import { invoicePositions } from '../../../revalle/invoice/invoice-files';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { loadInvoiceFiles } from '../../../server-only/revalle/invoice/invoice-files';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendFinanceAccountChangedEmailJobDefinition } from './revalle-send-finance-account-changed-email';

export const buildAccountChangedSubject = (title: string, kind: RevalleSupersedeKind = RevalleSupersedeKind.ACCOUNT) =>
  kind === RevalleSupersedeKind.COST_CENTER
    ? `Centro de custo da nota fiscal corrigido pela Contabilidade: ${title}`
    : `Conta contábil da nota fiscal alterada pelo Financeiro: ${title}`;

type NoticeAction = 'SIGN' | 'VIEW' | 'VERIFY';

/**
 * Um e-mail por pessoa (sem expor os endereços dos outros): o dono e todos os destinatários das duas versões, sem
 * repetir e-mail. Cada envio é uma tarefa do job: no retry, quem já recebeu não recebe de novo. A versão antiga
 * pendente está excluída (escondida das listas) e é lida mesmo assim. Sai depois do envio da nova versão.
 *
 * O botão de cada pessoa leva aonde ela entra sem conta no RevSign: quem age na nova versão, ao próprio link de
 * assinatura dela; o dono (usuário interno), à página da NF; os demais (cópia, quem saiu da nova versão), ao /verificar.
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
    recipients: { select: { name: true, email: true, role: true, token: true } },
    revalleInvoice: {
      select: {
        financeStatus: true,
        choiceCode: true,
        costCenterCode: true,
        supersedeKind: true,
        supersedeReason: true,
        supersededByEnvelopeId: true,
        supersededEnvelopeItemId: true,
      },
    },
  } as const;

  const [previous, next] = await Promise.all([
    prisma.envelope.findUnique({ where: { id: oldEnvelopeId }, select }),
    prisma.envelope.findUnique({ where: { id: newEnvelopeId }, select }),
  ]);

  const previousRow = previous?.revalleInvoice;
  const kind = previousRow?.supersedeKind ?? RevalleSupersedeKind.ACCOUNT;
  const isCostCenter = kind === RevalleSupersedeKind.COST_CENTER;
  // Fase 9: com 2+ notas, o que mudou é a nota marcada na versão antiga (`supersededEnvelopeItemId`) e a nota da mesma
  // posição na nova; com uma, a linha do envio (o espelho da nota única), como antes.
  const changedNote = previousRow?.supersededEnvelopeItemId
    ? await loadChangedNote(oldEnvelopeId, newEnvelopeId, previousRow.supersededEnvelopeItemId)
    : null;
  const fromNote = changedNote?.previous ?? previousRow;
  const nextNote = changedNote ? changedNote.next : next?.revalleInvoice;
  const nextCode = isCostCenter ? nextNote?.costCenterCode : nextNote?.choiceCode;

  if (
    !previous ||
    !next ||
    !nextCode ||
    previousRow?.financeStatus !== RevalleFinanceStatus.SUPERSEDED ||
    previousRow.supersededByEnvelopeId !== newEnvelopeId ||
    !previousRow.supersedeReason
  ) {
    io.logger.warn({
      msg: 'Nova versão sem as duas versões ligadas; aviso não enviado',
      oldEnvelopeId,
      newEnvelopeId,
    });

    return;
  }

  const buildAccountLine = async () => {
    const codes = [fromNote?.choiceCode, nextCode].filter((code): code is string => Boolean(code));
    const names = new Map(
      (
        await prisma.revalleAccountingAccount.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        })
      ).map((account) => [account.code, account.name]),
    );

    return {
      kind: 'ACCOUNT',
      title: previous.title,
      from: fromNote?.choiceCode ? formatInvoiceAccount(fromNote.choiceCode, names.get(fromNote.choiceCode)) : null,
      to: formatInvoiceAccount(nextCode, names.get(nextCode)),
    } as const;
  };

  const document = changedNote ? { document: changedNote.document } : {};
  const notice = buildVersionChangeNotice(
    isCostCenter
      ? { kind: 'COST_CENTER', fromCode: fromNote?.costCenterCode ?? '', toCode: nextCode, ...document }
      : { ...(await buildAccountLine()), ...document },
    previousRow.supersedeReason,
  );

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
  const ownerEmail = normalizeEmail(previous.user.email);
  const people = new Map<string, { name: string; action: NoticeAction; url: string }>();

  // Primeiro quem age na nova versão (o link de assinatura vale mais que a página da NF, mesmo para o dono).
  for (const recipient of next.recipients) {
    const email = normalizeEmail(recipient.email);

    if (email && recipient.role !== RecipientRole.CC && !people.has(email)) {
      people.set(email, { name: recipient.name, action: 'SIGN', url: `${assetBaseUrl}/sign/${recipient.token}` });
    }
  }

  for (const person of [previous.user, ...previous.recipients, ...next.recipients]) {
    const email = normalizeEmail(person.email);

    if (!email || people.has(email)) {
      continue;
    }

    people.set(
      email,
      email === ownerEmail
        ? { name: person.name ?? '', action: 'VIEW', url: `${assetBaseUrl}${invoiceViewPath(newEnvelopeId)}` }
        : { name: person.name ?? '', action: 'VERIFY', url: `${assetBaseUrl}/verificar` },
    );
  }

  // E-mail interno: sai mesmo com os e-mails do documento desligados (quem assina precisa saber que a versão mudou).
  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: previous.teamId },
    meta: previous.documentMeta,
  });

  const render = async (action: NoticeAction, url: string) => {
    const template = createElement(RevalleFinanceAccountChangedTemplate, {
      kind,
      documentName: previous.title,
      newDocumentName: next.title,
      notice,
      action,
      actionUrl: url,
      assetBaseUrl,
    });

    return await Promise.all([
      renderEmailWithI18N(template, { lang: emailLanguage, branding }),
      renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
    ]);
  };

  for (const [address, { name, action, url }] of people) {
    await io.runTask(`send-account-changed-${address}`, async () => {
      const [html, text] = await render(action, url);

      await emailTransport.sendMail({
        to: { name, address },
        from: senderEmail,
        subject: buildAccountChangedSubject(previous.title, kind),
        html,
        text,
      });
    });
  }
};

/**
 * Fase 9: a nota que mudou, nas duas versões. A antiga pelo arquivo marcado; a nova pela mesma posição (a cópia tem os
 * mesmos arquivos, na mesma ordem). Sem uma das duas, `null` (o aviso sai com a linha do envio).
 */
const loadChangedNote = async (
  oldEnvelopeId: string,
  newEnvelopeId: string,
  supersededEnvelopeItemId: string,
): Promise<{
  previous: { choiceCode: string | null; costCenterCode: string | null };
  next: { choiceCode: string | null; costCenterCode: string | null };
  document: VersionChangeDocument;
} | null> => {
  const [oldFiles, newFiles] = await Promise.all([loadInvoiceFiles(oldEnvelopeId), loadInvoiceFiles(newEnvelopeId)]);
  const oldPositions = invoicePositions(oldFiles);
  const newPositions = invoicePositions(newFiles);
  const previous = oldFiles.find((file) => file.envelopeItemId === supersededEnvelopeItemId);
  const position = previous ? oldPositions.get(previous.id) : undefined;
  const next = position ? newFiles.find((file) => newPositions.get(file.id)?.index === position.index) : undefined;

  if (!previous || !position || !next) {
    return null;
  }

  return {
    previous,
    next,
    document: { index: position.index, total: position.total, title: previous.title },
  };
};
