import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = (await cookies()).get('stomat_session');
  if (!session) redirect('/login');

  const api = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const access = await fetch(`${api}/platform/plans`, {
    headers: { Cookie: `stomat_session=${encodeURIComponent(session.value)}` },
    cache: 'no-store',
    redirect: 'error',
  });
  if (access.status === 401) redirect('/login');
  if (access.status === 403) notFound();
  if (!access.ok) throw new Error('Platform authorization unavailable');
  return children;
}
