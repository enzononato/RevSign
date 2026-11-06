import { cn } from '@documenso/ui/lib/utils';

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type { TemplateType as TemplateTypePrisma } from '@prisma/client';
import { Building2, Globe2, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react/dist/lucide-react';
import type { HTMLAttributes } from 'react';

type TemplateTypeIcon = {
  label: MessageDescriptor;
  icon?: LucideIcon;
  color: string;
};

type TemplateTypes = (typeof TemplateTypePrisma)[keyof typeof TemplateTypePrisma];

// REVALLE: redesign v3. Tipo de modelo não é status: ícones neutros (o texto já diz o tipo).
const TEMPLATE_TYPES: Record<TemplateTypes, TemplateTypeIcon> = {
  PRIVATE: {
    label: msg`Private`,
    icon: Lock,
    color: 'text-muted-foreground',
  },
  PUBLIC: {
    label: msg`Public`,
    icon: Globe2,
    color: 'text-muted-foreground',
  },
  ORGANISATION: {
    label: msg`Organisation`,
    icon: Building2,
    color: 'text-muted-foreground',
  },
};

export type TemplateTypeProps = HTMLAttributes<HTMLSpanElement> & {
  type: TemplateTypes;
  inheritColor?: boolean;
};

export const TemplateType = ({ className, type, inheritColor, ...props }: TemplateTypeProps) => {
  const { _ } = useLingui();

  const { label, icon: Icon, color } = TEMPLATE_TYPES[type];

  return (
    <span className={cn('flex items-center', className)} {...props}>
      {Icon && (
        <Icon
          className={cn('mr-2 inline-block h-4 w-4', {
            [color]: !inheritColor,
          })}
        />
      )}
      {_(label)}
    </span>
  );
};
