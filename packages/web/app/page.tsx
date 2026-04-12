import { ExchangeSimulator } from '@/components/home/ExchangeSimulator';
import { TrustBar }          from '@/components/home/TrustBar';

export default function HomePage() {
  return (
    <div className="flex flex-col items-center gap-8 pt-4 pb-12">
      {/* Hero */}
      <div className="text-center space-y-2 max-w-md">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">
          Envía dinero a<br />
          <span className="text-primary">México en minutos</span>
        </h1>
        <p className="text-gray-500 text-base">
          USDC en Base L2 → SPEI. Sin bancos intermediarios.
        </p>
      </div>

      {/* Trust bar */}
      <TrustBar />

      {/* Simulator card */}
      <div className="card w-full max-w-md p-6 space-y-5">
        <ExchangeSimulator />
      </div>

      {/* How it works */}
      <div className="w-full max-w-md">
        <h2 className="text-center text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
          ¿Cómo funciona?
        </h2>
        <div className="space-y-3">
          {[
            { n: '1', title: 'Ingresa el monto y la CLABE',  desc: 'Del receptor en México'          },
            { n: '2', title: 'Conecta MetaMask',              desc: 'Firma con tu wallet de Base L2'  },
            { n: '3', title: 'Confirma la transacción',       desc: 'USDC → contrato RemexBridge'     },
            { n: '4', title: 'El receptor recibe MXN',        desc: 'Vía SPEI en < 8 minutos'        },
          ].map(({ n, title, desc }) => (
            <div key={n} className="flex items-start gap-3 card p-4">
              <span className="flex-none w-7 h-7 rounded-full bg-primary text-white text-sm font-bold flex items-center justify-center">
                {n}
              </span>
              <div>
                <p className="font-semibold text-sm text-gray-900">{title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
