import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 同目录临时文件 + rename，避免读到半写内容。失败由调用方决定是否降级。 */
export function atomicWrite(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		fs.writeFileSync(temp, content, "utf8");
		fs.renameSync(temp, file);
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {
			/* 临时文件可能尚未创建或已完成 rename */
		}
		throw error;
	}
}

export function atomicWriteJson(file: string, value: unknown): void {
	atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
