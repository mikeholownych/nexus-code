/**
 * Dynamic few-shot tool demonstration injection based on task type (Candidate #18)
 * Drastically reduces argument hallucination in local models (7B-32B Qwen/DeepSeek)
 */

export interface FewShotExemplar {
  category: "edit" | "test_repair" | "batch_exploration" | "planning" | "git";
  title: string;
  triggerKeywords: string[];
  exemplarText: string;
}

export const FEW_SHOT_EXEMPLARS: FewShotExemplar[] = [
  {
    category: "edit",
    title: "Precise File Modification",
    triggerKeywords: ["edit", "modify", "replace", "fix", "update", "refactor", "bug"],
    exemplarText: `Example: Modifying a specific function using edit_file
Model:
\`\`\`json
{
  "tool": "edit_file",
  "arguments": {
    "path": "src/utils.ts",
    "target_content": "export function add(a: number, b: number): number {\\n  return a - b;\\n}",
    "replacement_content": "export function add(a: number, b: number): number {\\n  return a + b;\\n}"
  }
}
\`\`\``,
  },
  {
    category: "test_repair",
    title: "Test Execution and Error Self-Correction",
    triggerKeywords: ["test", "failing", "error", "compile", "cargo test", "npm test", "diagnostic"],
    exemplarText: `Example: Running test suite and diagnosing output
Model:
\`\`\`json
{
  "tool": "run_command",
  "arguments": {
    "command": "npm test"
  }
}
\`\`\`
Tool Result: "FAIL test/calc.test.ts: Expected 4 but got -2 at calc.ts:5:10"
Model:
\`\`\`json
{
  "tool": "edit_file",
  "arguments": {
    "path": "src/calc.ts",
    "target_content": "return a - b;",
    "replacement_content": "return a + b;"
  }
}
\`\`\``,
  },
  {
    category: "batch_exploration",
    title: "High-Efficiency Exploration with batch_read",
    triggerKeywords: ["explore", "read", "inspect", "investigate", "files", "batch", "understand"],
    exemplarText: `Example: Concurrently reading multiple files
Model:
\`\`\`json
{
  "tool": "batch_read",
  "arguments": {
    "paths": ["src/index.ts", "src/types.ts", "package.json"]
  }
}
\`\`\``,
  },
  {
    category: "planning",
    title: "Milestone-Driven Execution Planning",
    triggerKeywords: ["plan", "feature", "large", "multi-step", "phases", "architecture", "migrate"],
    exemplarText: `Example: Setting up structured milestone phases
Model:
\`\`\`json
{
  "tool": "update_plan",
  "arguments": {
    "phases": [
      { "name": "Explore existing types & contracts", "status": "completed" },
      { "name": "Implement core logic and endpoints", "status": "in_progress" },
      { "name": "Run unit test suite & verify", "status": "pending" }
    ]
  }
}
\`\`\``,
  },
];

/**
 * Select the 1-2 most relevant few-shot exemplars matching the task prompt or active conversation context
 */
export function selectRelevantFewShots(contextPrompt: string, maxExemplars: number = 2): string {
  const lower = contextPrompt.toLowerCase();
  const scored = FEW_SHOT_EXEMPLARS.map((ex) => {
    let score = 0;
    for (const kw of ex.triggerKeywords) {
      if (lower.includes(kw)) {
        score++;
      }
    }
    return { exemplar: ex, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.filter((s) => s.score > 0).slice(0, maxExemplars);

  if (selected.length === 0) {
    // Default to precise edit exemplar
    return `### Recommended Tool Usage Exemplar:\n${FEW_SHOT_EXEMPLARS[0].exemplarText}\n`;
  }

  return (
    `### Recommended Tool Usage Exemplars:\n` +
    selected.map((s) => s.exemplar.exemplarText).join("\n\n") +
    "\n"
  );
}
