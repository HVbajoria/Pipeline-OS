import re

with open("src/App.tsx", "r") as f:
    content = f.read()

funcs = """
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
"""

content = re.sub(
    r'  const handleSubmitScorecard = async \(e: React\.FormEvent, interviewId: string\) => \{.*?fetchState\(\);\s*\};',
    funcs, content, flags=re.DOTALL
)

with open("src/App.tsx", "w") as f:
    f.write(content)
