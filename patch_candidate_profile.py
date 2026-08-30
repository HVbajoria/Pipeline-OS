import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# Add states for profile modal
funcs = """
  const handleGenerateOnboarding = async (offerId: string) => {
    await axios.post(`/api/offers/${offerId}/onboarding`);
    fetchState();
  };

  const [viewingCandidate, setViewingCandidate] = useState<any>(null);
  const handleViewProfile = async (candidateId: string) => {
    try {
      const res = await axios.get(`/api/candidates/${candidateId}`);
      setViewingCandidate(res.data);
    } catch (e) {
      console.error(e);
    }
  };
"""

content = re.sub(
    r'  const handleGenerateOnboarding = async \(offerId: string\) => \{\s*await axios\.post\(`/api/offers/\$\{offerId\}/onboarding`\);\s*fetchState\(\);\s*\};',
    funcs, content
)

# Add View Profile button
btn = """
                      {app.status === 'applied' && (
                        <button onClick={() => handleScreen(app.id)} className="text-blue-600 hover:text-blue-900 bg-blue-50 px-3 py-1 rounded-md">Screen</button>
                      )}
                      <button onClick={() => handleViewProfile(cand!.id)} className="text-gray-600 hover:text-gray-900 bg-gray-50 px-3 py-1 rounded-md">Profile</button>
"""
content = re.sub(
    r'                      \{app\.status === \'applied\' && \(\s*<button onClick=\{\(\) => handleScreen\(app\.id\)\} className="text-blue-600 hover:text-blue-900 bg-blue-50 px-3 py-1 rounded-md">Screen</button>\s*\)\}',
    btn, content
)

# Add Modal
modal = """
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Recruiter Dashboard</h1>

        {viewingCandidate && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
              <div className="px-6 py-4 border-b flex justify-between items-center bg-gray-50">
                <h2 className="text-xl font-bold text-gray-900">Candidate Profile: {viewingCandidate.name}</h2>
                <button onClick={() => setViewingCandidate(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
              </div>
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
            </div>
          </div>
        )}
"""

content = re.sub(
    r'      <div>\s*<h1 className="text-2xl font-bold text-gray-900 mb-6">Recruiter Dashboard</h1>',
    modal, content
)


with open("src/App.tsx", "w") as f:
    f.write(content)

