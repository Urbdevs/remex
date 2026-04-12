'use client';

import { useState } from 'react';
import { Step1Amount }   from './Step1Amount';
import { Step2Wallet }   from './Step2Wallet';
import { Step3Confirm }  from './Step3Confirm';
import { Step4Tracking } from './Step4Tracking';

export interface SendFormData {
  // Step 1
  amountUsd:     number;
  recipientName: string;
  clabeNumber:   string;
  bankName:      string;
  recipientPhone: string;
  // Derived hashes (computed before Step 3)
  clabeHash?:     `0x${string}`;
  recipientHash?: `0x${string}`;
  // Step 4
  txHash?:        `0x${string}`;
}

const STEPS = [
  'Monto y destinatario',
  'Conectar wallet',
  'Confirmar',
  'Seguimiento',
];

export function SendStepper({ initialAmount }: { initialAmount?: number }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SendFormData>({
    amountUsd:      initialAmount ?? 100,
    recipientName:  '',
    clabeNumber:    '',
    bankName:       '',
    recipientPhone: '',
  });

  function update(patch: Partial<SendFormData>) {
    setForm(prev => ({ ...prev, ...patch }));
  }

  function next() { setStep(s => Math.min(s + 1, STEPS.length - 1)); }
  function back() { setStep(s => Math.max(s - 1, 0)); }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Step indicators */}
      <div className="flex items-center gap-0">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            {/* Circle */}
            <div className="flex flex-col items-center gap-1 flex-none">
              <div className={[
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors',
                i < step  ? 'bg-primary text-white'              :
                i === step ? 'bg-primary text-white ring-4 ring-primary-light' :
                              'bg-gray-200 text-gray-400',
              ].join(' ')}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${i === step ? 'text-primary' : 'text-gray-400'}`}>
                {label}
              </span>
            </div>
            {/* Connector */}
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 transition-colors ${i < step ? 'bg-primary' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step title (mobile) */}
      <p className="sm:hidden text-center text-sm font-semibold text-gray-600">
        Paso {step + 1}: {STEPS[step]}
      </p>

      {/* Step content */}
      <div className="card p-5 sm:p-6">
        {step === 0 && <Step1Amount form={form} update={update} onNext={next} />}
        {step === 1 && <Step2Wallet form={form} onNext={next} onBack={back} />}
        {step === 2 && <Step3Confirm form={form} update={update} onNext={next} onBack={back} />}
        {step === 3 && <Step4Tracking form={form} />}
      </div>
    </div>
  );
}
