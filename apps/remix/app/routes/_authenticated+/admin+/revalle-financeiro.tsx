import { redirect } from 'react-router';

// Fase 7: a tela Admin → Financeiro virou Admin → Perfis (Financeiro e Contabilidade). O endereço antigo continua
// valendo para os links salvos.
export function loader() {
  throw redirect('/admin/revalle-perfis');
}
