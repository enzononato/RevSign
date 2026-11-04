import { prisma } from '@documenso/prisma';
import { Prisma } from '@prisma/client';

import { AppError } from '../../../errors/app-error';
import { parseBirthDateInput } from '../../../revalle/birth-date';
import { isValidCpf } from '../../../revalle/cpf';
import { normalizeEmail } from '../../../revalle/email-domain';
import { env } from '../../../utils/env';
import { logger } from '../../../utils/logger';
import type { Colaborador } from '../colaboradores/repository';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';
import { isRevalleIdentityCheckDisabled, logRevalleBaseUnavailable } from '../gate/get-gate-state';

export type SignupIdentityInput = { email: string; cpf?: string | null; birthDate?: string | null };

export type SignupIdentityCheck = { required: false } | { required: true; cpf: string };

// Mensagens da spec (seção 5). "Dado errado" é uma só para CPF inválido, CPF fora da base e data diferente: quem erra
// não descobre qual dos dois estava errado nem se o CPF existe.
const SIGNUP_IDENTITY_ERRORS = {
  REQUIRED: {
    code: 'SIGNUP_IDENTITY_REQUIRED',
    message: 'Para criar a conta, informe o CPF e a data de nascimento na página de cadastro.',
    statusCode: 400,
  },
  INVALID: {
    code: 'SIGNUP_IDENTITY_INVALID',
    message: 'CPF ou data de nascimento não conferem com o cadastro de colaboradores.',
    statusCode: 400,
  },
  CONFLICT: {
    code: 'SIGNUP_IDENTITY_CONFLICT',
    message: 'Este CPF já está vinculado a outro e-mail. Fale com o administrador.',
    statusCode: 400,
  },
  UNAVAILABLE: {
    code: 'SIGNUP_IDENTITY_UNAVAILABLE',
    message: 'Não foi possível conferir seus dados agora. Tente de novo em alguns minutos.',
    statusCode: 503,
  },
} as const;

const fail = (error: (typeof SIGNUP_IDENTITY_ERRORS)[keyof typeof SIGNUP_IDENTITY_ERRORS]) =>
  new AppError(error.code, { message: error.message, statusCode: error.statusCode });

export const isSignupIdentityRequired = (): boolean => !isRevalleIdentityCheckDisabled();

/** A conta do administrador pode não estar na base de colaboradores, então se cadastra sem CPF mesmo sem vínculo. */
export const signupIdentityExemptEmail = (): string | null => {
  const email = env('NEXT_PRIVATE_REVALLE_ADMIN_EMAIL');

  return email?.trim() ? normalizeEmail(email) : null;
};

/**
 * Confere CPF e data de nascimento de quem se cadastra. Lança `AppError` quando o cadastro não pode seguir; devolve
 * `required: true` com o CPF (só dígitos, como na base) para o chamador guardar com `saveSignupIdentity`.
 * Nunca registra CPF nem data.
 */
export const assertSignupIdentity = async ({
  email,
  cpf,
  birthDate,
}: SignupIdentityInput): Promise<SignupIdentityCheck> => {
  if (!isSignupIdentityRequired()) {
    return { required: false };
  }

  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail === signupIdentityExemptEmail()) {
    return { required: false };
  }

  // Quem já passou pelo portão (e-mail vinculado a um CPF): é o caso do "criar conta" da página de conclusão.
  const existingLink = await prisma.revalleEmailLink.findUnique({ where: { email: normalizedEmail } });

  if (existingLink) {
    return { required: false };
  }

  const repository = getColaboradoresRepository();

  if (!repository) {
    logRevalleBaseUnavailable();

    throw fail(SIGNUP_IDENTITY_ERRORS.UNAVAILABLE);
  }

  try {
    if (await repository.findByEmail(normalizedEmail)) {
      return { required: false };
    }
  } catch (error) {
    logRevalleBaseUnavailable(error);

    throw fail(SIGNUP_IDENTITY_ERRORS.UNAVAILABLE);
  }

  const typedCpf = cpf?.trim();
  const typedBirthDate = birthDate?.trim();

  if (!typedCpf || !typedBirthDate) {
    throw fail(SIGNUP_IDENTITY_ERRORS.REQUIRED);
  }

  const isoBirthDate = parseBirthDateInput(typedBirthDate);

  if (!isValidCpf(typedCpf) || !isoBirthDate) {
    throw fail(SIGNUP_IDENTITY_ERRORS.INVALID);
  }

  let colaborador: Colaborador | null;

  try {
    colaborador = await repository.findByCpf(typedCpf);
  } catch (error) {
    logRevalleBaseUnavailable(error);

    throw fail(SIGNUP_IDENTITY_ERRORS.UNAVAILABLE);
  }

  if (!colaborador || colaborador.dataNascimento !== isoBirthDate) {
    throw fail(SIGNUP_IDENTITY_ERRORS.INVALID);
  }

  // A base pode não ter e-mail para a pessoa: só vale como conflito quando existe e é de outro endereço.
  const baseHasOtherEmail = colaborador.email !== null && normalizeEmail(colaborador.email) !== normalizedEmail;

  const linkedElsewhere = await prisma.revalleEmailLink.findFirst({
    where: { cpf: colaborador.cpf, email: { not: normalizedEmail } },
    select: { id: true },
  });

  if (baseHasOtherEmail || linkedElsewhere) {
    throw fail(SIGNUP_IDENTITY_ERRORS.CONFLICT);
  }

  return { required: true, cpf: colaborador.cpf };
};

/** Guarda o CPF conferido até o e-mail ser confirmado. O CPF não vai para `User`. */
export const saveSignupIdentity = async (userId: number, cpf: string): Promise<void> => {
  await prisma.revalleSignupIdentity.upsert({
    where: { userId },
    create: { userId, cpf },
    update: { cpf },
  });
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Chamada depois que o e-mail da conta foi confirmado: o CPF guardado no cadastro vira o vínculo e-mail ↔ CPF, se
 * ninguém o tomou antes (quem confirma primeiro fica com ele; o outro segue sem vínculo e o portão cuida na primeira
 * assinatura). A linha pendente sempre sai. Pode rodar de novo sem efeito e nunca lança: a confirmação do e-mail não
 * pode falhar por causa do vínculo. Só o `userId` vai para o log.
 */
export const linkSignupIdentityOnVerify = async (user: { id: number; email: string }): Promise<void> => {
  try {
    // Só e-mail já confirmado vira vínculo, mesmo que alguém chame esta função cedo demais.
    const pending = await prisma.revalleSignupIdentity.findFirst({
      where: { userId: user.id, user: { emailVerified: { not: null } } },
    });

    if (!pending) {
      return;
    }

    const email = normalizeEmail(user.email);
    const { cpf } = pending;

    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.revalleEmailLink.findFirst({ where: { OR: [{ email }, { cpf }] } });

      if (!existing) {
        await tx.revalleEmailLink.create({ data: { email, cpf } });
      }

      await tx.revalleSignupIdentity.deleteMany({ where: { userId: user.id } });

      return !existing;
    });

    if (created) {
      logger.info({ msg: '[RevSign] vínculo e-mail e CPF criado no cadastro', userId: user.id });
    }
  } catch (error) {
    // Duas confirmações ao mesmo tempo para o mesmo CPF: a outra levou o vínculo e esta transação voltou atrás.
    if (isUniqueViolation(error)) {
      await prisma.revalleSignupIdentity.deleteMany({ where: { userId: user.id } }).catch(() => undefined);

      return;
    }

    logger.error({
      msg: '[RevSign] vínculo do cadastro não gravado',
      userId: user.id,
      code: revalleErrorCode(error),
    });
  }
};
