import { Suspense } from 'react';
import { SendStepperWrapper } from './SendStepperWrapper';

export default function SendPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-gray-400">Cargando…</div>}>
      <SendStepperWrapper />
    </Suspense>
  );
}
