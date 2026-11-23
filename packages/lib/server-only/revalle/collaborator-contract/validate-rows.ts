import { z } from 'zod';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  isInactiveSituacao,
  type ParsedRow,
  type PreviewResult,
  type PreviewRow,
  type RowIssue,
} from '../../../revalle/collaborator-rows';
import { isValidCpf } from '../../../revalle/cpf';
import { type Colaborador, getColaboradoresRepository } from '../colaboradores/repository';

const CHUNK_SIZE = 500;

const ZEmail = z.string().trim().toLowerCase().max(254).email();

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const lookupByCpf = async (cpfs: string[]): Promise<Map<string, Colaborador>> => {
  const repository = getColaboradoresRepository();

  if (!repository) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'A base do RH não está configurada.' });
  }

  const found = new Map<string, Colaborador>();

  // Só leitura. Blocos de 500 CPFs; os resultados não são registrados em log.
  for (const block of chunk(cpfs, CHUNK_SIZE)) {
    for (const colaborador of await repository.findManyByCpf(block)) {
      found.set(colaborador.cpf, colaborador);
    }
  }

  return found;
};

/** Confere a lista contra o RH. Em repetição, a primeira ocorrência vale e as seguintes são marcadas. */
export const validateCollaboratorRows = async (rows: ParsedRow[]): Promise<PreviewResult> => {
  const validCpfs = [...new Set(rows.filter((row) => isValidCpf(row.cpf)).map((row) => row.cpf))];
  const hr = await lookupByCpf(validCpfs);

  const seenCpf = new Set<string>();
  const seenEmail = new Set<string>();

  const previewRows: PreviewRow[] = rows.map((row) => {
    const issues: RowIssue[] = [];
    const email = row.email.trim().toLowerCase();
    const emailOk = ZEmail.safeParse(email).success;
    const cpfOk = isValidCpf(row.cpf);
    const colaborador = cpfOk ? (hr.get(row.cpf) ?? null) : null;

    if (!emailOk) {
      issues.push('E-mail inválido');
    }

    if (!cpfOk) {
      issues.push('CPF inválido');
    } else if (!colaborador) {
      issues.push('CPF não está na base do RH');
    } else if (isInactiveSituacao(colaborador.situacao)) {
      issues.push('Colaborador inativo no RH');
    }

    if (cpfOk) {
      if (seenCpf.has(row.cpf)) {
        issues.push('CPF repetido na lista');
      }

      seenCpf.add(row.cpf);
    }

    if (emailOk) {
      if (seenEmail.has(email)) {
        issues.push('E-mail repetido na lista');
      }

      seenEmail.add(email);
    }

    // O e-mail da lista vale para o envio; o do RH não precisa coincidir (o portão confere só o CPF).
    return { ...row, email, hrName: colaborador?.nome ?? null, issues };
  });

  const isDuplicateIssue = (issue: RowIssue) =>
    issue === 'CPF repetido na lista' || issue === 'E-mail repetido na lista';

  let ready = 0;
  let withErrors = 0;
  let duplicates = 0;

  for (const row of previewRows) {
    if (row.issues.length === 0) {
      ready += 1;
    } else if (row.issues.every(isDuplicateIssue)) {
      duplicates += 1;
    } else {
      withErrors += 1;
    }
  }

  return { rows: previewRows, ready, withErrors, duplicates };
};
