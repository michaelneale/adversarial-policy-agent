/**
 * Adversary Extension
 *
 * A synchronous gate that reviews bash tool calls before execution.
 * Calls the LLM directly via pi-ai to evaluate whether the command
 * is safe, then blocks or allows based on the verdict.
 *
 * Enable with: pi --adversary
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

		// Pull last 4 user messages from session for context
		const recentUserMessages = getRecentUserMessages(ctx, 4);

		try {
			const verdict = await consultAdversary(ctx, originalTask, command, rules, recentUserMessages);

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

function getRecentUserMessages(ctx: ExtensionContext, count: number): string[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: string[] = [];

	for (let i = branch.length - 1; i >= 0 && messages.length < count; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const content = entry.message.content;
		if (typeof content === "string") {
			messages.unshift(content);
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			if (text) messages.unshift(text);
		}
	}

	return messages;
}

async function consultAdversary(ctx: ExtensionContext, originalTask: string, bashCommand: string, rules: string, recentUserMessages: string[]): Promise<AdversaryVerdict> {
	const model = ctx.model;
	if (!model) return { verdict: "ALLOW", reason: "No model available" };

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return { verdict: "ALLOW", reason: "No API key available" };

	const historySection = recentUserMessages.length > 0
		? [
			"Recent user messages (oldest first):",
			...recentUserMessages.map((m, i) => `${i + 1}. ${m.length > 200 ? m.slice(0, 200) + "..." : m}`),
			"",
		]
		: [];

	const userMessage = [
		`The user's original task: ${originalTask || "(unknown)"}`,
		"",
		...historySection,
		"The bash command to review:",
		"```",
		bashCommand,
		"```",
		"",
		rules,
		"",
		"Respond with a single word on the first line: ALLOW or BLOCK",
		"Then on the next line, a brief reason.",
	].join("\n");

	try {
		const response = await completeSimple(model, {
			systemPrompt: "You are a security reviewer. An AI coding agent is about to run a bash command. Your ONLY job: decide if this command is safe to execute. Respond with ALLOW or BLOCK on the first line, then a brief reason.",
			messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
		}, { apiKey });

		const output = response.content
			.filter((c) => c.type === "text")
			.map((c) => (c as any).text)
			.join("\n")
			.trim();

		const upper = output.toUpperCase();

		if (upper.startsWith("BLOCK") || upper.includes("\nBLOCK")) {
			const reason = output.replace(/^BLOCK\b[:\s-]*/i, "").trim() || "Blocked by adversary";
			return { verdict: "BLOCK", reason };
		}

		return { verdict: "ALLOW", reason: output.slice(0, 100) };
	} catch (err) {
		return { verdict: "ALLOW", reason: `Adversary error: ${err instanceof Error ? err.message : String(err)}` };
	}
}
