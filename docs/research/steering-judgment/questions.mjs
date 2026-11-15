// Single source of truth for the steering-judgment questions (both arms read this module).
export const OBJECTIVE = ["Ship the importer:", "1. Parse the CSV input", "2. Add retry logic to the uploader", "3. Write the migration guide"].join("\n");
export const REQUIREMENTS = [{ number: 1, text: "Parse the CSV input" }, { number: 2, text: "Add retry logic to the uploader" }, { number: 3, text: "Write the migration guide" }];
export const stateFor = (steeringText) => ({ objective: OBJECTIVE, requirements: REQUIREMENTS, steering: { text: steeringText } });
const q = (r) => ({
  [`r${r.number}.withdraws`]: {
    type: "noul",
    instructions: `Does the operator's message in \`steering.text\` tell the agent to stop working on requirement ${r.number} ("${r.text}"), or to leave it out of this task altogether?`,
    criteria: { true: "The operator drops, cancels, skips, descopes or replaces this requirement, so it will no longer be done as written.", false: "The operator keeps it, adds to it, asks about it, restricts how it is done, postpones it, or is talking about something else." },
  },
  [`r${r.number}.defers`]: {
    type: "noul",
    instructions: `Does the operator's message in \`steering.text\` say that requirement ${r.number} ("${r.text}") should wait until later instead of being dropped?`,
    criteria: { true: "The operator postpones it to a later time or condition and still expects it eventually.", false: "The operator says nothing about timing for it, drops it for good, or keeps it as it is." },
  },
  [`r${r.number}.changes`]: {
    type: "noul",
    instructions: `Does the operator's message in \`steering.text\` change what requirement ${r.number} ("${r.text}") asks for, making it narrower, looser or different, while still wanting a version of it?`,
    criteria: { true: "The operator narrows, relaxes or alters what it requires and still wants it done in that form.", false: "The operator leaves what it asks for unchanged, drops it, or is talking about something else." },
  },
});
export const questionsFor = () => Object.assign({}, ...REQUIREMENTS.map(q));
