'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { metaMask } from 'wagmi/connectors';
import { useAuth } from '@/components/providers';
import { shortAddress } from '@/lib/utils';

const TIER_LABELS: Record<string, string> = {
  unverified: 'Básico',
  standard:   'Estándar',
  enhanced:   'Avanzado',
};

const TIER_COLORS: Record<string, string> = {
  unverified: 'bg-gray-100 text-gray-600',
  standard:   'bg-blue-50  text-primary',
  enhanced:   'bg-emerald-50 text-emerald-700',
};

export function Header() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect }              = useConnect();
  const { disconnect }           = useDisconnect();
  const { user, logout }         = useAuth();

  const navLinks = [
    { href: '/',        label: 'Inicio'    },
    { href: '/send',    label: 'Enviar'    },
    { href: '/history', label: 'Historial' },
    { href: '/kyc',     label: 'KYC'       },
  ];

  return (
    <header className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <span className="text-xl font-bold text-primary tracking-tight">remex</span>
          <span className="text-xs font-medium text-gray-400 hidden sm:inline">.mx</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {navLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                pathname === href
                  ? 'bg-primary-light text-primary'
                  : 'text-gray-600 hover:bg-gray-100',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* Wallet + tier */}
        <div className="flex items-center gap-2">
          {user?.transaction_tier && (
            <span className={`hidden sm:inline text-xs font-medium px-2 py-1 rounded-full ${TIER_COLORS[user.transaction_tier] ?? TIER_COLORS.unverified}`}>
              {TIER_LABELS[user.transaction_tier] ?? user.transaction_tier}
            </span>
          )}

          {isConnected && address ? (
            <button
              onClick={() => { disconnect(); logout(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-mono text-gray-700 transition-colors"
              title="Desconectar wallet"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {shortAddress(address)}
            </button>
          ) : (
            <button
              onClick={() => connect({ connector: metaMask() })}
              className="px-3 py-1.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-dark transition-colors"
            >
              Conectar
            </button>
          )}
        </div>
      </div>

      {/* Mobile nav */}
      <nav className="sm:hidden flex border-t border-gray-100">
        {navLinks.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={[
              'flex-1 text-center py-2 text-xs font-medium transition-colors',
              pathname === href
                ? 'text-primary border-b-2 border-primary'
                : 'text-gray-500',
            ].join(' ')}
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
