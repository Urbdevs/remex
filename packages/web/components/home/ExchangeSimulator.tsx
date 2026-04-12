'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { estimateMxn, formatUsd, formatMxn, FEE_BPS } from '@/lib/utils';
import type { FxRateResponse } from '@/lib/api';

const MIN_USD = 10;
const MAX_USD = 2999;

export function ExchangeSimulator() {
  const router = useRouter();
  const [amount, setAmount] = useState<string>('100');

  const amountNum = parseFloat(amount) || 0;
  const isValid   = amountNum >= MIN_USD && amountNum <= MAX_USD;

  // Fetch FX rate (via our proxy to avoid CORS)
  const { data: fxData, isLoading: rateLoading } = useQuery<FxRateResponse>({
    queryKey:       ['fx-rate'],
    queryFn:        () => fetch('/api/fx-rate').then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       25_000,
  });

  const fxRate = fxData?.rate ?? 17.50;
  const est    = estimateMxn(amountNum, fxRate);

  // Flash update indicator
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (fxData) { setFlash(true); setTimeout(() => setFlash(false), 800); }
  }, [fxData?.updatedAt]);

  return (
    <div className="space-y-4">
      {/* Rate display */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">Tipo de cambio</span>
        <span className={`font-mono text-sm font-semibold transition-colors ${flash ? 'text-primary' : 'text-gray-700'}`}>
          {rateLoading ? (
            <span className="inline-block w-16 h-4 bg-gray-200 rounded animate-pulse" />
          ) : (
            <>
              1 USDC = <span className="text-primary">{fxRate.toFixed(4)}</span> MXN
              {fxData?.fallback && <span className="ml-1 text-xs text-gray-400">(est.)</span>}
            </>
          )}
        </span>
      </div>

      {/* Amount input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Tú envías (USD)
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-lg pointer-events-none">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={MIN_USD}
            max={MAX_USD}
            step="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className={[
              'w-full pl-9 pr-16 py-4 text-2xl font-mono font-semibold rounded-2xl border-2 bg-white',
              'focus:outline-none transition-colors',
              isValid || amountNum === 0
                ? 'border-gray-200 focus:border-primary'
                : 'border-red-300 focus:border-red-400',
            ].join(' ')}
            placeholder="100"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-medium pointer-events-none">
            USDC
          </span>
        </div>
        {amountNum > 0 && !isValid && (
          <p className="text-xs text-red-500 mt-1">
            {amountNum < MIN_USD ? `Mínimo $${MIN_USD} USD` : `Máximo $${MAX_USD} USD`}
          </p>
        )}
        <p className="text-xs text-gray-400 mt-1">
          Límite: ${MIN_USD}–${MAX_USD} USD · Diario: $5,000 USDC
        </p>
      </div>

      {/* Breakdown */}
      {amountNum > 0 && isValid && (
        <div className="rounded-xl bg-gray-50 border border-gray-200 divide-y divide-gray-200">
          <div className="flex justify-between px-4 py-2.5 text-sm">
            <span className="text-gray-500">Fee ({(FEE_BPS / 100).toFixed(1)}%)</span>
            <span className="font-mono text-gray-700">−${formatUsd(est.fee)} USDC</span>
          </div>
          <div className="flex justify-between px-4 py-2.5 text-sm">
            <span className="text-gray-500">Monto neto</span>
            <span className="font-mono text-gray-700">${formatUsd(est.net)} USDC</span>
          </div>
          <div className="flex justify-between px-4 py-3 bg-white rounded-b-xl">
            <span className="font-semibold text-gray-900">El receptor recibe</span>
            <span className="font-mono font-bold text-emerald-600 text-lg">
              ${formatMxn(est.mxn)} MXN
            </span>
          </div>
        </div>
      )}

      {/* CTA */}
      <Button
        size="lg"
        fullWidth
        disabled={!isValid || amountNum === 0}
        onClick={() => router.push(`/send?amount=${amountNum}`)}
        className="text-base mt-2"
      >
        Enviar ahora →
      </Button>
    </div>
  );
}
