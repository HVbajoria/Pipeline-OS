import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  PublicJobsClient,
  PublicJobsClientError,
  publicJobsClient
} from '../client/publicJobsClient';
import type { PublicJobsResult } from '../server/imports/publicJobs';

export interface LivePublicJobsPanelProps {
  client?: PublicJobsClient;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorText(error: unknown): string {
  if (error instanceof PublicJobsClientError) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Live public jobs could not be loaded.';
}

export function LivePublicJobsPanel({
  client = publicJobsClient
}: LivePublicJobsPanelProps) {
  const [result, setResult] = useState<PublicJobsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const load = async (refresh: boolean): Promise<void> => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setRequestError(null);
    try {
      const next = await client.getListings({ refresh, signal: controller.signal });
      if (!controller.signal.aborted) setResult(next);
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    return () => requestController.current?.abort();
  }, [client]);

  return (
    <section
      aria-labelledby="live-public-jobs-heading"
      className="panel panel--padded"
    >
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h2 id="live-public-jobs-heading" className="text-lg font-semibold">
            Live public jobs
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Current listings from approved public feeds. These are not internal requisitions yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="ui-button ui-button--secondary"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loading && !result && (
        <p role="status" className="text-sm text-gray-500 mt-4">
          Loading public listings…
        </p>
      )}
      {requestError && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mt-4">
          {requestError}
        </p>
      )}

      {result && (
        <>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>Cache: {result.cache.state}</span>
            <span>Fetched: {formatTimestamp(result.fetchedAt)}</span>
            <span>Cache window: {Math.round(result.cache.ttlMs / 60000)} minutes</span>
          </div>
          {result.errors.length > 0 && (
            <div role="status" className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              {result.errors.map((sourceError) => (
                <p key={`${sourceError.adapterName}-${sourceError.code}`}>
                  {sourceError.sourceName}: {sourceError.message}
                  {sourceError.sourceUrl && (
                    <> (<a className="underline" href={sourceError.sourceUrl} target="_blank" rel="noreferrer">source feed</a>)</>
                  )}
                </p>
              ))}
            </div>
          )}
          {result.listings.length === 0 ? (
            <p className="text-sm text-gray-500 mt-4">
              No public listings are available right now. Try Refresh later.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
              {result.listings.map((listing) => (
                <article
                  key={`${listing.sourceName}-${listing.externalId ?? listing.canonicalSourceUrl}`}
                  className="panel panel--compact"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">{listing.title}</h3>
                      <p className="text-sm text-gray-700 mt-1">{listing.company}</p>
                    </div>
                    <span className="text-xs rounded-full px-2 py-1 bg-blue-50 text-blue-700 whitespace-nowrap">
                      {listing.sourceName}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">{listing.location}</p>
                  {listing.employmentMetadata && (
                    <p className="text-xs text-gray-500 mt-1">
                      {[listing.employmentMetadata.employmentType, listing.employmentMetadata.workplaceType]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-2">
                    Feed fetched {formatTimestamp(listing.fetchedAt)}
                  </p>
                  <a
                    href={listing.canonicalSourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline mt-3"
                  >
                    View original listing <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default LivePublicJobsPanel;
