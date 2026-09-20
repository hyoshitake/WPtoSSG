'use client';

import { JOB_EVENT_TYPES, type DiagnosticResult, type Job, type JobCreateRequest, type JobEvent, type JobReport } from '@wptossg/shared';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

type JobResponse = {
  job: Job;
  events: JobEvent[];
};

function mergeEvents(previous: JobEvent[], incoming: JobEvent[]): JobEvent[] {
  const byId = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function extractJob(details: Record<string, unknown> | undefined): Job | undefined {
  const job = details?.job;
  if (!job || typeof job !== 'object') {
    return undefined;
  }
  return job as Job;
}

function extractDiagnostic(details: Record<string, unknown> | undefined): DiagnosticResult | undefined {
  const diagnostic = details?.diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') {
    return undefined;
  }
  return diagnostic as DiagnosticResult;
}

function extractReport(details: Record<string, unknown> | undefined): JobReport | undefined {
  const report = details?.report;
  if (!report || typeof report !== 'object') {
    return undefined;
  }
  return report as JobReport;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

export function JobDashboard() {
  const [siteUrl, setSiteUrl] = useState('https://example.com');
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult | null>(null);
  const [report, setReport] = useState<JobReport | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
    };
  }, []);

  const latestEvent = events.at(-1) ?? null;

  const connectionLabel = useMemo(() => {
    switch (connectionState) {
      case 'connecting':
        return '接続中';
      case 'connected':
        return '接続済み';
      case 'reconnecting':
        return '再接続中';
      case 'closed':
        return '接続終了';
      default:
        return '未接続';
    }
  }, [connectionState]);

  const connectToEvents = (jobId: string) => {
    sourceRef.current?.close();
    setConnectionState('connecting');

    const source = new EventSource(`/api/jobs/${jobId}/events`);
    sourceRef.current = source;

    const handleEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as JobEvent;
      setEvents((current) => mergeEvents(current, [event]));

      const nextJob = extractJob(event.details);
      if (nextJob) {
        setJob(nextJob);
      }

      const nextDiagnostic = extractDiagnostic(event.details);
      if (nextDiagnostic) {
        setDiagnostic(nextDiagnostic);
      }

      const nextReport = extractReport(event.details);
      if (nextReport) {
        setReport(nextReport);
      }

      if (event.type === 'completed' || event.type === 'failed') {
        setConnectionState('closed');
        source.close();
        sourceRef.current = null;
      }
    };

    for (const eventType of JOB_EVENT_TYPES) {
      source.addEventListener(eventType, handleEvent as EventListener);
    }

    source.onopen = () => {
      setConnectionState('connected');
      setErrorMessage(null);
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setConnectionState('closed');
        return;
      }
      setConnectionState('reconnecting');
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    setEvents([]);
    setDiagnostic(null);
    setReport(null);

    try {
      const payload: JobCreateRequest = { siteUrl };
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as JobResponse | { error: string };
      if (!response.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : 'ジョブ作成に失敗しました');
      }

      setJob(data.job);
      setEvents(data.events);
      setDiagnostic(data.job.diagnostic ?? null);
      setReport(data.job.report ?? null);
      connectToEvents(data.job.id);
    } catch (submitError) {
      setErrorMessage(submitError instanceof Error ? submitError.message : 'ジョブ作成に失敗しました');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">WPtoSSG</p>
        <h1 className="text-4xl font-semibold tracking-tight text-white">Web UI / SSE 監視コンソール</h1>
        <p className="max-w-3xl text-sm leading-6 text-slate-300">
          ジョブ作成、SSE 経由のステージ進捗、診断結果、最終レポートを 1 画面で確認できます。
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
          <form className="space-y-4" onSubmit={handleSubmit}>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-200">対象サイト URL</span>
              <input
                className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-50 outline-none transition focus:border-cyan-400"
                name="siteUrl"
                placeholder="https://example.com"
                value={siteUrl}
                onChange={(changeEvent) => setSiteUrl(changeEvent.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-full bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
                disabled={submitting}
                type="submit"
              >
                {submitting ? 'ジョブ作成中…' : 'ジョブを作成する'}
              </button>
              <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300">
                SSE: {connectionLabel}
              </span>
              {job ? (
                <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300">
                  Job ID: {job.id}
                </span>
              ) : null}
            </div>
            {errorMessage ? <p className="text-sm text-rose-300">{errorMessage}</p> : null}
          </form>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">状態</p>
              <p className="mt-3 text-2xl font-semibold text-white">{job?.status ?? 'pending'}</p>
              <p className="mt-2 text-sm text-slate-400">{job?.currentStage ?? 'PRECHECK'}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">進捗</p>
              <p className="mt-3 text-2xl font-semibold text-white">{job?.percent ?? 0}%</p>
              <div className="mt-3 h-2 rounded-full bg-slate-800">
                <div className="h-2 rounded-full bg-cyan-400 transition-all" style={{ width: `${job?.percent ?? 0}%` }} />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">最新イベント</p>
              <p className="mt-3 text-sm font-medium text-white">{latestEvent?.type ?? 'job_state_changed'}</p>
              <p className="mt-2 text-sm text-slate-400">{latestEvent?.message ?? 'まだイベントはありません。'}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white">イベントログ</h2>
              <span className="text-xs text-slate-400">{events.length} events</span>
            </div>
            <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {events.length === 0 ? (
                <p className="text-sm text-slate-400">ジョブ作成後にイベントを表示します。</p>
              ) : (
                events.map((entry) => (
                  <article key={entry.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                      <span>{entry.stage}</span>
                      <span>{formatTimestamp(entry.timestamp)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                        {entry.type}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-100">{entry.message}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
            <h2 className="text-lg font-semibold text-white">診断結果</h2>
            {diagnostic ? (
              <div className="mt-4 space-y-4">
                <div className="inline-flex rounded-full border border-cyan-500/40 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-200">
                  risk: {diagnostic.riskLevel}
                </div>
                <ul className="space-y-2 text-sm text-slate-200">
                  {diagnostic.reasons.map((reason) => (
                    <li key={reason} className="rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                      {reason}
                    </li>
                  ))}
                </ul>
                <div className="space-y-2">
                  {diagnostic.evidence.map((entry) => (
                    <div key={`${entry.type}:${entry.location}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                      <p className="font-medium text-slate-100">{entry.type}</p>
                      <p className="mt-1 break-all">{entry.location}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">DIAGNOSTIC ステージ完了後に表示されます。</p>
            )}
          </section>

          <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
            <h2 className="text-lg font-semibold text-white">最終レポート</h2>
            {report ? (
              <div className="mt-4 space-y-4 text-sm text-slate-200">
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-400">成功</p>
                    <p className="mt-2 text-xl font-semibold text-white">{report.successCount}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-400">失敗</p>
                    <p className="mt-2 text-xl font-semibold text-white">{report.failedCount}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-400">警告</p>
                    <p className="mt-2 text-xl font-semibold text-white">{report.warnings}</p>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">report.json</p>
                  <p className="mt-2 break-all text-slate-100">{report.storage?.reportPath ?? '未生成'}</p>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">FINALIZE 完了後に report.json の要約を表示します。</p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}
