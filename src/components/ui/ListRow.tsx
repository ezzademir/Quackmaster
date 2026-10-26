import type { ReactNode } from 'react';

/** One row in an inset grouped list. Put several inside `.ios-group`. */
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
  const className = `flex min-h-16 w-full flex-col gap-1 bg-white px-4 py-3 text-left ${
    muted ? 'opacity-60' : ''
  } ${onClick ? 'active:bg-stone-50' : ''}`;

  const titleRow = (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[17px] font-medium leading-6 tracking-tight text-stone-900">{title}</div>
        {meta ? <div className="mt-0.5 truncate text-[13px] leading-5 text-stone-500">{meta}</div> : null}
      </div>
      {aside ? <div className="shrink-0 text-[15px]">{aside}</div> : null}
    </div>
  );

  return (
    <div className={className}>
      {onClick ? (
        <button type="button" onClick={onClick} className="w-full text-left">
          {titleRow}
        </button>
      ) : (
        titleRow
      )}
      {body ? <div className="text-[15px] leading-6 text-stone-700">{body}</div> : null}
    </div>
  );
}
