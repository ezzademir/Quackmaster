import type { ReactNode } from 'react';

export function ListRow({
  title,
  meta,
  body,
  aside,
  muted = false,
  onClick,
}: {
  title: ReactNode;
  meta?: ReactNode;
  body?: ReactNode;
  aside?: ReactNode;
  muted?: boolean;
  onClick?: () => void;
}) {
  const className = `flex w-full flex-col gap-2 rounded-xl border border-stone-200 bg-white p-3.5 text-left transition-colors ${
    muted ? 'opacity-70' : ''
  } ${onClick ? 'active:bg-stone-50' : ''}`;

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-stone-900">{title}</div>
          {meta ? <div className="mt-0.5 text-xs text-stone-500">{meta}</div> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {body ? <div className="text-sm text-stone-700">{body}</div> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
