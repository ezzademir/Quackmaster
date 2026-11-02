import type { HTMLAttributes, ReactNode } from 'react';

export function Surface({
  children,
  className = '',
  padded = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children?: ReactNode;
  padded?: boolean;
}) {
  return (
    <div className={`panel ${padded ? 'p-4 sm:p-5' : ''} ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}
