/**
 * Runtime fallback registration of the pi-missions role agents.
 *
 * Primary path: the package manifest `pi-subagents.agents` exposes ./agents/*.md
 * to pi-subagents discovery — but only for *installed* packages. When the
 * extension is loaded ad-hoc (`pi -e ...`), pi-subagents never sees those files
 * and every spawn fails with "Unknown agent: mission-*" inside the workflow.
 *
 * So: at session start we register the agents over the process-local runtime
 * channel ONLY when this package is not installed (isInstalledPackage false).
 * Registering when installed would create runtime/configured name collisions
 * that pi-subagents surfaces as launch failures.
 */
import * as fs from "node:fs";
import * as os from "node:os";
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

export function packageRoot(): string | undefined {
	try {
		// src/runtime-agents.ts → <pkg>/src → <pkg>
		const here = fileURLToPath(import.meta.url);
		return path.resolve(path.dirname(here), "..");
	} catch {
		// fall through
	}
	try {
		return path.resolve(__dirname, "..");
	} catch {
		return undefined;
	}
}

interface SettingsFile {
	packages?: Array<string | { source?: string }>;
}

function readPackages(settingsPath: string): Array<string | { source?: string }> {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as SettingsFile;
		return Array.isArray(parsed.packages) ? parsed.packages : [];
	} catch {
		return [];
	}
}

/**
 * True when this package is installed via pi's package manager (npm:, git:, or
 * a local path entry in user/project settings) — meaning pi-subagents discovers
 * our file-based agents and runtime registration must NOT run.
 */
export function isInstalledPackage(cwd: string): boolean {
	const root = packageRoot();
	if (!root) return false;

	// npm/git installs are materialized under pi's managed install directories.
	if (/[\\/]\.pi[\\/]agent[\\/](npm|git)[\\/]/.test(root)) return true;
	if (/[\\/]\.pi[\\/](npm|git)[\\/]/.test(root)) return true;

	// Local-path installs are referenced from settings without copying.
	const userSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
	const projectSettings = path.join(cwd, ".pi", "settings.json");
	for (const [settingsPath, entries] of [
		[userSettings, readPackages(userSettings)],
		[path.join(cwd, ".pi", "settings.json"), readPackages(projectSettings)],
	] as const) {
		for (const entry of entries) {
			const source = typeof entry === "string" ? entry : entry.source;
			if (!source || source.startsWith("npm:") || source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) continue;
			const resolved = path.resolve(path.dirname(settingsPath), source);
			if (resolved === root) return true;
		}
	}
	return false;
}

/**
 * Register bundled role agents with pi-subagents at runtime. No-op when the
 * package is properly installed (file-based agents win and collisions poison
 * agent resolution). Safe to call repeatedly otherwise.
 */
export function ensureRuntimeAgents(pi: ExtensionAPI, cwd: string): void {
	if (isInstalledPackage(cwd)) return;
	const root = packageRoot();
	if (!root) return;
	const dir = path.join(root, "agents");
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
		} catch {
			// pi-subagents not installed — /mission-start reports that separately.
		}
	}
}
