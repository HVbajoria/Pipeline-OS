import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Search, ShieldCheck } from 'lucide-react';
import { PipelineError } from '../shared/errors';
import {
  GitHubProspectsClient,
  GitHubProspectsClientError,
  githubProspectsClient
} from '../client/githubProspectsClient';
import {
  actorContextForRole,
  type HumanRole
} from '../client/actorContext';
import {
  operationClient as sharedOperationClient,
  type OperationClient
} from '../client/operationClient';
import { useStore } from '../lib/store';
import type {
  ActorContext,
  SourcedProspectRecord
} from '../shared/models';
import type {
  ImportPublicProspectInput,
  PlanOperationInput,
  PlanOperationOutput
} from '../shared/operations';
import type {
  GitHubProspect,
  GitHubProspectSearchResult,
  PublicProspectConsentMethod,
  PublicProspectConsentStatus
} from '../shared/publicProspects';
import {
  getPublicProspectRetentionStatus,
  normalizePublicProspectTimestamp
} from '../shared/domain/provenance';
import {
  PUBLIC_PROSPECT_CONSENT_POLICY_VERSION,
  PUBLIC_PROSPECT_DEFAULT_CONSENT_SCOPE
} from '../shared/publicProspects';

export interface GitHubProspectsOperationClient {
  invoke: OperationClient['invoke'];
}

export interface GitHubProspectsPanelProps {
  client?: GitHubProspectsClient;
  /** Canonical mutation boundary; search remains on the read-only client facade. */
  operationClient?: GitHubProspectsOperationClient;
  actor?: ActorContext;
  role?: HumanRole;
}

export interface GitHubProspectsResultsProps {
  result: GitHubProspectSearchResult | null;
  loading?: boolean;
  requestError?: unknown;
  onSelectProspect?: (prospect: GitHubProspect) => void;
  selectedLogin?: string | null;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorText(error: unknown): string {
  if (error instanceof GitHubProspectsClientError) {
    if (error.isRateLimited) {
      return 'GitHub rate limit reached. Please wait and try again; an optional server-side token can provide rate-limit headroom.';
    }
    return error.message;
  }
  if (error instanceof PipelineError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'GitHub public-prospect operation could not be completed.';
}

function isRateLimitError(error: unknown): boolean {
  return (
    (error instanceof GitHubProspectsClientError && error.isRateLimited) ||
    (error instanceof PipelineError && error.code === 'RATE_LIMITED_ERROR')
  );
}

function sourceReferenceFor(
  prospect: GitHubProspect,
  result: GitHubProspectSearchResult
): Omit<ImportPublicProspectInput, 'consent' | 'candidateProfile'> {
  const sourceFilters = {
    ...(result.filters.language === undefined
      ? {}
      : { language: result.filters.language }),
    ...(result.filters.location === undefined
      ? {}
      : { location: result.filters.location })
  };
  return {
    source: 'github',
    sourceRecordId: prospect.login,
    profileUrl: prospect.profileUrl,
    canonicalSourceUrl: `https://api.github.com/users/${encodeURIComponent(prospect.login)}`,
    sourceQuery: result.query,
    ...(Object.keys(sourceFilters).length === 0 ? {} : { sourceFilters }),
    fetchedAt: prospect.fetchedAt,
    attribution: result.attribution
  };
}

function ProspectCard({
  prospect,
  onSelect,
  selected
}: {
  prospect: GitHubProspect;
  onSelect?: (prospect: GitHubProspect) => void;
  selected: boolean;
}) {
  return (
    <article className={`border rounded-lg p-4 ${selected ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-gray-200'}`}>
      <div className="flex items-start gap-3">
        {prospect.avatarUrl ? (
          <img
            src={prospect.avatarUrl}
            alt={`${prospect.username} GitHub avatar`}
            className="w-10 h-10 rounded-full bg-gray-100"
            loading="lazy"
          />
        ) : (
          <div aria-hidden="true" className="w-10 h-10 rounded-full bg-gray-100" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap justify-between gap-2">
            <div>
              <h3 className="font-semibold text-gray-900">{prospect.username}</h3>
              <p className="text-xs text-gray-500">
                {prospect.profileType} · Public GitHub profile
              </p>
            </div>
            <span className="text-xs rounded-full px-2 py-1 bg-slate-100 text-slate-700 whitespace-nowrap">
              Score {prospect.searchScore.toFixed(2)}
            </span>
          </div>
          {prospect.location && (
            <p className="text-xs text-gray-600 mt-2">{prospect.location}</p>
          )}
          {prospect.bio && (
            <p className="text-sm text-gray-700 mt-2">{prospect.bio}</p>
          )}
          {prospect.publicRepos !== undefined && (
            <p className="text-xs text-gray-500 mt-2">
              Public repositories: {prospect.publicRepos}
            </p>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Data origin: {prospect.dataOrigin} · Consent: {prospect.consentStatus}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <a
              href={prospect.profileUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline"
            >
              View GitHub profile <ExternalLink className="w-3.5 h-3.5" />
            </a>
            {onSelect && (
              <button
                type="button"
                onClick={() => onSelect(prospect)}
                className="rounded bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-800"
                data-prospect-select={prospect.login}
              >
                {selected ? 'Selected for consent' : 'Use for consented import'}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Render public prospect results without connecting them to candidate state. */
export function GitHubProspectsResults({
  result,
  loading = false,
  requestError = null,
  onSelectProspect,
  selectedLogin = null
}: GitHubProspectsResultsProps) {
  return (
    <>
      {loading && (
        <p role="status" className="text-sm text-gray-500 mt-4">
          Searching GitHub&apos;s public user index…
        </p>
      )}
      {requestError && (
        <p
          role="alert"
          className={`text-sm rounded-lg p-3 mt-4 ${isRateLimitError(requestError) ? 'text-amber-900 bg-amber-50 border border-amber-200' : 'text-red-700 bg-red-50 border border-red-200'}`}
        >
          {errorText(requestError)}
        </p>
      )}

      {result && (
        <div className="mt-4" data-github-prospect-results>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>Source: {result.source}</span>
            <span>Fetched: {formatTimestamp(result.fetchedAt)}</span>
            <span>Cache: {result.cache.hit ? 'cached' : 'fresh'}</span>
            <span>Cache age: {Math.round(result.cache.ageMs / 1000)}s</span>
            {result.cache.coalesced && <span>Request: joined in-flight search</span>}
          </div>
          {result.prospects.length === 0 ? (
            <p className="text-sm text-gray-500 mt-4">
              No public GitHub profiles matched this search.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
              {result.prospects.map((prospect) => (
                <ProspectCard
                  key={`${prospect.login}-${prospect.profileUrl}`}
                  prospect={prospect}
                  onSelect={onSelectProspect}
                  selected={selectedLogin === prospect.login}
                />
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-4">
            Attribution: GitHub public profile data via the official REST API.{' '}
            <a
              href={result.attribution.searchApiDocsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              API documentation
            </a>
            .
          </p>
        </div>
      )}
    </>
  );
}

export function GitHubProspectsConsentNotice() {
  return (
    <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 mt-4">
      These are public prospects, not candidates. Public visibility is not consent. A person is not in the PipelineOS recruiting workflow unless they apply or otherwise provide explicit consent. PipelineOS does not copy contact data from GitHub, auto-message, auto-apply, or make hiring decisions from this catalog.
    </p>
  );
}

function lifecycleLabel(record: SourcedProspectRecord): PublicProspectConsentStatus | 'imported' {
  if (record.consentStatus === 'withdrawn') return 'withdrawn';
  if (record.consentStatus === 'expired') return 'expired';
  return getPublicProspectRetentionStatus(record.retentionExpiresAt, new Date().toISOString()) === 'expired'
    ? 'expired'
    : 'imported';
}

function lifecycleClasses(status: PublicProspectConsentStatus | 'imported'): string {
  if (status === 'withdrawn') return 'bg-gray-200 text-gray-700';
  if (status === 'expired') return 'bg-red-100 text-red-800';
  return 'bg-green-100 text-green-800';
}

function ImportedProspectsList({
  client,
  actor,
  onNotice,
  onError
}: {
  client: GitHubProspectsOperationClient;
  actor: ActorContext;
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const sourcedProspects = useStore((state) => state.sourcedProspects);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const revoke = async (record: SourcedProspectRecord): Promise<void> => {
    if (actor.actorType !== 'human_ui') {
      onError(new Error('Only a trusted human may revoke consent.'));
      return;
    }
    setRevokingId(record.id);
    try {
      await client.invoke(
        'revoke_public_prospect_consent',
        { sourcedProspectId: record.id },
        { actor }
      );
      onNotice(`Consent withdrawn for ${record.sourceRecordId}. The canonical provenance record was retained safely.`);
    } catch (error) {
      onError(error);
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section data-sourced-prospects aria-label="Imported public prospects" className="mt-6 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-900">Consent and provenance records</h3>
          <p className="text-xs text-gray-500">Imported records are retained only for the server policy window and never become applications automatically.</p>
        </div>
        <span className="text-xs text-gray-500">{sourcedProspects.length} record{sourcedProspects.length === 1 ? '' : 's'}</span>
      </div>
      {sourcedProspects.length === 0 ? (
        <p data-sourced-prospects-empty className="text-sm text-gray-500 mt-3">No consented public prospects have been imported.</p>
      ) : (
        <div className="space-y-3 mt-3">
          {sourcedProspects.map((record) => {
            const status = lifecycleLabel(record);
            return (
              <article key={record.id} data-sourced-prospect-id={record.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <strong>{record.sourceRecordId}</strong>
                    <p className="text-xs text-gray-500">{record.source} · {record.dataOrigin} · fetched {formatTimestamp(record.fetchedAt)}</p>
                  </div>
                  <span data-sourced-prospect-status={status} className={`rounded-full px-2 py-1 text-xs capitalize ${lifecycleClasses(status)}`}>{status}</span>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-1 mt-3 text-xs text-gray-600">
                  <div><dt className="font-semibold inline">retention expires</dt><dd className="inline"> {formatTimestamp(record.retentionExpiresAt)}</dd></div>
                  <div><dt className="font-semibold inline">consent scope</dt><dd className="inline"> {record.consent?.scope ?? 'not retained'}</dd></div>
                  {record.withdrawnAt && <div><dt className="font-semibold inline">withdrawn</dt><dd className="inline"> {formatTimestamp(record.withdrawnAt)}</dd></div>}
                  {record.expiredAt && <div><dt className="font-semibold inline">expired</dt><dd className="inline"> {formatTimestamp(record.expiredAt)}</dd></div>}
                </dl>
                <p className="text-xs text-gray-500 mt-2">Field origins: {Object.entries(record.fieldOrigins).map(([field, origin]) => `${field}=${origin}`).join(' · ')}</p>
                {status === 'imported' && actor.actorType === 'human_ui' && (
                  <button
                    type="button"
                    data-revoke-prospect={record.id}
                    disabled={revokingId === record.id}
                    onClick={() => void revoke(record)}
                    className="mt-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 disabled:opacity-50"
                  >
                    {revokingId === record.id ? 'Withdrawing…' : 'Withdraw consent'}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Recruiter-only, explicit on-demand catalog search and consented import-plan
 * flow. Search never touches shared state; import is only a plan request and
 * must be approved and committed by a trusted human in ApprovalCardsPanel.
 */
export function GitHubProspectsPanel({
  client = githubProspectsClient,
  operationClient: mutationClient = sharedOperationClient,
  actor: configuredActor,
  role = 'recruiter'
}: GitHubProspectsPanelProps) {
  const actor = configuredActor ?? actorContextForRole(role);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const [location, setLocation] = useState('');
  const [result, setResult] = useState<GitHubProspectSearchResult | null>(null);
  const [selectedProspect, setSelectedProspect] = useState<GitHubProspect | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [mutationError, setMutationError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanOperationOutput | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentMethod, setConsentMethod] = useState<PublicProspectConsentMethod>('approved_consent_channel');
  const [consentScope, setConsentScope] = useState<string>(PUBLIC_PROSPECT_DEFAULT_CONSENT_SCOPE);
  const [capturedAt, setCapturedAt] = useState(() => new Date().toISOString());
  const [evidenceRef, setEvidenceRef] = useState('');
  const [policyVersion, setPolicyVersion] = useState<string>(PUBLIC_PROSPECT_CONSENT_POLICY_VERSION);
  const [candidateProfile, setCandidateProfile] = useState({
    name: '',
    email: '',
    resumeText: '',
    skills: '',
    experienceYears: ''
  });
  const requestController = useRef<AbortController | null>(null);

  const search = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setRequestError(new Error('Enter a GitHub search query first.'));
      return;
    }

    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setRequestError(null);
    setMutationError(null);
    setNotice(null);
    try {
      const next = await client.search(
        {
          query: normalizedQuery,
          ...(language.trim() ? { language: language.trim() } : {}),
          ...(location.trim() ? { location: location.trim() } : {})
        },
        controller.signal
      );
      if (!controller.signal.aborted) {
        setResult(next);
        setSelectedProspect(null);
        setPlanResult(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(error);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const selectProspect = (prospect: GitHubProspect): void => {
    setSelectedProspect(prospect);
    setMutationError(null);
    setNotice(null);
    setPlanResult(null);
  };

  const planImport = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setMutationError(null);
    setNotice(null);
    if (selectedProspect === null || result === null) {
      setMutationError(new Error('Select a public profile before recording consent.'));
      return;
    }
    if (!consentAccepted) {
      setMutationError(new Error('Confirm that explicit consent was recorded before planning an import.'));
      return;
    }
    let normalizedCapturedAt: string;
    try {
      normalizedCapturedAt = normalizePublicProspectTimestamp(capturedAt, 'consent.capturedAt');
    } catch (error) {
      setMutationError(error);
      return;
    }
    const source = sourceReferenceFor(selectedProspect, result);
    const consent = {
      method: consentMethod,
      scope: consentScope,
      capturedAt: normalizedCapturedAt,
      capturedBy: actor,
      evidenceRef,
      policyVersion
    };
    const candidateFields = {
      name: candidateProfile.name,
      email: candidateProfile.email,
      resumeText: candidateProfile.resumeText,
      ...(candidateProfile.skills.trim()
        ? { skills: candidateProfile.skills.split(',').map((skill) => skill.trim()).filter(Boolean) }
        : {}),
      ...(candidateProfile.experienceYears.trim()
        ? { experienceYears: Number(candidateProfile.experienceYears) }
        : {})
    };
    const input: ImportPublicProspectInput = {
      ...source,
      consent,
      ...(consentMethod === 'candidate_submitted' ? { candidateProfile: candidateFields } : {})
    };
    try {
      const planned = await mutationClient.invoke(
        'plan_operation',
        {
          targetOperation: 'import_public_prospect',
          input: input as unknown as PlanOperationInput['input']
        },
        { actor }
      );
      const output = planned as PlanOperationOutput;
      setPlanResult(output);
      setNotice(`Import plan ${output.approvalId} is ready for trusted human approval. No prospect or candidate record was changed.`);
    } catch (error) {
      setMutationError(error);
    }
  };

  useEffect(() => () => requestController.current?.abort(), [client]);

  return (
    <section
      aria-labelledby="github-prospects-heading"
      className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm"
    >
      <div>
        <h2 id="github-prospects-heading" className="text-lg font-semibold">
          Source candidates · public GitHub prospects
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Search public profiles on demand through GitHub&apos;s official REST API. Search is read-only and does not create a candidate record.
        </p>
      </div>

      <form onSubmit={(event) => void search(event)} className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2" data-source-candidates-form>
        <label className="md:col-span-3 text-sm text-gray-700">
          Query
          <input
            aria-label="GitHub prospect query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. backend engineer"
            maxLength={100}
            required
            className="mt-1 w-full border rounded p-2 text-sm"
          />
        </label>
        <label className="text-sm text-gray-700">
          Language <span className="text-gray-400">(optional)</span>
          <input
            aria-label="GitHub prospect language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            placeholder="TypeScript"
            maxLength={60}
            className="mt-1 w-full border rounded p-2 text-sm"
          />
        </label>
        <label className="text-sm text-gray-700">
          Location <span className="text-gray-400">(optional)</span>
          <input
            aria-label="GitHub prospect location"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Berlin"
            maxLength={60}
            className="mt-1 w-full border rounded p-2 text-sm"
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 bg-slate-800 text-white rounded p-2 text-sm font-medium disabled:opacity-50"
          >
            <Search className="w-4 h-4" />
            {loading ? 'Searching…' : 'Search GitHub'}
          </button>
        </div>
      </form>

      <GitHubProspectsResults
        result={result}
        loading={loading}
        requestError={requestError}
        onSelectProspect={selectProspect}
        selectedLogin={selectedProspect?.login}
      />
      <GitHubProspectsConsentNotice />

      {selectedProspect && result && (
        <form onSubmit={(event) => void planImport(event)} data-prospect-consent-form className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-700 mt-0.5" />
            <div>
              <h3 className="font-semibold text-indigo-950">Record explicit consent before planning import</h3>
              <p className="text-xs text-indigo-900">Selected public profile: <strong>{selectedProspect.login}</strong>. The plan is redacted and creates no domain record until a trusted human approves and commits it.</p>
            </div>
          </div>
          <div data-provenance-preview className="rounded-lg border border-indigo-100 bg-white p-3 text-xs text-gray-700 space-y-1">
            <p><strong>Provenance preview:</strong> sourceRecordId={selectedProspect.login} · dataOrigin=public_github · sourceQuery={result.query}</p>
            <p>Profile: <a className="underline" href={selectedProspect.profileUrl} target="_blank" rel="noreferrer noopener">{selectedProspect.profileUrl}</a></p>
            <p>Canonical source URL: https://api.github.com/users/{selectedProspect.login}</p>
            <p>Field origins: public source fields=github_public · consent metadata=recruiter_entered · retention preview=30 days from server import</p>
            <p>Attribution: <a className="underline" href={result.attribution.searchApiDocsUrl} target="_blank" rel="noreferrer noopener">GitHub REST API documentation</a> · fetched {formatTimestamp(selectedProspect.fetchedAt)}</p>
          </div>
          <label className="block text-sm text-gray-700">
            Consent method
            <select value={consentMethod} onChange={(event) => setConsentMethod(event.target.value as PublicProspectConsentMethod)} className="mt-1 w-full border rounded p-2 text-sm">
              <option value="approved_consent_channel">Approved consent channel</option>
              <option value="candidate_submitted">Candidate submitted profile</option>
            </select>
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="text-sm text-gray-700">Consent scope<input value={consentScope} onChange={(event) => setConsentScope(event.target.value)} required maxLength={200} className="mt-1 w-full border rounded p-2 text-sm" /></label>
            <label className="text-sm text-gray-700">Evidence reference<input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} required maxLength={256} placeholder="server consent record ID" className="mt-1 w-full border rounded p-2 text-sm" /></label>
            <label className="text-sm text-gray-700">Captured at (ISO timestamp)<input value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} required className="mt-1 w-full border rounded p-2 text-sm" /></label>
            <label className="text-sm text-gray-700">Policy version<input value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} required maxLength={80} className="mt-1 w-full border rounded p-2 text-sm" /></label>
          </div>
          {consentMethod === 'candidate_submitted' && (
            <div data-candidate-submitted-profile className="rounded-lg border border-indigo-100 bg-white p-3 space-y-2">
              <h4 className="font-medium text-gray-900">Candidate-submitted fields only</h4>
              <p className="text-xs text-gray-500">These private fields are sent only through the protected canonical operation and are never copied into public-prospect provenance or activity projections.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <input aria-label="Submitted candidate name" value={candidateProfile.name} onChange={(event) => setCandidateProfile((previous) => ({ ...previous, name: event.target.value }))} placeholder="Name" required className="border rounded p-2 text-sm" />
                <input aria-label="Submitted candidate email" value={candidateProfile.email} onChange={(event) => setCandidateProfile((previous) => ({ ...previous, email: event.target.value }))} placeholder="Email" required className="border rounded p-2 text-sm" />
                <input aria-label="Submitted candidate skills" value={candidateProfile.skills} onChange={(event) => setCandidateProfile((previous) => ({ ...previous, skills: event.target.value }))} placeholder="Skills, comma separated" className="border rounded p-2 text-sm" />
                <input aria-label="Submitted candidate experience" value={candidateProfile.experienceYears} onChange={(event) => setCandidateProfile((previous) => ({ ...previous, experienceYears: event.target.value }))} type="number" min="0" max="100" placeholder="Experience years" className="border rounded p-2 text-sm" />
              </div>
              <textarea aria-label="Submitted candidate resume" value={candidateProfile.resumeText} onChange={(event) => setCandidateProfile((previous) => ({ ...previous, resumeText: event.target.value }))} placeholder="Candidate-submitted resume text" required className="w-full border rounded p-2 text-sm" />
            </div>
          )}
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={consentAccepted} onChange={(event) => setConsentAccepted(event.target.checked)} className="mt-1" />
            <span>I confirm that explicit consent was captured for this exact scope and evidence reference. A public GitHub profile alone is not consent.</span>
          </label>
          <button type="submit" disabled={actor.actorType !== 'human_ui'} className="inline-flex items-center gap-2 rounded bg-indigo-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" data-plan-public-prospect>
            <ShieldCheck className="w-4 h-4" /> Plan consented import
          </button>
          {actor.actorType !== 'human_ui' && <p role="alert" className="text-xs text-red-700">Only a trusted human may capture consent and request this import plan from the UI.</p>}
        </form>
      )}

      {mutationError && <p role="alert" data-prospect-mutation-error className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorText(mutationError)}</p>}
      {notice && <p role="status" data-prospect-operation-notice className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
      {planResult && (
        <div data-prospect-approval-link className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
          Approval card <a className="font-semibold underline" href={`#approval-card-${planResult.approvalId}`}>{planResult.approvalId}</a> is visible in Human approval cards. Approve and commit it there; this panel does not bypass that boundary.
        </div>
      )}

      <ImportedProspectsList
        client={mutationClient}
        actor={actor}
        onNotice={(message) => { setNotice(message); setMutationError(null); }}
        onError={(error) => { setMutationError(error); setNotice(null); }}
      />
    </section>
  );
}

export default GitHubProspectsPanel;
