import type {
  PublicJobListingAdapterContext,
  PublicJobListingInput,
  PublicJobListingSourceAdapter
} from '../contracts';
import {
  assertArray,
  assertRecord,
  compensationRange,
  deriveRequirements,
  fetchSourceJson,
  optionalBoolean,
  optionalCurrency,
  optionalFiniteNumber,
  optionalId,
  optionalPlainText,
  optionalTextList,
  requiredPlainText,
  resolveSourceAdapterOptions,
  PublicJobListingAdapterError,
  type PublicJobListingSourceAdapterOptions,
  type PublicJobSourceFetch
} from './shared';

export const ARBEITNOW_PUBLIC_JOBS_URL =
  'https://www.arbeitnow.com/api/job-board-api';

export class ArbeitnowPublicJobListingAdapter
  implements PublicJobListingSourceAdapter {
  readonly adapterName = 'arbeitnow-public-job-board-api';
  readonly sourceName = 'Arbeitnow';
  readonly sourceUrl = ARBEITNOW_PUBLIC_JOBS_URL;

  private readonly fetcher: PublicJobSourceFetch;
  private readonly userAgent: string;

  constructor(
    options: PublicJobListingSourceAdapterOptions | PublicJobSourceFetch = {}
  ) {
    const resolved = resolveSourceAdapterOptions(options);
    this.fetcher = resolved.fetcher;
    this.userAgent = resolved.userAgent;
  }

  async fetchListings(
    context: PublicJobListingAdapterContext
  ): Promise<readonly PublicJobListingInput[]> {
    const payload = await fetchSourceJson(
      this.fetcher,
      this.sourceUrl,
      context,
      this.userAgent
    );
    const root = assertRecord(payload, 'Arbeitnow response');
    const jobs = assertArray(root.data, 'Arbeitnow response.data');
    return jobs.map((rawJob, index) => this.normalizeJob(rawJob, index, context));
  }

  private normalizeJob(
    rawJob: unknown,
    index: number,
    context: PublicJobListingAdapterContext
  ): PublicJobListingInput {
    const job = assertRecord(rawJob, `Arbeitnow response.data[${index}]`);
    const title = requiredPlainText(
      job.title,
      `Arbeitnow response.data[${index}].title`
    );
    const company = requiredPlainText(
      job.company_name ?? job.company,
      `Arbeitnow response.data[${index}].company_name`
    );
    const description = requiredPlainText(
      job.description,
      `Arbeitnow response.data[${index}].description`
    );
    const remote = optionalBoolean(
      job.remote,
      `Arbeitnow response.data[${index}].remote`
    );
    const location = optionalPlainText(
      job.location,
      `Arbeitnow response.data[${index}].location`
    ) ?? (remote === true ? 'Remote' : undefined);
    if (!location) {
      throw new PublicJobListingAdapterError(
        'MALFORMED_LISTING',
        `Arbeitnow response.data[${index}].location must be a non-empty location`,
        `Arbeitnow response.data[${index}].location`
      );
    }
    const url = requiredPlainText(
      job.url,
      `Arbeitnow response.data[${index}].url`
    );
    const tags = optionalTextList(
      job.tags,
      `Arbeitnow response.data[${index}].tags`
    );
    const requirements = deriveRequirements(
      tags,
      undefined,
      description,
      {
        tags: `Arbeitnow response.data[${index}].tags`,
        industry: `Arbeitnow response.data[${index}].industry`
      }
    );
    const externalId = optionalId(
      job.id ?? job.slug,
      `Arbeitnow response.data[${index}].id`
    );
    const jobTypes = optionalTextList(
      job.job_types ?? job.jobTypes ?? job.employment_type,
      `Arbeitnow response.data[${index}].job_types`
    );
    const min = optionalFiniteNumber(
      job.salary_min ?? job.salaryMin ?? (job.salary as Record<string, unknown> | undefined)?.min,
      `Arbeitnow response.data[${index}].salary_min`
    );
    const max = optionalFiniteNumber(
      job.salary_max ?? job.salaryMax ?? (job.salary as Record<string, unknown> | undefined)?.max,
      `Arbeitnow response.data[${index}].salary_max`
    );
    const currency = optionalCurrency(
      job.salary_currency ?? job.salaryCurrency ?? (job.salary as Record<string, unknown> | undefined)?.currency,
      `Arbeitnow response.data[${index}].salary_currency`
    );
    const salary = compensationRange(min, max, currency);
    const employmentMetadata = {
      ...(jobTypes.length > 0 ? { employmentType: jobTypes.join(', ') } : {}),
      ...(remote === true ? { workplaceType: 'remote' } : {}),
      ...(salary === undefined ? {} : { compensationRange: salary })
    };

    return {
      title,
      company,
      location,
      description,
      requirements,
      sourceName: this.sourceName,
      canonicalSourceUrl: url,
      fetchedAt: context.fetchedAt,
      ...(externalId === undefined ? {} : { externalId }),
      ...(Object.keys(employmentMetadata).length === 0
        ? {}
        : { employmentMetadata })
    };
  }
}

export const ArbeitnowAdapter = ArbeitnowPublicJobListingAdapter;
