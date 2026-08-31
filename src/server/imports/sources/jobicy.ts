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

export const JOBICY_PUBLIC_JOBS_URL =
  'https://jobicy.com/api/v2/remote-jobs?count=50&industry=engineering';

export class JobicyPublicJobListingAdapter
  implements PublicJobListingSourceAdapter {
  readonly adapterName = 'jobicy-public-jobs-api';
  readonly sourceName = 'Jobicy';
  readonly sourceUrl = JOBICY_PUBLIC_JOBS_URL;

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
    const root = assertRecord(payload, 'Jobicy response');
    const rawJobs = root.jobs ?? root.jobListings;
    const jobs = assertArray(rawJobs, 'Jobicy response.jobs');

    return jobs.map((rawJob, index) => this.normalizeJob(rawJob, index, context));
  }

  private normalizeJob(
    rawJob: unknown,
    index: number,
    context: PublicJobListingAdapterContext
  ): PublicJobListingInput {
    const job = assertRecord(rawJob, `Jobicy response.jobs[${index}]`);
    const title = requiredPlainText(
      job.jobTitle ?? job.title,
      `Jobicy response.jobs[${index}].jobTitle`
    );
    const company = requiredPlainText(
      job.companyName ?? job.company,
      `Jobicy response.jobs[${index}].companyName`
    );
    const description = requiredPlainText(
      job.jobDescription ?? job.description ?? job.jobExcerpt,
      `Jobicy response.jobs[${index}].jobDescription`
    );
    const location = optionalPlainText(
      job.jobGeo ?? job.location ?? job.jobLocation,
      `Jobicy response.jobs[${index}].jobGeo`
    ) ?? (optionalBoolean(job.remote, `Jobicy response.jobs[${index}].remote`)
      ? 'Remote'
      : undefined);
    if (!location) {
      throw new PublicJobListingAdapterError(
        'MALFORMED_LISTING',
        `Jobicy response.jobs[${index}].jobGeo must be a non-empty location`,
        `Jobicy response.jobs[${index}].jobGeo`
      );
    }

    const url = requiredPlainText(
      job.url ?? job.jobUrl,
      `Jobicy response.jobs[${index}].url`
    );
    const tags = optionalTextList(
      job.jobTags ?? job.tags,
      `Jobicy response.jobs[${index}].jobTags`
    );
    const industry = optionalTextList(
      job.jobIndustry ?? job.industry,
      `Jobicy response.jobs[${index}].jobIndustry`
    );
    const requirements = deriveRequirements(
      tags,
      industry,
      description,
      {
        tags: `Jobicy response.jobs[${index}].jobTags`,
        industry: `Jobicy response.jobs[${index}].jobIndustry`
      }
    );
    const externalId = optionalId(
      job.id,
      `Jobicy response.jobs[${index}].id`
    );
    const jobTypes = optionalTextList(
      job.jobType ?? job.employmentType,
      `Jobicy response.jobs[${index}].jobType`
    );
    const remote = optionalBoolean(
      job.remote,
      `Jobicy response.jobs[${index}].remote`
    );
    const min = optionalFiniteNumber(
      job.annualSalaryMin ?? job.salaryMin ?? (job.salary as Record<string, unknown> | undefined)?.min,
      `Jobicy response.jobs[${index}].annualSalaryMin`
    );
    const max = optionalFiniteNumber(
      job.annualSalaryMax ?? job.salaryMax ?? (job.salary as Record<string, unknown> | undefined)?.max,
      `Jobicy response.jobs[${index}].annualSalaryMax`
    );
    const currency = optionalCurrency(
      job.salaryCurrency ?? job.currency ?? (job.salary as Record<string, unknown> | undefined)?.currency,
      `Jobicy response.jobs[${index}].salaryCurrency`
    );
    const salary = compensationRange(min, max, currency);
    const employmentMetadata = {
      ...(jobTypes.length > 0 ? { employmentType: jobTypes.join(', ') } : {}),
      ...(remote === true || /\bremote\b/iu.test(location)
        ? { workplaceType: 'remote' }
        : {}),
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

export const JobicyAdapter = JobicyPublicJobListingAdapter;
