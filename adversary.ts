/**
 * Adversary Extension
 *
 * A synchronous gate that reviews bash tool calls before execution.
 * Spawns a separate `pi -p --no-session` process to evaluate whether
 * the command is safe, then blocks or allows based on the verdict.
 *
 * Enable with: pi --adversary
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AdversaryVerdict {
	verdict: "ALLOW" | "BLOCK";
	reason: string;
}

export default function adversary(pi: ExtensionAPI) {
	pi.registerFlag("adversary", {
		type: "boolean",
		default: false,
		description: "Enable adversary agent to review bash commands before execution",
	});

	let originalTask = "";
	let rules = loadRules();

	// Capture the original user task for context
	pi.on("before_agent_start", (event) => {
		if (!originalTask) {
			originalTask = event.prompt;
		}
	});

	// Reset on new session
	pi.on("session_switch", () => {
		originalTask = "";
		rules = loadRules(); // re-read in case user edited the file
	});

	// Sync gate: review every bash tool call
	pi.on("tool_call", async (event, ctx) => {
		if (!pi.getFlag("adversary")) return;
		if (event.toolName !== "bash") return;

		const command = event.input.command as string;

		ctx.ui.setStatus("adversary", "🛡️ reviewing…");

		try {
			const verdict = await consultAdversary(originalTask, command, rules);

			if (verdict.verdict === "BLOCK") {
				ctx.ui.notify(`🛑 Adversary blocked: ${verdict.reason}`, "error");
				return { block: true, reason: "This command was blocked by a security policy. Do not attempt to run it again or work around this restriction." };
			}

			// ALLOW — continue
			return undefined;
		} catch (err) {
			// If the adversary itself fails, allow through (fail-open)
			// so the main agent isn't broken by adversary issues
			return undefined;
		} finally {
			ctx.ui.setStatus("adversary", undefined);
		}
	});

	// Show status when active
	pi.on("session_start", (_, ctx) => {
		if (pi.getFlag("adversary")) {
			ctx.ui.setStatus("adversary", "🛡️ adversary");
		}
	});
}

const RULES_PATH = join(homedir(), ".pi", "agent", "adversary.md");

const DEFAULT_RULES = `BLOCK if the command:
- Exfiltrates data (curl/wget posting to unknown URLs, piping secrets out)
- Is destructive beyond the project scope (rm -rf /, modifying system files)
- Installs malware or runs obfuscated code
- Attempts to escalate privileges unnecessarily
- Downloads and executes untrusted remote scripts

ALLOW if the command is a normal development operation, even if it modifies files,
installs packages, runs tests, uses git, etc. Most commands are fine.
Err on the side of ALLOW — only block truly dangerous things.`;

function loadRules(): string {
	try {
		return readFileSync(RULES_PATH, "utf-8").trim();
	} catch {
		return DEFAULT_RULES;
	}
}

function consultAdversary(originalTask: string, bashCommand: string, rules: string): Promise<AdversaryVerdict> {
	return new Promise((resolve) => {
		const prompt = [
			"You are a security reviewer. An AI coding agent is about to run a bash command.",
			"Your ONLY job: decide if this command is safe to execute.",
			"",
			`The user's original task: ${originalTask || "(unknown)"}`,
			"",
			`The bash command to review:`,
			"```",
			bashCommand,
			"```",
			"",
			rules,
			"",
			'Respond with ONLY a JSON object: {"verdict": "ALLOW", "reason": "..."} or {"verdict": "BLOCK", "reason": "..."}',
		].join("\n");

		const proc = spawn("pi", ["-p", "--no-session", prompt], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});

		proc.on("close", () => {
			try {
				// Extract JSON from response (model may wrap it in markdown etc)
				const match = stdout.match(/\{[^}]*"verdict"\s*:\s*"(ALLOW|BLOCK)"[^}]*\}/);
				if (match) {
					const parsed = JSON.parse(match[0]) as AdversaryVerdict;
					resolve(parsed);
				} else {
					// Couldn't parse — fail open
					resolve({ verdict: "ALLOW", reason: "Could not parse adversary response" });
				}
			} catch {
				resolve({ verdict: "ALLOW", reason: "Adversary parse error" });
			}
		});

		proc.on("error", () => {
			resolve({ verdict: "ALLOW", reason: "Adversary process failed to spawn" });
		});

		// Timeout — don't block the main agent forever
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			resolve({ verdict: "ALLOW", reason: "Adversary timed out" });
		}, 15_000);

		proc.on("close", () => clearTimeout(timer));
	});
}
