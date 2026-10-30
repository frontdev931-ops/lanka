import { NextRequest, NextResponse } from 'next/server';

// Passes the language of the address to the root layout, so the server-rendered <html lang> is right for /ru and /en
export function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname;
  const lang = p === '/ru' || p.startsWith('/ru/') ? 'ru' : p === '/en' || p.startsWith('/en/') ? 'en' : 'uk';
  const headers = new Headers(req.headers);
  headers.set('x-lang', lang);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!_next|backend|icons|og|.*\\..*).*)'] };
