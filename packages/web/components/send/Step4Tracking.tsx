'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { formatMxn, shortHash, formatDate } from '@/lib/utils';
import { BASESCAN_URL } from '@/lib/wagmi';
import type { Transfer } from '@/lib/api';
import type { SendFormData } from './SendStepper';

interface Props {
  form: SendFormData;
}

type TimelineStep = {
  key:     Transfer['status'] | 'initiated';
  label:   string;
  detail?: string;
  done:    boolean;
  active:  boolean;
  error:   boolean;
};

export function Step4Tracking({ form }: Props) {
  const txHash = form.txHash;

  // Poll API every 10s to find remittance with matching txHash
  const { data, isLoading } = useQuery({
    queryKey:        ['remittance-status', txHash],
    queryFn:         () => api.getTransfers({ limit: 10 }),
    refetchInterval: 10_000,
    enabled:         !!txHash,
  });

  const remittance = data?.data.find(t => t.tx_hash === txHash);
  const status     = remittance?.status ?? 'pending';

  // Build timeline
  const steps: TimelineStep[] = [
    {
      key:    'initiated',
      label:  'Transacción enviada',
      detail: txHash ? `Tx: ${shortHash(txHash)}` : undefined,
      done:   true,
      active: status === 'pending' && !remittance,
      error:  false,
    },
    {
      key:    'pending',
      label:  'Detectada en blockchain',
      detail: remittance ? `Block: ${remittance.block_number ?? '—'}` : undefined,
      done:   !!remittance,
      active: !!remittance && status === 'pending',
      error:  false,
    },
    {
      key:    'processing',
      label:  'Procesando off-ramp Bitso',
      detail: remittance?.fx_rate ? `Rate: ${parseFloat(remittance.fx_rate).toFixed(4)} MXN/USDC` : undefined,
      done:   status === 'delivered' || status === 'refunded',
      active: status === 'processing',
      error:  false,
    },
    {
      key:    'delivered',
      label:  status === 'refunded' ? 'Reembolsado' : 'SPEI enviado ✓',
      detail: remittance?.spei_reference
        ? `Referencia: ${remittance.spei_reference}`
        : status === 'refunded' ? remittance?.error_message ?? undefined : undefined,
      done:   status === 'delivered' || status === 'refunded',
      active: false,
      error:  status === 'refunded',
    },
  ];

  const isDelivered = status === 'delivered';
  const isRefunded  = status === 'refunded';
  const isDone      = isDelivered || isRefunded;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="section-title">
          {isDelivered ? '✅ ¡Remesa entregada!' :
           isRefunded  ? '⚠️ Remesa reembolsada' :
                         '⏳ Procesando remesa…'}
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {isDone ? '' : 'Actualizando cada 10 segundos…'}
        </p>
      </div>

      {/* Timeline */}
      <div className="space-y-0">
        {steps.map((step, i) => (
          <div key={step.key} className="flex gap-3">
            {/* Left: circle + line */}
            <div className="flex flex-col items-center">
              <div className={[
                'w-8 h-8 rounded-full flex items-center justify-center flex-none text-sm font-bold transition-colors',
                step.error  ? 'bg-red-100 text-red-500' :
                step.done   ? 'bg-emerald-500 text-white' :
                step.active ? 'bg-primary text-white animate-pulse-slow' :
                              'bg-gray-200 text-gray-400',
              ].join(' ')}>
                {step.error  ? '!' :
                 step.done   ? '✓' :
                 step.active ? '⋯' :
                                i + 1}
              </div>
              {i < steps.length - 1 && (
                <div className={`w-0.5 h-8 mt-0.5 transition-colors ${step.done ? 'bg-emerald-300' : 'bg-gray-200'}`} />
              )}
            </div>

            {/* Right: label + detail */}
            <div className="pb-6">
              <p className={`text-sm font-semibold ${step.error ? 'text-red-600' : step.done || step.active ? 'text-gray-900' : 'text-gray-400'}`}>
                {step.label}
              </p>
              {step.detail && (
                <p className="text-xs font-mono text-gray-500 mt-0.5">{step.detail}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Delivered summary */}
      {isDelivered && remittance?.mxn_amount && (
        <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 space-y-1">
          <p className="text-sm text-emerald-700 font-medium">Monto entregado</p>
          <p className="font-mono text-2xl font-bold text-emerald-700">
            ${formatMxn(remittance.mxn_amount)} MXN
          </p>
          {remittance.resolved_at && (
            <p className="text-xs text-emerald-600">{formatDate(remittance.resolved_at)}</p>
          )}
        </div>
      )}

      {/* Basescan link */}
      {txHash && (
        <a
          href={`${BASESCAN_URL}/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <span className="font-mono">{shortHash(txHash)}</span>
          <span className="text-xs">Ver en Basescan ↗</span>
        </a>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Link href="/history" className="flex-1">
          <Button variant="secondary" size="lg" fullWidth>
            Ver historial
          </Button>
        </Link>
        {isDone && (
          <Link href="/send" className="flex-1">
            <Button size="lg" fullWidth>
              Nueva remesa
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
