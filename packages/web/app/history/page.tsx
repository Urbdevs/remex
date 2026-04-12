import { TransferList } from '@/components/history/TransferList';

export default function HistoryPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="section-title">Historial de remesas</h1>
        <p className="text-sm text-gray-500 mt-1">Se actualiza cada 10 segundos.</p>
      </div>
      <TransferList />
    </div>
  );
}
