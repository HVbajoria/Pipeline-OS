import re

with open("src/App.tsx", "r") as f:
    content = f.read()

funcs = """
  const handleScreen = async (appId: string) => {
    await axios.post(`/api/applications/${appId}/screen`);
    fetchState();
  };

  const handleProposeSlots = async (appId: string) => {
    await axios.post('/api/interviews/propose', { applicationId: appId });
    fetchState();
  };
"""

content = re.sub(r'  const handleScreen = async \(appId: string\) => \{\s*await axios\.post\(`/api/applications/\$\{appId\}/screen`\);\s*fetchState\(\);\s*\};', funcs, content)

# Look for Pipeline table actions
ui = """
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
"""

content = re.sub(
    r'                      \{app\.status === \'applied\' && \(\s*<button onClick=\{\(\) => handleScreen\(app\.id\)\} className="text-blue-600 hover:text-blue-900 bg-blue-50 px-3 py-1 rounded-md">Screen</button>\s*\)\}\s*<button onClick=\{\(\) => handleViewProfile\(cand!\.id\)\} className="text-gray-600 hover:text-gray-900 bg-gray-50 px-3 py-1 rounded-md">Profile</button>',
    ui, content
)

with open("src/App.tsx", "w") as f:
    f.write(content)
