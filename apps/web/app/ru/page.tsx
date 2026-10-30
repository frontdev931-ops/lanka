import type { Metadata } from 'next';
import Landing from '../../components/Landing';
import LandingJsonLd from '../../components/LandingJsonLd';
import { landingMetadata } from '../../lib/site';

export const metadata: Metadata = landingMetadata('ru');

export default function HomeRU() {
  return (
    <>
      <LandingJsonLd lang="ru" />
      <Landing lang="ru" />
    </>
  );
}
