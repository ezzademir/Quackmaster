import { Link } from 'react-router-dom';
import type { FinishedHubTotals } from '../utils/hubInventoryMath';

/** Compact hub finished-goods ATP with link to canonical Inventory view. */
export function HubAtpCompact({
  totals,
  className,
}: {
  totals: FinishedHubTotals;
  className?: string;
}) {
  return (
    <p className={className ?? 'text-sm text-gray-600'}>
      Hub FG available:{' '}
      <strong className="tabular-nums text-gray-900">{totals.available.toLocaleString()}</strong>
      {totals.reserved > 0 && (
        <>
          {' '}
          <span className="text-gray-500">
            ({totals.reserved.toLocaleString()} reserved)
          </span>
        </>
      )}
      {' · '}
      <Link to="/inventory" className="font-medium text-teal-600 hover:underline">
        View in Inventory
      </Link>
    </p>
  );
}
