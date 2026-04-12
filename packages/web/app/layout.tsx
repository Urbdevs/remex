import type { Metadata, Viewport } from 'next';
import { Inter, IBM_Plex_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import { Header }    from '@/components/layout/Header';
import './globals.css';

const inter = Inter({
  subsets:  ['latin'],
  variable: '--font-inter',
  display:  'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets:  ['latin'],
  weight:   ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display:  'swap',
});

export const metadata: Metadata = {
  title:       'remex.mx — Envía dinero a México',
  description: 'Remesas USA → México via USDC en Base L2. Rápido, barato y 100% on-chain.',
  icons:       { icon: '/favicon.ico' },
};

export const viewport: Viewport = {
  width:         'device-width',
  initialScale:  1,
  maximumScale:  1,
  themeColor:    '#0052FF',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body className="min-h-screen flex flex-col">
        <Providers>
          <Header />
          <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-6">
            {children}
          </main>
          <footer className="text-center py-4 text-xs text-gray-400 border-t border-gray-100">
            remex.mx · Remesas on-chain USA→México · Base L2
          </footer>
        </Providers>
      </body>
    </html>
  );
}
