import type {
  OperationBoundaryAdapterMap,
  OperationHandlerMap
} from '../operationService';
import answerCandidateFaq from './answerCandidateFaq';
import approveOperationPlan from './approveOperationPlan';
import bookInterview from './bookInterview';
import checkInterviewerAvailability from './checkInterviewerAvailability';
import commitOperationPlan from './commitOperationPlan';
import compareCandidates from './compareCandidates';
import coordinateInterviewWorkflow from './coordinateInterviewWorkflow';
import coordinateOnboardingWorkflow from './coordinateOnboardingWorkflow';
import createJobRequisition from './createJobRequisition';
import discoverCapabilities from './discoverCapabilities';
import enrollBenefits from './enrollBenefits';
import generateOffer from './generateOffer';
import generateOnboardingChecklist from './generateOnboardingChecklist';
import getApprovalCard from './getApprovalCard';
import getCandidateProfile from './getCandidateProfile';
import getInterviewKit from './getInterviewKit';
import getOnboardingStatus from './getOnboardingStatus';
import getPanelFeedbackSummary from './getPanelFeedbackSummary';
import getRecruitingWorkflowStatus from './getRecruitingWorkflowStatus';
import importPublicProspect from './importPublicProspect';
import initiateBackgroundCheck from './initiateBackgroundCheck';
import planOperation from './planOperation';
import listOpenJobs from './listOpenJobs';
import proposeInterviewSlots from './proposeInterviewSlots';
import rejectOperationPlan from './rejectOperationPlan';
import respondToOffer from './respondToOffer';
import screenCandidate from './screenCandidate';
import searchCandidates from './searchCandidates';
import searchPublicCandidates from './searchPublicCandidates';
import sendOffer from './sendOffer';
import revokePublicProspectConsent from './revokePublicProspectConsent';
import submitApplication from './submitApplication';
import submitInterviewFeedback from './submitInterviewFeedback';

/** Canonical service-owned adapters for the approval lifecycle. */
export const approvalOperationAdapters: OperationBoundaryAdapterMap = {
  plan_operation: planOperation,
  get_approval_card: getApprovalCard,
  approve_operation_plan: approveOperationPlan,
  reject_operation_plan: rejectOperationPlan,
  commit_operation_plan: commitOperationPlan
};

export const defaultOperationAdapters = approvalOperationAdapters;

/** Canonical server composition for all descriptors in the shared registry. */
export const defaultOperationHandlers: OperationHandlerMap = {
  create_job_requisition: createJobRequisition,
  list_open_jobs: listOpenJobs,
  search_candidates: searchCandidates,
  search_public_candidates: searchPublicCandidates,
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
  get_onboarding_status: getOnboardingStatus,
  compare_candidates: compareCandidates,
  get_recruiting_workflow_status: getRecruitingWorkflowStatus,
  import_public_prospect: importPublicProspect,
  revoke_public_prospect_consent: revokePublicProspectConsent,
  coordinate_interview_workflow: coordinateInterviewWorkflow,
  coordinate_onboarding_workflow: coordinateOnboardingWorkflow,
  discover_capabilities: discoverCapabilities
};

export const operationHandlers = defaultOperationHandlers;
