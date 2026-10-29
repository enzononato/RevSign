import { type ReactNode, useEffect, useRef } from 'react';

export const StepHeading = ({ children }: { children: ReactNode }) => {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <h1 ref={ref} tabIndex={-1} className="font-bold text-2xl leading-snug outline-none">
      {children}
    </h1>
  );
};
