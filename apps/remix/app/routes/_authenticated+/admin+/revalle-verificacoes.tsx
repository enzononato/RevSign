import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { ShieldCheck } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';

const TIMEZONE = 'America/Bahia';
const REASONS = {
  ATTEMPTS: 'Excesso de tentativas',
  CPF_CONFLICT: 'CPF ligado a outro e-mail',
  CODE_ATTEMPTS: 'Excesso de códigos errados',
} as const;

const formatDate = (date: Date) => DateTime.fromJSDate(new Date(date)).setZone(TIMEZONE).toFormat('dd/MM/yyyy HH:mm');

type LockedItem = {
  id: string;
  documentTitle: string;
  recipientEmail: string;
  reason: keyof typeof REASONS;
  conflictEmail: string | null;
  lockedAt: Date;
};
type LinkItem = { id: string; email: string; name: string | null; cpfMasked: string; createdAt: Date };

const LockedSection = () => {
  const { toast } = useToast();
  const [cursor, setCursor] = useState<string | undefined>();
  const [items, setItems] = useState<LockedItem[]>([]);

  const { data, isPending, refetch } = trpc.revalle.admin.findGates.useQuery({ type: 'LOCKED', cursor });

  useEffect(() => {
    if (data) {
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));

        return [...current, ...data.locked.filter((item) => !known.has(item.id))];
      });
    }
  }, [data]);

  const { mutateAsync: unlock, isPending: isUnlocking } = trpc.revalle.admin.unlockGate.useMutation();

  const onUnlock = async (id: string) => {
    try {
      await unlock({ gateId: id });
      setItems((current) => current.filter((item) => item.id !== id));
      toast({ title: 'Link desbloqueado.' });
      void refetch();
    } catch {
      toast({ title: 'Não foi possível desbloquear.', variant: 'destructive' });
    }
  };

  return (
    <section className="mt-8">
      <h3 className="font-semibold text-xl">Links bloqueados</h3>
      <p className="mt-1 text-muted-foreground text-sm">
        Depois de desbloquear, a pessoa pode tentar confirmar a identidade de novo.
      </p>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-3">Documento</th>
              <th className="p-3">E-mail</th>
              <th className="p-3">Motivo</th>
              <th className="p-3">Bloqueado em</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="max-w-[16rem] truncate p-3">{item.documentTitle}</td>
                <td className="p-3">{item.recipientEmail}</td>
                <td className="p-3">
                  {REASONS[item.reason]}
                  {item.conflictEmail && (
                    <span className="block text-muted-foreground text-xs">Vínculo atual: {item.conflictEmail}</span>
                  )}
                </td>
                <td className="whitespace-nowrap p-3">{formatDate(item.lockedAt)}</td>
                <td className="p-3 text-right">
                  <Button size="sm" variant="outline" disabled={isUnlocking} onClick={() => void onUnlock(item.id)}>
                    Desbloquear
                  </Button>
                </td>
              </tr>
            ))}
            {!isPending && items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Nenhum link bloqueado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data?.nextCursor && (
        <Button className="mt-3" variant="outline" size="sm" onClick={() => setCursor(data.nextCursor ?? undefined)}>
          Carregar mais
        </Button>
      )}
    </section>
  );
};

const LinksSection = () => {
  const { toast } = useToast();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [items, setItems] = useState<LinkItem[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setCursor(undefined);
      setItems([]);
    }, 400);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isPending } = trpc.revalle.admin.findGates.useQuery({
    type: 'LINKS',
    search: search || undefined,
    cursor,
  });

  useEffect(() => {
    if (data) {
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));

        return [...current, ...data.links.filter((item) => !known.has(item.id))];
      });
    }
  }, [data]);

  const { mutateAsync: removeLink, isPending: isRemoving } = trpc.revalle.admin.deleteLink.useMutation();

  const onRemove = async (id: string) => {
    try {
      await removeLink({ linkId: id });
      setItems((current) => current.filter((item) => item.id !== id));
      setConfirmingId(null);
      toast({ title: 'Vínculo removido.' });
    } catch {
      toast({ title: 'Não foi possível remover o vínculo.', variant: 'destructive' });
    }
  };

  return (
    <section className="mt-12">
      <h3 className="font-semibold text-xl">Vínculos de e-mail</h3>
      <p className="mt-1 text-muted-foreground text-sm">
        Ao remover um vínculo, a pessoa precisa confirmar CPF e data de nascimento de novo em documentos novos.
      </p>

      <Input
        className="mt-4 max-w-sm"
        placeholder="Buscar por e-mail"
        aria-label="Buscar por e-mail"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
      />

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-3">E-mail</th>
              <th className="p-3">Nome na base</th>
              <th className="p-3">CPF</th>
              <th className="p-3">Vinculado em</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="p-3">{item.email}</td>
                <td className="p-3">{item.name ?? '-'}</td>
                <td className="whitespace-nowrap p-3">{item.cpfMasked}</td>
                <td className="whitespace-nowrap p-3">{formatDate(item.createdAt)}</td>
                <td className="p-3 text-right">
                  {confirmingId === item.id ? (
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-muted-foreground">Remover este vínculo?</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={isRemoving}
                        onClick={() => void onRemove(item.id)}
                      >
                        Sim, remover
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmingId(null)}>
                        Cancelar
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setConfirmingId(item.id)}>
                      Remover vínculo
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!isPending && items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Nenhum vínculo encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data?.nextCursor && (
        <Button className="mt-3" variant="outline" size="sm" onClick={() => setCursor(data.nextCursor ?? undefined)}>
          Carregar mais
        </Button>
      )}
    </section>
  );
};

export default function AdminRevalleVerificacoesPage() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-8 w-8" />
        <h2 className="font-semibold text-4xl">Verificações</h2>
      </div>

      <LockedSection />
      <LinksSection />
    </div>
  );
}
