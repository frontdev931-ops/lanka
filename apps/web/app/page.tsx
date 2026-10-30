import type { Metadata } from 'next';
import Landing from '../components/Landing';
import LandingJsonLd from '../components/LandingJsonLd';
import { landingMetadata } from '../lib/site';

// Ukrainian is the main language and lives at the root; /ru and /en are the other versions (see lib/site.ts)
export const metadata: Metadata = landingMetadata('uk');

export default function Home() {
  return (
    <>
      <LandingJsonLd lang="uk" />
      <Landing lang="uk" />
    </>
  );
}
