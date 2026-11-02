import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

type RefreshFn = () => Promise<void> | void;

const PageRefreshContext = createContext<{
  register: (fn: RefreshFn) => () => void;
  run: () => Promise<void>;
} | null>(null);

export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const current = useRef<RefreshFn | null>(null);
  const api = useRef({
    register(fn: RefreshFn) {
      current.current = fn;
      return () => {
        if (current.current === fn) current.current = null;
      };
    },
    async run() {
      await current.current?.();
    },
  }).current;

  return <PageRefreshContext.Provider value={api}>{children}</PageRefreshContext.Provider>;
}

/** The shell calls this on pull-to-refresh. The latest page to register wins. */
export function useRegisterRefresh(fn: RefreshFn) {
  const ctx = useContext(PageRefreshContext);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(() => fnRef.current());
  }, [ctx]);
}

export function useRunRefresh() {
  const ctx = useContext(PageRefreshContext);
  return ctx?.run ?? (async () => undefined);
}
