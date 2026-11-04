import { costCenterLabel, REVALLE_COST_CENTERS } from '@documenso/lib/revalle/invoice/cost-centers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId } from 'react';

export type CostCenterSelectProps = {
  value: string | null;
  onSelect: (code: string) => void;
  disabled?: boolean;
};

/** Os cinco centros de custo da Revalle (lista fixa); 44 px de toque, como o resto do bloco da nota fiscal. */
export const CostCenterSelect = ({ value, onSelect, disabled = false }: CostCenterSelectProps) => {
  const { t } = useLingui();
  const triggerId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={triggerId} className="font-medium text-sm">
        <Trans>Centro de custo</Trans>
      </label>

      <Select value={value ?? ''} disabled={disabled} onValueChange={onSelect}>
        <SelectTrigger id={triggerId} className="h-11" data-testid="invoice-cost-center">
          <SelectValue placeholder={t`Selecione o centro de custo`} />
        </SelectTrigger>

        <SelectContent>
          {REVALLE_COST_CENTERS.map((center) => (
            <SelectItem key={center.code} value={center.code} className="min-h-11">
              {costCenterLabel(center.code)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
