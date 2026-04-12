'use client';

import { useSearchParams } from 'next/navigation';
import { SendStepper } from '@/components/send/SendStepper';

export function SendStepperWrapper() {
  const params      = useSearchParams();
  const rawAmount   = params.get('amount');
  const initialAmt  = rawAmount ? parseFloat(rawAmount) : undefined;

  return <SendStepper initialAmount={initialAmt} />;
}
