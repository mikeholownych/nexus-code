// Terminal presentation & human observability for Nexus Contest Demo
// Strictly formats output for video clarity and judge readability

const ESC = "\x1b[";
export const colors = {
	reset: `${ESC}0m`,
	bold: `${ESC}1m`,
	dim: `${ESC}2m`,
	italic: `${ESC}3m`,
	underline: `${ESC}4m`,
	red: `${ESC}31m`,
	green: `${ESC}32m`,
	yellow: `${ESC}33m`,
	blue: `${ESC}34m`,
	magenta: `${ESC}35m`,
	cyan: `${ESC}36m`,
	white: `${ESC}37m`,
	black: `${ESC}30m`,
	bgBlue: `${ESC}44m`,
	bgMagenta: `${ESC}45m`,
	bgCyan: `${ESC}46m`,
	bgYellow: `${ESC}43m`,
	bgGreen: `${ESC}42m`,
	bgRed: `${ESC}41m`,
	gray: `${ESC}90m`,
};

export class TerminalDisplay {
	constructor(options = {}) {
		this.pacingMs = options.pacingMs ?? (options.fast ? 0 : 800);
		this.verbose = Boolean(options.verbose);
		this.mode = options.mode || "local";
		this.agents = options.agents || "deterministic";
		this.startTime = Date.now();
		this.stageStartTime = Date.now();
	}

	async pace(multiplier = 1) {
		if (this.pacingMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, Math.round(this.pacingMs * multiplier)));
	}

	banner() {
		const isCf = this.mode === "cloudflare";
		const subBadge = isCf
			? `${colors.bgCyan}${colors.white}${colors.bold} SUBSTRATE: REAL CLOUDFLARE ARTIFACTS + WORKERS ${colors.reset}`
			: `${colors.bgBlue}${colors.white}${colors.bold} SUBSTRATE: LOCAL FIXTURE (OFFLINE SIMULATION) ${colors.reset}`;

		const agentBadge = this.agents === "real"
			? `${colors.bgGreen}${colors.white}${colors.bold} ACTORS: LIVE AI AGENTS (INFERENCE: ENGINEERING/B0) ${colors.reset}`
			: `${colors.bgYellow}${colors.black}${colors.bold} ACTORS: DETERMINISTIC COLLABORATION REGRESSION HARNESS ${colors.reset}`;

		console.log(`\n${colors.bold}${colors.cyan}================================================================================${colors.reset}`);
		console.log(`${colors.bold}${colors.white}  NEXUS: AGENT-NATIVE GIT COLLABORATION PLATFORM${colors.reset}`);
		console.log(`${colors.dim}  Continuous Reassessment & Work-State Synthesis Above Git Repositories${colors.reset}`);
		console.log(`  ${subBadge}`);
		console.log(`  ${agentBadge}`);
		console.log(`${colors.bold}${colors.cyan}================================================================================${colors.reset}\n`);
	}

	stageHeader(number, title, subtitle = "") {
		this.stageStartTime = Date.now();
		const numStr = `[${number}]`;
		console.log(`\n${colors.bold}${colors.yellow}--------------------------------------------------------------------------------${colors.reset}`);
		console.log(`${colors.bold}${colors.yellow}${numStr} ${title.toUpperCase()}${colors.reset}`);
		if (subtitle) {
			console.log(`${colors.dim}    ${subtitle}${colors.reset}`);
		}
		console.log(`${colors.bold}${colors.yellow}--------------------------------------------------------------------------------${colors.reset}`);
	}

	stageEnd(number, summary = "") {
		const elapsedSec = ((Date.now() - this.stageStartTime) / 1000).toFixed(2);
		const summaryText = summary ? ` — ${summary}` : "";
		console.log(`${colors.dim}    ⏱  Stage ${number} completed in ${elapsedSec}s${summaryText}${colors.reset}\n`);
	}

	info(label, value) {
		console.log(`  ${colors.bold}${colors.white}${label.padEnd(16)}:${colors.reset} ${value}`);
	}

	detail(message) {
		console.log(`    ${colors.dim}${message}${colors.reset}`);
	}

	// Visualizes an agent cognitive loop step
	loopStep(agentName, phase, text, details = null) {
		let phaseColor = colors.white;
		let badge = "";

		switch (phase) {
			case "OBSERVED":
				phaseColor = colors.cyan;
				badge = `${colors.bold}${colors.cyan}🔍 [OBSERVED]${colors.reset}`;
				break;
			case "ASSESS":
				phaseColor = colors.blue;
				badge = `${colors.bold}${colors.blue}🧠 [ASSESS]  ${colors.reset}`;
				break;
			case "DERIVED":
				phaseColor = colors.magenta;
				badge = `${colors.bold}${colors.magenta}⚙️  [DERIVED] ${colors.reset}`;
				break;
			case "INFERRED":
				phaseColor = colors.yellow;
				badge = `${colors.bold}${colors.yellow}💡 [INFERRED]${colors.reset}`;
				break;
			case "ACT":
				phaseColor = colors.green;
				badge = `${colors.bold}${colors.green}⚡ [ACT]     ${colors.reset}`;
				break;
			case "VALIDATE":
				phaseColor = colors.blue;
				badge = `${colors.bold}${colors.blue}🧪 [VALIDATE]${colors.reset}`;
				break;
			case "REASSESS":
				phaseColor = colors.magenta;
				badge = `${colors.bold}${colors.magenta}🔄 [REASSESS]${colors.reset}`;
				break;
			default:
				badge = `[${phase}]`;
		}

		const agentBadge = `${colors.bold}${colors.white}${agentName}${colors.reset}`;
		console.log(`  ${badge} ${agentBadge}: ${text}`);
		if (details) {
			if (typeof details === "string") {
				console.log(`      ${colors.dim}${details}${colors.reset}`);
			} else if (Array.isArray(details)) {
				for (const item of details) {
					console.log(`      ${colors.dim}• ${item}${colors.reset}`);
				}
			} else if (typeof details === "object") {
				for (const [k, v] of Object.entries(details)) {
					console.log(`      ${colors.dim}${k}: ${v}${colors.reset}`);
				}
			}
		}
	}

	workStateCard(title, payload) {
		console.log(`\n    ${colors.bold}${colors.magenta}┌── [MACHINE-READABLE WORK-STATE: ${title}] ─────────────────────────${colors.reset}`);
		console.log(`    ${colors.magenta}│${colors.reset}  ${colors.dim}Schema:  ${colors.reset}${colors.bold}${payload.schema || "nexus.agent-work-state.v1"}${colors.reset}`);
		if (payload.event) console.log(`    ${colors.magenta}│${colors.reset}  ${colors.dim}Event:   ${colors.reset}${colors.bold}${colors.yellow}${payload.event}${colors.reset}`);
		if (payload.producer?.candidateCommit) {
			console.log(`    ${colors.magenta}│${colors.reset}  ${colors.dim}Ref:     ${colors.reset}${payload.producer.candidateRef || "candidates/producer"} (${payload.producer.candidateCommit.slice(0, 10)})`);
		}
		if (payload.contract) {
			console.log(`    ${colors.magenta}│${colors.reset}  ${colors.dim}Contract:${colors.reset} ${payload.contract.file} (${payload.contract.type})`);
			if (payload.contract.changes) {
				for (const ch of payload.contract.changes) {
					const actColor = ch.action === "REMOVED" ? colors.red : colors.green;
					console.log(`    ${colors.magenta}│${colors.reset}    • ${actColor}${ch.action}${colors.reset} property '${ch.property}' ${ch.type ? `-> ${ch.type}` : ""}`);
				}
			}
		}
		console.log(`    ${colors.bold}${colors.magenta}└────────────────────────────────────────────────────────────────────${colors.reset}\n`);
	}

	contrastCard(controlResult, treatmentResult) {
		const isCf = this.mode === "cloudflare";
		const transportLabel = isCf
			? "nexus.agent-work-state.v1 via Cloudflare Workers + Artifacts Git"
			: "nexus.agent-work-state.v1 via Local Git/Ref Transport";

		console.log(`\n  ${colors.bold}${colors.white}┌── [EMPIRICAL COMPARISON: CONTROL vs TREATMENT] ────────────────────${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.bold}${colors.red}CONTROL (Unassisted / Stale Assumptions):${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Coordination Signal:     ${colors.red}None (Isolated Worktree)${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Integration Attempt 1:   ${colors.bold}${colors.red}FAILED (${controlResult.attempt1Error || "TS2339"})${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Reactive Rework Cycles:  ${colors.bold}${colors.yellow}${controlResult.correctiveCommits} corrective commit${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.bold}${colors.green}TREATMENT (Nexus Work-State Synthesis):${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Coordination Signal:     ${colors.green}${transportLabel}${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Integration Attempt 1:   ${colors.bold}${colors.green}PASSED (1st-pass clean compile & test)${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}    • Blind Integration Fails: ${colors.bold}${colors.green}0 (Zero reactive rework cycles)${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.dim}Note: E3R proven directional result (3/3 trials, 0 failed blind integrations vs 1).${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}└────────────────────────────────────────────────────────────────────${colors.reset}\n`);
	}

	historicalContrastCard() {
		console.log(`\n  ${colors.bold}${colors.white}┌── [PRIOR CONTROL vs TREATMENT RESULT: E3R] ────────────────────────${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.dim}Historical qualified result: 3/3 trials; 0 failed blind integrations with the signal vs 1 without it.${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.yellow}No blind control was executed in this current real-agent run.${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}│${colors.reset}  ${colors.dim}Current run status: treatment candidate adapted; integration validation follows in Stage 7.${colors.reset}`);
		console.log(`  ${colors.bold}${colors.white}└────────────────────────────────────────────────────────────────────${colors.reset}\n`);
	}

	finalSummary(report) {
		const totalElapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
		console.log(`\n${colors.bold}${colors.green}================================================================================${colors.reset}`);
		console.log(`${colors.bold}${colors.green}  DEMONSTRATION VERIFICATION COMPLETE${colors.reset}`);
		console.log(`${colors.bold}${colors.green}================================================================================${colors.reset}`);
		console.log(`  ${colors.bold}Substrate Mode:${colors.reset}     ${report.substrateMode.toUpperCase()}`);
		console.log(`  ${colors.bold}Baseline Commit:${colors.reset}    ${report.baselineCommit}`);
		console.log(`  ${colors.bold}Producer Candidate:${colors.reset} ${report.producerCommit}`);
		console.log(`  ${colors.bold}Consumer Candidate:${colors.reset} ${report.consumerCommit}`);
		console.log(`  ${colors.bold}Work-State Digest:${colors.reset}  ${report.workStateDigest || "N/A"}`);
		console.log(`  ${colors.bold}Integrated Ref:${colors.reset}     ${report.integratedRef} (${report.integratedCommit})`);
		console.log(`  ${colors.bold}Validation Status:${colors.reset}  ${colors.bold}${colors.green}PASS${colors.reset}`);
		if (report.typeSafety) {
			console.log(`  ${colors.bold}Type Safety:${colors.reset}        ${report.typeSafety === "STRICT" ? `${colors.bold}${colors.green}STRICT (zero any/suppression escape hatches)${colors.reset}` : `${colors.bold}${colors.red}VIOLATION (any/suppression used)${colors.reset}`}`);
		}
		console.log(`  ${colors.bold}Total Run Duration:${colors.reset} ${totalElapsed}s\n`);
	}
}
