import re

with open("src/App.tsx", "r") as f:
    content = f.read()

ui = """
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
"""

content = re.sub(
    r'                   <form onSubmit=\{\(e\) => handleSubmitScorecard\(e, interview\.id\)\} className="space-y-4 mt-6 border-t pt-4">.*?                   </form>',
    ui, content, flags=re.DOTALL
)

with open("src/App.tsx", "w") as f:
    f.write(content)
