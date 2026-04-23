'use client';

import { useEffect } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { metaMask } from 'wagmi/connectors';
import { useReadContract } from 'wagmi';
import { Button }    from '@/components/ui/Button';
import { useAuth }   from '@/components/providers';
import { shortAddress, formatUsdc } from '@/lib/utils';
import { ERC20_ABI } from '@/lib/abis';
import { USDC_ADDRESS } from '@/lib/wagmi';
import type { SendFormData } from './SendStepper';

interface Props {
  form:    SendFormData;
  onNext:  () => void;
  onBack:  () => void;
}

export function Step2Wallet({ form, onNext, onBack }: Props) {
  const { address, isConnected } = useAccount();
  const { connect, isPending: connectPending } = useConnect();
  const { user, loading: authLoading } = useAuth();

  // Bypass KYC check in development when NEXT_PUBLIC_SKIP_KYC_DEV=true
  const skipKycDev =
    process.env.NEXT_PUBLIC_SKIP_KYC_DEV === 'true' &&
    process.env.NODE_ENV === 'development';
  const kycApproved = skipKycDev || user?.kyc_status === 'approved';

  // Read USDC balance
  const { data: usdcBalance } = useReadContract({
    abi:          ERC20_ABI,
    address:      USDC_ADDRESS,
    functionName: 'balanceOf',
    args:         address ? [address] : undefined,
    query:        { enabled: !!address },
  });

  const balanceNum = usdcBalance ? Number(usdcBalance) / 1_000_000 : 0;
  const needsMore  = balanceNum < form.amountUsd;
  const isReady    = isConnected && !!user && !authLoading;

  return (
    <div className="space-y-5">
      <h2 className="section-title">Conectar wallet</h2>
      <p className="text-sm text-gray-500">
        Necesitas MetaMask con USDC en la red Base {process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? '' : 'Sepolia'}.
      </p>

      {!isConnected ? (
        <div className="space-y-4">
          {/* MetaMask connect */}
          <button
            onClick={() => connect({ connector: metaMask() })}
            disabled={connectPending}
            className="w-full flex items-center justify-between p-4 rounded-2xl border-2 border-gray-200 hover:border-primary hover:bg-primary-light transition-all group"
          >
            <div className="flex items-center gap-3">
              {/* MetaMask fox icon (simplified) */}
              <div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center text-2xl">🦊</div>
              <div className="text-left">
                <p className="font-semibold text-gray-900">MetaMask</p>
                <p className="text-xs text-gray-500">Extensión de navegador</p>
              </div>
            </div>
            {connectPending ? (
              <svg className="animate-spin w-5 h-5 text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <span className="text-gray-400 group-hover:text-primary text-lg">→</span>
            )}
          </button>

          <p className="text-center text-xs text-gray-400">
            ¿No tienes MetaMask?{' '}
            <a href="https://metamask.io" target="_blank" rel="noopener noreferrer" className="text-primary underline">
              Descargar
            </a>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Connected wallet info */}
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Wallet conectada</span>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="font-mono text-sm font-medium text-gray-800">{shortAddress(address!)}</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Balance USDC</span>
              <span className={`font-mono text-sm font-semibold ${needsMore ? 'text-red-500' : 'text-gray-800'}`}>
                {usdcBalance != null ? `$${formatUsdc(usdcBalance)} USDC` : '—'}
              </span>
            </div>

            {needsMore && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
                Balance insuficiente. Necesitas al menos ${form.amountUsd.toFixed(2)} USDC.
              </div>
            )}
          </div>

          {/* Auth status */}
          {authLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <svg className="animate-spin w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Firmando mensaje SIWE…
            </div>
          ) : user ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <span>✓</span>
              <span>Autenticado como {user.full_name ?? shortAddress(address!)}</span>
            </div>
          ) : null}

          {/* KYC warning — hidden when skipKycDev=true */}
          {user && !kycApproved && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
              <p className="font-semibold">⚠️ Verificación de identidad requerida</p>
              <p className="text-xs mt-1">
                Debes completar KYC antes de enviar remesas.{' '}
                <a href="/kyc" className="underline font-medium">Verificar ahora →</a>
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button variant="ghost" size="lg" onClick={onBack} className="flex-none">
          ← Atrás
        </Button>
        <Button
          size="lg"
          fullWidth
          disabled={!isReady || needsMore || !kycApproved}
          onClick={onNext}
        >
          Siguiente: Revisar →
        </Button>
      </div>
    </div>
  );
}
