import { AppError } from '@documenso/lib/errors/app-error';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { useLingui } from '@lingui/react/macro';

/** Toast de erro do painel de unidades: os códigos conhecidos ganham uma frase clara; o resto, a frase padrão. */
export const useUnitsErrorToast = () => {
  const { t } = useLingui();
  const { toast } = useToast();

  return (error: unknown, fallback?: string) => {
    const { code } = AppError.parseError(error);

    const messages: Record<string, string> = {
      REVALLE_UNIT_EXISTS: t`Já existe uma unidade com esse nome na base do RH.`,
      REVALLE_TEAM_EXISTS: t`Já existe um time com esse nome nesta unidade.`,
      REVALLE_TEAM_HAS_DOCUMENTS: t`Este time tem documentos e não pode ser removido.`,
      REVALLE_UNIT_OWNER: t`Quem criou a unidade não pode sair dela.`,
      REVALLE_USER_DISABLED: t`Esta conta está desativada. Reative a conta antes de pôr na unidade.`,
      FORBIDDEN: t`Só o administrador pode fazer isso.`,
      NOT_FOUND: t`Não encontrado. Atualize a página e tente de novo.`,
    };

    toast({
      title: messages[code] ?? fallback ?? t`Não foi possível salvar. Tente de novo.`,
      variant: 'destructive',
    });
  };
};
