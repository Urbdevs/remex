'use client';

import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatUsdc, formatMxn, formatDate, shortHash } from '@/lib/utils';
import { BASESCAN_URL } from '@/lib/wagmi';
import type { Transfer } from '@/lib/api';

export function TransferCard({ transfer: t }: { transfer: Transfer }) {
  const amountUsdc = parseFloat(t.amount_usdc) / 1_000_000;

  return (
    <div className="card p-4 space-y-3 hover:shadow-md transition-shadow">
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-lg font-semibold text-gray-900">
            ${formatUsdc(t.amount_usdc)} USDC
          </p>
          {t.mxn_amount && (
            <p className="text-sm text-emerald-600 font-medium">
              → ${formatMxn(t.mxn_amount)} MXN
            </p>
          )}
        </div>
        <StatusBadge status={t.status} />
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
        {t.fx_rate && (
          <>
            <span>Tipo de cambio</span>
            <span className="font-mono text-gray-700">{parseFloat(t.fx_rate).toFixed(4)} MXN/USDC</span>
          </>
        )}
        {t.spei_reference && (
          <>
            <span>Ref. SPEI</span>
            <span className="font-mono text-gray-700">{t.spei_reference}</span>
          </>
        )}
        <span>Fecha</span>
        <span className="text-gray-700">{formatDate(t.created_at)}</span>
        {t.resolved_at && (
          <>
            <span>Resuelto</span>
            <span className="text-gray-700">{formatDate(t.resolved_at)}</span>
          </>
        )}
      </div>

      {/* Tx hash */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
        <span className="font-mono text-xs text-gray-400">{shortHash(t.tx_hash)}</span>
        <a
          href={`${BASESCAN_URL}/tx/${t.tx_hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          Ver en Basescan ↗
        </a>
      </div>

      {/* Error message if refunded */}
      {t.error_message && (
        <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-600">
          {t.error_message}
        </div>
      )}
    </div>
  );
}
