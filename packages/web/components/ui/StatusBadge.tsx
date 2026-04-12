type Status = 'pending' | 'processing' | 'delivered' | 'refunded';

const styles: Record<Status, string> = {
  pending:    'bg-gray-100   text-gray-600',
  processing: 'bg-amber-50   text-amber-700',
  delivered:  'bg-emerald-50 text-emerald-700',
  refunded:   'bg-red-50     text-red-600',
};

const labels: Record<Status, string> = {
  pending:    'Pendiente',
  processing: 'En proceso',
  delivered:  'Entregado',
  refunded:   'Reembolsado',
};

const dots: Record<Status, string> = {
  pending:    'bg-gray-400',
  processing: 'bg-amber-500 animate-pulse',
  delivered:  'bg-emerald-500',
  refunded:   'bg-red-500',
};

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${styles[status]} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status]}`} />
      {labels[status]}
    </span>
  );
}
