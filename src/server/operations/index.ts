import type { OperationHandlerMap } from '../operationService';
import answerCandidateFaq from './answerCandidateFaq';
import bookInterview from './bookInterview';
import checkInterviewerAvailability from './checkInterviewerAvailability';
import createJobRequisition from './createJobRequisition';
import enrollBenefits from './enrollBenefits';
import generateOffer from './generateOffer';
import generateOnboardingChecklist from './generateOnboardingChecklist';
import getCandidateProfile from './getCandidateProfile';
import getInterviewKit from './getInterviewKit';
import getOnboardingStatus from './getOnboardingStatus';
import getPanelFeedbackSummary from './getPanelFeedbackSummary';
import initiateBackgroundCheck from './initiateBackgroundCheck';
import proposeInterviewSlots from './proposeInterviewSlots';
import respondToOffer from './respondToOffer';
import screenCandidate from './screenCandidate';
import searchCandidates from './searchCandidates';
import sendOffer from './sendOffer';
import submitApplication from './submitApplication';
import submitInterviewFeedback from './submitInterviewFeedback';

/** Canonical server composition for all descriptors in the shared registry. */
export const defaultOperationHandlers: OperationHandlerMap = {
  create_job_requisition: createJobRequisition,
  search_candidates: searchCandidates,
  get_candidate_profile: getCandidateProfile,
  submit_application: submitApplication,
  screen_candidate: screenCandidate,
  answer_candidate_faq: answerCandidateFaq,
  check_interviewer_availability: checkInterviewerAvailability,
  propose_interview_slots: proposeInterviewSlots,
  book_interview: bookInterview,
  get_interview_kit: getInterviewKit,
  submit_interview_feedback: submitInterviewFeedback,
  get_panel_feedback_summary: getPanelFeedbackSummary,
  generate_offer: generateOffer,
  send_offer: sendOffer,
  respond_to_offer: respondToOffer,
  initiate_background_check: initiateBackgroundCheck,
  enroll_benefits: enrollBenefits,
  generate_onboarding_checklist: generateOnboardingChecklist,
  get_onboarding_status: getOnboardingStatus
};

export const operationHandlers = defaultOperationHandlers;
