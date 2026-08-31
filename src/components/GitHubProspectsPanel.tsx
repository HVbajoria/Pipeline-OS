import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Search } from 'lucide-react';
import { PipelineError } from '../shared/errors';
import {
  GitHubProspectsClient,
  GitHubProspectsClientError,
  githubProspectsClient
} from '../client/githubProspectsClient';
import type {
  GitHubProspect,
  GitHubProspectSearchResult
} from '../shared/publicProspects';

export interface GitHubProspectsPanelProps {
  client?: GitHubProspectsClient;
}

export interface GitHubProspectsResultsProps {
  result: GitHubProspectSearchResult | null;
  loading?: boolean;
  requestError?: unknown;
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
  return 'GitHub public-prospect search could not be completed.';
}

function isRateLimitError(error: unknown): boolean {
  return (
    (error instanceof GitHubProspectsClientError && error.isRateLimited) ||
    (error instanceof PipelineError && error.code === 'RATE_LIMITED_ERROR')
  );
}

function ProspectCard({ prospect }: { prospect: GitHubProspect }) {
  return (
    <article className="border border-gray-200 rounded-lg p-4">
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
          <a
            href={prospect.profileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline mt-3"
          >
            View GitHub profile <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </article>
  );
}

/** Render public prospect results without connecting them to candidate state. */
export function GitHubProspectsResults({
  result,
  loading = false,
  requestError = null
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
                <ProspectCard key={`${prospect.login}-${prospect.profileUrl}`} prospect={prospect} />
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
      These are public prospects, not candidates. A person is not in the PipelineOS recruiting workflow unless they apply or otherwise provide consent. PipelineOS does not copy email, phone, or contact data, auto-message, auto-apply, or make hiring decisions from this catalog.
    </p>
  );
}

/**
 * Recruiter-only, explicit on-demand catalog search. Prospects never enter
 * the shared candidate/application projection from this component.
 */
export function GitHubProspectsPanel({
  client = githubProspectsClient
}: GitHubProspectsPanelProps) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const [location, setLocation] = useState('');
  const [result, setResult] = useState<GitHubProspectSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
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
    try {
      const next = await client.search(
        {
          query: normalizedQuery,
          ...(language.trim() ? { language: language.trim() } : {}),
          ...(location.trim() ? { location: location.trim() } : {})
        },
        controller.signal
      );
      if (!controller.signal.aborted) setResult(next);
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(error);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
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
          Public GitHub prospects
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Search public profiles on demand through GitHub&apos;s official REST API. This is not a candidate database.
        </p>
      </div>

      <form onSubmit={(event) => void search(event)} className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
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
      />
      <GitHubProspectsConsentNotice />
    </section>
  );
}

export default GitHubProspectsPanel;
