import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';
import { ThemeScript } from '@/components/shell/theme-script';
import { ThemeSync } from '@/components/shell/theme-sync';
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

/**
 * The browser chrome's colour, which is not a token — `themeColor` is read out of
 * the document head by the OS before any CSS has been resolved, so it cannot be
 * `var(--rcln-paper)`.
 *
 * Both entries are the DEFAULT accent's page background, and they are matched to
 * `prefers-color-scheme` rather than to the stored preference: this is the strip
 * above the address bar on a phone, and getting it within a shade is worth more
 * than the dynamic `<meta>` rewriting it would take to get it exact for the four
 * other accents.
 *
 * `colorScheme` is deliberately absent. Declaring it here would pin the document
 * to one scheme and override what theme.css sets per appearance.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1512' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /*
     * `suppressHydrationWarning` is on <html> because `ThemeScript` writes
     * `data-appearance` and `data-accent` onto this element before React
     * hydrates. Without it React sees attributes the server did not send and
     * warns on every page load of every themed session. It suppresses the
     * mismatch on THIS ELEMENT ONLY — one element deep, not the tree.
     */
    <html
      lang="en-IN"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        {/* First thing in the document, and blocking on purpose: this is what
            stops a dark-mode reload flashing white. See theme-script.tsx. */}
        <ThemeScript />
      </head>
      <body className="flex min-h-full flex-col">
        {children}
        <ThemeSync />
      </body>
    </html>
  );
}
