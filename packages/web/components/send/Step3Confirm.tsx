'use client';

import { useState } from 'react';
import { parseUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';
import { useWriteContract } from 'wagmi';
import { readContract, waitForTransactionReceipt } from 'wagmi/actions';
import { useQuery } from '@tanstack/react-query';
import { Button }      from '@/components/ui/Button';
import { useAuth }     from '@/components/providers';
import { estimateMxn, formatMxn, formatUsd, hashString, FEE_BPS } from '@/lib/utils';
import { api } from '@/lib/api';
import { REMEX_BRIDGE_ABI, ERC20_ABI } from '@/lib/abis';
import { CONTRACT_ADDRESS, USDC_ADDRESS, wagmiConfig } from '@/lib/wagmi';
import type { FxRateResponse } from '@/lib/api';
import type { SendFormData } from './SendStepper';

interface Props {
  form:    SendFormData;
  update:  (patch: Partial<SendFormData>) => void;
  onNext:  () => void;
  onBack:  () => void;
}

type TxStep = 'idle' | 'saving-info' | 'checking-limit' | 'checking-allowance' | 'approving' | 'sending' | 'waiting' | 'error';

export function Step3Confirm({ form, update, onNext, onBack }: Props) {
  const { address } = useAccount();
  const { user }    = useAuth();
  const [txStep, setTxStep] = useState<TxStep>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const { data: fxData } = useQuery<FxRateResponse>({
    queryKey: ['fx-rate'],
    queryFn:  () => fetch('/api/fx-rate').then(r => r.json()),
    staleTime: 25_000,
  });

  const fxRate = fxData?.rate ?? 17.50;
  const est    = estimateMxn(form.amountUsd, fxRate);

  const { writeContractAsync } = useWriteContract();

  const STEP_LABELS: Record<TxStep, string> = {
    'idle':               'Confirmar y enviar',
    'saving-info':        'Guardando datos del receptor…',
    'checking-limit':     'Verificando límite FinCEN…',
    'checking-allowance': 'Verificando allowance USDC…',
    'approving':          'Aprobando USDC (1/2)…',
    'waiting':            'Esperando confirmación…',
    'sending':            'Enviando remesa (2/2)…',
    'error':              'Reintentar',
  };

  async function handleSend() {
    if (!address) return;
    setErrorMsg('');

    const amountUsdc = parseUnits(form.amountUsd.toString(), 6);
    if (amountUsdc === 0n) {
      setErrorMsg('Monto inválido. Por favor regresa al paso 1.');
      setTxStep('error');
      return;
    }

    try {
      // 1. Save recipient info
      setTxStep('saving-info');
      const clabeHash     = hashString(form.clabeNumber);
      const recipientHash = hashString(form.recipientName);
      update({ clabeHash, recipientHash });
      await api.saveRecipientInfo({ clabeHash, recipientPhone: form.recipientPhone });

      // 2. Check FinCEN limit
      setTxStep('checking-limit');
      const limitCheck = await api.checkLimit(form.amountUsd);
      if (!limitCheck.allowed) {
        setErrorMsg(`Límite diario excedido. Restante: $${limitCheck.remaining.toFixed(2)} USD (tier ${limitCheck.tier})`);
        setTxStep('error');
        return;
      }

      // 3. Check USDC allowance
      setTxStep('checking-allowance');
      const allowance = await readContract(wagmiConfig, {
        abi:          ERC20_ABI,
        address:      USDC_ADDRESS,
        functionName: 'allowance',
        args:         [address, CONTRACT_ADDRESS],
      });

      // 4. Approve USDC if needed
      if ((allowance as bigint) < amountUsdc) {
        setTxStep('approving');
        const approveTxHash = await writeContractAsync({
          abi:          ERC20_ABI,
          address:      USDC_ADDRESS,
          functionName: 'approve',
          args:         [CONTRACT_ADDRESS, amountUsdc],
        });
        setTxStep('waiting');
        await waitForTransactionReceipt(wagmiConfig, { hash: approveTxHash });
      }

      // 5. Call sendRemittance
      setTxStep('sending');
      const txHash = await writeContractAsync({
        abi:          REMEX_BRIDGE_ABI,
        address:      CONTRACT_ADDRESS,
        functionName: 'sendRemittance',
        args:         [amountUsdc, clabeHash, recipientHash],
      });

      // 6. Wait for receipt
      setTxStep('waiting');
      await waitForTransactionReceipt(wagmiConfig, { hash: txHash });

      // 7. Move to tracking step
      update({ txHash, clabeHash, recipientHash });
      onNext();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      // Handle user rejection gracefully
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setErrorMsg('Transacción cancelada por el usuario.');
      } else {
        setErrorMsg(msg.slice(0, 200));
      }
      setTxStep('error');
    }
  }

  const isLoading = txStep !== 'idle' && txStep !== 'error';

  return (
    <div className="space-y-5">
      <h2 className="section-title">Confirmar envío</h2>

      {/* Summary card */}
      <div className="rounded-2xl border border-gray-200 divide-y divide-gray-100 text-sm">
        <Row label="Envías"      value={`$${formatUsd(form.amountUsd)} USDC`} mono />
        <Row label={`Fee (${(FEE_BPS/100).toFixed(1)}%)`} value={`-$${formatUsd(est.fee)} USDC`} mono />
        <Row label="Tipo de cambio" value={`${fxRate.toFixed(4)} MXN/USDC`} />
        <Row label="Receptor recibe" value={`~$${formatMxn(est.mxn)} MXN`} highlight mono />

        <div className="px-4 pt-3 pb-4 space-y-2 bg-gray-50 rounded-b-2xl">
          <p className="label">Destinatario</p>
          <p className="font-medium text-gray-900">{form.recipientName}</p>
          <p className="text-gray-500">{form.bankName}</p>
          <p className="font-mono text-gray-600 text-xs">{form.clabeNumber}</p>
          <p className="text-gray-500 text-xs">{form.recipientPhone}</p>
        </div>
      </div>

      {/* Two-tx explanation */}
      <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs text-blue-700 space-y-1">
        <p className="font-semibold">⚡ Necesitas 2 transacciones en MetaMask:</p>
        <ol className="list-decimal list-inside space-y-0.5 text-blue-600">
          <li>Aprobar USDC al contrato (si no tienes allowance)</li>
          <li>Enviar la remesa al contrato RemexBridge</li>
        </ol>
      </div>

      {/* Progress indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <svg className="animate-spin w-4 h-4 text-primary flex-none" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          {STEP_LABELS[txStep]}
        </div>
      )}

      {/* Error */}
      {txStep === 'error' && errorMsg && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600">
          {errorMsg}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="ghost" size="lg" onClick={onBack} disabled={isLoading} className="flex-none">
          ← Atrás
        </Button>
        <Button
          size="lg"
          fullWidth
          loading={isLoading}
          onClick={handleSend}
        >
          {STEP_LABELS[isLoading ? txStep : txStep === 'error' ? 'error' : 'idle']}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className="flex justify-between items-center px-4 py-3">
      <span className="text-gray-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-emerald-700 font-bold text-base' : 'text-gray-800 font-medium'}`}>
        {value}
      </span>
    </div>
  );
}
