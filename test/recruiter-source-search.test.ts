import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';
import { buildRecruiterGitHubSearchInput } from '../src/client/recruiterSourceSearch';
import {
  GitHubProspectsConsentNotice,
  GitHubProspectsResults
} from '../src/components/GitHubProspectsPanel';
import { useStore } from '../src/lib/store';
import type { GitHubProspectSearchResult } from '../src/shared/publicProspects';

const fetchedAt = '2026-04-01T12:00:00.000Z';

const result: GitHubProspectSearchResult = {
  prospects: [
    {
      source: 'github',
      sourceUrl: 'https://github.com/octocat',
      profileUrl: 'https://github.com/octocat',
      username: 'octocat',
      login: 'octocat',
      profileType: 'User',
      searchScore: 42.75,
      query: 'backend TypeScript',
      fetchedAt,
      dataOrigin: 'public_github',
      consentStatus: 'not_provided',
      location: 'San Francisco',
      bio: 'Builds public software',
      publicRepos: 8
    }
  ],
  query: 'backend TypeScript',
  filters: { query: 'backend TypeScript' },
  source: 'github',
  fetchedAt,
  cache: {
    hit: false,
    coalesced: false,
    ageMs: 0,
    ttlMs: 300000,
    fetchedAt,
    expiresAt: '2026-04-01T12:05:00.000Z'
  },
  attribution: {
    source: 'github',
    apiUrl: 'https://api.github.com/search/users',
    searchApiDocsUrl: 'https://docs.github.com/en/rest/search/search',
    rateLimitsDocsUrl: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
    userApiDocsUrl: 'https://docs.github.com/en/rest/users/users'
  }
};

afterEach(() => {
  useStore.getState().setRole('recruiter');
});

describe('Recruiter Source candidates GitHub search', () => {
  it('maps the supported public-search filters and omits unsupported fields', () => {
    expect(
      buildRecruiterGitHubSearchInput({
        query: '  backend   engineer ',
        language: ' TypeScript ',
        location: ' New   York ',
      })
    ).toEqual({
      query: 'backend engineer',
      language: 'TypeScript',
      location: 'New York'
    });
  });

  it('rejects missing or control-character input before the browser client is called', () => {
    expect(() => buildRecruiterGitHubSearchInput({ query: '  ', language: '' })).toThrow(
      'Enter a GitHub search query first.'
    );
    expect(() => buildRecruiterGitHubSearchInput({ query: 'backend\nengineer' })).toThrow(
      'unsupported control characters'
    );
  });

  it('renders GitHub result metadata and only an external profile link', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(GitHubProspectsResults, { result }),
        createElement(GitHubProspectsConsentNotice)
      )
    );

    expect(markup).toContain('octocat');
    expect(markup).toContain('Score 42.75');
    expect(markup).toContain('Source: github');
    expect(markup).toContain('Cache: fresh');
    expect(markup).toContain('Data origin: public_github');
    expect(markup).toContain('Consent: not_provided');
    expect(markup).toContain('View GitHub profile');
    expect(markup).toContain('https://github.com/octocat');
    expect(markup).not.toContain('Open profile');
    expect(markup).not.toContain('Import to candidate');
  });

  it('uses the canonical client and shared panel without browser GitHub routes or unsupported fields', () => {
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const panelSource = readFileSync(
      new URL('../src/components/GitHubProspectsPanel.tsx', import.meta.url),
      'utf8'
    );
    const clientSource = readFileSync(
      new URL('../src/client/githubProspectsClient.ts', import.meta.url),
      'utf8'
    );

    expect(appSource).toContain('GitHubProspectsPanel');
    expect(appSource).not.toContain('githubProspectsClient');
    expect(appSource).not.toContain('/api/prospects/github');
    expect(clientSource).toContain("'search_public_candidates'");
    expect(clientSource).toContain('operationClient.invoke');
    expect(panelSource).toContain("'plan_operation'");
    expect(panelSource).toContain("'revoke_public_prospect_consent'");
    expect(panelSource).not.toContain('experienceLevel');
    expect(panelSource).not.toContain('maxResults');
  });

  it('uses GitHubProspectsPanel as the sole Source candidates entry point', () => {
    const markup = renderToStaticMarkup(createElement(App));
    const panelMarkup = renderToStaticMarkup(
      createElement('div', null, createElement(GitHubProspectsConsentNotice))
    );
    const sourceStart = markup.indexOf('Source candidates');
    const sourceEnd = markup.indexOf('</form>', sourceStart);
    const sourceForm = markup.slice(sourceStart, sourceEnd);

    expect(sourceStart).toBeGreaterThanOrEqual(0);
    expect(sourceForm).toContain('public GitHub prospects');
    expect(sourceForm).toContain('Language');
    expect(sourceForm).toContain('Location');
    expect(sourceForm).not.toContain('Experience level');
    expect(sourceForm).not.toContain('experienceLevel');
    expect(sourceForm).toContain('Search');
    expect(panelMarkup).toContain('Public visibility is not consent');
    const panelSource = readFileSync(
      new URL('../src/components/GitHubProspectsPanel.tsx', import.meta.url),
      'utf8'
    );
    expect(panelSource).toContain('Record explicit consent before planning import');
    expect(markup).not.toContain('Open profile');
    expect(markup).not.toContain('Import to candidate');
  });
});
