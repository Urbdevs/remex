'use client';

import { useState, useCallback } from 'react';
import Script from 'next/script';
import { Button } from '@/components/ui/Button';

// Persona SDK is loaded from CDN and attached to window.Persona
declare global {
  interface Window {
    Persona?: {
      Client: new (options: PersonaOptions) => PersonaClient;
    };
  }
}

interface PersonaOptions {
  templateId:  string;
  environment: 'production' | 'sandbox';
  onReady:     () => void;
  onComplete:  (data: { inquiryId: string; status: string }) => void;
  onCancel:    () => void;
  onError:     (error: unknown) => void;
}

interface PersonaClient {
  open: () => void;
}

export function KycWidget() {
  const [sdkLoaded,   setSdkLoaded]   = useState(false);
  const [launching,   setLaunching]   = useState(false);
  const [completed,   setCompleted]   = useState(false);
  const [inquiryId,   setInquiryId]   = useState<string | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  const templateId  = process.env.NEXT_PUBLIC_PERSONA_TEMPLATE_ID ?? '';
  const environment = (process.env.NEXT_PUBLIC_PERSONA_ENV ?? 'sandbox') as 'production' | 'sandbox';

  const startInquiry = useCallback(() => {
    if (!window.Persona || !templateId) {
      setError('SDK no disponible. Recarga la página.');
      return;
    }
    setLaunching(true);
    setError(null);

    const client = new window.Persona.Client({
      templateId,
      environment,
      onReady: () => { setLaunching(false); client.open(); },
      onComplete: ({ inquiryId: id, status }) => {
        setCompleted(true);
        setInquiryId(id);
        // The API will receive the webhook from Persona and update kyc_status
      },
      onCancel: () => { setLaunching(false); },
      onError:  (err) => {
        setLaunching(false);
        setError('Error al abrir la verificación. Intenta de nuevo.');
        console.error('Persona error:', err);
      },
    });
  }, [templateId, environment]);

  if (!templateId) {
    return (
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 text-sm text-gray-500">
        KYC no configurado. Define <code className="font-mono text-xs bg-gray-100 px-1 rounded">NEXT_PUBLIC_PERSONA_TEMPLATE_ID</code> en .env.local.
      </div>
    );
  }

  if (completed) {
    return (
      <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-5 text-center space-y-2">
        <p className="text-3xl">✅</p>
        <p className="font-semibold text-emerald-800">Verificación enviada</p>
        <p className="text-sm text-emerald-700">
          Tu solicitud está siendo revisada. Recibirás una notificación cuando sea aprobada.
        </p>
        {inquiryId && (
          <p className="text-xs font-mono text-emerald-600">ID: {inquiryId}</p>
        )}
      </div>
    );
  }

  return (
    <>
      <Script
        src="https://cdn.withpersona.com/dist/persona-v4.8.0.js"
        onLoad={() => setSdkLoaded(true)}
        onError={() => setError('No se pudo cargar el SDK de verificación.')}
      />

      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          La verificación de identidad es requerida por regulaciones FinCEN/MSB para
          procesar remesas internacionales.
        </p>
        <ul className="text-sm text-gray-500 space-y-1.5">
          {['Identificación oficial (pasaporte o licencia)', 'Selfie en tiempo real', 'Toma ~3 minutos'].map(item => (
            <li key={item} className="flex items-center gap-2">
              <span className="text-primary">✓</span> {item}
            </li>
          ))}
        </ul>

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
            {error}
          </div>
        )}

        <Button
          size="lg"
          fullWidth
          disabled={!sdkLoaded}
          loading={launching || !sdkLoaded}
          onClick={startInquiry}
        >
          {!sdkLoaded ? 'Cargando…' : 'Comenzar verificación'}
        </Button>
      </div>
    </>
  );
}
