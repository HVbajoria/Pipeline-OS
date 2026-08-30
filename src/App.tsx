import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import { useStore } from './lib/store';
import { registerAllTools, onLogToolCall, ToolCallLog, registeredTools } from './lib/webmcp';
import { Activity, Briefcase, Users, User, LogOut, CheckCircle, Clock, FileText, X, HelpCircle, Book } from 'lucide-react';
import axios from 'axios';
import { Joyride, Step } from 'react-joyride';

const AgentActivityLog = () => {
  const [logs, setLogs] = useState<ToolCallLog[]>([]);

  useEffect(() => {
    const unsub = onLogToolCall((log) => {
      setLogs((prev) => {
        const existing = prev.findIndex(l => l.id === log.id);
        if (existing > -1) {
          const newLogs = [...prev];
          newLogs[existing] = log;
          return newLogs;
        }
        return [log, ...prev].slice(0, 50);
      });
    });
    return unsub;
  }, []);

  return (
    <div className="w-80 bg-gray-50 border-l border-gray-200 h-full overflow-y-auto flex flex-col tour-agent-log">
      <div className="p-4 border-b border-gray-200 bg-white sticky top-0 font-medium flex items-center gap-2">
        <Activity className="w-4 h-4 text-blue-600" /> Agent Activity Log
      </div>
      <div className="p-4 flex-1 space-y-3">
        {logs.map(log => (
          <div key={log.id} className="text-sm bg-white border border-gray-200 rounded-lg p-3 shadow-sm">
            <div className="flex justify-between items-center mb-1">
              <span className="font-medium text-gray-800">{log.name}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${log.status === 'success' ? 'bg-green-100 text-green-700' : log.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                {log.status}
              </span>
            </div>
            <div className="text-xs text-gray-500 font-mono bg-gray-50 p-2 rounded truncate" title={JSON.stringify(log.params)}>
              {JSON.stringify(log.params)}
            </div>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="text-sm text-gray-400 text-center py-8">
            No agent activity yet. Start calling tools!
          </div>
        )}
      </div>
    </div>
  );
};

const Navigation = ({ onStartTour }: { onStartTour: () => void }) => {
  const { currentRole, setRole, resetState } = useStore();
  
  return (
    <nav className="bg-slate-900 text-white w-64 flex flex-col h-full">
      <div className="p-4 flex items-center gap-2 border-b border-slate-800">
        <Briefcase className="w-6 h-6 text-blue-400" />
        <span className="font-bold text-lg tracking-tight">PipelineOS</span>
      </div>
      
      <div className="flex-1 py-6 px-3 space-y-1 tour-role-switcher">
        <div className="px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">View As</div>
        <button
          onClick={() => setRole('recruiter')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentRole === 'recruiter' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
        >
          <Users className="w-4 h-4" /> Recruiter
        </button>
        <button
          onClick={() => setRole('candidate')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentRole === 'candidate' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
        >
          <User className="w-4 h-4" /> Candidate
        </button>
        <button
          onClick={() => setRole('hiring-manager')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentRole === 'hiring-manager' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
        >
          <FileText className="w-4 h-4" /> Hiring Manager
        </button>
        <button
          onClick={() => setRole('documentation')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentRole === 'documentation' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
        >
          <Book className="w-4 h-4" /> Documentation
        </button>
      </div>

      <div className="p-4 border-t border-slate-800 space-y-2">
        <button onClick={onStartTour} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
          <HelpCircle className="w-4 h-4" /> Start Tour
        </button>
        <button onClick={resetState} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
          Reset DB (Demo)
        </button>
      </div>
    </nav>
  );
}

// --- Views ---

const DocumentationView = () => {
  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">WebMCP Tools Documentation</h1>
        <p className="text-gray-500">Below are the registered tools available to the agent along with their schemas.</p>
      </div>
      
      <div className="space-y-6">
        {registeredTools.map(tool => (
          <div key={tool.name} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 mb-2 font-mono text-blue-600">{tool.name}</h2>
            <p className="text-gray-700 mb-4">{tool.description}</p>
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 overflow-x-auto">
              <pre className="text-sm text-slate-800 font-mono whitespace-pre-wrap">
                {JSON.stringify(tool.schema, null, 2)}
              </pre>
            </div>
          </div>
        ))}
        {registeredTools.length === 0 && (
          <div className="text-gray-500 text-center py-12 bg-white rounded-xl border border-gray-200">
            No tools registered.
          </div>
        )}
      </div>
    </div>
  );
};

const RecruiterView = () => {
  const { jobs, applications, candidates, offers, onboardingTasks, interviews, fetchState } = useStore();
  const [schedulingAppId, setSchedulingAppId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string>('');

  const checkOverlap = (slot: string) => {
    return interviews.some((i: any) => i.status === 'scheduled' && i.slot === slot);
  };


  const handleCreateReq = async (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const reqs = fd.get('requirements')?.toString().split(',').map(s => s.trim()) || [];
    await axios.post('/api/jobs', {
      title: fd.get('title'),
      department: fd.get('department'),
      requirements: reqs,
      compBand: {
        min: parseInt(fd.get('min') as string),
        max: parseInt(fd.get('max') as string),
        currency: fd.get('currency')
      }
    });
    fetchState();
    (e.target as HTMLFormElement).reset();
  };

  const [searchResults, setSearchResults] = useState<any[]>([]);
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const query = fd.get('query') as string;
    const skills = fd.get('skills')?.toString().split(',').map(s => s.trim()).filter(Boolean) || [];
    const experienceLevel = fd.get('experienceLevel') as string;
    
    const res = await axios.post('/api/candidates/search', { query, skills, experienceLevel: experienceLevel || undefined });
    setSearchResults(res.data.results);
  };


  const handleScreen = async (appId: string) => {
    await axios.post(`/api/applications/${appId}/screen`);
    fetchState();
  };

  const handleProposeSlots = async (appId: string) => {
    await axios.post('/api/interviews/propose', { applicationId: appId });
    fetchState();
  };


  const handleOffer = async (applicationId: string) => {
    await axios.post(`/api/offers`, { applicationId, compAmount: 175000 });
    fetchState();
  };

  const handleBackgroundCheck = async (offerId: string) => {
    await axios.post(`/api/offers/${offerId}/background-check`);
    fetchState();
  };


  const handleGenerateOnboarding = async (offerId: string) => {
    await axios.post(`/api/offers/${offerId}/onboarding`);
    fetchState();
  };


  const [viewingCandidate, setViewingCandidate] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'interviews'>('profile');
  const [feedbackSummary, setFeedbackSummary] = useState<any>(null);

  const handleViewProfile = async (candidateId: string) => {
    try {
      const res = await axios.get(`/api/candidates/${candidateId}`);
      setViewingCandidate(res.data);
      setActiveTab('profile');
      
      // Attempt to load feedback for the first application if exists
      if (res.data.applicationHistory?.length > 0) {
        const appId = res.data.applicationHistory[0].id;
        const fbRes = await axios.get(`/api/applications/${appId}/feedback-summary`);
        setFeedbackSummary(fbRes.data);
      }
    } catch (e) {
      console.error(e);
    }
  };



  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">


      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Recruiter Dashboard</h1>

        {viewingCandidate && (

          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
              <div className="px-6 py-4 border-b flex justify-between items-center bg-gray-50">
                <h2 className="text-xl font-bold text-gray-900">Candidate Profile: {viewingCandidate.name}</h2>
                <button onClick={() => setViewingCandidate(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
              </div>
              <div className="flex border-b">
                <button onClick={() => setActiveTab('profile')} className={`px-6 py-3 font-medium text-sm ${activeTab === 'profile' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Profile Details</button>
                <button onClick={() => setActiveTab('interviews')} className={`px-6 py-3 font-medium text-sm ${activeTab === 'interviews' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Interview Summary</button>
              </div>
              
              {activeTab === 'profile' ? (
                <div className="p-6 overflow-y-auto space-y-4 flex-1">
                  <div>
                    <div className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Email</div>
                    <div>{viewingCandidate.email}</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Skills</div>
                    <div className="flex gap-2 flex-wrap mt-1">
                      {viewingCandidate.skills.map((s: string) => <span key={s} className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs">{s}</span>)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Resume</div>
                    <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-3 rounded border border-gray-200 mt-1">{viewingCandidate.resumeText}</pre>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Application History</div>
                    {viewingCandidate.applicationHistory?.length > 0 ? (
                      <ul className="space-y-2">
                        {viewingCandidate.applicationHistory.map((h: any) => (
                          <li key={h.id} className="text-sm border p-2 rounded flex justify-between">
                            <span>Job ID: {h.jobId}</span>
                            <span className="capitalize font-semibold">{h.status}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <div className="text-sm text-gray-500">No applications on file.</div>}
                  </div>
                </div>
              ) : (
                <div className="p-6 overflow-y-auto space-y-4 flex-1">
                  {!feedbackSummary || feedbackSummary.scorecards?.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">No interview feedback available yet.</div>
                  ) : (
                    <div>
                      <div className="grid grid-cols-2 gap-4 mb-6">
                        <div className="bg-gray-50 p-4 rounded-xl border">
                          <h3 className="font-semibold text-gray-700 text-sm mb-2">Average Competency Scores</h3>
                          <ul className="space-y-1">
                            {Object.entries(feedbackSummary.averageScores).map(([comp, score]) => (
                              <li key={comp} className="flex justify-between text-sm">
                                <span className="capitalize">{comp}</span>
                                <span className="font-bold">{(score as number).toFixed(1)} / 5</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-xl border">
                          <h3 className="font-semibold text-gray-700 text-sm mb-2">Recommendation Tally</h3>
                          <ul className="space-y-1">
                            {Object.entries(feedbackSummary.recommendationTally).map(([rec, count]) => (
                              <li key={rec} className="flex justify-between text-sm">
                                <span className="capitalize">{rec.replace('_', ' ')}</span>
                                <span className="font-bold">{count as number}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      
                      <h3 className="font-semibold text-gray-700 text-sm mb-2 border-b pb-2">Individual Scorecards</h3>
                      <div className="space-y-3">
                        {feedbackSummary.scorecards.map((s: any) => (
                          <div key={s.id} className="border p-4 rounded-lg bg-white shadow-sm">
                            <div className="flex justify-between items-center mb-2">
                              <span className="font-medium text-sm text-gray-800">Interviewer: {s.interviewer}</span>
                              <span className={`px-2 py-1 rounded text-xs font-bold ${s.recommendation === 'strong_hire' ? 'bg-green-100 text-green-800' : s.recommendation === 'hire' ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}`}>{s.recommendation.toUpperCase().replace('_', ' ')}</span>
                            </div>
                            <div className="text-xs text-gray-500 space-y-1 mt-2">
                                {Object.entries(s.competencyScores).map(([c, sc]) => (
                                  <div key={c}><span className="capitalize font-medium">{c}:</span> {sc as number}</div>
                                ))}
                            </div>
                            {s.comments && (
                              <div className="mt-3 text-sm text-gray-700 bg-gray-50 p-2 rounded border border-gray-100">
                                {s.comments}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        )}

        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
            <h2 className="text-lg font-semibold mb-4 border-b pb-2">New Requisition</h2>
            <form onSubmit={handleCreateReq} className="space-y-3">
              <div>
                <input name="title" placeholder="Job Title" required className="w-full border rounded p-2 text-sm" />
              </div>
              <div>
                <input name="department" placeholder="Department" required className="w-full border rounded p-2 text-sm" />
              </div>
              <div>
                <input name="requirements" placeholder="Requirements (comma separated)" required className="w-full border rounded p-2 text-sm" />
              </div>
              <div className="flex gap-2">
                <input name="min" type="number" placeholder="Min Salary" required className="w-full border rounded p-2 text-sm" />
                <input name="max" type="number" placeholder="Max Salary" required className="w-full border rounded p-2 text-sm" />
                <input name="currency" placeholder="Currency (e.g. $)" defaultValue="$" required className="w-16 border rounded p-2 text-sm" />
              </div>
              <button type="submit" className="w-full bg-blue-600 text-white rounded p-2 text-sm font-medium hover:bg-blue-700">Create Requisition</button>
            </form>
          </div>

          <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
            <h2 className="text-lg font-semibold mb-4 border-b pb-2">Source Candidates</h2>
            <form onSubmit={handleSearch} className="space-y-3">
              <div>
                <input name="query" placeholder="Search Query (e.g. 'kubernetes backend')" className="w-full border rounded p-2 text-sm" />
              </div>
              <div>
                <input name="skills" placeholder="Skills (comma separated)" className="w-full border rounded p-2 text-sm" />
              </div>
              <div>
                <select name="experienceLevel" className="w-full border rounded p-2 text-sm bg-white">
                  <option value="">Any Experience Level</option>
                  <option value="junior">Junior</option>
                  <option value="mid">Mid</option>
                  <option value="senior">Senior</option>
                </select>
              </div>
              <button type="submit" className="w-full bg-indigo-600 text-white rounded p-2 text-sm font-medium hover:bg-indigo-700">Search</button>
            </form>
            {searchResults.length > 0 && (
              <div className="mt-4 space-y-3 max-h-60 overflow-y-auto border-t pt-4">
                {searchResults.map(res => (
                  <div key={res.candidateId} className="bg-white rounded-lg border border-gray-200 p-3 shadow-sm hover:border-indigo-300 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <div className="font-semibold text-gray-900">{res.name}</div>
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-indigo-100 text-indigo-800">
                        Score: {res.matchScore}
                      </span>
                    </div>
                    <div className="text-xs text-gray-700 bg-indigo-50/50 p-2 rounded border border-indigo-100">
                      <span className="font-semibold text-indigo-900 block mb-0.5">Rationale:</span>
                      {res.rationale}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <h2 className="text-lg font-semibold mb-4 border-b pb-2">Active Requisitions</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {jobs.map(job => (
            <div key={job.id} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-semibold text-gray-900">{job.title}</h3>
                <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">Open</span>
              </div>
              <p className="text-sm text-gray-500 mb-4">{job.department} &middot; {job.compBand}</p>
              <div className="text-sm text-gray-600">
                {applications.filter(a => a.jobId === job.id).length} Active Applications
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4 border-b pb-2">Pipeline (All Applications)</h2>
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Candidate</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stage</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Score</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {applications.map(app => {
                const cand = candidates.find(c => c.id === app.candidateId);
                const offer = offers.find(o => o.applicationId === app.id);
                return (
                  <tr key={app.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{cand?.name}</div>
                      <div className="text-sm text-gray-500">{cand?.email}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="px-2.5 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800 capitalize">
                        {app.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {app.screeningScore !== undefined ? `${app.screeningScore}%` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">


                      {app.status === 'applied' && (
                        <button onClick={() => handleScreen(app.id)} className="text-blue-600 hover:text-blue-900 bg-blue-50 px-3 py-1 rounded-md">Screen</button>
                      )}
                      {app.status === 'screened' && (
                        <button onClick={() => handleProposeSlots(app.id)} className="text-indigo-600 hover:text-indigo-900 bg-indigo-50 px-3 py-1 rounded-md">Propose Slots</button>
                      )}
                      {app.status === 'interviewing' && (
                        <button onClick={() => handleOffer(app.id)} className="text-green-600 hover:text-green-900 bg-green-50 px-3 py-1 rounded-md">Make Offer</button>
                      )}
                      <button onClick={() => handleViewProfile(cand!.id)} className="text-gray-600 hover:text-gray-900 bg-gray-50 px-3 py-1 rounded-md">Profile</button>


                      {app.status === 'screened' && schedulingAppId !== app.id && (
                        <button 
                          onClick={() => {
                            setSchedulingAppId(app.id);
                            const tomorrow = new Date();
                            tomorrow.setDate(tomorrow.getDate() + 1);
                            setSelectedSlot(tomorrow.toISOString().split('T')[0] + " 10:00");
                          }} 
                          className="text-indigo-600 hover:text-indigo-900 bg-indigo-50 px-3 py-1 rounded-md" 
                          title="Schedule interview"
                        >
                          Schedule...
                        </button>
                      )}
                      {app.status === 'screened' && schedulingAppId === app.id && (
                        <div className="flex flex-col gap-2">
                          <input 
                            type="datetime-local" 
                            value={selectedSlot}
                            onChange={(e) => setSelectedSlot(e.target.value)}
                            className={`text-xs border rounded p-1 w-max ${checkOverlap(selectedSlot) ? 'border-red-500 bg-red-50' : 'border-gray-300'}`}
                          />
                          {checkOverlap(selectedSlot) && (
                            <span className="text-xs text-red-600 flex items-center gap-1">
                              ⚠️ Time slot overlaps with existing interview
                            </span>
                          )}
                          <div className="flex gap-2">
                            <button 
                              onClick={async () => {
                                await axios.post('/api/interviews/schedule', { applicationId: app.id, slot: selectedSlot });
                                setSchedulingAppId(null);
                                fetchState();
                              }}
                              className="text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1 rounded-md text-xs"
                            >Confirm</button>
                            <button 
                              onClick={() => setSchedulingAppId(null)}
                              className="text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded-md text-xs"
                            >Cancel</button>
                          </div>
                        </div>
                      )}
                      {app.status === 'interviewing' && (
                        <button onClick={() => handleOffer(app.id)} className="text-green-600 hover:text-green-900 bg-green-50 px-3 py-1 rounded-md">Make Offer</button>
                      )}
                      {app.status === 'offered' && (
                        <span className="text-gray-500 italic">Offer Drafted</span>
                      )}
                      {app.status === 'hired' && (
                        <div className="flex flex-col gap-2">
                          <span className="text-green-600 font-bold">Hired!</span>
                          
                          {offer && offer.status === 'accepted' && (
                            <div className="flex flex-col gap-1">
                              {!offer.backgroundCheckStatus ? (
                                <button onClick={() => handleBackgroundCheck(offer.id)} className="text-purple-600 hover:text-purple-900 bg-purple-50 px-3 py-1 rounded-md text-xs w-max">Initiate BG Check</button>
                              ) : (
                                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-md w-max">BG: {offer.backgroundCheckStatus}</span>
                              )}
                              
                              {onboardingTasks.filter((t: any) => t.offerId === offer.id).length === 0 ? (
                                <button onClick={() => handleGenerateOnboarding(offer.id)} className="text-orange-600 hover:text-orange-900 bg-orange-50 px-3 py-1 rounded-md text-xs w-max">Generate Onboarding</button>
                              ) : (
                                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-md w-max">Tasks Generated ({onboardingTasks.filter((t: any) => t.offerId === offer.id).length})</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {applications.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-gray-500 text-sm">No applications yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const CandidateView = () => {
  const { jobs, candidates, applications, offers, interviews, fetchState } = useStore();
  const candidateId = "cand-1"; // Hardcoded for demo
  const cand = candidates.find(c => c.id === candidateId);
  const myApps = applications.filter(a => a.candidateId === candidateId);
  const myOffers = offers.filter(o => myApps.some(a => a.id === o.applicationId));


  const handleApply = async (jobId: string) => {
    await axios.post('/api/applications', { candidateId, jobId, resumeText: cand?.resumeText || "My Resume" });
    fetchState();
  };

  const [faqAnswers, setFaqAnswers] = useState<Record<string, { answer: string, fromData: boolean }>>({});
  const handleAskFaq = async (e: React.FormEvent, jobId: string) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const question = (form.elements.namedItem('question') as HTMLInputElement).value;
    try {
      const res = await axios.post(`/api/jobs/${jobId}/faq`, { question });
      setFaqAnswers(prev => ({ ...prev, [jobId]: { answer: res.data.answer, fromData: res.data.answeredFromData } }));
    } catch (e) {
      setFaqAnswers(prev => ({ ...prev, [jobId]: { answer: "Error getting answer.", fromData: false } }));
    }
  };


  const handleOfferResponse = async (offerId: string, decision: string) => {
    await axios.post(`/api/offers/${offerId}/respond`, { decision });
    fetchState();
  };

  const handleEnrollBenefits = async (offerId: string, plan: string) => {
    await axios.post(`/api/offers/${offerId}/benefits`, { planSelections: { health: plan } });
    fetchState();
  };

  const handleBookInterview = async (applicationId: string, slot: string) => {
    await axios.post('/api/interviews/book', { applicationId, slot });
    fetchState();
  };


  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome, {cand?.name}</h1>
        <p className="text-gray-500">Find your next role.</p>
      </div>


      {interviews.filter((i: any) => i.status === 'proposed' && myApps.some(a => a.id === i.applicationId)).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4 border-b pb-2">Action Required: Schedule Interview</h2>
          <div className="space-y-4">
            {myApps.map(app => {
              const appInterviews = interviews.filter((i: any) => i.applicationId === app.id && i.status === 'proposed');
              if (appInterviews.length === 0) return null;
              const job = jobs.find(j => j.id === app.jobId);
              return (
                <div key={app.id} className="bg-blue-50 border border-blue-200 p-5 rounded-xl shadow-sm">
                  <h3 className="font-bold text-blue-900 text-lg mb-2">Pick your interview time for {job?.title}</h3>
                  <div className="flex gap-2 flex-wrap">
                    {appInterviews.map((i: any) => (
                      <button 
                        key={i.id} 
                        onClick={() => handleBookInterview(app.id, i.slot)}
                        className="px-4 py-2 bg-white text-blue-700 border border-blue-300 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
                      >
                        {new Date(i.slot).toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {myOffers.length > 0 && (

        <div>
          <h2 className="text-lg font-semibold mb-4 border-b pb-2">Your Offers</h2>
          <div className="space-y-4">
            {myOffers.map(offer => (
              <div key={offer.id} className="bg-green-50 border border-green-200 p-5 rounded-xl shadow-sm">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="font-bold text-green-900 text-lg">Offer Extended</h3>
                    <p className="text-green-800 font-medium">Compensation: ${offer.compAmount.toLocaleString()}</p>
                  </div>
                  <span className="px-3 py-1 rounded-full text-sm font-semibold bg-green-200 text-green-900 capitalize">{offer.status}</span>
                </div>
                {offer.status === 'sent' && (
                  <div className="flex gap-3 mt-4">
                    <button onClick={() => handleOfferResponse(offer.id, 'accepted')} className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors">Accept Offer</button>
                    <button onClick={() => handleOfferResponse(offer.id, 'declined')} className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-lg font-medium hover:bg-gray-50 transition-colors">Decline</button>
                  </div>
                )}
                {offer.status === 'accepted' && (
                  <div className="mt-4 pt-4 border-t border-green-200">
                    <h4 className="font-semibold text-green-900 mb-2">Next Steps (Post-Offer)</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-green-800">Background Check:</span>
                        <span className="font-medium">{offer.backgroundCheckStatus || 'Not started'}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-green-800">Benefits Enrollment:</span>
                        {offer.benefitsEnrolled ? (
                          <span className="font-medium">Complete</span>
                        ) : (
                          <div className="flex gap-2 items-center">
                            <select id={`plan-${offer.id}`} className="text-xs border border-green-300 rounded p-1 bg-white">
                              <option value="ppo">PPO Premium</option>
                              <option value="hmo">HMO Standard</option>
                            </select>
                            <button 
                              onClick={() => {
                                const val = (document.getElementById(`plan-${offer.id}`) as HTMLSelectElement).value;
                                handleEnrollBenefits(offer.id, val);
                              }}
                              className="bg-green-600 text-white px-3 py-1 rounded text-xs hover:bg-green-700 transition-colors"
                            >
                              Enroll
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4 border-b pb-2">Open Roles</h2>
        <div className="space-y-4">
          {jobs.map(job => {
            const applied = myApps.some(a => a.jobId === job.id);

            return (
              <div key={job.id} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-lg">{job.title}</h3>
                    <p className="text-sm text-gray-500 mt-1">{job.department} &middot; {job.compBand}</p>
                  </div>
                  {applied ? (
                    <span className="flex items-center gap-1 text-sm font-medium text-green-600 bg-green-50 px-3 py-1.5 rounded-full"><CheckCircle className="w-4 h-4" /> Applied</span>
                  ) : (
                    <button onClick={() => handleApply(job.id)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">Apply Now</button>
                  )}
                </div>
                
                <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                  <h4 className="text-sm font-semibold mb-2">Ask about this role</h4>
                  <form onSubmit={(e) => handleAskFaq(e, job.id)} className="flex gap-2 mb-2">
                    <input name="question" placeholder="E.g., What are the requirements?" required className="flex-1 border rounded p-2 text-sm" />
                    <button type="submit" className="bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm hover:bg-slate-300 font-medium">Ask AI</button>
                  </form>
                  {faqAnswers[job.id] && (
                    <div className={`p-3 rounded text-sm ${faqAnswers[job.id].fromData ? 'bg-blue-50 text-blue-900 border border-blue-100' : 'bg-orange-50 text-orange-900 border border-orange-100'}`}>
                      <strong>Answer:</strong> {faqAnswers[job.id].answer}
                    </div>
                  )}
                </div>
              </div>
            );
})}
        </div>
      </div>
    </div>
  );
};

const HiringManagerView = () => {
  const { interviews, applications, candidates, jobs, fetchState } = useStore();
  const [prepKit, setPrepKit] = useState<any>(null);
  const [loadingKit, setLoadingKit] = useState<boolean>(false);
  
  const pendingInterviews = interviews.filter((i: any) => i.status === 'scheduled');


  const handleSubmitScorecard = async (e: React.FormEvent, interviewId: string) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
       
    await axios.post(`/api/interviews/${interviewId}/feedback`, {
      interviewer: "hm-1",
      competencyScores: {
        technical: parseInt(form.technical.value, 10),
        communication: parseInt(form.communication.value, 10)
      },
      recommendation: form.recommendation.value,
      comments: form.comments.value
    });
       
    fetchState();
  };


  const handleViewPrep = async (jobId: string) => {
    setLoadingKit(true);
    setPrepKit({ loading: true }); // Open modal in loading state
    try {
      const res = await axios.get(`/api/jobs/${jobId}/interview-kit`);
      setPrepKit(res.data);
    } catch (e) {
      setPrepKit({ error: true });
    } finally {
      setLoadingKit(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 relative">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Hiring Manager Portal</h1>
        <p className="text-gray-500">Review pending scorecards and interview pipeline.</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4 border-b pb-2">Pending Scorecards</h2>
        {pendingInterviews.length === 0 ? (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-8 text-center text-gray-500">
             <Clock className="w-12 h-12 mx-auto text-gray-300 mb-3" />
             No pending scorecards to review. Your pipeline is clean!
          </div>
        ) : (
          <div className="space-y-4">
            {pendingInterviews.map((interview: any) => {
               const app = applications.find((a: any) => a.id === interview.applicationId);
               const cand = candidates.find((c: any) => c.id === app?.candidateId);
               const job = jobs.find((j: any) => j.id === app?.jobId);
               
               return (
                 <div key={interview.id} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm relative">
                   <div className="mb-4">
                     <div className="flex justify-between items-start">
                       <div>
                         <h3 className="font-bold text-gray-900 text-lg">{cand?.name}</h3>
                         <p className="text-sm text-gray-500">Interview for: {job?.title} &middot; Slot: {interview.slot}</p>
                       </div>
                       <button onClick={() => handleViewPrep(job.id)} className="text-blue-600 hover:text-blue-800 text-sm font-medium border border-blue-200 hover:bg-blue-50 px-3 py-1.5 rounded-md transition-colors">
                         View Interview Prep
                       </button>
                     </div>
                   </div>
                   

                  <form onSubmit={(e) => handleSubmitScorecard(e, interview.id)} className="space-y-4 mt-6 border-t pt-4">
                    {prepKit && !prepKit.loading && !prepKit.error && (
                      <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl mb-4">
                        <h4 className="font-semibold text-blue-900 mb-2">Interview Kit</h4>
                        <div className="space-y-3">
                          {prepKit.competencies?.map((comp: any, idx: number) => (
                            <div key={idx} className="bg-white p-3 rounded shadow-sm border border-blue-100 text-sm">
                              <div className="font-bold text-blue-800 mb-1">{comp.name || comp.competency}</div>
                              <ul className="list-disc pl-5 text-gray-700 space-y-1">
                                {comp.questions ? comp.questions.map((q: string, i: number) => <li key={i}>{q}</li>) : <li>{comp.question} (Expected: {comp.expectedSignal})</li>}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    <h4 className="font-semibold text-gray-900 mb-2">Scorecard</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Technical Skills (1-5)</label>
                        <select name="technical" className="w-full border rounded p-2 text-sm bg-white" required>
                          {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Communication (1-5)</label>
                        <select name="communication" className="w-full border rounded p-2 text-sm bg-white" required>
                          {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Overall Recommendation</label>
                      <select name="recommendation" className="w-full border rounded p-2 text-sm bg-white" required>
                        <option value="no_hire">No Hire</option>
                        <option value="hire">Hire</option>
                        <option value="strong_hire">Strong Hire</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Comments</label>
                      <textarea name="comments" className="w-full border rounded p-2 text-sm bg-white" rows={3}></textarea>
                    </div>
                    <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors">
                      Submit Scorecard
                    </button>
                  </form>

                 </div>
               );
            })}
          </div>
        )}
      </div>

      {prepKit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="px-6 py-4 border-b flex justify-between items-center bg-gray-50">
              <h2 className="text-xl font-bold text-gray-900">AI Interview Kit</h2>
              <button onClick={() => setPrepKit(null)} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {loadingKit ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <Activity className="w-8 h-8 animate-pulse text-blue-500 mb-4" />
                  <p>Generating personalized questions based on job requirements...</p>
                </div>
              ) : prepKit.error ? (
                <div className="text-red-500 text-center py-8">Failed to load interview kit.</div>
              ) : (
                <div className="space-y-6">
                  {prepKit.questions?.map((q: any, i: number) => (
                    <div key={i} className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
                      <div className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-2">{q.competency}</div>
                      <p className="font-semibold text-gray-900 mb-3 text-lg">{q.question}</p>
                      <div className="bg-green-50 p-3 rounded-lg border border-green-100">
                        <span className="text-xs font-bold text-green-800 uppercase block mb-1">Expected Signal</span>
                        <p className="text-sm text-green-900">{q.expectedSignal}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


export default function App() {
  const { currentRole, fetchState } = useStore();
  const [runTour, setRunTour] = useState(false);

  useEffect(() => {
    fetchState();
    registerAllTools(fetchState);

    if (!localStorage.getItem('pipeline-tour-completed')) {
      setRunTour(true);
    }
  }, []);

  const handleJoyrideCallback = (data: any) => {
    const { status } = data;
    if (['finished', 'skipped'].includes(status)) {
      setRunTour(false);
      localStorage.setItem('pipeline-tour-completed', 'true');
    }
  };

  const steps: any[] = [
    {
      target: '.tour-role-switcher',
      content: 'Welcome to PipelineOS! Switch between Recruiter, Candidate, and Hiring Manager views here to experience different personas.',
      placement: 'right',
      disableBeacon: true,
    },
    {
      target: '.tour-main-content',
      content: 'This is the main workspace. Data changes instantly depending on your selected persona. Try simulating actions like scheduling interviews!',
      placement: 'center',
    },
    {
      target: '.tour-agent-log',
      content: 'As you navigate and trigger actions, watch the AI Agent activity stream right here. It actively logs the background WebMCP tasks processing your workflow.',
      placement: 'left',
    }
  ];

  return (
    <BrowserRouter>
      <div className="flex h-screen w-full bg-gray-50 overflow-hidden font-sans">
        <Joyride
          steps={steps}
          run={runTour}
          continuous
          showSkipButton
          showProgress
          callback={handleJoyrideCallback}
          styles={{
            // @ts-ignore
            options: {
              primaryColor: '#2563eb',
            },
          }}
        />
        <Navigation onStartTour={() => setRunTour(true)} />
        
        <main className="flex-1 h-full overflow-y-auto tour-main-content">
          {currentRole === 'recruiter' && <RecruiterView />}
          {currentRole === 'candidate' && <CandidateView />}
          {currentRole === 'hiring-manager' && <HiringManagerView />}
          {currentRole === 'documentation' && <DocumentationView />}
        </main>
        
        <AgentActivityLog />
      </div>
    </BrowserRouter>
  );
}
