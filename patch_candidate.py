import re

with open("src/App.tsx", "r") as f:
    content = f.read()

funcs = """
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
"""

content = re.sub(
    r'  const handleApply = async \(jobId: string\) => \{\s*await axios.post\(\'/api/applications\', \{ candidateId, jobId, resumeText: cand\?\.resumeText \|\| "My Resume" \}\);\s*fetchState\(\);\s*\};',
    funcs, content
)

ui = """
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
"""

content = re.sub(
    r'            return \(\s*<div key=\{job.id\} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex justify-between items-center">.*?</div>\s*\);\s*',
    ui, content, flags=re.DOTALL
)

with open("src/App.tsx", "w") as f:
    f.write(content)

