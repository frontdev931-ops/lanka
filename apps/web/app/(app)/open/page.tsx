'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loading } from '../../../components/ui';
import { SignalClinic } from '../../../components/SignalClinic';
import { safeNext } from '../../../lib/safe-next';

// Where a notification leads (/open?c=<clinicId>&to=<page>, ids and an in-app path only). A signed-out person goes to the sign-in first and comes
// back here (Shell); another selected clinic gets the existing safe switch, a clinic without access a refusal without data (SignalClinic); then
// the page itself opens. `to` must be a path of this app.
export default function OpenPage() {
  return (
    <SignalClinic>
      <Go />
    </SignalClinic>
  );
}

function Go() {
  const router = useRouter();
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    setTo(safeNext(new URLSearchParams(window.location.search).get('to')) ?? '/dashboard');
  }, []);
  useEffect(() => {
    if (to) router.replace(to);
  }, [to, router]);
  return <Loading />;
}
