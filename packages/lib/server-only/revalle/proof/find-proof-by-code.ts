import { prisma } from '@documenso/prisma';
import { DocumentStatus, type RecipientRole, SigningStatus } from '@prisma/client';

import { VERIFICATION_CODE_ALPHABET, VERIFICATION_CODE_REGEX } from './verification-code';

/**
 * Normaliza o que a pessoa digitou: maiúsculas, sem espaços, hífen no meio.
 * Devolve null se não for um código válido (formato e alfabeto), sem tocar no banco.
 */
export const normalizeVerificationCodeInput = (input: string): string | null => {
  const compact = input.toUpperCase().replace(/\s+/g, '');
  const withHyphen = /^[^-]{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;

  return VERIFICATION_CODE_REGEX.test(withHyphen) &&
    [...withHyphen.replace('-', '')].every((c) => VERIFICATION_CODE_ALPHABET.includes(c))
    ? withHyphen
    : null;
};

export type RevalleProofLookup = {
  documentTitle: string;
  status: 'COMPLETED' | 'REJECTED' | 'PENDING';
  /** Conclusão (COMPLETED) ou recusa (REJECTED); nulo se em andamento. */
  completedAt: Date | null;
  /** SHA-256 final: só quando há um único arquivo e ele já foi selado. */
  finalSha256: string | null;
  /** Um item por arquivo; `finalSha256` só depois da selagem. */
  items: { title: string; finalSha256: string | null }[];
  signers: { nome: string; cpfMasked: string | null; signedAt: Date; role: RecipientRole }[];
};

/**
 * Consulta pública pelo código de verificação. Devolve só o que pode ser público:
 * nunca e-mail, IP, aparelho, local, CPF completo, conteúdo ou URL do arquivo.
 */
export const findRevalleProofByCode = async (code: string): Promise<RevalleProofLookup | null> => {
  const normalized = normalizeVerificationCodeInput(code);

  if (!normalized) {
    return null;
  }

  const proof = await prisma.revalleSignatureProof.findUnique({
    where: { verificationCode: normalized },
    select: {
      recipient: {
        select: {
          envelope: {
            select: {
              title: true,
              status: true,
              completedAt: true,
              deletedAt: true,
              envelopeItems: {
                orderBy: { order: 'asc' },
                select: { title: true, revalleHash: { select: { finalSha256: true } } },
              },
              recipients: {
                select: {
                  role: true,
                  signingStatus: true,
                  signedAt: true,
                  revalleProof: { select: { signedAt: true, employee: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const envelope = proof?.recipient.envelope;

  // Excluído ou cancelado: some da consulta pública.
  if (!envelope || envelope.deletedAt || envelope.status === DocumentStatus.CANCELLED) {
    return null;
  }

  const completed = envelope.status === DocumentStatus.COMPLETED;
  // Recusa: horário gravado em signedAt de quem recusou (a selagem pode ainda não ter virado o status).
  const rejections = envelope.recipients.filter((r) => r.signingStatus === SigningStatus.REJECTED);
  const rejected = !completed && (envelope.status === DocumentStatus.REJECTED || rejections.length > 0);
  const rejectedAt = rejections.reduce<Date | null>(
    (first, r) => (r.signedAt && (!first || r.signedAt < first) ? r.signedAt : first),
    null,
  );
  const items = envelope.envelopeItems.map((item) => ({
    title: item.title,
    finalSha256: completed ? (item.revalleHash?.finalSha256 ?? null) : null,
  }));

  const signers = envelope.recipients
    .flatMap((recipient) => (recipient.revalleProof ? [{ ...recipient.revalleProof, role: recipient.role }] : []))
    .map((p) => {
      const employee = (p.employee ?? null) as { nome?: unknown; cpfMasked?: unknown } | null;

      return {
        nome: typeof employee?.nome === 'string' ? employee.nome : 'Signatário',
        cpfMasked: typeof employee?.cpfMasked === 'string' ? employee.cpfMasked : null,
        signedAt: p.signedAt,
        role: p.role,
      };
    })
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime());

  return {
    documentTitle: envelope.title,
    status: completed ? 'COMPLETED' : rejected ? 'REJECTED' : 'PENDING',
    completedAt: completed ? envelope.completedAt : rejected ? rejectedAt : null,
    finalSha256: items.length === 1 ? items[0].finalSha256 : null,
    items,
    signers,
  };
};
