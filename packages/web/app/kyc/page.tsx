'use client';

import { useAuth }      from '@/components/providers';
import { KycWidget }    from '@/components/kyc/KycWidget';
import { KycBanner }    from '@/components/kyc/KycBanner';

const KYC_STATUS_INFO: Record<string, { label: string; color: string; desc: string }> = {
  none:         { label: 'No iniciado', color: 'gray',    desc: 'Completa la verificación para empezar a enviar.'       },
  pending:      { label: 'Pendiente',   color: 'amber',   desc: 'Tu solicitud está siendo revisada.'                    },
  submitted:    { label: 'Enviado',     color: 'blue',    desc: 'Verificando tu identidad...'                            },
  approved:     { label: 'Aprobado ✓',  color: 'emerald', desc: 'Tu identidad está verificada. Puedes enviar remesas.'   },
  declined:     { label: 'Rechazado',   color: 'red',     desc: 'Tu solicitud fue rechazada. Intenta de nuevo.'          },
  under_review: { label: 'En revisión', color: 'blue',    desc: 'Un agente está revisando tu solicitud.'                 },
};

const TIER_INFO = {
  unverified: { label: 'Básico',   limit: '$500/día',    next: 'standard' },
  standard:   { label: 'Estándar', limit: '$3,000/día',  next: 'enhanced' },
  enhanced:   { label: 'Avanzado', limit: '$10,000/día', next: null       },
} as const;

export default function KycPage() {
  const { user } = useAuth();

  if (!user) {
    return (
      <div className="max-w-lg mx-auto text-center py-12 space-y-3">
        <p className="text-2xl">🔒</p>
        <p className="text-gray-500">Conecta tu wallet para acceder a la verificación KYC.</p>
      </div>
    );
  }

  const kycInfo  = KYC_STATUS_INFO[user.kyc_status] ?? KYC_STATUS_INFO.none;
  const tierInfo = TIER_INFO[user.transaction_tier]  ?? TIER_INFO.unverified;

  const colorClasses: Record<string, string> = {
    gray:    'bg-gray-50   border-gray-200   text-gray-700',
    amber:   'bg-amber-50  border-amber-200  text-amber-700',
    blue:    'bg-blue-50   border-blue-200   text-blue-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    red:     'bg-red-50    border-red-200    text-red-700',
  };

  const isApproved = user.kyc_status === 'approved';

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h1 className="section-title">Verificación de identidad</h1>

      {/* Current status */}
      <div className={`rounded-2xl border p-4 space-y-1 ${colorClasses[kycInfo.color]}`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Estado KYC</span>
          <span className="text-sm font-bold">{kycInfo.label}</span>
        </div>
        <p className="text-xs">{kycInfo.desc}</p>
      </div>

      {/* Tier breakdown */}
      <div className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Tu tier actual</h2>
        <div className="space-y-2">
          {(Object.entries(TIER_INFO) as [keyof typeof TIER_INFO, typeof TIER_INFO[keyof typeof TIER_INFO]][]).map(([key, info]) => {
            const isCurrent = key === user.transaction_tier;
            const isPast    = Object.keys(TIER_INFO).indexOf(key) < Object.keys(TIER_INFO).indexOf(user.transaction_tier);
            return (
              <div
                key={key}
                className={[
                  'flex items-center justify-between rounded-xl px-4 py-3 border transition-colors',
                  isCurrent ? 'border-primary bg-primary-light'        :
                  isPast    ? 'border-emerald-200 bg-emerald-50'        :
                              'border-gray-100 bg-gray-50 opacity-50',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{isPast || isCurrent ? '✓' : '○'}</span>
                  <div>
                    <p className={`text-sm font-semibold ${isCurrent ? 'text-primary' : isPast ? 'text-emerald-700' : 'text-gray-400'}`}>
                      {info.label}
                    </p>
                    <p className="text-xs text-gray-500">{info.limit}</p>
                  </div>
                </div>
                {isCurrent && (
                  <span className="text-xs font-semibold text-primary bg-white px-2 py-0.5 rounded-full border border-primary">
                    Actual
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Verification widget */}
      {(!isApproved || user.transaction_tier !== 'enhanced') && (
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">
            {!isApproved
              ? 'Completar verificación de identidad'
              : `Mejorar a tier ${TIER_INFO[tierInfo.next as keyof typeof TIER_INFO]?.label ?? 'Avanzado'}`}
          </h2>
          <KycWidget />
        </div>
      )}

      {/* Approved and max tier */}
      {isApproved && user.transaction_tier === 'enhanced' && (
        <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-5 text-center space-y-2">
          <p className="text-3xl">🏆</p>
          <p className="font-semibold text-emerald-800">Verificación completa</p>
          <p className="text-sm text-emerald-700">
            Tier Avanzado activo — límite $10,000 USD/día.
          </p>
        </div>
      )}
    </div>
  );
}
