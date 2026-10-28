import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../utils/auth';
import { visibleSections } from '../utils/workflowNav';

/** One workflow step. The first task is the thing to do. The rest stay one tap away. */
export function SectionHome() {
  const { pathname } = useLocation();
  const { isAdmin } = useAuth();
  const section = visibleSections(isAdmin).find((item) => item.home === pathname);
  if (!section || section.tasks.length === 0) return <Navigate to="/" replace />;

  const [primary, ...rest] = section.tasks;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <p className="text-[15px] leading-6 text-stone-500">{section.detail}</p>
      <Link
        to={primary.path}
        className="block rounded-[1.75rem] bg-white p-6 shadow-sm ring-1 ring-black/5 transition active:scale-[0.99]"
      >
        <p className="text-[12px] font-semibold uppercase tracking-wide text-stone-400">Start here</p>
        <p className="mt-2 text-[28px] font-semibold tracking-tight text-stone-900">{primary.label}</p>
        <p className="mt-2 text-[15px] leading-6 text-stone-500">{primary.detail}</p>
      </Link>
      {rest.length > 0 ? (
        <ul className="overflow-hidden rounded-[1.5rem] bg-white/80 shadow-sm ring-1 ring-black/5 backdrop-blur-xl">
          {rest.map((task) => (
            <li key={task.path} className="border-b border-stone-100 last:border-0">
              <Link to={task.path} className="flex min-h-16 items-center justify-between gap-4 px-5 py-3 active:bg-stone-50">
                <span>
                  <span className="block text-[17px] font-medium text-stone-900">{task.label}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-stone-500">{task.detail}</span>
                </span>
                <span aria-hidden className="text-xl text-stone-300">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
