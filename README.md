# PipelineOS

A WebMCP-Native Recruiting Platform that covers the *entire* hiring pipeline — sourcing through onboarding — and exposes every major action as a **WebMCP tool**.

## Inspiration

Based on Josh Bersin's recruiting-workflow diagram showing 30+ manual pre-offer steps. Traditional tools (like LinkedIn Hiring Assistant) automate sourcing, screening, and scheduling, but usually stop at the offer. Post-offer tasks (background checks, benefits, pre-boarding, onboarding) remain manual. 

PipelineOS is the first WebMCP application to cover the *whole* pipeline, pre- and post-offer, enabling both Recruiter Agents and Candidate Agents to transact through the same live application state.

## WebMCP Tools Implemented

The application exposes the following tools via `navigator.modelContext.registerTool`:

### Phase A — Sourcing & Screening
- `create_job_requisition`: Post a new job.
- `search_candidates`: Query candidate DB by skills or keywords.
- `get_candidate_profile`: Retrieve full profile data.
- `submit_application`: Submit a candidate's resume to a job.
- `screen_candidate`: Automatically score a candidate against job requirements.
- `answer_candidate_faq`: Answer candidate questions based on requisition details.

### Phase B — Scheduling & Interviewing (Simplified)
- `schedule_interview`: Move candidate to interviewing stage. 
  *(Note: Due to time constraints, the full scorecard aggregation workflow was simplified to a single scheduling step).*

### Phase C — Offer & Post-Offer (The Differentiator)
- `generate_offer`: Draft an offer.
- `send_offer`: Dispatch the offer to the candidate.
- `respond_to_offer`: Accept, decline, or counter the offer.
- `initiate_background_check`: Trigger the background check process.
- `enroll_benefits`: Candidate enrollment in benefits.
- `generate_onboarding_checklist`: Auto-create onboarding tasks based on role.
- `get_onboarding_status`: Check onboarding progress.

## Running the Demo

1. Start the app.
2. An **Agent Activity Log** is visible on the right side of the screen.
3. Your WebMCP-compatible agent can interact directly with the tools (or you can simulate it using `window.__webmcp_tools` in the browser console).
4. The UI will instantly reflect state changes made by the agents.
5. Use the navigation sidebar to switch between Recruiter, Candidate, and Hiring Manager views to observe the end-to-end flow.
