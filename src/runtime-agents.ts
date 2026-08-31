/**
 * Runtime fallback registration of the pi-missions role agents.
 *
 * Primary path: the package manifest `pi-subagents.agents` exposes ./agents/*.md
 * to pi-subagents discovery (works for installed packages). When the extension
 * was loaded ad-hoc (`pi -e ...`) pi-subagents never sees those files, so we
 * register the same agents over the process-local runtime-agent channel.
 *
 * Collision semantics work in our favor: if the file-based package agent is
 * already discoverable, registration fails and the richer file definition wins.
 * Runtime registration supports only description/systemPrompt/tools, so it is a
 * fallback, not the preferred path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

interface AgentDef {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
}

/** Parse the subset of agent frontmatter this package ships (name/description/tools). */
export function parseAgentFile(raw: string): AgentDef | undefined {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return undefined;
	const [, frontmatter, body] = match;
	const get = (key: string): string | undefined => {
		const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m?.[1]?.trim();
	};
	const name = get("name");
	const description = get("description");
	const toolsRaw = get("tools");
	if (!name || !description) return undefined;
	return {
		name,
		description,
		tools: toolsRaw ? toolsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [],
		systemPrompt: body.trim(),
	};
}

function agentsDir(): string | undefined {
	try {
		// extensions/index.ts → <pkg>/extensions/ → ../agents
		const here = fileURLToPath(import.meta.url);
		return path.join(path.dirname(here), "..", "agents");
	} catch {
		// fall through to CJS-style resolution
	}
	try {
		return path.join(__dirname, "..", "agents");
	} catch {
		return undefined;
	}
}

/**
 * Register bundled role agents with pi-subagents at runtime. Safe to call on
 * every session start; existing agents (file-based or previously registered)
 * cause an ignored collision error.
 */
export function ensureRuntimeAgents(pi: ExtensionAPI): void {
	const dir = agentsDir();
	if (!dir) return;
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return;
	}
	for (const file of files) {
		let def: AgentDef | undefined;
		try {
			def = parseAgentFile(fs.readFileSync(path.join(dir, file), "utf8"));
		} catch {
			continue;
		}
		if (!def) continue;
		const request: {
			version: 1;
			name: string;
			definition: { description: string; systemPrompt: string; tools: readonly string[] };
			result?: { ok: true } | { ok: false; error: Error };
		} = {
			version: 1,
			name: def.name,
			definition: { description: def.description, systemPrompt: def.systemPrompt, tools: def.tools },
		};
		try {
			pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
			// request.result?.ok === false → collision (file agent wins) or pi-subagents
			// rejected it; either way the file-based/installed path is authoritative.
		} catch {
			// pi-subagents not installed — /mission-start reports that separately.
		}
	}
}
