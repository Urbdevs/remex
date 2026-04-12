'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input }  from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { estimateMxn, formatMxn, formatUsd, isValidClabe, isValidPhone, FEE_BPS } from '@/lib/utils';
import type { FxRateResponse } from '@/lib/api';
import type { SendFormData } from './SendStepper';

const MEXICAN_BANKS = [
  'BBVA México', 'Santander', 'Banorte', 'HSBC', 'Banamex / Citi',
  'Scotiabank', 'Inbursa', 'Azteca', 'Hey Banco', 'Nubank', 'Otro',
];

interface Props {
  form:    SendFormData;
  update:  (patch: Partial<SendFormData>) => void;
  onNext:  () => void;
}

interface Errors {
  amountUsd?:      string;
  recipientName?:  string;
  clabeNumber?:    string;
  bankName?:       string;
  recipientPhone?: string;
}

export function Step1Amount({ form, update, onNext }: Props) {
  const [errors, setErrors] = useState<Errors>({});

  const { data: fxData } = useQuery<FxRateResponse>({
    queryKey:        ['fx-rate'],
    queryFn:         () => fetch('/api/fx-rate').then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       25_000,
  });

  const fxRate = fxData?.rate ?? 17.50;
  const est    = estimateMxn(form.amountUsd, fxRate);

  function validate(): boolean {
    const e: Errors = {};
    if (!form.amountUsd || form.amountUsd < 10)    e.amountUsd      = 'Mínimo $10 USD';
    if (form.amountUsd > 2999)                       e.amountUsd      = 'Máximo $2,999 USD';
    if (!form.recipientName.trim())                  e.recipientName  = 'Ingresa el nombre del receptor';
    if (!isValidClabe(form.clabeNumber))             e.clabeNumber    = 'CLABE inválida (18 dígitos)';
    if (!form.bankName)                              e.bankName       = 'Selecciona un banco';
    if (!isValidPhone(form.recipientPhone))          e.recipientPhone = 'Teléfono inválido. Ej: +521234567890';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleNext() {
    if (validate()) onNext();
  }

  return (
    <div className="space-y-5">
      <h2 className="section-title">Monto y destinatario</h2>

      {/* Amount */}
      <div className="space-y-1">
        <label className="text-sm font-medium text-gray-700">Tú envías (USD)</label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-xl pointer-events-none">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={10}
            max={2999}
            value={form.amountUsd || ''}
            onChange={e => update({ amountUsd: parseFloat(e.target.value) || 0 })}
            className={[
              'w-full pl-9 pr-20 py-4 text-2xl font-mono font-semibold rounded-xl border-2 bg-white',
              'focus:outline-none transition-colors',
              errors.amountUsd ? 'border-red-300' : 'border-gray-200 focus:border-primary',
            ].join(' ')}
            placeholder="100"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-medium pointer-events-none">
            USDC
          </span>
        </div>
        {errors.amountUsd && <p className="text-xs text-red-500">{errors.amountUsd}</p>}
      </div>

      {/* Live estimate */}
      {form.amountUsd >= 10 && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex justify-between items-center">
          <div>
            <p className="text-xs text-emerald-600 font-medium">El receptor recibe ~</p>
            <p className="font-mono text-xl font-bold text-emerald-700">${formatMxn(est.mxn)} MXN</p>
          </div>
          <div className="text-right text-xs text-gray-500">
            <p>Fee {(FEE_BPS / 100).toFixed(1)}%: ${formatUsd(est.fee)}</p>
            <p>Rate: {fxRate.toFixed(4)} MXN/USD</p>
          </div>
        </div>
      )}

      <div className="border-t border-gray-100 pt-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">Datos del receptor</h3>

        <Input
          label="Nombre completo"
          placeholder="María González"
          value={form.recipientName}
          onChange={e => update({ recipientName: e.target.value })}
          error={errors.recipientName}
        />

        <Input
          label="CLABE interbancaria"
          placeholder="002180700054321234"
          value={form.clabeNumber}
          onChange={e => update({ clabeNumber: e.target.value.replace(/\D/g, '').slice(0, 18) })}
          error={errors.clabeNumber}
          hint="18 dígitos del banco destino"
          mono
          maxLength={18}
        />

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Banco</label>
          <select
            value={form.bankName}
            onChange={e => update({ bankName: e.target.value })}
            className={[
              'w-full rounded-xl border px-3 py-3 text-sm bg-white text-gray-900',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-colors',
              errors.bankName ? 'border-red-400' : 'border-gray-200 hover:border-gray-300',
            ].join(' ')}
          >
            <option value="">Seleccionar banco...</option>
            {MEXICAN_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          {errors.bankName && <p className="text-xs text-red-500">{errors.bankName}</p>}
        </div>

        <Input
          label="WhatsApp del receptor (México)"
          placeholder="+521234567890"
          value={form.recipientPhone}
          onChange={e => update({ recipientPhone: e.target.value })}
          error={errors.recipientPhone}
          hint="Formato internacional: +52..."
          type="tel"
        />
      </div>

      <Button size="lg" fullWidth onClick={handleNext}>
        Siguiente: Conectar wallet →
      </Button>
    </div>
  );
}
