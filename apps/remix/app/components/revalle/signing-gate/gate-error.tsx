import { AlertCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export const GateError = ({ children, id }: { children: ReactNode; id?: string }) => (
  <p
    id={id}
    role="alert"
    className="flex items-start gap-2.5 rounded-[13px] bg-danger-bg px-3.5 py-3 font-semibold text-[14.5px] text-destructive"
  >
    <AlertCircleIcon aria-hidden className="mt-0.5 h-[18px] w-[18px] flex-shrink-0" />
    <span>{children}</span>
  </p>
);
