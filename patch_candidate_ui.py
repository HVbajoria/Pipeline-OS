import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# Update CandidateView signature to include interviews
content = content.replace(
    "const { jobs, candidates, applications, offers, fetchState } = useStore();",
    "const { jobs, candidates, applications, offers, interviews, fetchState } = useStore();"
)

# Add book logic in CandidateView
funcs = """
  const handleBookInterview = async (applicationId: string, slot: string) => {
    await axios.post('/api/interviews/book', { applicationId, slot });
    fetchState();
  };
"""

content = re.sub(r'  const handleEnrollBenefits = async \(offerId: string, plan: string\) => \{.*?\};', 
    r'\g<0>\n' + funcs, content, flags=re.DOTALL)


# Add proposed interviews UI in CandidateView
ui = """
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
"""

content = content.replace("      {myOffers.length > 0 && (", ui)

with open("src/App.tsx", "w") as f:
    f.write(content)
