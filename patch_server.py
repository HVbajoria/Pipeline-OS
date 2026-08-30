import re

with open("server.ts", "r") as f:
    content = f.read()

content = content.replace(
    "status: 'scheduled' | 'completed';",
    "status: 'proposed' | 'scheduled' | 'completed' | 'cancelled';"
)

content = content.replace(
    "recommendation: 'hire' | 'no_hire' | 'strong_hire';",
    "recommendation: 'hire' | 'no_hire' | 'strong_hire';\n  comments?: string;"
)

funcs = """// Phase B - Scheduling

const mockSlots = [
  "2026-09-01T10:00:00Z",
  "2026-09-01T14:00:00Z",
  "2026-09-02T11:00:00Z",
  "2026-09-02T15:00:00Z",
  "2026-09-03T09:00:00Z"
];

app.post("/api/interviews/availability", (req, res) => {
  const { panelId, dateRange } = req.body;
  res.json({ commonFreeSlots: mockSlots });
});

app.post("/api/interviews/propose", (req, res) => {
  const { applicationId } = req.body;
  const app = store.applications.find(a => a.id === applicationId);
  if (!app) return res.status(404).json({ error: "Application not found" });
  
  const proposed = mockSlots.slice(0, 3).map(slot => {
    const interview: Interview = {
      id: `int-${uuidv4().slice(0,8)}`,
      applicationId,
      slot,
      status: 'proposed'
    };
    store.interviews.push(interview);
    return interview;
  });
  
  res.json({ proposedSlots: proposed });
});

app.post("/api/interviews/book", (req, res) => {
  const { applicationId, slot } = req.body;
  const app = store.applications.find(a => a.id === applicationId);
  if (!app) return res.status(404).json({ error: "Application not found" });
  
  const proposed = store.interviews.filter(i => i.applicationId === applicationId && i.status === 'proposed');
  
  let bookedInterview = null;
  proposed.forEach(i => {
    if (i.slot === slot) {
      i.status = 'scheduled';
      bookedInterview = i;
    } else {
      i.status = 'cancelled';
    }
  });
  
  if (!bookedInterview) {
    return res.status(400).json({ error: "Slot not found or not proposed" });
  }
  
  app.status = 'interviewing';
  res.json({ interviewId: bookedInterview.id, status: "booked" });
});

app.get("/api/jobs/:id/interview-kit", async (req, res) => {
  const job = store.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const competencies = [
    {
      name: "System Design",
      questions: ["How would you scale a web application?", "Describe a time you had to make a tough technical decision."]
    },
    {
      name: "Coding",
      questions: ["Write a function to reverse a string.", "Explain time complexity."]
    },
    {
      name: "Collaboration",
      questions: ["Tell me about a time you disagreed with a coworker.", "How do you handle feedback?"]
    }
  ];
  
  res.json({ competencies });
});

app.post("/api/interviews/:id/feedback", (req, res) => {
  const { interviewer, competencyScores, recommendation, comments } = req.body;
  const interview = store.interviews.find(i => i.id === req.params.id);
  if (!interview || (interview.status !== 'scheduled' && interview.status !== 'completed')) {
    return res.status(404).json({ error: "Interview not found or not bookable" });
  }

  const scorecard: Scorecard = {
    id: `score-${uuidv4().slice(0,8)}`,
    interviewId: interview.id,
    interviewer,
    competencyScores,
    recommendation,
    comments
  };
  
  store.scorecards.push(scorecard);
  interview.status = 'completed';
  
  res.json({ scorecardId: scorecard.id });
});

app.get("/api/applications/:id/feedback-summary", (req, res) => {
  const applicationId = req.params.id;
  const app = store.applications.find(a => a.id === applicationId);
  if (!app) return res.status(404).json({ error: "Application not found" });

  const appInterviews = store.interviews.filter(i => i.applicationId === applicationId);
  const appScorecards = store.scorecards.filter(s => appInterviews.some(i => i.id === s.interviewId));
  
  const recommendationTally: Record<string, number> = {};
  const sumScores: Record<string, number> = {};
  const countScores: Record<string, number> = {};
  
  appScorecards.forEach(s => {
    recommendationTally[s.recommendation] = (recommendationTally[s.recommendation] || 0) + 1;
    for (const [comp, score] of Object.entries(s.competencyScores)) {
      sumScores[comp] = (sumScores[comp] || 0) + score;
      countScores[comp] = (countScores[comp] || 0) + 1;
    }
  });
  
  const averageScores: Record<string, number> = {};
  for (const comp in sumScores) {
    averageScores[comp] = sumScores[comp] / countScores[comp];
  }
  
  res.json({
    averageScores,
    recommendationTally,
    scorecards: appScorecards
  });
});

"""

content = re.sub(r'// Phase B - Scheduling.*?// Phase C - Offer & Post-Offer', funcs + '// Phase C - Offer & Post-Offer', content, flags=re.DOTALL)

with open("server.ts", "w") as f:
    f.write(content)

