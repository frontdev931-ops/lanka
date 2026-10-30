'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDate } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, PageHeader, resultTone } from '../../../components/ui';

interface Task {
  id: string;
  title: string;
  note: string | null;
  dueDate: string;
  priority: number;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  result: string | null;
  patient: { id: string; fullName: string; phone: string | null } | null;
  assignee: { id: string; name: string } | null;
}

interface Assignee {
  id: string;
  name: string;
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const todayStart = () => new Date(new Date().toDateString()).getTime();

export default function TasksPage() {
  const { t, label } = useI18n();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [status, setStatus] = useState<'OPEN' | 'DONE'>('OPEN');
  const [mine, setMine] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams({ status });
    if (mine) q.set('assigneeId', 'me');
    api<Task[]>(`/tasks?${q}`).then(setTasks).catch((e) => setError(e.message));
  }, [status, mine]);

  useEffect(load, [load]);
  useEffect(() => {
    api<Assignee[]>('/tasks/assignees').then(setAssignees).catch(() => {});
  }, []);

  async function patch(id: string, body: Record<string, unknown>) {
    setError('');
    try {
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    try {
      await api('/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: f.title, dueDate: f.dueDate || undefined, assigneeId: f.assigneeId || undefined, priority: f.high ? 2 : 1 }),
      });
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader title={t('tasks.title')} subtitle={t('tasks.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      <Card title={t('tasks.new')}>
        <form onSubmit={add} className="toolbar">
          <input className="input grow" name="title" placeholder={t('tasks.placeholder')} required minLength={2} />
          <input className="input" name="dueDate" type="date" />
          <select className="select" name="assigneeId">
            <option value="">{t('common.unassigned')}</option>
            {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <label className="checkbox"><input type="checkbox" name="high" /> {t('common.urgent')}</label>
          <button type="submit" className="btn btn-primary"><Icon name="plus" size={16} /> {t('common.add')}</button>
        </form>
        <p className="rule" style={{ margin: '12px 0 0' }}>{t('tasks.hint')}</p>
      </Card>

      <Card
        flush
        title={t('tasks.list')}
        actions={
          <>
            <button className={`tab${status === 'OPEN' ? ' active' : ''}`} onClick={() => setStatus('OPEN')}>{t('tasks.open')}</button>
            <button className={`tab${status === 'DONE' ? ' active' : ''}`} onClick={() => setStatus('DONE')}>{t('tasks.done')}</button>
            <label className="checkbox"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t('tasks.mine')}</label>
          </>
        }
      >
        {tasks === null ? (
          <Loading />
        ) : !tasks.length ? (
          <Empty title={status === 'OPEN' ? t('tasks.emptyOpen') : t('tasks.emptyDone')}>
            {status === 'OPEN' && t('tasks.emptyOpenHint')}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('tasks.colTask')}</th><th>{t('tasks.colPatient')}</th><th>{t('tasks.colDue')}</th>
                  <th>{t('tasks.colAssignee')}</th><th>{t('tasks.colResult')}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const overdue = task.status === 'OPEN' && new Date(task.dueDate).getTime() < todayStart();
                  return (
                    <tr key={task.id}>
                      <td>
                        <span className="cell-main">{task.title}</span>
                        {task.priority === 2 && <> <Badge tone="red">{t('common.urgent')}</Badge></>}
                      </td>
                      <td>
                        {task.patient ? (
                          <>
                            <Link href={`/patients/${task.patient.id}`} className="cell-main">{task.patient.fullName}</Link>
                            <div className="cell-sub">{task.patient.phone}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {fmtDate(task.dueDate)} {overdue && <Badge tone="red">{t('common.overdue')}</Badge>}
                      </td>
                      <td>
                        <select className="select sm" value={task.assignee?.id ?? ''} onChange={(e) => patch(task.id, { assigneeId: e.target.value || null })}>
                          <option value="">{t('common.notAssigned')}</option>
                          {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                      <td>{task.result ? <Badge tone={resultTone(task.result)}>{label('result', task.result)}</Badge> : <span className="muted">—</span>}</td>
                      <td>
                        <div className="actions">
                          {task.status === 'OPEN' ? (
                            <>
                              <button className="btn btn-sm btn-success" onClick={() => patch(task.id, { status: 'DONE', result: 'BOOKED' })}>{t('tasks.btnBooked')}</button>
                              <button className="btn btn-sm" onClick={() => patch(task.id, { result: 'CALL_LATER', dueDate: tomorrow() })}>{t('tasks.btnLater')}</button>
                              <button className="btn btn-sm" onClick={() => patch(task.id, { result: 'NO_ANSWER', dueDate: tomorrow() })}>{t('tasks.btnNoAnswer')}</button>
                              <button className="btn btn-sm btn-danger" onClick={() => patch(task.id, { status: 'DONE', result: 'DECLINED' })}>{t('tasks.btnDeclined')}</button>
                            </>
                          ) : (
                            <button className="btn btn-sm" onClick={() => patch(task.id, { status: 'OPEN' })}>{t('tasks.reopen')}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
