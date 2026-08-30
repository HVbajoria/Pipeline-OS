import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  UNANSWERED_FAQ_MESSAGE,
  composeFaqAnswer
} from '../src/shared/domain/faq';
import type { JobRequisition } from '../src/shared/models';
import {
  PROPERTY_TEST_OPTIONS,
  TEST_TIMESTAMP
} from './factories';

type SupportedField = 'title' | 'department' | 'requirements' | 'compensation';

interface SupportedQuestionCase {
  kind: 'supported';
  fields: SupportedField[];
  question: string;
}

interface UnsupportedQuestionCase {
  kind: 'unsupported';
  question: string;
}

type FaqQuestionCase = SupportedQuestionCase | UnsupportedQuestionCase;

const supportedFieldPhrases: Record<SupportedField, string> = {
  title: 'role title',
  department: 'department',
  requirements: 'requirements',
  compensation: 'salary range'
};

const supportedFieldArbitrary = fc.constantFrom<SupportedField>(
  'title',
  'department',
  'requirements',
  'compensation'
);

const supportedQuestionArbitrary: fc.Arbitrary<SupportedQuestionCase> = fc
  .array(supportedFieldArbitrary, { minLength: 1, maxLength: 4 })
  .map((fields) => [...new Set(fields)])
  .map((fields) => ({
    kind: 'supported' as const,
    fields,
    question: `Could you provide ${fields
      .map((field) => supportedFieldPhrases[field])
      .join(' and ')}?`
  }));

/** These terms are intentionally outside every permitted FAQ field vocabulary. */
const unsupportedQuestionArbitrary: fc.Arbitrary<UnsupportedQuestionCase> = fc
  .array(
    fc.constantFrom(
      'company',
      'culture',
      'location',
      'office',
      'benefits',
      'vacation',
      'equity',
      'remote',
      'interview',
      'process',
      'timeline',
      'manager',
      'travel'
    ),
    { minLength: 1, maxLength: 5 }
  )
  .map((terms) => ({
    kind: 'unsupported' as const,
    question: `Could you tell me about ${terms.join(' ')}?`
  }));

const faqQuestionArbitrary = fc.oneof(
  supportedQuestionArbitrary,
  unsupportedQuestionArbitrary
);

const jobArbitrary: fc.Arbitrary<JobRequisition> = fc
  .record({
    titleMarker: fc.integer({ min: 0, max: 1_000_000 }),
    departmentMarker: fc.integer({ min: 0, max: 1_000_000 }),
    requirementMarkers: fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
      minLength: 1,
      maxLength: 4
    }),
    minimum: fc.integer({ min: 0, max: 1_000_000 }),
    rangeWidth: fc.integer({ min: 0, max: 100_000 }),
    currency: fc.constantFrom('USD', 'EUR', 'GBP')
  })
  .map(({ titleMarker, departmentMarker, requirementMarkers, minimum, rangeWidth, currency }) => ({
    id: 'generated-job',
    title: `RoleMarker-${titleMarker}`,
    department: `DepartmentMarker-${departmentMarker}`,
    requirements: requirementMarkers.map(
      (marker, index) => `RequirementMarker-${index}-${marker}`
    ),
    compBand: {
      min: minimum,
      max: minimum + rangeWidth,
      currency
    },
    status: 'open' as const,
    createdBy: 'generated-recruiter',
    createdAt: TEST_TIMESTAMP
  }));

function expectedSupportedAnswer(
  job: JobRequisition,
  fields: readonly SupportedField[]
): string {
  const requested = new Set(fields);
  const parts: string[] = [];

  if (requested.has('title')) {
    parts.push(`The role title is "${job.title}".`);
  }
  if (requested.has('department')) {
    parts.push(`The department is "${job.department}".`);
  }
  if (requested.has('requirements')) {
    parts.push(`The listed requirements are: ${job.requirements.join(', ')}.`);
  }
  if (requested.has('compensation')) {
    parts.push(
      `The compensation band is ${job.compBand.min}–${job.compBand.max} ${job.compBand.currency}.`
    );
  }

  return parts.join(' ');
}

describe('FAQ provenance properties', () => {
  it('answers only from permitted requisition fields and explicitly declines unsupported questions', () => {
    // Feature: pipelineos, Property 10: FAQ provenance
    // **Validates: Requirements 9.1, 9.2, 9.3**
    fc.assert(
      fc.property(jobArbitrary, faqQuestionArbitrary, (job, questionCase) => {
        const result = composeFaqAnswer(job, questionCase.question);

        if (questionCase.kind === 'unsupported') {
          expect(result).toEqual({
            answer: UNANSWERED_FAQ_MESSAGE,
            answeredFromData: false
          });
          return;
        }

        expect(result).toEqual({
          answer: expectedSupportedAnswer(job, questionCase.fields),
          answeredFromData: true
        });

        for (const field of questionCase.fields) {
          if (field === 'title') expect(result.answer).toContain(job.title);
          if (field === 'department') expect(result.answer).toContain(job.department);
          if (field === 'requirements') {
            for (const requirement of job.requirements) {
              expect(result.answer).toContain(requirement);
            }
          }
          if (field === 'compensation') {
            expect(result.answer).toContain(String(job.compBand.min));
            expect(result.answer).toContain(String(job.compBand.max));
            expect(result.answer).toContain(job.compBand.currency);
          }
        }
      }),
      PROPERTY_TEST_OPTIONS
    );
  });
});
