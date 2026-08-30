import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { v4 as uuidv4 } from "uuid";
import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
function getAI() {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    aiClient = new GoogleGenAI({ apiKey: key });
  }
  return aiClient;
}

// Types
export interface JobRequisition {
  id: string;
  title: string;
  department: string;
  requirements: string[];
  compBand: string;
  status: 'open' | 'closed';
  createdBy: string;
}

export interface Candidate {
  id: string;
  name: string;
  email: string;
  resumeText: string;
  skills: string[];
  appliedRoles: string[]; // job ids
}

export interface Application {
  id: string;
  candidateId: string;
  jobId: string;
  status: 'applied' | 'screened' | 'interviewing' | 'offered' | 'hired' | 'rejected';
  screeningScore?: number;
  screeningRationale?: string;
  notes: string[];
}

export interface Interview {
  id: string;
  applicationId: string;
  slot: string;
  status: 'proposed' | 'scheduled' | 'completed' | 'cancelled';
}

export interface Scorecard {
  id: string;
  interviewId: string;
  interviewer: string;
  competencyScores: Record<string, number>;
  recommendation: 'hire' | 'no_hire' | 'strong_hire';
  comments?: string;
}

export interface Offer {
  id: string;
  applicationId: string;
  compAmount: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'countered';
  sentAt?: string;
  respondedAt?: string;
  counterAmount?: number;
  backgroundCheckStatus?: 'pending' | 'clear';
  benefitsEnrolled?: boolean;
}

export interface OnboardingTask {
  id: string;
  offerId: string;
  taskName: string;
  status: 'pending' | 'completed';
  dueDate: string;
}

// Initial Seed Data
const initialJobs: JobRequisition[] = [
  {
    id: "job-1",
    title: "Senior Backend Engineer",
    department: "Engineering",
    requirements: ["Node.js", "Express", "PostgreSQL", "AWS"],
    compBand: "$160,000 - $190,000",
    status: "open",
    createdBy: "sarah-recruiter"
  }
];

const initialCandidates: Candidate[] = [
  {
    id: "cand-1",
    name: "Alice Chen",
    email: "alice@example.com",
    resumeText: "Experienced backend engineer with 8 years building scalable APIs.",
    skills: ["Node.js", "TypeScript", "AWS", "Go"],
    appliedRoles: []
  },
  {
    id: "cand-2",
    name: "Bob Smith",
    email: "bob@example.com",
    resumeText: "Frontend developer specializing in React and CSS animations.",
    skills: ["React", "CSS", "JavaScript"],
    appliedRoles: []
  },
  {
    id: "cand-3",
    name: "Charlie Davis",
    email: "charlie@example.com",
    resumeText: "Backend engineer focused on data engineering.",
    skills: ["Python", "Django", "SQL"],
    appliedRoles: []
  }
];

// In-Memory Data Store
const store = {
  jobs: [...initialJobs],
  candidates: [...initialCandidates],
  applications: [] as Application[],
  interviews: [] as Interview[],
  scorecards: [] as Scorecard[],
  offers: [] as Offer[],
  onboardingTasks: [] as OnboardingTask[]
};

const app = express();
app.use(express.json());

// Helper to simulate network latency if needed, but we keep it synchronous for now

// Dump all state for UI
app.get("/api/state", (req, res) => {
  res.json(store);
});

// Reset state
app.post("/api/reset", (req, res) => {
  store.jobs = [...initialJobs];
  store.candidates = [...initialCandidates];
  store.applications = [];
  store.interviews = [];
  store.scorecards = [];
  store.offers = [];
  store.onboardingTasks = [];
  res.json({ success: true });
});

// Phase A - Sourcing & Screening

app.post("/api/jobs", (req, res) => {
  const { title, department, requirements, compBand } = req.body;
  
  if (!title || !department || !requirements || !compBand || typeof compBand.min !== 'number' || typeof compBand.max !== 'number' || !compBand.currency) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return res.status(400).json({ error: "Requirements must be a non-empty array" });
  }
  if (compBand.min > compBand.max) {
    return res.status(400).json({ error: "compBand.min must be <= compBand.max" });
  }

  const newJob: JobRequisition = {
    id: `job-${uuidv4().slice(0,8)}`,
    title, department, requirements,
    compBand: `${compBand.currency}${compBand.min} - ${compBand.currency}${compBand.max}`,
    status: 'open',
    createdBy: 'sarah-recruiter'
  };
  store.jobs.push(newJob);
  res.json({ jobId: newJob.id });
});

app.post("/api/candidates/search", (req, res) => {
  const { query, skills = [], experienceLevel } = req.body;
  
  let queryTokens = new Set<string>(skills.map((s: string) => s.toLowerCase()));
  if (query) {
    query.split(/\W+/).filter((t: string) => t.length > 2).forEach((t: string) => queryTokens.add(t.toLowerCase()));
  }

  const ranked = store.candidates.map(c => {
    const candTokens = new Set<string>();
    c.skills.forEach(s => candTokens.add(s.toLowerCase()));
    c.resumeText.split(/\W+/).filter((t: string) => t.length > 2).forEach((t: string) => candTokens.add(t.toLowerCase()));

    let intersection = 0;
    candTokens.forEach(t => {
      if (queryTokens.has(t)) intersection++;
    });
    
    let union = candTokens.size + queryTokens.size - intersection;
    let score = union === 0 ? 0 : intersection / union;
    
    let rationaleParts: string[] = [];
    if (intersection > 0) rationaleParts.push(`Matched ${intersection} keywords/skills`);

    if (experienceLevel && c.resumeText.toLowerCase().includes(experienceLevel.toLowerCase())) {
      score += 0.2;
      rationaleParts.push(`Experience level match: ${experienceLevel}`);
    }

    return { 
      candidateId: c.id, 
      name: c.name, 
      matchScore: parseFloat(score.toFixed(2)), 
      rationale: rationaleParts.join('; ') || 'No clear match' 
    };
  }).sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);
    
  res.json({ results: ranked });
});

app.get("/api/candidates/:id", (req, res) => {
  const cand = store.candidates.find(c => c.id === req.params.id);
  if (cand) {
    const applicationHistory = store.applications.filter(a => a.candidateId === cand.id);
    res.json({ ...cand, applicationHistory });
  } else {
    res.status(404).json({ error: "Candidate not found" });
  }
});

app.post("/api/applications", (req, res) => {
  const { candidateId, jobId, resumeText } = req.body;
  if (!candidateId || !jobId || !resumeText) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  const job = store.jobs.find(j => j.id === jobId);
  if (!job || job.status !== 'open') {
    return res.status(404).json({ error: "Job not found or not open" });
  }

  const existing = store.applications.find(a => a.candidateId === candidateId && a.jobId === jobId);
  if (existing) {
    return res.status(409).json({ error: "Duplicate application exists" });
  }

  const cand = store.candidates.find(c => c.id === candidateId);
  if (cand) {
    if (cand.resumeText !== resumeText) {
      cand.resumeText = cand.resumeText + "\n\n--- Tailored Resume ---\n" + resumeText;
    }
    if (!cand.appliedRoles.includes(jobId)) cand.appliedRoles.push(jobId);
  }
  
  const app: Application = {
    id: `app-${uuidv4().slice(0,8)}`,
    candidateId,
    jobId,
    status: 'applied',
    notes: []
  };
  store.applications.push(app);
  res.json({ applicationId: app.id, status: 'applied' });
});

app.post("/api/applications/:id/screen", (req, res) => {
  const app = store.applications.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: "Application not found" });
  
  const job = store.jobs.find(j => j.id === app.jobId);
  const cand = store.candidates.find(c => c.id === app.candidateId);
  
  if (job && cand) {
    let overlap = 0;
    const missing: string[] = [];
    job.requirements.forEach(req => { 
       if (cand.skills.some(s => s.toLowerCase() === req.toLowerCase()) || cand.resumeText.toLowerCase().includes(req.toLowerCase())) {
          overlap++;
       } else {
          missing.push(req);
       }
    });
    
    let seniorityMatch = true;
    if (job.title.toLowerCase().includes('senior') && !cand.resumeText.toLowerCase().includes('senior') && !cand.resumeText.match(/\b([5-9]|\d{2,})\s+years\b/i)) {
      seniorityMatch = false;
    }
    
    let baseScore = (overlap / (job.requirements.length || 1)) * 100;
    let score = Math.round(seniorityMatch ? baseScore : baseScore * 0.8);
    
    let rationale = `Matched ${overlap}/${job.requirements.length} requirements.`;
    if (!seniorityMatch) rationale += ` Experience gap on seniority implied by title.`;
    if (missing.length > 0) rationale += ` Missing: ${missing.join(', ')}`;
    
    app.screeningScore = score;
    app.screeningRationale = rationale;
    app.status = 'screened';
  }
  res.json({ 
    applicationId: app.id, 
    screeningScore: app.screeningScore, 
    screeningRationale: app.screeningRationale, 
    status: app.status 
  });
});

app.post("/api/jobs/:id/faq", async (req, res) => {
  const job = store.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  
  try {
    const ai = getAI();
    const prompt = `You are a helpful recruiting assistant. Answer the candidate's question based on the job details below. Keep the answer concise, professional, and directly address the question. 
If the question CANNOT be answered from the provided job details, start your answer EXACTLY with "CANNOT_ANSWER_FROM_DATA: " followed by a brief reason.

Job Title: ${job.title}
Department: ${job.department}
Requirements: ${job.requirements.join(', ')}
Compensation Band: ${job.compBand}

Candidate Question: ${req.body.question}
Answer:`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const answer = response.text || "";
    const answeredFromData = !answer.includes("CANNOT_ANSWER_FROM_DATA");
    const cleanAnswer = answer.replace("CANNOT_ANSWER_FROM_DATA: ", "").trim();

    res.json({ answer: cleanAnswer, answeredFromData });
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate answer" });
  }
});

// Phase B - Scheduling

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

// Phase C - Offer & Post-Offer

app.post("/api/offers", (req, res) => {
  const { applicationId, compAmount } = req.body;
  const app = store.applications.find(a => a.id === applicationId);
  if (!app) return res.status(404).json({ error: "Application not found" });
  
  app.status = 'offered';
  const offer: Offer = {
    id: `off-${uuidv4().slice(0,8)}`,
    applicationId,
    compAmount,
    status: 'draft'
  };
  store.offers.push(offer);
  res.json(offer);
});

app.post("/api/offers/:id/send", (req, res) => {
  const offer = store.offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  
  offer.status = 'sent';
  offer.sentAt = new Date().toISOString();
  res.json(offer);
});

app.post("/api/offers/:id/respond", (req, res) => {
  const { decision, counterAmount } = req.body;
  const offer = store.offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  
  offer.status = decision;
  offer.respondedAt = new Date().toISOString();
  if (decision === 'countered' && counterAmount) {
     offer.counterAmount = counterAmount;
  }
  if (decision === 'accepted') {
     const app = store.applications.find(a => a.id === offer.applicationId);
     if (app) app.status = 'hired';
  }
  res.json(offer);
});

app.post("/api/offers/:id/background-check", (req, res) => {
  const offer = store.offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  
  offer.backgroundCheckStatus = 'pending';
  // Simulate it passing quickly
  setTimeout(() => {
    offer.backgroundCheckStatus = 'clear';
  }, 1000);
  
  res.json(offer);
});

app.post("/api/offers/:id/benefits", (req, res) => {
  const offer = store.offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  
  offer.benefitsEnrolled = true;
  res.json(offer);
});

app.post("/api/offers/:id/onboarding", (req, res) => {
  const offer = store.offers.find(o => o.id === req.params.id);
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  
  const templates = ["Setup Laptop", "Review Company Policies", "Complete Payroll Forms", "Join Team Standup"];
  
  const tasks = templates.map(t => {
     const task: OnboardingTask = {
       id: `task-${uuidv4().slice(0,8)}`,
       offerId: offer.id,
       taskName: t,
       status: 'pending',
       dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
     };
     store.onboardingTasks.push(task);
     return task;
  });
  
  res.json({ tasks });
});

app.get("/api/offers/:id/onboarding", (req, res) => {
  const tasks = store.onboardingTasks.filter(t => t.offerId === req.params.id);
  res.json({ tasks });
});

async function startServer() {
  const PORT = 3000;

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
