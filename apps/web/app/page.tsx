import type { Metadata } from 'next';
import Landing from '../components/Landing';

export const metadata: Metadata = {
  title: 'LANKA: звіти, ШІ-адміністратор і автоматизація для клінік на Cliniccards',
  description: 'LANKA бере дані з Cliniccards: звіти з Excel і PDF, ШІ відповідає пацієнтам і готує запис, нагадування та воронка пацієнта. Демо без реєстрації.',
  openGraph: { title: 'LANKA для клінік на Cliniccards', description: 'Звіти, ШІ-адміністратор, автоматизація й воронка пацієнта. Демо без реєстрації.', type: 'website' },
};

export default function Home() {
  return <Landing />;
}
