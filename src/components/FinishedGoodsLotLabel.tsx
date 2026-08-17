import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, Printer, GitBranch } from 'lucide-react';

export interface FinishedGoodsLotLabelData {
  productName: string;
  lotLabel: string;
  sku: string;
  runNumber: string;
  manufacturedAt?: string | null;
  expiryDate?: string | null;
  quantity?: number | null;
  unit?: string | null;
}

function formatLabelDate(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function labelDocumentHtml(data: FinishedGoodsLotLabelData): string {
  const qty =
    data.quantity != null && Number.isFinite(data.quantity)
      ? `${data.quantity}${data.unit ? ` ${data.unit}` : ''}`
      : '—';
  const lot = data.lotLabel.replace(/</g, '');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${lot}</title>
  <style>
    @page { size: 90mm 60mm; margin: 4mm; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; color: #111; }
    .label { border: 2px solid #111; padding: 8px 10px; }
    .brand { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #444; }
    .product { font-size: 14px; font-weight: 700; margin-top: 4px; }
    .lot { font-size: 22px; font-weight: 800; letter-spacing: 0.04em; margin: 8px 0 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .row { display: flex; justify-content: space-between; font-size: 11px; margin-top: 3px; }
    .k { color: #555; }
    .v { font-weight: 600; }
  </style>
</head>
<body>
  <div class="label">
    <div class="brand">Quackmaster · finished goods</div>
    <div class="product">${data.productName.replace(/</g, '')}</div>
    <div class="lot">${lot}</div>
    <div class="row"><span class="k">SKU</span><span class="v">${data.sku.replace(/</g, '')}</span></div>
    <div class="row"><span class="k">MFG</span><span class="v">${formatLabelDate(data.manufacturedAt)}</span></div>
    <div class="row"><span class="k">EXP</span><span class="v">${formatLabelDate(data.expiryDate)}</span></div>
    <div class="row"><span class="k">QTY</span><span class="v">${qty}</span></div>
    <div class="row"><span class="k">RUN</span><span class="v">${data.runNumber.replace(/</g, '')}</span></div>
  </div>
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`;
}

export function printFinishedGoodsLotLabel(data: FinishedGoodsLotLabelData): void {
  const w = window.open('', '_blank', 'width=420,height=360');
  if (!w) return;
  w.document.write(labelDocumentHtml(data));
  w.document.close();
}

export function FinishedGoodsLotLabel({
  data,
  onDone,
  doneLabel = 'Done',
}: {
  data: FinishedGoodsLotLabelData;
  onDone?: () => void;
  doneLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const genealogyTo = `/genealogy?q=${encodeURIComponent(data.lotLabel)}`;

  async function copyLot() {
    try {
      await navigator.clipboard.writeText(data.lotLabel);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border-2 border-gray-900 bg-white p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
          Quackmaster · finished goods
        </p>
        <p className="mt-1 text-sm font-semibold text-gray-900">{data.productName}</p>
        <p className="mt-2 font-mono text-2xl font-extrabold tracking-wide text-gray-900">{data.lotLabel}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">SKU</dt>
          <dd className="text-right font-medium text-gray-900">{data.sku}</dd>
          <dt className="text-gray-500">MFG</dt>
          <dd className="text-right font-medium text-gray-900">{formatLabelDate(data.manufacturedAt)}</dd>
          <dt className="text-gray-500">EXP</dt>
          <dd className="text-right font-medium text-gray-900">{formatLabelDate(data.expiryDate)}</dd>
          {data.quantity != null && (
            <>
              <dt className="text-gray-500">Qty</dt>
              <dd className="text-right font-medium text-gray-900">
                {data.quantity}
                {data.unit ? ` ${data.unit}` : ''}
              </dd>
            </>
          )}
          <dt className="text-gray-500">Run</dt>
          <dd className="text-right font-medium text-gray-900">{data.runNumber}</dd>
        </dl>
      </div>
      <p className="text-xs text-gray-500">
        Ink-label packs with this lot code. Search the same code in Genealogy to trace hub, outlets, and the production
        run.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => printFinishedGoodsLotLabel(data)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Printer size={15} /> Print label
        </button>
        <button
          type="button"
          onClick={() => void copyLot()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy lot'}
        </button>
        <Link
          to={genealogyTo}
          className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 hover:bg-teal-100"
        >
          <GitBranch size={15} /> Trace lot
        </Link>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="ml-auto rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {doneLabel}
          </button>
        )}
      </div>
    </div>
  );
}
