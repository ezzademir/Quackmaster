import { Link } from 'react-router-dom';
import { AlertTriangle, Package, Clock, Scale } from 'lucide-react';

export interface AlertItem {
  id: string;
  tone: 'amber' | 'red' | 'sky';
  title: string;
  detail: string;
  to: string;
}

interface Props {
  alerts: AlertItem[];
  title?: string;
}

export function AlertsPanel({ alerts, title = 'Alerts' }: Props) {
  if (alerts.length === 0) return null;

  const iconFor = (id: string) => {
    if (id.startsWith('low')) return <Package size={16} />;
    if (id.startsWith('expir')) return <Clock size={16} />;
    if (id.startsWith('recon') || id.startsWith('var')) return <Scale size={16} />;
    return <AlertTriangle size={16} />;
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="flex items-center gap-2 font-semibold text-gray-900">
        <AlertTriangle size={18} className="text-amber-600" />
        {title}
      </h2>
      <ul className="mt-3 space-y-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <Link
              to={a.to}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:shadow-sm ${
                a.tone === 'red'
                  ? 'border-red-200 bg-red-50/80'
                  : a.tone === 'sky'
                    ? 'border-sky-200 bg-sky-50/80'
                    : 'border-amber-200 bg-amber-50/80'
              }`}
            >
              <span className="mt-0.5 text-gray-600">{iconFor(a.id)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900">{a.title}</span>
                <span className="block text-xs text-gray-600">{a.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
