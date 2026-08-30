import { conflictError, notFoundError, ValidationError } from '../../shared/errors';
import type { BenefitsEnrollmentRecord, PlanSelections } from '../../shared/models';
import type { EnrollBenefitsOutput } from '../../shared/operations';
import {
  assertNonEmptyString,
  assertPlainObject,
  assertRecordId
} from '../../shared/validators';
import type { OperationHandler } from '../operationService';

const PLAN_FIELDS = ['medical', 'dental', 'vision'] as const;
type PlanField = (typeof PLAN_FIELDS)[number];

function validatedPlanSelections(value: unknown): PlanSelections {
  const raw = assertPlainObject(value, 'planSelections');
  const selections = {
    medical: assertNonEmptyString(raw.medical, 'planSelections.medical'),
    dental: assertNonEmptyString(raw.dental, 'planSelections.dental'),
    vision: assertNonEmptyString(raw.vision, 'planSelections.vision')
  };
  return selections;
}

/** Validate catalog selections and create one enrollment for an offer. */
export const enrollBenefits: OperationHandler<'enroll_benefits'> = (
  input,
  context
): EnrollBenefitsOutput => {
  const offerId = assertRecordId(input.offerId, 'offerId');
  const planSelections = validatedPlanSelections(input.planSelections);
  const catalog = context.state.catalogs.planCatalog;

  for (const field of PLAN_FIELDS as readonly PlanField[]) {
    const selection = planSelections[field];
    if (!catalog[field].includes(selection)) {
      throw new ValidationError(
        `planSelections.${field} must be a valid ${field} plan`,
        { field: `planSelections.${field}` }
      );
    }
  }

  const offer = context.state.offers.get(offerId);
  if (offer === undefined) {
    throw notFoundError(`Offer ${offerId} was not found`, {
      recordType: 'Offer_Record',
      recordId: offerId,
      field: 'offerId'
    });
  }

  const existing = [...context.state.benefitsEnrollments.values()].find(
    (enrollment) => enrollment.offerId === offerId
  );
  if (existing !== undefined) {
    throw conflictError(`Benefits are already enrolled for offer ${offerId}`, {
      recordType: 'Benefits_Enrollment_Record',
      recordId: existing.id,
      field: 'offerId'
    });
  }

  let enrollmentId = context.nextId('benefits');
  while (context.state.benefitsEnrollments.has(enrollmentId)) {
    enrollmentId = context.nextId('benefits');
  }

  const enrollment: BenefitsEnrollmentRecord = {
    id: enrollmentId,
    offerId,
    planSelections,
    enrolledAt: context.now()
  };
  context.state.benefitsEnrollments.set(enrollmentId, enrollment);

  return { enrollmentId };
};

export const enrollBenefitsHandler = enrollBenefits;
export default enrollBenefits;
