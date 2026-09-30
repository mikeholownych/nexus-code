import pc from "picocolors";
import ora from "ora";
export class TerminalUI {
    spinner = null;
    banner() {
        console.log(pc.bold(pc.cyan("\n╔════════════════════════════════════════════════════════════════╗")));
        console.log(pc.bold(pc.cyan("║           NEXUS CODE HARNESS - LOCAL AI AUTONOMOUS CLI        ║")));
        console.log(pc.bold(pc.cyan("╚════════════════════════════════════════════════════════════════╝\n")));
    }
    stepHeader(step, maxSteps) {
        console.log(pc.bgCyan(pc.black(` STEP ${step}/${maxSteps} `)) +
            " " +
            pc.gray("─".repeat(50)));
    }
    startSpinner(text) {
        this.spinner = ora({
            text: pc.yellow(text),
            spinner: "dots",
        }).start();
    }
    updateSpinner(text) {
        if (this.spinner) {
            this.spinner.text = pc.yellow(text);
        }
    }
    stopSpinner(success = true, message) {
        if (this.spinner) {
            if (success) {
                this.spinner.succeed(message ? pc.green(message) : undefined);
            }
            else {
                this.spinner.fail(message ? pc.red(message) : undefined);
            }
            this.spinner = null;
        }
    }
    printThought(thought) {
        if (!thought || !thought.trim())
            return;
        console.log(pc.bold(pc.magenta("\n💭 Thought:")));
        const lines = thought.trim().split("\n");
        for (const line of lines) {
            console.log(pc.gray("  │ ") + line);
        }
        console.log();
    }
    printToolCall(name, args) {
        console.log(pc.bold(pc.blue("⚡ Tool Call: ")) +
            pc.bold(pc.white(name)) +
            pc.gray(" ") +
            pc.dim(JSON.stringify(args)));
    }
    printToolResult(toolName, success, output, error) {
        if (success) {
            console.log(pc.bold(pc.green("✔ Result:")));
            // If diff, render nicely
            if (toolName === "edit_file" && output) {
                this.renderDiff(output);
            }
            else {
                const preview = output.length > 500 ? output.substring(0, 500) + "\n... [TRUNCATED]" : output;
                const lines = preview.split("\n");
                for (const line of lines) {
                    console.log(pc.gray("  ") + line);
                }
            }
        }
        else {
            console.log(pc.bold(pc.red("✖ Tool Error:")));
            console.log(pc.red(`  ${error || output}`));
        }
        console.log();
    }
    renderDiff(diffText) {
        const lines = diffText.split("\n");
        for (const line of lines) {
            if (line.startsWith("+")) {
                console.log(pc.green(`  ${line}`));
            }
            else if (line.startsWith("-")) {
                console.log(pc.red(`  ${line}`));
            }
            else {
                console.log(pc.gray(`  ${line}`));
            }
        }
    }
    taskCompleted(summary, notes) {
        console.log(pc.bold(pc.green("\n════════════════════════ TASK COMPLETED ════════════════════════")));
        console.log(pc.bold(pc.white("\nSummary:")));
        console.log(summary);
        if (notes && notes.trim()) {
            console.log(pc.bold(pc.yellow("\nNotes:")));
            console.log(notes);
        }
        console.log(pc.bold(pc.green("════════════════════════════════════════════════════════════════\n")));
    }
}
