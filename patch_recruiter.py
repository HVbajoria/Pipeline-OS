import re

with open("src/App.tsx", "r") as f:
    content = f.read()

funcs = """
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
"""
content = re.sub(r'  const handleScreen = async \(appId: string\) => \{', funcs, content)

ui = """
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Recruiter Dashboard</h1>
        
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
              <div className="mt-4 space-y-2 max-h-40 overflow-y-auto border-t pt-2">
                {searchResults.map(res => (
                  <div key={res.candidateId} className="text-sm p-2 bg-gray-50 rounded border">
                    <div className="font-bold">{res.name} (Score: {res.matchScore})</div>
                    <div className="text-gray-500 text-xs">{res.rationale}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <h2 className="text-lg font-semibold mb-4 border-b pb-2">Active Requisitions</h2>
"""

content = re.sub(
    r'      <div>\s*<h1 className="text-2xl font-bold text-gray-900 mb-6">Recruiter Dashboard</h1>\s*<h2 className="text-lg font-semibold mb-4 border-b pb-2">Active Requisitions</h2>',
    ui, content
)

with open("src/App.tsx", "w") as f:
    f.write(content)

