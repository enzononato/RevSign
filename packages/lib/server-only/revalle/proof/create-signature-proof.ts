import { prisma } from '@documenso/prisma';
import { FieldType, Prisma } from '@prisma/client';

import { maskCpf } from '../../../revalle/cpf';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { logger } from '../../../utils/logger';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { type IpLocation, lookupIpLocation } from '../geoip';
import { describeUserAgent } from './user-agent';
import { generateVerificationCode } from './verification-code';

type Db = Prisma.TransactionClient;

export type DeviceLocation =
  | { status: 'GRANTED'; lat: number; lon: number; accuracyM: number }
  | { status: 'DENIED' | 'UNAVAILABLE' | 'NOT_REQUESTED' };

export type ProofEmployee = {
  nome: string;
  cpfMasked: string;
  matricula: string | null;
  cargo: string | null;
  setor: string | null;
  unidade: string | null;
  situacao: string | null;
};

export type ProofFactor = {
  factor: 'EMAIL_LINK' | 'EMAIL_CODE' | 'EMPLOYEE_CONFIRMATION' | 'EMPLOYEE_LINKED';
  at: string;
};

/** Consultas lentas (base de colaboradores, GeoIP) que não devem rodar dentro da transação. */
export type ProofExternals = {
  employee: ProofEmployee | null;
  ipLocation: IpLocation | null;
};

const MAX_CODE_ATTEMPTS = 5;

const logCode = (msg: string, error: unknown) => {
  const code = error instanceof Error ? ((error as Error & { code?: string }).code ?? error.name) : undefined;

  logger.error({ msg, code });
};

const loadEmployee = async (cpf: string | null): Promise<ProofEmployee | null> => {
  if (!cpf) {
    return null;
  }

  try {
    const colaborador = await getColaboradoresRepository()?.findByCpf(cpf);

    if (!colaborador) {
      return null;
    }

    return {
      nome: colaborador.nome,
      cpfMasked: maskCpf(cpf),
      matricula: colaborador.matricula ?? null,
      cargo: colaborador.cargo ?? null,
      setor: colaborador.setor ?? null,
      unidade: colaborador.unidade ?? null,
      situacao: colaborador.situacao ?? null,
    };
  } catch (error) {
    // A base fora do ar não impede a conclusão: a prova fica sem os dados do RH.
    logCode('[RevSign] base de colaboradores indisponível ao congelar a prova', error);

    return null;
  }
};

export const loadProofExternals = async (
  recipientId: number,
  requestMetadata?: RequestMetadata,
): Promise<ProofExternals> => {
  const gate = await prisma.revalleRecipientGate.findUnique({ where: { recipientId }, select: { cpf: true } });
  const [employee, ipLocation] = await Promise.all([
    loadEmployee(gate?.cpf ?? null),
    lookupIpLocation(requestMetadata?.ipAddress),
  ]);

  return { employee, ipLocation };
};

export type CreateRevalleSignatureProofOptions = {
  recipientId: number;
  requestMetadata?: RequestMetadata;
  deviceLocation?: DeviceLocation;
  tx?: Db;
  externals?: ProofExternals;
};

/**
 * Congela a prova da assinatura. Idempotente por destinatário: se já existe, devolve a existente.
 * Deve rodar na mesma transação que marca o destinatário como assinado, depois da inserção automática dos campos.
 */
export const createRevalleSignatureProof = async ({
  recipientId,
  requestMetadata,
  deviceLocation = { status: 'NOT_REQUESTED' },
  tx = prisma,
  externals,
}: CreateRevalleSignatureProofOptions) => {
  const existing = await tx.revalleSignatureProof.findUnique({ where: { recipientId } });

  if (existing) {
    return existing;
  }

  const { employee, ipLocation } = externals ?? (await loadProofExternals(recipientId, requestMetadata));

  const recipient = await tx.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { email: true, envelopeId: true, signedAt: true },
  });
  const gate = await tx.revalleRecipientGate.findUnique({ where: { recipientId } });

  const logs = await tx.documentAuditLog.findMany({
    where: {
      envelopeId: recipient.envelopeId,
      OR: [
        {
          type: {
            in: [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED, DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED],
          },
          data: { path: ['recipientId'], equals: recipientId },
        },
        {
          type: {
            in: [DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_CONFIRMED, DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_LINKED],
          },
          email: { equals: recipient.email, mode: 'insensitive' },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { type: true, createdAt: true },
  });

  const first = (type: string) => logs.find((log) => log.type === type)?.createdAt;
  const last = (type: string) => [...logs].reverse().find((log) => log.type === type)?.createdAt;

  const signedAt = recipient.signedAt ?? new Date();
  const openedAt = first(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED);
  const linkAt = [openedAt, gate?.termAcceptedAt]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => +a - +b)[0];

  const factors: ProofFactor[] = [{ factor: 'EMAIL_LINK', at: (linkAt ?? signedAt).toISOString() }];
  const codeAt = last(DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED);
  const confirmedAt = last(DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_CONFIRMED);
  const linkedAt = last(DOCUMENT_AUDIT_LOG_TYPE.REVALLE_IDENTITY_LINKED);

  if (codeAt) {
    factors.push({ factor: 'EMAIL_CODE', at: codeAt.toISOString() });
  }

  if (gate?.identityStatus === 'CONFIRMED') {
    factors.push({
      factor: 'EMPLOYEE_CONFIRMATION',
      at: (confirmedAt ?? gate.identityConfirmedAt ?? signedAt).toISOString(),
    });
  } else if (gate?.identityStatus === 'LINKED') {
    factors.push({ factor: 'EMPLOYEE_LINKED', at: (linkedAt ?? gate.identityConfirmedAt ?? signedAt).toISOString() });
  }

  const signatureFields = await tx.field.findMany({
    where: { recipientId, type: FieldType.SIGNATURE },
    select: { customText: true, signature: { select: { signatureImageAsBase64: true, typedSignature: true } } },
  });
  const drewSignature = signatureFields.some(
    (field) =>
      Boolean(field.signature?.signatureImageAsBase64) ||
      Boolean(field.signature?.typedSignature) ||
      Boolean(field.customText),
  );

  const data = {
    recipientId,
    signedAt,
    employee: employee ?? Prisma.JsonNull,
    identityVerified: gate?.identityStatus === 'CONFIRMED' || gate?.identityStatus === 'LINKED',
    factors,
    termVersion: gate?.termVersion ?? null,
    termAcceptedAt: gate?.termAcceptedAt ?? null,
    ipAddress: requestMetadata?.ipAddress ?? null,
    userAgent: requestMetadata?.userAgent ?? null,
    device: describeUserAgent(requestMetadata?.userAgent),
    ipLocation: ipLocation ?? Prisma.JsonNull,
    deviceLocation,
    drewSignature,
  };

  // O código é aleatório e único. Dentro da transação um erro de unicidade abortaria tudo,
  // então a colisão (rara) é checada antes de gravar, com até 5 sorteios.
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const verificationCode = generateVerificationCode();
    const taken = await tx.revalleSignatureProof.findUnique({ where: { verificationCode }, select: { id: true } });

    if (!taken) {
      return await tx.revalleSignatureProof.create({ data: { ...data, verificationCode } });
    }
  }

  throw new Error('Não foi possível gerar um código de verificação único.');
};
