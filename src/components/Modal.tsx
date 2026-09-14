import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  footer?: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children, size = 'md', footer }: ModalProps) {
  if (!isOpen) return null;

  const sizeClasses: Record<string, string> = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <div
        className={`relative flex max-h-[100dvh] w-full flex-col rounded-t-2xl border border-stone-200 bg-white sm:max-h-[min(80dvh,calc(100dvh-2rem))] sm:rounded-xl ${sizeClasses[size]}`}
      >
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5 sm:px-6">
          <h2 className="text-base font-semibold text-stone-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-10 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-5 sm:px-6">
          {children}
        </div>
        {footer ? (
          <div className="flex flex-col-reverse gap-2 border-t border-stone-100 px-5 py-3 sm:flex-row sm:justify-end sm:px-6 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
            {footer}
          </div>
        ) : (
          <div className="pb-[max(0px,env(safe-area-inset-bottom,0px))] sm:pb-0" />
        )}
      </div>
    </div>
  );
}
