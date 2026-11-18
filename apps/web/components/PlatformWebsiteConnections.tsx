'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import type { WebsiteRequest } from '../lib/website-requests';
import { Alert, Badge, Card, Loading } from './ui';

interface ClinicOption { id: string; name: string }
interface OpenRequest extends WebsiteRequest {
  clinicId: string;
  clinic: { name: string };
  email: string | null;
}
interface WebsiteSettings {
  origins: string[];
  formPage: string | null;
  request: WebsiteRequest | null;
  requestReceivedAt: string | null;
  lastReceivedAt: string | null;
}

export function PlatformWebsiteConnections({ clinics }: { clinics: ClinicOption[] }) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<OpenRequest[] | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<ClinicOption | null>(null);
  const details = useRef<HTMLDivElement>(null);
  const load = useCallback(() => {
    api<OpenRequest[]>('/platform/website-requests').then((rows) => { setRequests(rows); setError(''); }).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { details.current?.scrollIntoView({ block: 'start' }); }, [target]);
  const options = target && !clinics.some((c) => c.id === target.id) ? [target, ...clinics] : clinics;

  return (
    <div id="platform-website">
      <Card title={t('ld.platformRequests')}>
        {error && <Alert tone="error">{error}</Alert>}
        {!requests && !error && <Loading />}
        {requests?.length === 0 && <p className="muted">{t('ld.noRequests')}</p>}
        {requests?.map((r) => (
          <section key={r.id} className="rule-card" style={{ marginBottom: 12, overflowWrap: 'anywhere' }}>
            <div className="toolbar spread">
              <strong>{r.clinic.name}</strong>
              <Badge tone="amber">{t(r.installedAt ? 'ld.requestInstalled' : 'ld.requestReceived')}</Badge>
            </div>
            <p style={{ margin: '8px 0' }}>{r.websiteOrigin} · {fmtDateTime(r.createdAt)}{r.email && <> · <a href={`mailto:${r.email}`}>{r.email}</a></>}</p>
            <button className="btn" onClick={() => setTarget({ id: r.clinicId, name: r.clinic.name })}>{t('ld.openClinic')}</button>
          </section>
        ))}
        <label className="field" style={{ marginBottom: 0 }}>
          <span>{t('ld.selectClinic')}</span>
          <select className="input" value={target?.id ?? ''} onChange={(e) => setTarget(options.find((c) => c.id === e.target.value) ?? null)}>
            <option value="">—</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </Card>
      {target && <div ref={details} style={{ scrollMarginTop: 64 }}><PlatformWebsiteClinic key={target.id} clinic={target} onChanged={load} /></div>}
    </div>
  );
}

function PlatformWebsiteClinic({ clinic, onChanged }: { clinic: ClinicOption; onChanged: () => void }) {
  const { t } = useI18n();
  const path = `/platform/clinics/${encodeURIComponent(clinic.id)}/website`;
  const [s, setS] = useState<WebsiteSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<WebsiteSettings>(path).then(setS).catch((e) => setError((e as Error).message));
  }, [path]);

  async function update(endpoint: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      const next = await api<WebsiteSettings>(endpoint, body && { method: 'PATCH', body: JSON.stringify(body) });
      setS(next);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const request = s?.request;
  const evidence = request ? s?.requestReceivedAt : s?.lastReceivedAt;
  async function record(action: 'installed' | 'complete') {
    if (request && await update(`${path}/requests/${request.id}`, { action })) onChanged();
  }

  return (
    <Card title={t('ld.manageClinic', { clinic: clinic.name })}>
      {error && <Alert tone="error">{error}</Alert>}
      {!s && !error && <Loading />}
      {s && (
        <>
          {(request || s.origins.length > 0) && (
            <p style={{ overflowWrap: 'anywhere' }}>{t('ld.origins')} · {request?.websiteOrigin ?? s.origins.join(', ')}</p>
          )}
          {s.formPage && <p style={{ overflowWrap: 'anywhere' }}>{t('ld.formPage')} · {s.formPage}</p>}
          {request && <Badge tone={request.handledAt ? 'green' : 'amber'}>{t(request.handledAt ? 'ld.requestComplete' : request.installedAt ? 'ld.requestInstalled' : 'ld.requestReceived')}</Badge>}
          <section className="rule-card" style={{ marginTop: 14 }}>
            <strong>{t('ld.verification')}</strong>
            <p className="muted">{evidence ? t('ld.receivedAt', { d: fmtDateTime(evidence) }) : t('ld.noReceiptEvidence')}</p>
            <div className="toolbar">
              <button className="btn" disabled={busy} onClick={() => update(path)}>{t('ld.refreshStatus')}</button>
              {request && !request.handledAt && (
                <>
                  {!request.installedAt && <button className="btn" disabled={busy} onClick={() => record('installed')}>{t('ld.recordInstalled')}</button>}
                  <button className="btn btn-primary" disabled={busy || !request.installedAt || !evidence} onClick={() => record('complete')}>{t('ld.completeRequest')}</button>
                </>
              )}
            </div>
          </section>
        </>
      )}
    </Card>
  );
}
