import re

with open("src/App.tsx", "r") as f:
    content = f.read()

funcs = """
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
"""

content = re.sub(
    r'  const \[viewingCandidate, setViewingCandidate\] = useState<any>\(null\);\s*const handleViewProfile = async \(candidateId: string\) => \{\s*try \{\s*const res = await axios\.get\(`/api/candidates/\$\{candidateId\}`\);\s*setViewingCandidate\(res\.data\);\s*\} catch \(e\) \{\s*console\.error\(e\);\s*\}\s*\};',
    funcs, content
)


ui = """
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
"""

content = re.sub(
    r'          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">.*?</div>\s*</div>\s*</div>\s*\)',
    ui + '\n        )', content, flags=re.DOTALL
)

with open("src/App.tsx", "w") as f:
    f.write(content)
