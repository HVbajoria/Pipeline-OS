import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ActorContext, JobRequisition } from '../shared/models';
import {
  actorContextForRole,
  type HumanRole
} from '../client/actorContext';
import {
  operationClient,
  type OperationClient
} from '../client/operationClient';
import { useStore } from '../lib/store';
import {
  canonicalReadErrorMessage,
  classifyCanonicalReadError,
  projectWorkflowStatus,
  type CanonicalReadErrorState,
  type WorkflowStatusViewModel
} from '../lib/viewModels';

export interface WorkflowStatusOperationClient {
  invoke: OperationClient['invoke'];
}

export interface WorkflowStatusPanelProps {
  client?: WorkflowStatusOperationClient;
  actor?: ActorContext;
  role?: HumanRole;
  initialJobId?: string;
}

type WorkflowQueryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; output: WorkflowStatusViewModel; loadedAtRevision: number }
  | { kind: 'error'; error: unknown; errorState: CanonicalReadErrorState };

function WorkflowError({
  error,
  state
}: {
  error: unknown;
  state: CanonicalReadErrorState;
}) {
  return (
    <div
      role="alert"
      data-workflow-status-error={state}
      className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      <strong className="capitalize">{state}:</strong> {canonicalReadErrorMessage(error, state)}
    </div>
  );
}

function ScopeSummary({ output }: { output: WorkflowStatusViewModel }) {
  const scopeEntries = Object.entries(output.scope);
  return (
    <dl data-workflow-status-scope className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      <div><dt className="inline font-semibold">snapshot revision</dt><dd className="inline"> {output.revision}</dd></div>
      {scopeEntries.map(([key, value]) => (
        <div key={key}><dt className="inline font-semibold">{key}</dt><dd className="inline"> <code>{value}</code></dd></div>
      ))}
      <div><dt className="inline font-semibold">generated</dt><dd className="inline"> {output.generatedAt}</dd></div>
    </dl>
  );
}

function TextList({
  title,
  items,
  testId,
  emptyText
}: {
  title: string;
  items: readonly string[];
  testId: string;
  emptyText: string;
}) {
  return (
    <section data-testid={testId} className="rounded-lg bg-slate-50 p-3 text-sm">
      <h4 className="font-medium text-gray-900">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1 text-gray-500">{emptyText}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-gray-700">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </section>
  );
}

function WorkflowResult({ output }: { output: WorkflowStatusViewModel }) {
  const counts = Object.entries(output.countsByApplicationStatus);
  const empty = output.applications.length === 0 && counts.every(([, count]) => count === 0);
  return (
    <section data-workflow-status-result aria-label="Canonical recruiting workflow status" className="space-y-3">
      <ScopeSummary output={output} />
      {empty ? (
        <p data-workflow-status-empty className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
          No applications are visible in this actor-scoped workflow.
        </p>
      ) : (
        <>
          <section data-workflow-status-counts className="rounded-lg border border-gray-200 bg-white p-3">
            <h4 className="font-medium text-gray-900">Application counts</h4>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {counts.map(([status, count]) => (
                <div key={status} className="rounded bg-slate-50 p-2">
                  <dt className="capitalize text-gray-500">{status.replaceAll('_', ' ')}</dt>
                  <dd className="font-semibold text-gray-900">{count}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section data-workflow-status-applications className="space-y-2">
            <h4 className="font-medium text-gray-900">Applications</h4>
            {output.applications.map((application) => (
              <article
                key={application.applicationId}
                data-workflow-application={application.applicationId}
                className="rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h5 className="font-semibold text-gray-900">{application.applicationId}</h5>
                    <p className="text-xs text-gray-500">
                      Candidate <code>{application.candidateId}</code> · Job <code>{application.jobId}</code>
                    </p>
                  </div>
                  <span data-workflow-application-stage className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-800">
                    {application.currentStage}
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-600">Persisted status: {application.status}</p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextList
                    title="Blockers"
                    items={application.blockers}
                    testId={`workflow-blockers-${application.applicationId}`}
                    emptyText="No blockers returned."
                  />
                  <TextList
                    title="Next actions"
                    items={application.nextActions}
                    testId={`workflow-actions-${application.applicationId}`}
                    emptyText="No next action returned."
                  />
                </div>
              </article>
            ))}
          </section>
        </>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <TextList title="Workflow blockers" items={output.blockers} testId="workflow-status-blockers" emptyText="No aggregate blockers returned." />
        <TextList title="Next actions" items={output.nextActions} testId="workflow-status-actions" emptyText="No aggregate next actions returned." />
      </div>
      <section data-workflow-status-approvals className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-sm">
        <h4 className="font-medium text-indigo-900">Pending approvals</h4>
        {output.pendingApprovals.length === 0 ? (
          <p data-workflow-status-approvals-empty className="mt-1 text-indigo-700">No pending approvals are visible for this actor.</p>
        ) : (
          <ul className="mt-1 space-y-2 text-indigo-900">
            {output.pendingApprovals.map((card) => (
              <li key={card.id} data-workflow-approval={card.id} className="rounded bg-white/70 p-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <span><strong>{card.targetOperation}</strong> · <code>{card.id}</code></span>
                  <span>{card.status}</span>
                </div>
                <p className="text-xs">{card.changeSummary.join(' · ') || 'No change summary returned.'}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

/** Render the canonical get_recruiting_workflow_status response only. */
export function WorkflowStatusPanel({
  client = operationClient,
  actor: configuredActor,
  role,
  initialJobId
}: WorkflowStatusPanelProps) {
  const currentRole = useStore((state) => state.currentRole);
  const jobs = useStore((state) => state.jobs);
  const authoritativeRevision = useStore((state) => state.revision);
  const [jobId, setJobId] = useState(initialJobId ?? '');
  const [detail, setDetail] = useState<'summary' | 'full'>('full');
  const [query, setQuery] = useState<WorkflowQueryState>({ kind: 'idle' });
  const requestController = useRef<AbortController | null>(null);
  const actor = configuredActor ?? actorContextForRole(
    role ?? (currentRole === 'hiring-manager' ? 'hiring-manager' : 'recruiter')
  );

  useEffect(() => () => requestController.current?.abort(), []);

  const runStatus = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setQuery({ kind: 'loading' });
    try {
      const output = await client.invoke(
        'get_recruiting_workflow_status',
        {
          detail,
          limit: 50,
          ...(jobId.trim().length === 0 ? {} : { jobId })
        },
        { actor, signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setQuery({
        kind: 'success',
        output: projectWorkflowStatus(output),
        loadedAtRevision: useStore.getState().revision
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setQuery({
        kind: 'error',
        error,
        errorState: classifyCanonicalReadError(error)
      });
    }
  };

  const stale = query.kind === 'success' && authoritativeRevision > query.loadedAtRevision;

  return (
    <section data-p13-workflow-status aria-label="Recruiting workflow status" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Recruiting workflow status</h2>
        <p className="text-sm text-gray-500">
          Read the actor-scoped status snapshot from the server, including canonical blockers, next actions, counts, and pending approvals.
        </p>
      </div>
      <form onSubmit={(event) => void runStatus(event)} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
        <label className="block text-sm text-gray-700">
          Job scope
          <select aria-label="Workflow status job" value={jobId} onChange={(event) => setJobId(event.target.value)} className="mt-1 w-full rounded border p-2">
            <option value="">All visible jobs</option>
            {jobs.map((job: JobRequisition) => <option key={job.id} value={job.id}>{job.title} ({job.id})</option>)}
          </select>
        </label>
        <label className="block text-sm text-gray-700">
          Detail
          <select aria-label="Workflow status detail" value={detail} onChange={(event) => setDetail(event.target.value as 'summary' | 'full')} className="mt-1 w-full rounded border p-2">
            <option value="summary">Summary</option>
            <option value="full">Full</option>
          </select>
        </label>
        <button type="submit" disabled={query.kind === 'loading'} className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {query.kind === 'loading' ? 'Loading status…' : 'Load workflow status'}
        </button>
      </form>
      {query.kind === 'idle' && <p data-workflow-status-idle className="text-sm text-gray-500">Choose a scope, then request a canonical workflow snapshot.</p>}
      {query.kind === 'loading' && <p data-workflow-status-loading role="status" className="text-sm text-indigo-700">Loading the canonical workflow status…</p>}
      {query.kind === 'error' && <WorkflowError error={query.error} state={query.errorState} />}
      {query.kind === 'success' && stale && (
        <p data-workflow-status-stale role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This status snapshot is stale because the shared snapshot advanced. Refresh explicitly; no automatic mutation or retry was attempted.
        </p>
      )}
      {query.kind === 'success' && <WorkflowResult output={query.output} />}
    </section>
  );
}

export default WorkflowStatusPanel;
