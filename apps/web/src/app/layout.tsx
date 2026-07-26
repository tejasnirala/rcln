import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';
import './globals.css';

/*
 * Three roles from one superfamily, exposed as CSS variables and mapped to
 * --font-display / --font-sans / --font-mono in globals.css.
 *
 * Plex Sans ships a variable axis; Plex Serif and Plex Mono do not, so their
 * weights have to be listed or next/font throws at build time. Keep the lists
 * short — every weight is another file on the wire.
 */
const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
});

const plexSerif = IBM_Plex_Serif({
  variable: '--font-plex-serif',
  subsets: ['latin'],
  weight: ['600'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
});

const siteUrl = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://rcln.com';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'rcln — one record, from token to invoice',
    template: '%s · rcln',
  },
  description:
    'Practice software for Indian clinics and hospitals. Appointments, consults, prescriptions, pharmacy, lab and GST billing on one patient record, across every branch.',
  applicationName: 'rcln',
  openGraph: {
    type: 'website',
    siteName: 'rcln',
    url: siteUrl,
    locale: 'en_IN',
    title: 'rcln — one record, from token to invoice',
    description:
      'Practice software for Indian clinics and hospitals. One patient record from the front desk to the GST invoice, across every branch.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'rcln — one record, from token to invoice',
    description: 'Practice software for Indian clinics and hospitals.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: '#f3f5f2',
  colorScheme: 'light',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en-IN"
      className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
