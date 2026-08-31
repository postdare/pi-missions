/**
 * pi-missions · store/state
 *
 * STATE.json 读写。所有写操作经过 per-file promise 队列串行化,
 * 防止 tool_result / tick / 命令并发写坏文件。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MissionState } from "../core/types.ts";

const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const prev = queues.get(file) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	queues.set(
		file,
		next.catch(() => {}),
	);
	return next;
}

export async function saveStateFile(file: string, state: MissionState): Promise<void> {
	return enqueue(file, async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, file);
	});
}

export function loadStateFile(file: string): MissionState | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as MissionState;
	} catch {
		return null;
	}
}

export function writeCurrentPointer(file: string, missionId: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, missionId, "utf8");
}

export function readCurrentPointer(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8").trim() || null;
	} catch {
		return null;
	}
}
