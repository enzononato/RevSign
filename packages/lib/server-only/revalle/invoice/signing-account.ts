import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { type InvoicePosition, invoicePositions } from '../../../revalle/invoice/invoice-files';
import { logger } from '../../../utils/logger';
import { loadInvoiceFiles } from './invoice-files';

export type RevalleInvoiceCostCenter = { code: string; name: string };

/** Fase 9: uma nota do envio, como quem assina a vê no documento dela. */
export type RevalleSigningInvoiceDocument = {
  envelopeItemId: string;
  title: string;
  position: InvoicePosition;
  account: { code: string; name: string } | null;
  costCenter: RevalleInvoiceCostCenter | null;
};

export type RevalleSigningInvoice = {
  /** Uma nota: a conta dela (como antes da Fase 9). Com 2+ notas: nula (cada nota tem a sua em `documents`). */
  account: { code: string; name: string } | null;
  /** Uma nota: o centro dela. Com 2+ notas: nulo. */
  costCenter: RevalleInvoiceCostCenter | null;
  /**
   * Fase 9: as notas do envio, na ordem dos arquivos. Com uma nota, a mesma conta e o mesmo centro de cima (a tela de
   * assinatura fica como antes); vazio num envio de antes da Fase 9 que ainda não tem as linhas por arquivo.
   */
  documents: RevalleSigningInvoiceDocument[];
};

/** "Conta contábil: número e nome" e "centro de custo: código e nome" da escolha atual; o que não existe, nulo. */
const toSigningValues = (
  choiceCode: string | null,
  costCenterCode: string | null,
  accountNames: Map<string, string>,
) => {
  const center = REVALLE_COST_CENTERS.find((item) => item.code === costCenterCode);

  return {
    account: choiceCode ? { code: choiceCode, name: accountNames.get(choiceCode) ?? '' } : null,
    costCenter: center ? { code: center.code, name: center.name } : null,
  };
};

const loadAccountNames = async (codes: Array<string | null>, db: Prisma.TransactionClient) => {
  const wanted = [...new Set(codes.filter((code): code is string => Boolean(code)))];

  if (wanted.length === 0) {
    return new Map<string, string>();
  }

  const accounts = await db.revalleAccountingAccount.findMany({
    where: { code: { in: wanted } },
    select: { code: true, name: true },
  });

  return new Map(accounts.map((account) => [account.code, account.name]));
};

/**
 * A conta contábil e o centro de custo que quem assina vê e que ficam congelados na prova, cada um por si: a escolha atual
 * da NF. A correção do centro faz todos assinarem de novo mesmo numa NF sem conta (marcada depois do envio), então o
 * centro não depende dela. Documento comum e NF sem nenhum dos dois devolvem null.
 *
 * Fase 9: com 2+ notas no envio, cada nota tem a sua conta e o seu centro (`documents`, das linhas por arquivo) e os de
 * cima ficam nulos; null só se nenhuma nota tem conta nem centro. Com uma nota (ou envio de antes da Fase 9 ainda sem as
 * linhas por arquivo), a leitura de sempre, da linha do envio (o espelho da nota única).
 */
export const findSigningInvoiceAccount = async (
  envelopeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<RevalleSigningInvoice | null> => {
  const row = await db.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, choiceCode: true, costCenterCode: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const files = await loadInvoiceFiles(envelopeId, db);
  const nfs = files.filter((file) => file.kind === RevalleInvoiceFileKind.NF);

  if (nfs.length >= 2) {
    const positions = invoicePositions(files);
    const accountNames = await loadAccountNames(
      nfs.map((file) => file.choiceCode),
      db,
    );

    const documents = nfs.flatMap((file) => {
      const position = positions.get(file.id);

      return position
        ? [
            {
              envelopeItemId: file.envelopeItemId,
              title: file.title,
              position,
              ...toSigningValues(file.choiceCode, file.costCenterCode, accountNames),
            },
          ]
        : [];
    });

    if (documents.every((document) => !document.account && !document.costCenter)) {
      return null;
    }

    return { account: null, costCenter: null, documents };
  }

  const center = REVALLE_COST_CENTERS.find((item) => item.code === row.costCenterCode);

  if (!row.choiceCode && !center) {
    return null;
  }

  const { account, costCenter } = toSigningValues(
    row.choiceCode,
    row.costCenterCode,
    await loadAccountNames([row.choiceCode], db),
  );
  const [only] = nfs;

  return {
    account,
    costCenter,
    documents: only
      ? [
          {
            envelopeItemId: only.envelopeItemId,
            title: only.title,
            position: { index: 1, total: 1 },
            account,
            costCenter,
          },
        ]
      : [],
  };
};

/** Fase 9: o que a página de assinatura mostrou em cada nota (`RevalleRecipientGate.invoiceShown`, com 2+ notas). */
export type RevalleInvoiceShown = Record<string, { accountCode: string | null; costCenterCode: string | null }>;

/** O `invoiceShown` gravado no portão, conferido (o que não tem o formato fica de fora). */
export const parseInvoiceShown = (value: unknown): RevalleInvoiceShown | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const shown: RevalleInvoiceShown = {};

  for (const [envelopeItemId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const { accountCode, costCenterCode } = entry as { accountCode?: unknown; costCenterCode?: unknown };

    shown[envelopeItemId] = {
      accountCode: typeof accountCode === 'string' ? accountCode : null,
      costCenterCode: typeof costCenterCode === 'string' ? costCenterCode : null,
    };
  }

  return shown;
};

/**
 * Para a página de assinatura: só depois do portão e só com o documento aberto para quem assina (o loader chama com o
 * payload que ele já montou, e nada da NF sai antes disso). Os códigos mostrados ficam no portão do destinatário: a prova
 * só congela o que a página mostrou (o embed não mostra; o que foi escolhido depois que a página abriu também não). A
 * conta e o centro valem em separado: o que a NF não tem grava nulo, e a prova nunca afirma o que a página não mostrou.
 *
 * Fase 9: com 2+ notas, a página mostra, em cada nota, a conta e o centro dela; o portão guarda os de todas as notas
 * (`invoiceShown`, por arquivo) e as duas colunas de uma nota ficam nulas. Com uma nota, como antes.
 */
export const showSigningInvoiceAccountForToken = async (token: string): Promise<RevalleSigningInvoice | null> => {
  const recipient = await prisma.recipient.findFirst({ where: { token }, select: { id: true, envelopeId: true } });

  if (!recipient) {
    return null;
  }

  const invoice = await findSigningInvoiceAccount(recipient.envelopeId);

  if (invoice) {
    const isMulti = invoice.documents.length >= 2;
    const shown: RevalleInvoiceShown = Object.fromEntries(
      invoice.documents.map((document) => [
        document.envelopeItemId,
        { accountCode: document.account?.code ?? null, costCenterCode: document.costCenter?.code ?? null },
      ]),
    );

    try {
      await prisma.revalleRecipientGate.updateMany({
        where: { recipientId: recipient.id },
        data: isMulti
          ? { invoiceAccountShownCode: null, invoiceCostCenterShownCode: null, invoiceShown: shown }
          : {
              invoiceAccountShownCode: invoice.account?.code ?? null,
              invoiceCostCenterShownCode: invoice.costCenter?.code ?? null,
            },
      });
    } catch (error) {
      // Sem o registro, a prova fica sem a linha da conta e do centro (nunca afirma o que não sabe); a página segue.
      logger.warn({
        msg: 'revalle invoice: falha ao registrar a conta e o centro mostrados',
        recipientId: recipient.id,
        error: String(error),
      });
    }
  }

  return invoice;
};
