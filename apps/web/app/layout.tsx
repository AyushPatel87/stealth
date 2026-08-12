import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stealth — Options Intelligence',
  description:
    'Scans US equity options for cash-secured puts, covered calls and credit spreads, and explains every score.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
