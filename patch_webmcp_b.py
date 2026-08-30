import re

with open("src/lib/webmcp.ts", "r") as f:
    content = f.read()

funcs = """
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
"""

content = re.sub(r'  // Phase B.*?// Phase C', funcs + '\n  // Phase C', content, flags=re.DOTALL)

with open("src/lib/webmcp.ts", "w") as f:
    f.write(content)
