export type TemplateNewAccountWarningProps = {
  senderEmail: string;
  reportUrl?: string;
};

// REVALLE: sem o aviso "enviado de uma conta nova" e sem o "Denunciar remetente": no RevSign só envia quem tem conta
// da Revalle, e o aviso assustava colaborador recebendo documento da própria empresa.
export const TemplateNewAccountWarning = (_props: TemplateNewAccountWarningProps) => null;
