import type { Metadata } from 'next';
import Landing from '../../components/Landing';
import LandingJsonLd from '../../components/LandingJsonLd';
import { landingMetadata } from '../../lib/site';

export const metadata: Metadata = landingMetadata('en');

export default function HomeEN() {
  return (
    <>
      <LandingJsonLd lang="en" />
      <Landing lang="en" />
    </>
  );
}
