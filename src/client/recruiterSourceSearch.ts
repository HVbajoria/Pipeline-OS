import type { GitHubProspectSearchInput } from '../shared/publicProspects';

export interface RecruiterSourceSearchFields {
  query: unknown;
  language?: unknown;
  location?: unknown;
}

function normalizeSearchText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be text.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`${field} contains unsupported control characters.`);
  }
  return value.trim().replace(/\s+/gu, ' ');
}

function optionalSearchText(value: unknown, field: string): string | undefined {
  const normalized = normalizeSearchText(value ?? '', field);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Convert the recruiter source form into the shared public-prospect operation
 * input. Only the operation's supported query, language, and location fields
 * are returned; experience-level and result-limit controls are not part of
 * public GitHub sourcing.
 */
export function buildRecruiterGitHubSearchInput(
  fields: RecruiterSourceSearchFields
): GitHubProspectSearchInput {
  const query = normalizeSearchText(fields.query, 'Query');
  if (query.length === 0) {
    throw new Error('Enter a GitHub search query first.');
  }

  const language = optionalSearchText(fields.language, 'Language');
  const location = optionalSearchText(fields.location, 'Location');

  return {
    query,
    ...(language === undefined ? {} : { language }),
    ...(location === undefined ? {} : { location })
  };
}
