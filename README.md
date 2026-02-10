# Adversarial Agent

A [pi](https://github.com/mariozechner/pi) extension that acts as a synchronous security gate. Every bash command the primary agent wants to run is reviewed by a separate LLM before execution. If the command looks dangerous, it's blocked.

## How it works

```
Primary agent wants to run `bash` tool call
        │
        ▼
Extension intercepts via `tool_call` event
        │
        ▼
Spawns `pi -p --no-session` subprocess
with the command + your rules
        │
        ▼
Adversary LLM returns ALLOW or BLOCK
        │
        ├─ ALLOW → command executes normally
        └─ BLOCK → command is rejected, agent sees generic error
```

The adversary runs in a completely separate context — its own process, its own LLM call, no shared state with the primary agent. The primary agent cannot influence or bypass the review.

## Quick start

```bash
# 1. Create the extensions directory (if it doesn't exist)
mkdir -p ~/.pi/agent/extensions

# 2. Copy the extension and rules
cp adversary.ts ~/.pi/agent/extensions/adversary.ts
cp adversary.md ~/.pi/agent/adversary.md

# 3. Run pi with the adversary enabled
pi --adversary
```

That's it. Every bash command the agent tries to run will now be reviewed first.

Without `--adversary`, the extension is completely inert — no overhead, no subprocess spawns.

## What the adversary sees

The adversary LLM gets exactly three things:

1. **The user's original task** — the first prompt from the session
2. **The bash command** being reviewed
3. **The rules** from `~/.pi/agent/adversary.md`

It does **not** get:
- The conversation history
- Previous tool calls or results
- What files have been read/written
- The primary agent's reasoning
- The system prompt

This is intentional — the adversary evaluates each command in isolation against the rules, with only the original task for context.

## What the agent sees when blocked

The agent gets an opaque error:

```
This command was blocked by a security policy. Do not attempt to run it again or work around this restriction.
```

It is deliberately told nothing about *why*. The user sees the real reason via a `🛑` notification in the UI.

## Rules

The adversary's judgment is driven by `~/.pi/agent/adversary.md`. Edit it to match your needs.

Default rules:

```
BLOCK if the command:
- Exfiltrates data (curl/wget posting to unknown URLs, piping secrets out)
- Is destructive beyond the project scope (rm -rf /, modifying system files)
- Installs malware or runs obfuscated code
- Attempts to escalate privileges unnecessarily
- Downloads and executes untrusted remote scripts

ALLOW if the command is a normal development operation, even if it modifies files,
installs packages, runs tests, uses git, etc. Most commands are fine.
Err on the side of ALLOW — only block truly dangerous things.
```

Rules are re-read on every session switch, so you can edit them while pi is running.

## What it gates

Only **bash** tool calls. Reads, writes, edits, grep, find, and ls pass through unreviewed.

## Fail-open design

If the adversary subprocess crashes, times out (15s), or returns something unparseable, the command is **allowed through**. The adversary should never break the primary agent's workflow.

## Files

| File | Purpose |
|------|---------|
| `adversary.ts` | Pi extension — the tool_call gate, subprocess spawning, rules loading |
| `adversary.md` | Default rules — copy to `~/.pi/agent/adversary.md` |
