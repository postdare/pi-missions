/**
 * pi-missions · store/log
 *
 * LOG.md —— 排障时唯一要读的文件。一条一行,不写散文。
 * 机器产出的 LOG effect 不带时间戳,这里统一补 ISO 前缀。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function appendLog(file: string, line: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
	fs.appendFileSync(file, `${ts} ${line}\n`, "utf8");
}

export function readLog(file: string, taskFilter?: string): string {
	try {
		const content = fs.readFileSync(file, "utf8");
		if (!taskFilter) return content;
		return content
			.split("\n")
			.filter((l) => !l.trim() || l.includes(taskFilter))
			.join("\n");
	} catch {
		return "(暂无日志)";
	}
}
