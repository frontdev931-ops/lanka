import { Inter_Tight, Onest } from 'next/font/google';

// The brand's type (design of 2026-11-23): a tight display face for headings and a Cyrillic-first text face. Self-hosted by Next, no request
// to Google at runtime. Shared by the landing and the clinic workspace (the root layout puts both variables on <html>).
export const display = Inter_Tight({ subsets: ['latin', 'cyrillic'], weight: ['600', '700', '800'], variable: '--lp-display', display: 'swap' });
export const text = Onest({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600', '700'], variable: '--lp-text', display: 'swap' });
