import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/shared/errors';
import {
  arePublicJobListingsEqual,
  deduplicatePublicJobListings,
  getPublicJobListingDeduplicationKey,
  getPublicJobListingDeduplicationStrategy,
  getPublicJobListingFallbackKey,
  importPublicJobListings,
  InMemoryPublicJobListingStore,
  normalizeDate,
  normalizePublicJobListing,
  normalizeUrl,
  createSyntheticCandidates,
  type PublicJobListingInput,
  type PublicJobListingRecord,
  type PublicJobListingSourceAdapter
} from '../src/server/imports';

const FIXED_IMPORT_TIME = '2026-02-01T12:00:00.000Z';

function listing(
  overrides: Partial<PublicJobListingInput> = {}
): PublicJobListingInput {
  return {
    title: 'Platform Engineer',
    company: 'Example Systems',
    location: 'Remote',
    description: 'Build reliable platform services.',
    requirements: ['TypeScript', 'Cloud operations'],
    canonicalSourceUrl: 'https://jobs.example.test/platform-engineer',
    fetchedAt: FIXED_IMPORT_TIME,
    sourceName: 'Approved Board',
    externalId: 'platform-1',
    ...overrides
  };
}

function normalizedListing(
  overrides: Partial<PublicJobListingInput> = {}
): PublicJobListingRecord {
  return normalizePublicJobListing(listing(overrides));
}

function fixedClock() {
  return { now: () => FIXED_IMPORT_TIME };
}

describe('public job listing importer boundary', () => {
  it('normalizes text, URL components, dates, optional metadata, and attribution', () => {
    const result = normalizePublicJobListing({
      title: '  Senior\u00a0 Platform  Engineer\n',
      company: ' Example Systems ',
      location: ' Remote / United States ',
      description: '  Build dependable services.  ',
      requirements: [' TypeScript\n', ' Cloud operations '],
      sourceName: ' Approved Board ',
      canonicalSourceUrl:
        'HTTPS://JOBS.EXAMPLE.TEST:443/platform-engineer/?view=full#description',
      fetchedAt: '2026-01-01T05:30:00+05:30',
      externalId: ' listing-1 ',
      employmentMetadata: {
        employmentType: ' Full-Time ',
        workplaceType: ' Remote ',
        compensationRange: {
          min: 100000,
          max: 140000,
          currency: ' USD '
        }
      }
    });

    expect(result).toEqual({
      title: 'Senior Platform Engineer',
      company: 'Example Systems',
      location: 'Remote / United States',
      description: 'Build dependable services.',
      requirements: ['TypeScript', 'Cloud operations'],
      sourceName: 'Approved Board',
      canonicalSourceUrl:
        'https://jobs.example.test/platform-engineer?view=full',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      externalId: 'listing-1',
      employmentMetadata: {
        employmentType: 'full-time',
        workplaceType: 'remote',
        compensationRange: {
          min: 100000,
          max: 140000,
          currency: 'USD'
        }
      }
    });
  });

  it('normalizes date-only values and rejects malformed dates and URLs', () => {
    expect(normalizeDate('2026-02-03')).toBe('2026-02-03T00:00:00.000Z');
    expect(normalizeDate('2026-02-03T18:30:00-04:00')).toBe(
      '2026-02-03T22:30:00.000Z'
    );
    expect(() => normalizeDate('2026-02-30')).toThrow(/invalid calendar date/);
    expect(() => normalizeDate('2026-02-03T18:30:00')).toThrow(/timezone/);
    expect(normalizeUrl('https://Example.test/jobs/1/#details')).toBe(
      'https://example.test/jobs/1'
    );
    expect(() => normalizeUrl('ftp://example.test/jobs/1')).toThrow(/http or https/);
    expect(() => normalizeUrl('not-a-url')).toThrow(/absolute URL/);
  });

  it('rejects malformed records with multiple actionable field issues', () => {
    let caught: PipelineError | undefined;
    try {
      normalizePublicJobListing({
        title: ' ',
        company: 42,
        location: '',
        description: '',
        requirements: [''],
        sourceName: ' ',
        canonicalSourceUrl: 'not-a-url',
        fetchedAt: 'not-a-date',
        externalId: ' '
      });
    } catch (error) {
      caught = PipelineError.from(error);
    }

    expect(caught?.code).toBe('VALIDATION_ERROR');
    expect(caught?.status).toBe(400);
    expect(caught?.details?.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'title',
        'company',
        'location',
        'description',
        'requirements[0]',
        'sourceName',
        'canonicalSourceUrl',
        'fetchedAt',
        'externalId'
      ])
    );
  });

  it('uses external ID, then canonical URL, and exposes a stable fallback key', () => {
    const withExternalId = normalizedListing();
    const sameExternalIdDifferentUrl = normalizedListing({
      canonicalSourceUrl: 'https://jobs.example.test/renamed',
      title: 'Renamed Platform Engineer'
    });
    const differentSourceSameExternalId = normalizedListing({
      sourceName: 'Another Approved Board'
    });
    const urlOnly = normalizedListing({ externalId: null });
    const urlOnlyDifferentFields = normalizedListing({
      externalId: null,
      title: 'A different title',
      company: 'A different company'
    });

    expect(getPublicJobListingDeduplicationStrategy(withExternalId)).toBe(
      'source-external-id'
    );
    expect(getPublicJobListingDeduplicationKey(withExternalId)).toBe(
      getPublicJobListingDeduplicationKey(sameExternalIdDifferentUrl)
    );
    expect(getPublicJobListingDeduplicationKey(withExternalId)).not.toBe(
      getPublicJobListingDeduplicationKey(differentSourceSameExternalId)
    );
    expect(getPublicJobListingDeduplicationStrategy(urlOnly)).toBe(
      'canonical-url'
    );
    expect(getPublicJobListingDeduplicationKey(urlOnly)).toBe(
      getPublicJobListingDeduplicationKey(urlOnlyDifferentFields)
    );

    const fallbackA = {
      ...urlOnly,
      canonicalSourceUrl: ''
    } as PublicJobListingRecord;
    const fallbackB = {
      ...fallbackA,
      company: '  EXAMPLE SYSTEMS ',
      title: ' PLATFORM ENGINEER ',
      location: ' remote '
    };
    expect(getPublicJobListingDeduplicationStrategy(fallbackA)).toBe(
      'company-title-location'
    );
    expect(getPublicJobListingFallbackKey(fallbackA)).toBe(
      getPublicJobListingFallbackKey(fallbackB)
    );
  });

  it('deduplicates normalized batches deterministically and compares records by value', () => {
    const first = normalizedListing();
    const duplicate = normalizedListing();
    const second = normalizedListing({
      externalId: 'platform-2',
      canonicalSourceUrl: 'https://jobs.example.test/platform-engineer-2'
    });
    const result = deduplicatePublicJobListings([first, duplicate, second]);

    expect(result.records).toEqual([first, second]);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicateKeys).toEqual([
      getPublicJobListingDeduplicationKey(first)
    ]);
    expect(arePublicJobListingsEqual(first, duplicate)).toBe(true);
    expect(arePublicJobListingsEqual(first, second)).toBe(false);
  });

  it('reports created, updated, skipped, and malformed counts with source attribution', async () => {
    const first = listing();
    const same = listing();
    const changed = listing({
      title: 'Platform Engineer (Updated)',
      description: 'Build more reliable platform services.'
    });
    const urlOnly = listing({
      externalId: null,
      canonicalSourceUrl: 'https://jobs.example.test/data-engineer',
      title: 'Data Engineer'
    });
    const malformed = {
      ...listing(),
      title: '',
      canonicalSourceUrl: 'bad-url'
    } as unknown as PublicJobListingInput;

    const adapter: PublicJobListingSourceAdapter = {
      adapterName: 'approved-board-test-adapter',
      sourceName: 'Approved Board',
      async fetchListings() {
        return [first, same, changed, urlOnly, malformed];
      }
    };
    const store = new InMemoryPublicJobListingStore();

    const result = await importPublicJobListings(adapter, store, {
      clock: fixedClock()
    });

    expect(result.created).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.errorDetails[0]).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        index: 4,
        sourceName: 'Approved Board',
        canonicalSourceUrl: 'bad-url'
      }
    });
    expect(result.errorDetails[0].details?.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['title', 'canonicalSourceUrl'])
    );
    expect(result.attribution).toEqual({
      adapterName: 'approved-board-test-adapter',
      sourceName: 'Approved Board',
      importedAt: FIXED_IMPORT_TIME,
      canonicalSourceUrls: [
        'https://jobs.example.test/data-engineer',
        'https://jobs.example.test/platform-engineer'
      ]
    });

    const stored = await store.list();
    expect(stored).toHaveLength(2);
    expect(stored[0].sourceName).toBe('Approved Board');
    expect(stored[0].canonicalSourceUrl).toMatch(/^https:\/\//);
    expect(stored.find((record) => record.title === 'Platform Engineer (Updated)')).toBeDefined();
  });

  it('does not make an adapter failure look like a successful empty import', async () => {
    const adapter: PublicJobListingSourceAdapter = {
      adapterName: 'approved-board-test-adapter',
      sourceName: 'Approved Board',
      async fetchListings() {
        throw new Error('source temporarily unavailable');
      }
    };

    const result = await importPublicJobListings(
      adapter,
      new InMemoryPublicJobListingStore(),
      { clock: fixedClock() }
    );

    expect(result).toMatchObject({
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 1,
      attribution: {
        sourceName: 'Approved Board',
        importedAt: FIXED_IMPORT_TIME
      }
    });
    expect(result.errorDetails[0]).toMatchObject({
      code: 'ADAPTER_ERROR',
      message: 'source temporarily unavailable',
      details: { sourceName: 'Approved Board' }
    });
  });
});

describe('synthetic candidate fixtures', () => {
  it('are deterministic, fresh, explicitly marked, and free of copied contact data', () => {
    const first = createSyntheticCandidates();
    const second = createSyntheticCandidates();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).toHaveLength(3);
    expect(first.every((candidate) => candidate.synthetic === true)).toBe(true);
    expect(first.every((candidate) => candidate.dataOrigin === 'synthetic')).toBe(true);
    expect(first.every((candidate) => candidate.email.endsWith('.example.test'))).toBe(
      true
    );
    expect(first.every((candidate) => !('phone' in candidate))).toBe(true);
    expect(first.every((candidate) => candidate.name.startsWith('Synthetic Candidate'))).toBe(
      true
    );

    first[0].skills.push('mutated-in-test');
    expect(second[0].skills).not.toContain('mutated-in-test');
  });
});
