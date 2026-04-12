'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth }         from '@/components/providers';
import { TransferCard }    from './TransferCard';
import { api }             from '@/lib/api';
import type { Transfer }   from '@/lib/api';

type FilterStatus = 'all' | Transfer['status'];

const FILTERS: { value: FilterStatus; label: string }[] = [
  { value: 'all',        label: 'Todas'       },
  { value: 'processing', label: 'En proceso'  },
  { value: 'delivered',  label: 'Entregadas'  },
  { value: 'refunded',   label: 'Reembolsadas'},
  { value: 'pending',    label: 'Pendientes'  },
];

export function TransferList() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<FilterStatus>('all');

  const { data, isLoading, isError } = useQuery({
    queryKey:        ['transfers', user?.id],
    queryFn:         () => api.getTransfers({ limit: 50 }),
    refetchInterval: 10_000,
    enabled:         !!user,
  });

  if (!user) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-2xl">🔒</p>
        <p className="text-gray-500">Conecta tu wallet para ver tu historial.</p>
      </div>
    );
  }

  const transfers = data?.data ?? [];
  const filtered  = filter === 'all' ? transfers : transfers.filter(t => t.status === filter);

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
        {FILTERS.map(({ value, label }) => {
          const count = value === 'all'
            ? transfers.length
            : transfers.filter(t => t.status === value).length;
          return (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={[
                'flex-none px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap',
                filter === value
                  ? 'bg-primary text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-primary hover:text-primary',
              ].join(' ')}
            >
              {label}
              {count > 0 && (
                <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${filter === value ? 'bg-white/20' : 'bg-gray-100'}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="card p-4 h-32 animate-pulse bg-gray-100" />
          ))}
        </div>
      ) : isError ? (
        <div className="text-center py-8 text-red-500 text-sm">
          Error cargando historial. Verifica que la API esté corriendo.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-3xl">📭</p>
          <p className="text-gray-500">
            {filter === 'all'
              ? 'Aún no has enviado ninguna remesa.'
              : `No hay remesas con estado "${FILTERS.find(f => f.value === filter)?.label}".`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(t => (
            <TransferCard key={t.remittance_id} transfer={t} />
          ))}
        </div>
      )}
    </div>
  );
}
