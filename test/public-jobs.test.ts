import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ArbeitnowPublicJobListingAdapter,
  ARBEITNOW_PUBLIC_JOBS_URL,
  JobicyPublicJobListingAdapter,
  JOBICY_PUBLIC_JOBS_URL,
  PublicJobsCoordinator,
  type PublicJobSourceFetch
} from '../src/server/imports';
import { createPipelineApi } from '../src/server/api';

const FIRST_FETCHED_AT = '2026-03-01T12:00:00.000Z';
const SECOND_FETCHED_AT = '2026-03-01T12:01:00.000Z';

const jobicyPayload = {
  jobs: [
    {
      id: 'jobicy-1',
      url: 'https://jobicy.com/jobs/senior-backend?ref=api#details',
      jobTitle: 'Senior <em>Backend</em> Engineer',
      companyName: 'Acme &amp; Co',
      jobGeo: 'Remote / United States',
      jobDescription:
        '<p>Build &amp; operate reliable APIs.</p><ul><li>Own platform services</li></ul><script>ignore()</script>',
      jobIndustry: ['Engineering'],
      jobType: ['Full-time'],
      remote: true,
      annualSalaryMin: 150000,
      annualSalaryMax: 180000,
      salaryCurrency: 'USD'
    }
  ]
};

const arbeitnowPayload = {
  data: [
    {
      slug: 'staff-data-engineer',
      url: 'https://www.arbeitnow.com/jobs/staff-data-engineer',
      title: 'Staff Data Engineer',
      company_name: 'Data &amp; Co',
      location: '',
      remote: true,
      description: '<p>Design data platforms &amp; pipelines.</p>',
      tags: ['Python', 'SQL'],
      job_types: ['full_time']
    }
  ],
  meta: { page: 1 }
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function payloadFor(url: string): unknown {
  if (url === JOBICY_PUBLIC_JOBS_URL) return jobicyPayload;
  if (url === ARBEITNOW_PUBLIC_JOBS_URL) return arbeitnowPayload;
  throw new Error(`Unexpected source URL: ${url}`);
}

function staticFetcher(payloads: Record<string, unknown>): {
  fetcher: PublicJobSourceFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (!(url in payloads)) throw new Error(`No fixture for ${url}`);
      return jsonResponse(payloads[url]);
    }
  };
}

interface HttpResult {
  status: number;
  body: unknown;
}

function jsonRequest(baseUrl: string, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const request = httpRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'application/json' }
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            body: text.length === 0 ? undefined : JSON.parse(text)
          });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

describe('approved public job source adapters', () => {
  it('normalizes Jobicy fields, strips HTML, derives requirements, and preserves source URL input', async () => {
    const { fetcher, calls } = staticFetcher({ [JOBICY_PUBLIC_JOBS_URL]: jobicyPayload });
    const adapter = new JobicyPublicJobListingAdapter(fetcher);
    const listings = await adapter.fetchListings({ fetchedAt: FIRST_FETCHED_AT });

    expect(calls).toEqual([JOBICY_PUBLIC_JOBS_URL]);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      title: 'Senior Backend Engineer',
      company: 'Acme & Co',
      location: 'Remote / United States',
      description: 'Build & operate reliable APIs. Own platform services',
      requirements: expect.arrayContaining(['Engineering', 'Build & operate reliable APIs.']),
      sourceName: 'Jobicy',
      canonicalSourceUrl: 'https://jobicy.com/jobs/senior-backend?ref=api#details',
      fetchedAt: FIRST_FETCHED_AT,
      externalId: 'jobicy-1',
      employmentMetadata: {
        employmentType: 'Full-time',
        workplaceType: 'remote',
        compensationRange: { min: 150000, max: 180000, currency: 'USD' }
      }
    });
    expect(listings[0].description).not.toMatch(/[<>]|ignore\(\)/u);
  });

  it('normalizes Arbeitnow fields, uses Remote for a remote-only location, and retains tags', async () => {
    const { fetcher } = staticFetcher({ [ARBEITNOW_PUBLIC_JOBS_URL]: arbeitnowPayload });
    const adapter = new ArbeitnowPublicJobListingAdapter(fetcher);
    const listings = await adapter.fetchListings({ fetchedAt: FIRST_FETCHED_AT });

    expect(listings).toEqual([
      expect.objectContaining({
        title: 'Staff Data Engineer',
        company: 'Data & Co',
        location: 'Remote',
        description: 'Design data platforms & pipelines.',
        requirements: expect.arrayContaining(['Python', 'SQL']),
        sourceName: 'Arbeitnow',
        canonicalSourceUrl: 'https://www.arbeitnow.com/jobs/staff-data-engineer',
        externalId: 'staff-data-engineer',
        employmentMetadata: {
          employmentType: 'full_time',
          workplaceType: 'remote'
        }
      })
    ]);
  });

  it('rejects malformed feed roots and listings instead of returning silent empties', async () => {
    const malformedRoot = new JobicyPublicJobListingAdapter(async () =>
      jsonResponse({ jobs: {} })
    );
    await expect(
      malformedRoot.fetchListings({ fetchedAt: FIRST_FETCHED_AT })
    ).rejects.toMatchObject({
      code: 'MALFORMED_PAYLOAD'
    });

    const malformedListing = new ArbeitnowPublicJobListingAdapter(async () =>
      jsonResponse({ data: [{ title: 'Missing fields' }] })
    );
    await expect(
      malformedListing.fetchListings({ fetchedAt: FIRST_FETCHED_AT })
    ).rejects.toMatchObject({
      code: 'MALFORMED_LISTING'
    });
  });
});

describe('public jobs coordinator cache and source isolation', () => {
  it('combines both sources, caches for 15 minutes, and bypasses cache on refresh=true', async () => {
    let now = FIRST_FETCHED_AT;
    const { fetcher, calls } = staticFetcher({
      [JOBICY_PUBLIC_JOBS_URL]: jobicyPayload,
      [ARBEITNOW_PUBLIC_JOBS_URL]: arbeitnowPayload
    });
    const coordinator = new PublicJobsCoordinator({
      fetcher,
      clock: { now: () => now }
    });

    const first = await coordinator.getListings();
    expect(first.listings).toHaveLength(2);
    expect(first.cache).toMatchObject({
      state: 'refreshed',
      ttlMs: 15 * 60 * 1000,
      hit: false,
      refreshed: true
    });
    expect(first.errors).toEqual([]);
    expect(first.sources.map((source) => source.sourceName)).toEqual([
      'Jobicy',
      'Arbeitnow'
    ]);
    expect(first.sources.every((source) => source.sourceUrl.startsWith('https://'))).toBe(true);
    expect(first.sources.flatMap((source) => source.canonicalSourceUrls)).toEqual([
      'https://jobicy.com/jobs/senior-backend?ref=api',
      'https://www.arbeitnow.com/jobs/staff-data-engineer'
    ]);
    expect(calls).toHaveLength(2);

    now = '2026-03-01T12:05:00.000Z';
    const cached = await coordinator.getListings();
    expect(cached.cache).toMatchObject({ state: 'fresh', hit: true, refreshed: false });
    expect(cached.sources.every((source) => source.cached && source.status === 'cached')).toBe(true);
    expect(calls).toHaveLength(2);

    now = SECOND_FETCHED_AT;
    const refreshed = await coordinator.getListings({ refresh: true });
    expect(refreshed.cache).toMatchObject({ state: 'refreshed', hit: false, refreshed: true });
    expect(refreshed.sources.every((source) => source.status === 'fresh')).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('keeps source failures independent and serves stale source cache when refresh fails', async () => {
    let now = FIRST_FETCHED_AT;
    let arbeitnowAvailable = true;
    const calls: string[] = [];
    const fetcher: PublicJobSourceFetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === JOBICY_PUBLIC_JOBS_URL) return jsonResponse(jobicyPayload);
      if (arbeitnowAvailable) return jsonResponse(arbeitnowPayload);
      throw new Error('Arbeitnow temporarily unavailable');
    };
    const coordinator = new PublicJobsCoordinator({
      fetcher,
      clock: { now: () => now }
    });

    const initial = await coordinator.getListings();
    expect(initial.errors).toEqual([]);

    arbeitnowAvailable = false;
    now = '2026-03-01T12:16:00.000Z';
    const partial = await coordinator.getListings();
    expect(partial.listings).toHaveLength(2);
    expect(partial.errors).toEqual([
      expect.objectContaining({
        sourceName: 'Arbeitnow',
        code: 'FETCH_ERROR',
        message: 'Arbeitnow temporarily unavailable'
      })
    ]);
    expect(partial.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: 'Jobicy', status: 'fresh' }),
      expect.objectContaining({ sourceName: 'Arbeitnow', status: 'stale', cached: true })
    ]));
    expect(partial.cache.state).toBe('partial');
    expect(calls).toHaveLength(4);
  });

  it('returns a structured malformed-source error without throwing or treating it as success', async () => {
    const coordinator = new PublicJobsCoordinator({
      adapters: [new JobicyPublicJobListingAdapter(async () => jsonResponse({ wrong: [] }))],
      clock: { now: () => FIRST_FETCHED_AT }
    });
    const result = await coordinator.getListings();
    expect(result.listings).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        sourceName: 'Jobicy',
        code: 'MALFORMED_PAYLOAD'
      })
    ]);
    expect(result.cache.state).toBe('empty');
    expect(result.sources[0]).toMatchObject({ status: 'error', listingCount: 0 });
  });
});

describe('GET /api/public-jobs', () => {
  let server: Server | undefined;
  let baseUrl = '';

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  });

  it('returns normalized listings, cache metadata, source attribution, errors, and refresh behavior', async () => {
    const { fetcher, calls } = staticFetcher({
      [JOBICY_PUBLIC_JOBS_URL]: jobicyPayload,
      [ARBEITNOW_PUBLIC_JOBS_URL]: arbeitnowPayload
    });
    const coordinator = new PublicJobsCoordinator({
      fetcher,
      clock: { now: () => FIRST_FETCHED_AT }
    });
    const api = createPipelineApi({ publicJobs: coordinator });
    server = createServer(api.app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const first = await jsonRequest(baseUrl, '/api/public-jobs');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      listings: expect.arrayContaining([
        expect.objectContaining({ sourceName: 'Jobicy' }),
        expect.objectContaining({ sourceName: 'Arbeitnow' })
      ]),
      errors: [],
      cache: expect.objectContaining({ state: 'refreshed' })
    });
    expect(calls).toHaveLength(2);

    const cached = await jsonRequest(baseUrl, '/api/public-jobs');
    expect(cached.status).toBe(200);
    expect(cached.body).toMatchObject({
      cache: expect.objectContaining({ state: 'fresh', hit: true })
    });
    expect(calls).toHaveLength(2);

    const refreshed = await jsonRequest(baseUrl, '/api/public-jobs?refresh=true');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      cache: expect.objectContaining({ state: 'refreshed', refreshed: true }),
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceUrl: JOBICY_PUBLIC_JOBS_URL }),
        expect.objectContaining({ sourceUrl: ARBEITNOW_PUBLIC_JOBS_URL })
      ])
    });
    expect(calls).toHaveLength(4);
  });
});
