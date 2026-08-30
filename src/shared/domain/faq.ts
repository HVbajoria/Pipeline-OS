/** Deterministic, requisition-only candidate FAQ composition. */

import type { JobRequisition } from '../models';
import type {
  AnswerCandidateFaqOutput
} from '../operations';
import { normalizeTokens } from './scoring';

export const UNANSWERED_FAQ_MESSAGE =
  "I don't have that information in the requisition data.";

const TITLE_TERMS = new Set([
  'title',
  'role',
  'position',
  'job',
  'opening',
  'called'
]);
const DEPARTMENT_TERMS = new Set([
  'department',
  'team',
  'function',
  'area'
]);
const REQUIREMENT_TERMS = new Set([
  'requirement',
  'requirements',
  'qualification',
  'qualifications',
  'skill',
  'skills',
  'experience',
  'responsibility',
  'responsibilities'
]);
const COMPENSATION_TERMS = new Set([
  'compensation',
  'salary',
  'pay',
  'range',
  'band',
  'wage',
  'cash'
]);

function containsAny(tokens: readonly string[], terms: ReadonlySet<string>): boolean {
  return tokens.some((token) => terms.has(token));
}

/**
 * Answer only intents that can be grounded in a JobRequisition.  The generic
 * unanswered message contains no company, location, culture, or other
 * invented information.
 */
export function composeFaqAnswer(
  job: Pick<JobRequisition, 'title' | 'department' | 'requirements' | 'compBand'>,
  question: string
): AnswerCandidateFaqOutput {
  const tokens = normalizeTokens(question);
  const parts: string[] = [];

  if (containsAny(tokens, TITLE_TERMS)) {
    parts.push(`The role title is "${job.title}".`);
  }
  if (containsAny(tokens, DEPARTMENT_TERMS)) {
    parts.push(`The department is "${job.department}".`);
  }
  if (containsAny(tokens, REQUIREMENT_TERMS)) {
    const requirements = job.requirements.length
      ? job.requirements.join(', ')
      : 'no requirements are listed';
    parts.push(`The listed requirements are: ${requirements}.`);
  }
  if (containsAny(tokens, COMPENSATION_TERMS)) {
    parts.push(
      `The compensation band is ${job.compBand.min}–${job.compBand.max} ${job.compBand.currency}.`
    );
  }

  if (parts.length === 0) {
    return { answer: UNANSWERED_FAQ_MESSAGE, answeredFromData: false };
  }
  return { answer: parts.join(' '), answeredFromData: true };
}

export const answerCandidateFaq = composeFaqAnswer;
export const answerFaq = composeFaqAnswer;
