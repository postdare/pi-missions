/**
 * pi 清单的回归防线。
 *
 * 事故:package.json 里只声明了 `pi.extensions`,skills/ 下的 SKILL.md 一直没被加载。
 * 病根在 pi 的资源发现规则 —— **一旦存在 `pi` 清单,约定目录的自动发现就整个跳过**
 * (core/package-manager.js · collectPackageResources 命中 manifest 分支后直接 return)。
 * 也就是说:声明了一项,就等于关掉了其余所有项的自动发现,而这件事不报错、不告警,
 * 表现只是"模型从来没见过这个 skill"。
 *
 * 所以规则是:**根目录下存在的每个约定目录,都必须在 pi 清单里显式列出。**
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

/** pi 的 RESOURCE_TYPES,顺序无关 */
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

test("存在的约定目录必须在 pi 清单里显式列出 —— 漏一个就等于该资源静默失踪", () => {
	assert.ok(pkg.pi, "package.json 必须有 pi 清单");
	for (const type of RESOURCE_TYPES) {
		if (!existsSync(join(root, type))) continue;
		assert.ok(
			Array.isArray(pkg.pi[type]) && pkg.pi[type].length > 0,
			`${type}/ 目录存在,但 pi 清单里没有 "${type}" —— 清单一旦存在就会关掉约定目录的自动发现,这个目录会被静默忽略`,
		);
	}
});

test("清单里列出的路径都存在", () => {
	for (const type of RESOURCE_TYPES) {
		for (const entry of pkg.pi[type] ?? []) {
			if (entry.startsWith("!")) continue; // 排除模式,不指向文件
			assert.ok(existsSync(join(root, entry)), `pi.${type} 里的 ${entry} 不存在`);
		}
	}
});

test("skill 能被 pi 的加载器识别:有 SKILL.md,name/description 合法", async () => {
	let loadSkillsFromDir: any;
	try {
		({ loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent"));
	} catch {
		return; // peer 依赖没装,跳过(和其他 UI 测试同样的处理)
	}
	const r = loadSkillsFromDir({ dir: join(root, "skills"), source: "path" });
	assert.deepEqual(r.diagnostics, [], "SKILL.md 的 frontmatter 有问题");
	assert.deepEqual(
		r.skills.map((s: any) => s.name).sort(),
		["pi-missions"],
	);
	assert.ok(
		!r.skills[0].disableModelInvocation,
		"skill 必须对模型可见 —— 它的全部作用就是让模型自己判断该不该开 mission",
	);
});
