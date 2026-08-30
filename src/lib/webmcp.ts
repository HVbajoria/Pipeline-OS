import { useStore } from './store';
import axios from 'axios';

// Extend the window object to support WebMCP
declare global {
  interface Navigator {
    modelContext?: {
      registerTool: (params: any) => void;
    };
  }
  interface Window {
    __webmcp_tools?: any;
  }
}

// Ensure the polyfill exists
if (typeof window !== 'undefined' && window.navigator && !window.navigator.modelContext) {
  window.navigator.modelContext = {
    registerTool: (params: any) => {
      console.log('Registered tool (Polyfill):', params.name);
      // In a real WebMCP environment, this would expose the tool to the agent.
      // Here, we just store it globally so we can simulate or log it if needed.
      if (!window.__webmcp_tools) window.__webmcp_tools = {};
      window.__webmcp_tools[params.name] = params;
    }
  };
}

export type ToolCallLog = {
  id: string;
  timestamp: string;
  name: string;
  params: any;
  result?: any;
  error?: string;
  status: 'pending' | 'success' | 'error';
};

// We will use a global callback to notify the UI of tool logs
type LogListener = (log: ToolCallLog) => void;
const logListeners: LogListener[] = [];

export const onLogToolCall = (listener: LogListener) => {
  logListeners.push(listener);
  return () => {
    const index = logListeners.indexOf(listener);
    if (index > -1) logListeners.splice(index, 1);
  };
};

const notifyListeners = (log: ToolCallLog) => {
  logListeners.forEach(l => l(log));
};

export const registeredTools: { name: string, description: string, schema: any }[] = [];

// Wrapper to register a tool and handle logging
export const registerWebMCPTool = (
  name: string,
  description: string,
  schema: any,
  handler: (params: any) => Promise<any>
) => {
  if (!registeredTools.some(t => t.name === name)) {
    registeredTools.push({ name, description, schema });
  }

  const wrappedHandler = async (params: any) => {
    const logId = Math.random().toString(36).substr(2, 9);
    const log: ToolCallLog = {
      id: logId,
      timestamp: new Date().toISOString(),
      name,
      params,
      status: 'pending'
    };
    notifyListeners({ ...log });

    try {
      const result = await handler(params);
      notifyListeners({ ...log, status: 'success', result });
      return result;
    } catch (error: any) {
      notifyListeners({ ...log, status: 'error', error: error.message || String(error) });
      throw error;
    }
  };

  if (window.navigator.modelContext?.registerTool) {
    window.navigator.modelContext.registerTool({
      name,
      description,
      schema,
      handler: wrappedHandler
    });
  }
};

// Function to actually register all our tools on page load
export const registerAllTools = (triggerRefresh: () => void) => {
  // Phase A
  registerWebMCPTool(
    'create_job_requisition',
    'Create a new job requisition',
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        department: { type: 'string' },
        requirements: { type: 'array', items: { type: 'string' } },
        compBand: {
          type: 'object',
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
            currency: { type: 'string' }
          },
          required: ['min', 'max', 'currency']
        }
      },
      required: ['title', 'department', 'requirements', 'compBand']
    },
    async (params) => {
      const res = await axios.post('/api/jobs', params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'search_candidates',
    'Search for candidates based on skills or keywords',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
        experienceLevel: { type: 'string', enum: ['junior', 'mid', 'senior'] }
      }
    },
    async (params) => {
      const res = await axios.post('/api/candidates/search', params);
      return res.data;
    }
  );

  registerWebMCPTool(
    'get_candidate_profile',
    'Get full profile of a specific candidate',
    {
      type: 'object',
      properties: { candidateId: { type: 'string' } },
      required: ['candidateId']
    },
    async (params) => {
      const res = await axios.get(`/api/candidates/${params.candidateId}`);
      return res.data;
    }
  );

  registerWebMCPTool(
    'submit_application',
    'Submit an application for a candidate to a specific job',
    {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        jobId: { type: 'string' },
        resumeText: { type: 'string' }
      },
      required: ['candidateId', 'jobId', 'resumeText']
    },
    async (params) => {
      const res = await axios.post('/api/applications', params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'screen_candidate',
    'Screen a candidate application against job requirements',
    {
      type: 'object',
      properties: { applicationId: { type: 'string' } },
      required: ['applicationId']
    },
    async (params) => {
      const res = await axios.post(`/api/applications/${params.applicationId}/screen`);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'answer_candidate_faq',
    'Answer questions based on job requisition data',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        question: { type: 'string' }
      },
      required: ['jobId', 'question']
    },
    async (params) => {
      const res = await axios.post(`/api/jobs/${params.jobId}/faq`, { question: params.question });
      return res.data;
    }
  );


  // Phase B
  registerWebMCPTool(
    'check_interviewer_availability',
    'Check common free slots across interviewers for a panel',
    {
      type: 'object',
      properties: {
        panelId: { type: 'string' },
        dateRange: { 
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' }
          }
        }
      },
      required: ['panelId']
    },
    async (params) => {
      const res = await axios.post(`/api/interviews/availability`, params);
      return res.data;
    }
  );

  registerWebMCPTool(
    'propose_interview_slots',
    'Propose top 3 interview slots to a candidate for an application',
    {
      type: 'object',
      properties: {
        applicationId: { type: 'string' }
      },
      required: ['applicationId']
    },
    async (params) => {
      const res = await axios.post(`/api/interviews/propose`, params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'book_interview',
    'Book an interview from proposed slots',
    {
      type: 'object',
      properties: {
        applicationId: { type: 'string' },
        slot: { type: 'string' }
      },
      required: ['applicationId', 'slot']
    },
    async (params) => {
      const res = await axios.post('/api/interviews/book', params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'get_interview_kit',
    'Fetch structured competency questions and interview prep based on job requirements',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string' }
      },
      required: ['jobId']
    },
    async (params) => {
      const res = await axios.get(`/api/jobs/${params.jobId}/interview-kit`);
      return res.data;
    }
  );

  registerWebMCPTool(
    'submit_interview_feedback',
    'Submit structured feedback for an interview',
    {
      type: 'object',
      properties: {
        interviewId: { type: 'string' },
        interviewer: { type: 'string' },
        competencyScores: { type: 'object' },
        recommendation: { type: 'string', enum: ['hire', 'no_hire', 'strong_hire'] },
        comments: { type: 'string' }
      },
      required: ['interviewId', 'interviewer', 'competencyScores', 'recommendation']
    },
    async (params) => {
      const res = await axios.post(`/api/interviews/${params.interviewId}/feedback`, params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'get_panel_feedback_summary',
    'Get consolidated interview feedback for an application',
    {
      type: 'object',
      properties: {
        applicationId: { type: 'string' }
      },
      required: ['applicationId']
    },
    async (params) => {
      const res = await axios.get(`/api/applications/${params.applicationId}/feedback-summary`);
      return res.data;
    }
  );

  // Phase C
  registerWebMCPTool(
    'generate_offer',
    'Generate an offer draft for an applicant',
    {
      type: 'object',
      properties: {
        applicationId: { type: 'string' },
        compAmount: { type: 'number' }
      },
      required: ['applicationId', 'compAmount']
    },
    async (params) => {
      const res = await axios.post('/api/offers', params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'send_offer',
    'Send a drafted offer to the candidate',
    {
      type: 'object',
      properties: { offerId: { type: 'string' } },
      required: ['offerId']
    },
    async (params) => {
      const res = await axios.post(`/api/offers/${params.offerId}/send`);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'respond_to_offer',
    'Candidate responds to an offer',
    {
      type: 'object',
      properties: {
        offerId: { type: 'string' },
        decision: { type: 'string', enum: ['accepted', 'declined', 'countered'] },
        counterAmount: { type: 'number' }
      },
      required: ['offerId', 'decision']
    },
    async (params) => {
      const res = await axios.post(`/api/offers/${params.offerId}/respond`, params);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'initiate_background_check',
    'Initiate a background check for an accepted offer',
    {
      type: 'object',
      properties: { offerId: { type: 'string' } },
      required: ['offerId']
    },
    async (params) => {
      // Optimistically update the store to 'pending'
      const store = useStore.getState();
      const offer = store.offers.find(o => o.id === params.offerId);
      if (offer) {
        useStore.setState({
          offers: store.offers.map(o => 
            o.id === params.offerId ? { ...o, backgroundCheckStatus: 'pending' } : o
          )
        });
      }
      
      const res = await axios.post(`/api/offers/${params.offerId}/background-check`);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'enroll_benefits',
    'Candidate enrolls in benefits',
    {
      type: 'object',
      properties: {
        offerId: { type: 'string' },
        planSelections: { type: 'object' }
      },
      required: ['offerId']
    },
    async (params) => {
      const store = useStore.getState();
      const offer = store.offers.find(o => o.id === params.offerId);
      if (offer) {
        useStore.setState({
          offers: store.offers.map(o => 
            o.id === params.offerId ? { ...o, benefitsEnrolled: true } : o
          )
        });
      }
      
      const res = await axios.post(`/api/offers/${params.offerId}/benefits`, { planSelections: params.planSelections });
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'generate_onboarding_checklist',
    'Auto-create onboarding tasks from template',
    {
      type: 'object',
      properties: { offerId: { type: 'string' } },
      required: ['offerId']
    },
    async (params) => {
      const res = await axios.post(`/api/offers/${params.offerId}/onboarding`);
      triggerRefresh();
      return res.data;
    }
  );

  registerWebMCPTool(
    'get_onboarding_status',
    'Check status of onboarding tasks',
    {
      type: 'object',
      properties: { offerId: { type: 'string' } },
      required: ['offerId']
    },
    async (params) => {
      const res = await axios.get(`/api/offers/${params.offerId}/onboarding`);
      return res.data;
    }
  );
};
