import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans } from '@lingui/react/macro';

import { cn } from '../../lib/utils';

export type SignaturePadColorPickerProps = {
  selectedColor: string;
  setSelectedColor: (color: string) => void;
  className?: string;
};

export const SignaturePadColorPicker = ({
  selectedColor,
  setSelectedColor,
  className,
}: SignaturePadColorPickerProps) => {
  return (
    // REVALLE: no celular (< sm) o seletor tem 44 px de altura, encostado no canto.
    <div className={cn('absolute top-0 right-0 text-foreground filter sm:top-2 sm:right-2', className)}>
      <Select defaultValue={selectedColor} onValueChange={(value) => setSelectedColor(value)}>
        <SelectTrigger className="h-auto min-h-11 w-auto border-none p-0.5 px-2 sm:min-h-0 sm:px-0.5">
          <SelectValue placeholder="" />
        </SelectTrigger>

        <SelectContent className="w-[100px]" align="end">
          <SelectItem value="black">
            <div className="flex items-center text-[0.688rem] text-muted-foreground">
              <div className="mr-1 h-4 w-4 rounded-full border-2 border-border bg-black shadow-sm" />
              <Trans>Black</Trans>
            </div>
          </SelectItem>

          <SelectItem value="red">
            <div className="flex items-center text-[0.688rem] text-muted-foreground">
              <div className="mr-1 h-4 w-4 rounded-full border-2 border-border bg-[red] shadow-sm" />
              <Trans>Red</Trans>
            </div>
          </SelectItem>

          <SelectItem value="blue">
            <div className="flex items-center text-[0.688rem] text-muted-foreground">
              <div className="mr-1 h-4 w-4 rounded-full border-2 border-border bg-[blue] shadow-sm" />
              <Trans>Blue</Trans>
            </div>
          </SelectItem>

          <SelectItem value="green">
            <div className="flex items-center text-[0.688rem] text-muted-foreground">
              <div className="mr-1 h-4 w-4 rounded-full border-2 border-border bg-[green] shadow-sm" />
              <Trans>Green</Trans>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
