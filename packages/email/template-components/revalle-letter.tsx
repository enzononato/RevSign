import { REVALLE_APP_NAME, REVALLE_COMPANY_NAME } from '@documenso/lib/revalle/brand';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { RecipientRole } from '@prisma/client';
import type { ReactNode } from 'react';
import { Fragment } from 'react';

import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateFooter } from './template-footer';

// E-mails com cara de carta (24/11/2026): o convite caía em "Promoções" no Gmail. Sem imagens, texto alinhado à
// esquerda, um botão discreto com o endereço por extenso embaixo e rodapé curto. Usado pelo convite, pelo reenvio e
// pelo lembrete automático; a marca em texto (`RevalleWordmark`) também substitui o logo nos outros e-mails.

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Marca em texto, sem imagem: "RevSign · Revalle". */
export const RevalleWordmark = () => (
  <Text className="m-0 font-semibold text-base text-primary leading-6">
    {REVALLE_APP_NAME} <span className="font-normal text-muted-foreground">· {REVALLE_COMPANY_NAME}</span>
  </Text>
);

export type RevalleLetterProps = {
  preview: string;
  children: ReactNode;
};

/** Página branca de até 560px: marca, linha, corpo, linha e o rodapé de sempre (`TemplateFooter`). */
export const RevalleLetter = ({ preview, children }: RevalleLetterProps) => {
  const { i18n } = useLingui();

  return (
    <Html lang={i18n.locale}>
      <Head />

      <Body className="m-0 bg-background text-foreground" style={{ fontFamily: FONT_FAMILY }}>
        <Preview>{preview}</Preview>

        <Container className="mx-auto max-w-[560px] px-4 pt-6 pb-2">
          <RevalleWordmark />

          <Hr className="mt-3 mb-6 border-border" />

          {children}

          <Hr className="mt-8 mb-0 border-border" />

          <TemplateFooter />
        </Container>
      </Body>
    </Html>
  );
};

export const RevalleParagraph = ({ children }: { children: ReactNode }) => (
  <Text className="my-4 text-[15px] text-foreground leading-6">{children}</Text>
);

/** Mensagem escrita por quem enviou: parágrafos separados por linha em branco, quebras de linha mantidas. */
export const RevalleMessage = ({ text }: { text?: string }) => {
  const normalized = (text ?? '').trim().replace(/\r\n?/g, '\n');

  if (!normalized) {
    return null;
  }

  return normalized.split(/\n\s*\n/).map((paragraph, i) => (
    <Text key={`p-${i}`} className="my-4 whitespace-pre-line break-words text-[15px] text-foreground leading-6">
      {paragraph.split('\n').map((line, j) => (
        <Fragment key={`l-${i}-${j}`}>
          {j > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </Text>
  ));
};

const STARTS_WITH_GREETING = /^\s*(ol[áa]|oi|prezad[oa]s?|car[oa]s?|bom dia|boa tarde|boa noite|hello|hi|dear)\b/i;

/** "Olá, {nome}," ou, sem nome, "Olá,". */
const RevalleGreeting = ({ name }: { name?: string | null }) => {
  const recipientName = (name ?? '').trim();

  return (
    <RevalleParagraph>{recipientName ? <Trans>Hi {recipientName},</Trans> : <Trans>Olá,</Trans>}</RevalleParagraph>
  );
};

export type RevalleLetterOpeningProps = {
  recipientName?: string | null;
  /** A frase de quem enviou o quê ("Ana enviou o documento "X" para você assinar."), já traduzida. */
  sentence: string;
  /** Mensagem escrita por quem enviou, se houver. */
  customBody?: string;
};

/**
 * Abertura da carta: "Olá, {nome},", a frase e a mensagem de quem enviou. Quando a mensagem já começa com saudação
 * ("Olá {signer.name}, …"), ela abre a carta no lugar da nossa e a frase vem logo depois, antes do botão: sem
 * cumprimentar duas vezes e sem a frase solta antes do "Olá".
 */
export const RevalleLetterOpening = ({ recipientName, sentence, customBody }: RevalleLetterOpeningProps) => {
  if (customBody && STARTS_WITH_GREETING.test(customBody)) {
    return (
      <>
        <RevalleMessage text={customBody} />
        <RevalleParagraph>{sentence}</RevalleParagraph>
      </>
    );
  }

  return (
    <>
      <RevalleGreeting name={recipientName} />
      <RevalleParagraph>{sentence}</RevalleParagraph>
      <RevalleMessage text={customBody} />
    </>
  );
};

/** Verbo da frase do convite, como no assunto (`revalleInviteSubject`). */
export const revalleRoleVerb = (role: RecipientRole): MessageDescriptor => {
  switch (role) {
    case RecipientRole.APPROVER:
      return msg`aprovar`;
    case RecipientRole.VIEWER:
      return msg`ver`;
    case RecipientRole.ASSISTANT:
      return msg`preencher`;
    case RecipientRole.CC:
      return msg`acompanhar`;
    default:
      return msg`assinar`;
  }
};

const RoleButtonLabel = ({ role }: { role: RecipientRole }) => {
  switch (role) {
    case RecipientRole.APPROVER:
      return <Trans>Approve Document</Trans>;
    case RecipientRole.ASSISTANT:
      return <Trans>Preencher documento</Trans>;
    case RecipientRole.VIEWER:
    case RecipientRole.CC:
      return <Trans>View Document</Trans>;
    default:
      return <Trans>Sign Document</Trans>;
  }
};

/**
 * Botão do tamanho normal, à esquerda, e o endereço por extenso para quem não consegue clicar. No texto puro, só o
 * botão ("Assinar documento https://…"): o endereço não se repete.
 */
export const RevalleActionButton = ({ role, href }: { role: RecipientRole; href: string }) => (
  <>
    <Section className="mt-6 mb-2">
      <Button
        href={href}
        className="rounded-md bg-primary px-5 py-2.5 font-medium text-[15px] text-primary-foreground leading-6 no-underline"
      >
        <RoleButtonLabel role={role} />
      </Button>
    </Section>

    <Section data-skip-in-text="true">
      <Text className="mt-4 mb-1 text-[13px] text-muted-foreground leading-5">
        <Trans>Se o botão não funcionar, copie e cole este endereço no navegador:</Trans>
      </Text>

      <Text className="mt-0 mb-4 text-[13px] text-muted-foreground leading-5" style={{ wordBreak: 'break-all' }}>
        {href}
      </Text>
    </Section>
  </>
);

/** "Atenciosamente," + nome de quem enviou (e uma linha de detalhe: e-mail ou equipe). */
export const RevalleSignOff = ({ name, detail }: { name: string; detail?: string | null }) => (
  <Text className="mt-4 mb-4 text-[15px] text-foreground leading-6">
    <Trans>Atenciosamente,</Trans>
    <br />
    {name}
    {detail && (
      <>
        <br />
        <span className="text-[13px] text-muted-foreground">{detail}</span>
      </>
    )}
  </Text>
);
