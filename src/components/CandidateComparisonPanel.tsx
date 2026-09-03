import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ActorContext, CandidateRecord, JobRequisition } from '../shared/models';
import { ValidationError } from '../shared/errors';
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
  projectCandidateComparison,
  type CandidateComparisonViewModel,
  type CanonicalReadErrorState
} from '../lib/viewModels';

export interface CandidateComparisonOperationClient {
  invoke: OperationClient['invoke'];
}

export interface CandidateComparisonPanelProps {
  client?: CandidateComparisonOperationClient;
  actor?: ActorContext;
  role?: HumanRole;
  initialJobId?: string;
  initialCandidateIds?: string[];
}

type ComparisonQueryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; output: CandidateComparisonViewModel; loadedAtRevision: number }
  | { kind: 'error'; error: unknown; errorState: CanonicalReadErrorState };

function roleForPanel(role: HumanRole | undefined): HumanRole {
  return role ?? 'recruiter';
}

function candidateLabel(candidate: CandidateRecord): string {
  return `${candidate.name} (${candidate.id})`;
}

function ComparisonError({
  error,
  state
}: {
  error: unknown;
  state: CanonicalReadErrorState;
}) {
  const message = canonicalReadErrorMessage(error, state);
  return (
    <div
      role="alert"
      data-comparison-error={state}
      className="callout callout--danger"
    >
      <strong className="capitalize">{state}:</strong> {message}
    </div>
  );
}

function ComparisonResult({ output }: { output: CandidateComparisonViewModel }) {
  return (
    <section data-comparison-result aria-label="Canonical candidate comparison" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        <span>Job snapshot: <code>{output.jobId}</code></span>
        <span data-comparison-revision>Server revision: {output.revision}</span>
      </div>
      {output.candidates.length === 0 ? (
        <p data-comparison-empty className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
          The server returned no comparison rows for this scope.
        </p>
      ) : (
        <div className="space-y-3">
          {output.candidates.map((candidate) => (
            <article
              key={candidate.candidateId}
              data-comparison-candidate={candidate.candidateId}
              className="panel panel--compact"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-gray-900">#{candidate.rank} {candidate.name}</h4>
                  <p className="text-xs text-gray-500"><code>{candidate.candidateId}</code></p>
                </div>
                <span data-comparison-score className="rounded-full bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-800">
                  {candidate.totalScore}
                </span>
              </header>
              <p data-comparison-rationale className="mt-2 text-sm text-gray-700">{candidate.rationale}</p>
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-700 sm:grid-cols-3">
                <section data-comparison-requirements className="rounded bg-slate-50 p-2">
                  <strong>Requirements · {candidate.scoreBreakdown.requirementMatch.score}</strong>
                  <p>Matched: {candidate.scoreBreakdown.requirementMatch.matched.join(', ') || 'none'}</p>
                  <p>Missing: {candidate.scoreBreakdown.requirementMatch.missing.join(', ') || 'none'}</p>
                </section>
                <section data-comparison-skills className="rounded bg-slate-50 p-2">
                  <strong>Skills · {candidate.scoreBreakdown.skillOverlap.score}</strong>
                  <p>Matched: {candidate.scoreBreakdown.skillOverlap.matched.join(', ') || 'none'}</p>
                </section>
                <section data-comparison-experience className="rounded bg-slate-50 p-2">
                  <strong>Experience · {candidate.scoreBreakdown.experienceFit.score}</strong>
                  <p>{candidate.scoreBreakdown.experienceFit.evidence}</p>
                </section>
              </div>
              {candidate.limitations.length > 0 && (
                <ul data-comparison-limitations className="mt-2 list-disc pl-5 text-xs text-amber-800">
                  {candidate.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** Render the canonical compare_candidates response without local scoring. */
export function CandidateComparisonPanel({
  client = operationClient,
  actor: configuredActor,
  role,
  initialJobId,
  initialCandidateIds
}: CandidateComparisonPanelProps) {
  const currentRole = useStore((state) => state.currentRole);
  const jobs = useStore((state) => state.jobs);
  const candidates = useStore((state) => state.candidates);
  const authoritativeRevision = useStore((state) => state.revision);
  const [jobId, setJobId] = useState(initialJobId ?? '');
  const [candidateIds, setCandidateIds] = useState<string[]>(initialCandidateIds ?? []);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [query, setQuery] = useState<ComparisonQueryState>({ kind: 'idle' });
  const requestController = useRef<AbortController | null>(null);
  const initializedCandidates = useRef((initialCandidateIds?.length ?? 0) > 0);
  const actor = configuredActor ?? actorContextForRole(
    role ?? (currentRole === 'hiring-manager' ? 'hiring-manager' : roleForPanel(role))
  );

  useEffect(() => {
    if (jobId === '' && jobs[0] !== undefined) setJobId(jobs[0].id);
  }, [jobId, jobs]);

  useEffect(() => {
    if (initializedCandidates.current || candidates.length < 2) return;
    setCandidateIds(candidates.slice(0, 2).map((candidate) => candidate.id));
    initializedCandidates.current = true;
  }, [candidates]);

  useEffect(() => () => requestController.current?.abort(), []);

  const toggleCandidate = (candidateId: string) => {
    setSelectionMessage(null);
    setCandidateIds((previous) => {
      if (previous.includes(candidateId)) return previous.filter((id) => id !== candidateId);
      if (previous.length >= 5) {
        setSelectionMessage('Select no more than five candidates.');
        return previous;
      }
      return [...previous, candidateId];
    });
  };

  const runComparison = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (jobId.trim().length === 0) {
      setQuery({
        kind: 'error',
        error: new ValidationError('Select a job before comparing candidates.', {
          field: 'jobId',
          reason: 'input_invalid'
        }),
        errorState: 'invalid'
      });
      return;
    }
    if (candidateIds.length < 2) {
      setQuery({
        kind: 'error',
        error: new ValidationError('Select at least two candidates before comparing.', {
          field: 'candidateIds',
          reason: 'input_invalid'
        }),
        errorState: 'invalid'
      });
      return;
    }

    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setSelectionMessage(null);
    setQuery({ kind: 'loading' });
    try {
      const output = await client.invoke(
        'compare_candidates',
        { jobId, candidateIds },
        { actor, signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setQuery({
        kind: 'success',
        output: projectCandidateComparison(output),
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
    <section data-p13-comparison aria-label="Candidate comparison" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Explainable candidate comparison</h2>
        <p className="text-sm text-gray-500">
          Compare permitted candidates using the server snapshot. Scores, evidence, ranking, and limitations are not recomputed in the browser.
        </p>
      </div>
      <form onSubmit={(event) => void runComparison(event)} className="panel panel--padded space-y-4">
        <label className="block text-sm text-gray-700">
          Job
          <select
            aria-label="Comparison job"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
            className="mt-1 w-full rounded border p-2"
          >
            {jobs.length === 0 && <option value="">No jobs available</option>}
            {jobs.map((job: JobRequisition) => <option key={job.id} value={job.id}>{job.title} ({job.id})</option>)}
          </select>
        </label>
        <fieldset>
          <legend className="text-sm font-medium text-gray-700">Candidates (select 2–5)</legend>
          {candidates.length === 0 ? (
            <p data-comparison-selection-empty className="mt-1 text-sm text-gray-500">No candidate records are available in this view.</p>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {candidates.map((candidate: CandidateRecord) => (
                <label key={candidate.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                  <input
                    type="checkbox"
                    checked={candidateIds.includes(candidate.id)}
                    onChange={() => toggleCandidate(candidate.id)}
                  />
                  <span>{candidateLabel(candidate)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {selectionMessage && <p role="alert" className="text-sm text-amber-800">{selectionMessage}</p>}
        <button type="submit" disabled={query.kind === 'loading'} className="ui-button ui-button--primary">
          {query.kind === 'loading' ? 'Comparing…' : 'Compare candidates'}
        </button>
      </form>
      {query.kind === 'idle' && <p data-comparison-idle className="text-sm text-gray-500">Choose a job and candidates, then request a server comparison.</p>}
      {query.kind === 'loading' && <p data-comparison-loading role="status" className="text-sm text-blue-700">Loading the canonical comparison snapshot…</p>}
      {query.kind === 'error' && <ComparisonError error={query.error} state={query.errorState} />}
      {query.kind === 'success' && stale && (
        <p data-comparison-stale role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This comparison is stale because the shared snapshot advanced. Refresh explicitly to request a new canonical result.
        </p>
      )}
      {query.kind === 'success' && <ComparisonResult output={query.output} />}
    </section>
  );
}

export default CandidateComparisonPanel;
