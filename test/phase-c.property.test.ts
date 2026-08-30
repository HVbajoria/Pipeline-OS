import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type {
  ApplicationRecord,
  ApplicationStatus,
  BackgroundCheckStatus,
  BenefitsEnrollmentRecord,
  CompensationBand,
  OfferRecord,
  OfferStatus,
  RoleTemplate,
  ScorecardRecommendation
} from '../src/shared/models';
import { PipelineError } from '../src/shared/errors';
import { scheduleOnboardingTasks, calculateOnboardingStatus } from '../src/shared/domain/onboarding';
import { OperationService } from '../src/server/operationService';
import { generateOffer } from '../src/server/operations/generateOffer';
import { sendOffer } from '../src/server/operations/sendOffer';
import { respondToOffer } from '../src/server/operations/respondToOffer';
import { initiateBackgroundCheck } from '../src/server/operations/initiateBackgroundCheck';
import { enrollBenefits } from '../src/server/operations/enrollBenefits';
import { generateOnboardingChecklist } from '../src/server/operations/generateOnboardingChecklist';
import { getOnboardingStatus } from '../src/server/operations/getOnboardingStatus';
import { createSeed } from '../src/server/seed';
import {
  TEST_TIMESTAMP,
  assertAsyncProperty,
  createTestContext
} from './factories';

const offerStatuses = ['draft', 'sent', 'accepted', 'declined', 'countered'] as const;
const applicationStatuses = [
  'applied',
  'screened',
  'interviewing',
  'offer_sent',
  'offer_accepted',
  'offer_declined',
  'rejected',
  'onboarding'
] as const;
const backgroundStatuses = ['pending', 'clear', 'flagged'] as const;
const currencyArbitrary = fc.constantFrom('USD', 'EUR', 'GBP');
const nonNegativeAmountArbitrary = fc.integer({ min: 0, max: 300000 });

function applicationFixture(
  status: ApplicationStatus,
  id = 'property-c-application',
  jobId = 'job-1'
): ApplicationRecord {
  return {
    id,
    candidateId: 'cand-1',
    jobId,
    status,
    screeningScore: null,
    screeningRationale: null,
    notes: [],
    createdAt: TEST_TIMESTAMP
  };
}

function offerFixture(
  status: OfferStatus,
  applicationId = 'property-c-application',
  compAmount = 175000,
  currency = 'USD'
): OfferRecord {
  return {
    id: 'property-c-offer',
    applicationId,
    compAmount,
    currency,
    status,
    counterAmount: null,
    sentAt: status === 'sent' ? TEST_TIMESTAMP : null,
    respondedAt: null
  };
}

function seedWithJobBand(
  compBand: CompensationBand,
  applicationStatus: ApplicationStatus = 'applied'
) {
  const seed = createSeed();
  seed.jobs = new Map([
    [
      'job-1',
      {
        ...seed.jobs.get('job-1')!,
        compBand
      }
    ]
  ]);
  seed.applications = new Map([
    ['property-c-application', applicationFixture(applicationStatus)]
  ]);
  return seed;
}

function seedWithSentOffer(
  applicationStatus: ApplicationStatus = 'offer_sent',
  offerStatus: OfferStatus = 'sent'
) {
  const seed = createSeed();
  const application = applicationFixture(applicationStatus);
  const offer = offerFixture(offerStatus, application.id);
  seed.applications = new Map([[application.id, application]]);
  seed.offers = new Map([[offer.id, offer]]);
  return seed;
}

function expectDomainUnchanged(
  before: ReturnType<ReturnType<typeof createTestContext>['repository']['read']>,
  after: ReturnType<ReturnType<typeof createTestContext>['repository']['read']>
): void {
  expect(after.applications).toEqual(before.applications);
  expect(after.offers).toEqual(before.offers);
  expect(after.backgroundChecks).toEqual(before.backgroundChecks);
  expect(after.benefitsEnrollments).toEqual(before.benefitsEnrollments);
  expect(after.onboardingTasks).toEqual(before.onboardingTasks);
}

async function thrownError<T>(promise: Promise<T>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    return PipelineError.from(error);
  }
  throw new Error('Expected operation to fail');
}

describe('Phase C correctness properties', () => {
  it('Property 16: preserves offer band semantics and response branch effects', async () => {
    // Feature: pipelineos, Property 16: Offer band and response semantics
    // **Validates: Requirements 16.1, 16.2, 18.1, 18.2, 18.3**
    const fixtureArbitrary = fc.record({
      minimum: fc.integer({ min: 0, max: 250000 }),
      width: fc.integer({ min: 0, max: 50000 }),
      compAmount: nonNegativeAmountArbitrary,
      currency: currencyArbitrary,
      decision: fc.constantFrom('accept', 'decline', 'counter'),
      counterAmount: nonNegativeAmountArbitrary
    });

    await assertAsyncProperty(
      fc.asyncProperty(fixtureArbitrary, async (fixture) => {
        const compBand: CompensationBand = {
          min: fixture.minimum,
          max: fixture.minimum + fixture.width,
          currency: fixture.currency
        };
        const generateContext = createTestContext({
          seed: seedWithJobBand(compBand),
          idPrefix: 'property-offer'
        });
        const generateService = new OperationService(generateContext.repository, {
          generate_offer: generateOffer
        });
        const generated = await generateService.invoke(
          'generate_offer',
          {
            applicationId: 'property-c-application',
            compAmount: fixture.compAmount
          },
          generateContext.actor
        );
        const generatedOffer = generateContext.repository.read().offers.get(generated.offerId)!;

        expect(generatedOffer.currency).toBe(compBand.currency);
        expect(generatedOffer.compAmount).toBe(fixture.compAmount);
        expect(generatedOffer.status).toBe('draft');
        expect(generatedOffer.counterAmount).toBeNull();
        expect(generatedOffer.sentAt).toBeNull();
        expect(generatedOffer.respondedAt).toBeNull();
        const isOutside =
          fixture.compAmount < compBand.min || fixture.compAmount > compBand.max;
        const expectedWarning = isOutside
          ? `Compensation amount ${fixture.compAmount} is outside the ${compBand.currency} band of ${compBand.min}-${compBand.max}.`
          : undefined;
        if (expectedWarning === undefined) {
          expect(generatedOffer.compensationWarning).toBeUndefined();
        } else {
          expect(generatedOffer.compensationWarning).toBe(expectedWarning);
        }

        const responseContext = createTestContext({
          seed: seedWithSentOffer(),
          idPrefix: 'property-response'
        });
        const responseService = new OperationService(responseContext.repository, {
          respond_to_offer: respondToOffer
        });
        const responseBefore = responseContext.repository.read();
        const sentOfferBefore = responseBefore.offers.get('property-c-offer')!;
        const applicationBefore = responseBefore.applications.get(
          'property-c-application'
        )!;
        const responseInput = fixture.decision === 'counter'
          ? {
              offerId: 'property-c-offer',
              decision: fixture.decision,
              counterAmount: fixture.counterAmount
            }
          : {
              offerId: 'property-c-offer',
              decision: fixture.decision
            };
        const response = await responseService.invoke(
          'respond_to_offer',
          responseInput,
          responseContext.actor
        );
        const responseState = responseContext.repository.read();
        const offer = responseState.offers.get('property-c-offer')!;
        const application = responseState.applications.get('property-c-application')!;

        const expectedStatus =
          fixture.decision === 'accept'
            ? 'accepted'
            : fixture.decision === 'decline'
              ? 'declined'
              : 'countered';
        const expectedApplicationStatus =
          fixture.decision === 'accept'
            ? 'offer_accepted'
            : fixture.decision === 'decline'
              ? 'offer_declined'
              : 'offer_sent';
        expect(response).toEqual({
          offerId: 'property-c-offer',
          status: expectedStatus
        });
        expect(offer).toEqual({
          ...sentOfferBefore,
          status: expectedStatus,
          counterAmount:
            fixture.decision === 'counter' ? fixture.counterAmount : null,
          respondedAt: TEST_TIMESTAMP
        });
        if (fixture.decision === 'counter') {
          expect(application).toEqual(applicationBefore);
          expect(application.status).not.toBe('offer_accepted');
          expect(application.status).not.toBe('offer_declined');
        } else {
          expect(application).toEqual({
            ...applicationBefore,
            status: expectedApplicationStatus
          });
          expect(application.status).not.toBe(
            fixture.decision === 'accept' ? 'offer_declined' : 'offer_accepted'
          );
        }
      })
    );
  });

  it('Property 17: sends only draft offers for interviewing applications', async () => {
    // Feature: pipelineos, Property 17: Send-offer transition
    // **Validates: Requirements 17.1, 17.2, 17.5, 23.1, 23.4**
    const fixtureArbitrary = fc.record({
      offerStatus: fc.constantFrom<OfferStatus>(...offerStatuses),
      applicationStatus: fc.constantFrom<ApplicationStatus>(...applicationStatuses)
    });

    await assertAsyncProperty(
      fc.asyncProperty(fixtureArbitrary, async ({ offerStatus, applicationStatus }) => {
        const seed = seedWithSentOffer(applicationStatus, offerStatus);
        const context = createTestContext({ seed });
        const service = new OperationService(context.repository, {
          send_offer: sendOffer
        });
        const before = context.repository.read();
        const promise = service.invoke(
          'send_offer',
          { offerId: 'property-c-offer' },
          context.actor
        );

        if (offerStatus === 'draft' && applicationStatus === 'interviewing') {
          await expect(promise).resolves.toEqual({
            offerId: 'property-c-offer',
            status: 'sent'
          });
          const state = context.repository.read();
          expect(state.offers.get('property-c-offer')).toMatchObject({
            status: 'sent',
            sentAt: TEST_TIMESTAMP
          });
          expect(state.applications.get('property-c-application')?.status).toBe('offer_sent');
        } else {
          const error = await thrownError(promise);
          expect(error.status).toBe(409);
          expectDomainUnchanged(before, context.repository.read());
        }
      })
    );
  });

  it('Property 18: preserves catalog and post-offer record integrity', async () => {
    // Feature: pipelineos, Property 18: Catalog and post-offer record integrity
    // **Validates: Requirements 19.1, 19.2, 19.5, 20.1, 20.2, 20.4**
    const planCatalog = createSeed().catalogs.planCatalog;
    const validSelectionsArbitrary = fc.record({
      medical: fc.constantFrom(...planCatalog.medical),
      dental: fc.constantFrom(...planCatalog.dental),
      vision: fc.constantFrom(...planCatalog.vision)
    });
    const invalidSelectionsArbitrary = fc.oneof(
      fc.record({
        medical: fc.constant('invalid-medical-plan'),
        dental: fc.constantFrom(...planCatalog.dental),
        vision: fc.constantFrom(...planCatalog.vision)
      }),
      fc.record({
        medical: fc.constantFrom(...planCatalog.medical),
        dental: fc.constant('invalid-dental-plan'),
        vision: fc.constantFrom(...planCatalog.vision)
      }),
      fc.record({
        medical: fc.constantFrom(...planCatalog.medical),
        dental: fc.constantFrom(...planCatalog.dental),
        vision: fc.constant('invalid-vision-plan')
      })
    );
    const fixtureArbitrary = fc.record({
      offerStatus: fc.constantFrom<OfferStatus>(...offerStatuses),
      validSelections: validSelectionsArbitrary,
      invalidSelections: invalidSelectionsArbitrary
    });

    await assertAsyncProperty(
      fc.asyncProperty(
        fixtureArbitrary,
        async ({ offerStatus, validSelections, invalidSelections }) => {
          const backgroundContext = createTestContext({
            seed: seedWithSentOffer('offer_accepted', offerStatus)
          });
          const backgroundService = new OperationService(backgroundContext.repository, {
            initiate_background_check: initiateBackgroundCheck
          });
          const backgroundBefore = backgroundContext.repository.read();
          const backgroundPromise = backgroundService.invoke(
            'initiate_background_check',
            { offerId: 'property-c-offer' },
            backgroundContext.actor
          );

          if (offerStatus === 'accepted') {
            const output = await backgroundPromise;
            const state = backgroundContext.repository.read();
            const record = state.backgroundChecks.get(output.backgroundCheckId);

            expect(output).toEqual({
              backgroundCheckId: 'background-check-1',
              status: 'clear'
            });
            expect(state.backgroundChecks.size).toBe(1);
            expect(record).toEqual({
              id: output.backgroundCheckId,
              offerId: 'property-c-offer',
              status: 'clear',
              initiatedAt: TEST_TIMESTAMP,
              completedAt: TEST_TIMESTAMP
            });
          } else {
            const error = await thrownError(backgroundPromise);
            expect(error.status).toBe(409);
            expectDomainUnchanged(backgroundBefore, backgroundContext.repository.read());
          }

          const benefitsContext = createTestContext({
            seed: seedWithSentOffer('offer_sent', offerStatus)
          });
          const benefitsService = new OperationService(benefitsContext.repository, {
            enroll_benefits: enrollBenefits
          });
          const validOutput = await benefitsService.invoke(
            'enroll_benefits',
            { offerId: 'property-c-offer', planSelections: validSelections },
            benefitsContext.actor
          );
          const benefitsState = benefitsContext.repository.read();
          const enrollment = benefitsState.benefitsEnrollments.get(
            validOutput.enrollmentId
          );

          expect(validOutput).toEqual({ enrollmentId: 'benefits-1' });
          expect(benefitsState.benefitsEnrollments.size).toBe(1);
          expect(enrollment).toEqual({
            id: validOutput.enrollmentId,
            offerId: 'property-c-offer',
            planSelections: validSelections,
            enrolledAt: TEST_TIMESTAMP
          });

          const invalidContext = createTestContext({
            seed: seedWithSentOffer('offer_sent', offerStatus)
          });
          const invalidService = new OperationService(invalidContext.repository, {
            enroll_benefits: enrollBenefits
          });
          const invalidBefore = invalidContext.repository.read();
          const invalidPromise = invalidService.invoke(
            'enroll_benefits',
            { offerId: 'property-c-offer', planSelections: invalidSelections },
            invalidContext.actor
          );
          const invalidError = await thrownError(invalidPromise);

          expect(invalidError.status).toBe(400);
          expectDomainUnchanged(invalidBefore, invalidContext.repository.read());
        }
      )
    );
  });

  it('Property 19: matches onboarding task offsets and status calculations', async () => {
    // Feature: pipelineos, Property 19: Onboarding task and status calculation
    // **Validates: Requirements 21.1, 21.3, 21.4, 21.5, 22.1, 22.2, 22.3**
    const templates = createSeed().catalogs.roleTemplates;
    const taskStatuses = ['pending', 'in_progress', 'complete'] as const;
    const fixtureArbitrary = fc.record({
      templateIndex: fc.integer({ min: 0, max: templates.length - 1 }),
      taskStatuses: fc.array(fc.constantFrom(...taskStatuses), {
        minLength: 3,
        maxLength: 3
      }),
      hasBackgroundCheck: fc.boolean(),
      backgroundStatus: fc.constantFrom<BackgroundCheckStatus>(...backgroundStatuses),
      hasBenefits: fc.boolean()
    });

    await assertAsyncProperty(
      fc.asyncProperty(fixtureArbitrary, async (fixture) => {
        const template: RoleTemplate = templates[fixture.templateIndex];
        const isGeneric = template.roleMatcher === 'generic';
        const seed = createSeed();
        const job = {
          ...seed.jobs.get('job-1')!,
          id: 'property-onboarding-job',
          title: isGeneric ? 'Operations Coordinator' : `${template.roleMatcher} role`,
          department: isGeneric ? 'Operations' : template.roleMatcher,
          requirements: isGeneric ? ['Coordination'] : [template.roleMatcher]
        };
        seed.jobs = new Map([[job.id, job]]);
        const application = applicationFixture(
          'offer_accepted',
          'property-onboarding-application',
          job.id
        );
        const offer = offerFixture(
          'accepted',
          application.id,
          175000,
          job.compBand.currency
        );
        offer.id = 'property-onboarding-offer';
        seed.applications = new Map([[application.id, application]]);
        seed.offers = new Map([[offer.id, offer]]);

        if (fixture.hasBackgroundCheck) {
          seed.backgroundChecks = new Map([
            [
              'property-background',
              {
                id: 'property-background',
                offerId: offer.id,
                status: fixture.backgroundStatus,
                initiatedAt: TEST_TIMESTAMP,
                completedAt: fixture.backgroundStatus === 'pending' ? null : TEST_TIMESTAMP
              }
            ]
          ]);
        }
        if (fixture.hasBenefits) {
          const enrollment: BenefitsEnrollmentRecord = {
            id: 'property-benefits',
            offerId: offer.id,
            planSelections: {
              medical: 'medical-basic',
              dental: 'dental-basic',
              vision: 'vision-basic'
            },
            enrolledAt: TEST_TIMESTAMP
          };
          seed.benefitsEnrollments = new Map([[enrollment.id, enrollment]]);
        }

        const context = createTestContext({ seed, idPrefix: 'property-onboarding' });
        const service = new OperationService(context.repository, {
          generate_onboarding_checklist: generateOnboardingChecklist,
          get_onboarding_status: getOnboardingStatus
        });

        const referenceStatus = (
          state: ReturnType<typeof context.repository.read>
        ) => {
          const relatedTasks = [...state.onboardingTasks.values()].filter(
            (task) => task.offerId === offer.id
          );
          const done = relatedTasks.filter((task) => task.status === 'complete').length;
          const total = relatedTasks.length;
          return {
            backgroundCheckStatus:
              [...state.backgroundChecks.values()].find(
                (record) => record.offerId === offer.id
              )?.status ?? null,
            benefitsEnrolled: [...state.benefitsEnrollments.values()].some(
              (record) => record.offerId === offer.id
            ),
            taskCompletion: { done, total },
            completionPercentage: total === 0 ? 0 : (done / total) * 100
          };
        };

        // Before checklist generation there are no tasks, so the reference
        // calculation explicitly covers the required zero-total case.
        const initialStatus = await service.invoke(
          'get_onboarding_status',
          { offerId: offer.id },
          context.actor
        );
        expect(initialStatus).toEqual(referenceStatus(context.repository.read()));
        expect(initialStatus).toEqual({
          backgroundCheckStatus: fixture.hasBackgroundCheck
            ? fixture.backgroundStatus
            : null,
          benefitsEnrolled: fixture.hasBenefits,
          taskCompletion: { done: 0, total: 0 },
          completionPercentage: 0
        });

        const checklist = await service.invoke(
          'generate_onboarding_checklist',
          { offerId: offer.id },
          context.actor
        );
        const startDate = context.repository.read().catalogs.startDate;
        const expectedSchedule = template.onboardingTasks.map(({ taskName, offsetDays }) => ({
          taskName,
          dueDate: new Date(
            Date.parse(startDate) + offsetDays * 24 * 60 * 60 * 1000
          ).toISOString()
        }));
        // Keep the pure helper aligned with an independent offset calculation.
        expect(scheduleOnboardingTasks(template, startDate)).toEqual(expectedSchedule);
        expect(checklist.tasks).toHaveLength(template.onboardingTasks.length);
        expect(checklist.tasks.map(({ taskName, dueDate }) => ({ taskName, dueDate }))).toEqual(
          expectedSchedule
        );
        expect(
          new Set(checklist.tasks.map(({ taskId }) => taskId)).size
        ).toBe(template.onboardingTasks.length);

        const postChecklistState = context.repository.read();
        const generatedTasks = [...postChecklistState.onboardingTasks.values()].filter(
          (task) => task.offerId === offer.id
        );
        expect(generatedTasks.map(({ id, taskName, status, dueDate }) => ({
          id,
          taskName,
          status,
          dueDate
        }))).toEqual(
          checklist.tasks.map(({ taskId, taskName, dueDate }) => ({
            id: taskId,
            taskName,
            status: 'pending',
            dueDate
          }))
        );
        expect(postChecklistState.applications.get(application.id)?.status).toBe(
          'onboarding'
        );

        const taskIds = checklist.tasks.map(({ taskId }) => taskId);
        const statusesForTemplate = fixture.taskStatuses.slice(
          0,
          template.onboardingTasks.length
        );
        context.repository.transact((draft) => {
          taskIds.forEach((taskId, index) => {
            draft.onboardingTasks.get(taskId)!.status = statusesForTemplate[index];
          });
        });

        const finalState = context.repository.read();
        const expectedStatus = referenceStatus(finalState);
        expect(
          calculateOnboardingStatus({
            offerId: offer.id,
            backgroundChecks: [...finalState.backgroundChecks.values()],
            benefitsEnrollments: [...finalState.benefitsEnrollments.values()],
            tasks: [...finalState.onboardingTasks.values()]
          })
        ).toEqual(expectedStatus);

        const status = await service.invoke(
          'get_onboarding_status',
          { offerId: offer.id },
          context.actor
        );
        expect(status).toEqual(expectedStatus);
      })
    );
  });
});
