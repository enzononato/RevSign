import type { ReactNode } from 'react';

export const GateError = ({ children, id }: { children: ReactNode; id?: string }) => (
  <p
    id={id}
    role="alert"
    className="rounded-md border border-destructive/40 bg-destructive/10 p-3 font-medium text-destructive"
  >
    {children}
  </p>
);
