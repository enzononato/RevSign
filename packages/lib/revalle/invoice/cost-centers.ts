/** Lista fixa dos centros de custo da Revalle (spec da Fase 7, seção 1): um por NF, escolhido pela pessoa. */
export const REVALLE_COST_CENTERS = [
  { code: '101', name: 'Puxada' },
  { code: '201', name: 'Armazém' },
  { code: '301', name: 'Administrativo' },
  { code: '401', name: 'Vendas' },
  { code: '501', name: 'Entrega' },
] as const;

export type RevalleCostCenterCode = (typeof REVALLE_COST_CENTERS)[number]['code'];

export const isCostCenterCode = (value: unknown): value is RevalleCostCenterCode =>
  REVALLE_COST_CENTERS.some((center) => center.code === value);

/** Só o nome ("Puxada"); código fora da lista não tem nome. */
export const costCenterName = (code: string) => REVALLE_COST_CENTERS.find((item) => item.code === code)?.name ?? null;

/** "101 – Puxada"; código fora da lista volta como veio. */
export const costCenterLabel = (code: string) => {
  const center = REVALLE_COST_CENTERS.find((item) => item.code === code);

  return center ? `${center.code} – ${center.name}` : code;
};
