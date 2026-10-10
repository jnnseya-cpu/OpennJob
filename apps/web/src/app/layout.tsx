import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpennJob',
  description: 'Find jobs that fit your CV, review each application, and stay in control of what is sent.',
  referrer: 'no-referrer',
  icons: { icon: '/brand/opennjob-logo-192.png', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1a3c8a' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <Script src="/theme.js" strategy="beforeInteractive" />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
