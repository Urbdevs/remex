'use client';

import Link from 'next/link';
import { useAuth } from '@/components/providers';

const TIER_LIMITS: Record<string, number> = {
  unverified: 500,
  standard:   3_000,
  enhanced:   10_000,
};

const TIER_LABELS: Record<string, string> = {
  unverified: 'Básico',
  standard:   'Estándar',
  enhanced:   'Avanzado',
};

export function KycBanner() {
  const { user } = useAuth();

  if (!user) return null;

  const tier    = user.transaction_tier;
  const limit   = TIER_LIMITS[tier] ?? 500;
  const isApproved = user.kyc_status === 'approved';

  if (!isApproved || tier === 'enhanced') return null;

  return (
    <div className={`rounded-2xl border p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3 ${
      tier === 'unverified'
        ? 'bg-amber-50 border-amber-200'
        : 'bg-blue-50 border-blue-200'
    }`}>
      <div className="text-2xl">{tier === 'unverified' ? '⚠️' : '🔐'}</div>
      <div className="flex-1">
        <p className="font-semibold text-gray-900 text-sm">
          {tier === 'unverified'
            ? 'Completa KYC para enviar más'
            : 'Verifica tu identidad avanzada'}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          Tier actual: <span className="font-medium">{TIER_LABELS[tier]}</span> —
          límite diario ${limit.toLocaleString()} USD.
          {tier === 'unverified' && ' Mejora a Estándar para $3,000/día.'}
          {tier === 'standard'   && ' Mejora a Avanzado para $10,000/día.'}
        </p>
      </div>
      <Link
        href="/kyc"
        className="flex-none text-sm font-semibold text-primary hover:underline whitespace-nowrap"
      >
        Verificar ahora →
      </Link>
    </div>
  );
}
