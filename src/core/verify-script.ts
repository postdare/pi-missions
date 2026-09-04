/**
 * pi-missions · core/verify-script
 *
 * 冻结前的 verify.sh 静态检查:拦下会把**工作目录**切离仓库根的写法。
 *
 * 系统调 verify.sh 时 cwd 就是仓库根(runtime 的 exec 传 `{ cwd: this.cwd }`),
 * 所以正确的脚本什么都不用做。三个真实 mission 连续栽在这里,三次都是脚本
 * 自己把对的 cwd 切走了 —— 症状是「好几条 AC 同时红,且原因与代码内容无关」,
 * 而 verify.sh 是冻结件、ACT 改不了,只能升 L2 回 PLAN 重写重冻。
 *
 * 往 `templates/phases/plan.md` 写警告的路子试过了,第三次照踩。所以这一刀
 * 落在 L0:提交时就拦,不必等整轮基线(每条 AC 各跑一遍测试)才暴露,
 * 而且报的是病因(第 N 行把 cwd 切到哪了)而不是症状(AC5 声明 green 却是红的)。
 *
 * ## 宁可漏判,不可误判
 *
 * 这是对 shell 文本的启发式判断。漏判只是回到今天的状态(基线仍会抓到);
 * 误判是把一个本来正确的计划挡在门外,而 planner 没有任何办法说服 L0。
 * 所以只拦**能证明**离开仓库根的两族写法,拿不准的一律放行:
 *
 *   R1  cd 到 $0 / ${BASH_SOURCE} 推导出的目录 —— $0 就是冻结件路径
 *       missions/state/<id>/generations/<n>/verify.sh,那个目录里没有源码。
 *   R2  cd 到 mktemp -d 出来的目录之后再消费项目源码 —— 新建的空目录里
 *       没有 go.mod / package.json,也没有 ./cmd/x。
 *
 * 每条规则都配了「长得像但其实合法」的反例(见 __tests__),加规则前先写反例:
 * 想不出反例,说明还没想清楚它拦的是什么。
 */

/** 一处会切走工作目录的写法 */
export interface VerifyScriptIssue {
	/** 1 起算的行号 */
	line: number;
	/** 该行原文(去掉首尾空白;过长时截断) */
	text: string;
	/** 为什么这么写会坏 */
	reason: string;
	/** 该写成什么。**这条不能省** —— 正确答案是"什么都不写",反直觉,不明说会去发明另一种 cd */
	fix: string;
}

/** 报错里贴多少原文。够认出是哪一行,又不至于把打回信息灌成一堵墙 */
const LINE_EXCERPT = 120;

/**
 * 消费"当前目录下的项目源码"的构建/测试子命令。
 *
 * 只列**读现有工程**的子命令:`cargo init`、`npm init` 在空临时目录里跑是完全
 * 正当的(就是要在那儿建新工程),把它们算进来就是误判。
 */
const SOURCE_CONSUMING: Record<string, string[]> = {
	go: ["build", "test", "vet", "run", "install", "generate", "list"],
	npm: ["test", "run", "ci", "start", "build"],
	pnpm: ["test", "run", "start", "build"],
	yarn: ["test", "run", "start", "build"],
	cargo: ["build", "test", "check", "run", "clippy"],
};

/** 这些参数意味着工具自己会去别处找工程,cwd 就不重要了 —— 见到就放行 */
const ESCAPES = ["-C", "--directory", "-f", "--file", "--manifest-path", "--prefix", "--cwd", "-c"];

/**
 * 检查一份 verify.sh。返回空数组 = 没发现能证明的问题(不等于脚本一定对)。
 */
export function inspectVerifyScript(script: string): VerifyScriptIssue[] {
	const issues: VerifyScriptIssue[] = [];
	const rawLines = script.split("\n");

	// 变量来源追踪。只跟一跳:`DIR="$(dirname "$0")"` 之后的 `cd "$DIR"` 要认出来,
	// 但不做数据流分析 —— 再往下就不是"能证明"了。
	const fromScriptDir = new Set<string>();
	const fromTemp = new Set<string>();
	/** 顶层(不在子 shell 里)是否已经切进临时目录,以及在哪一行切的 */
	let strandedAt: { line: number; text: string } | null = null;

	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i];
		const code = stripComment(raw);
		if (!code.trim()) continue;
		const lineNo = i + 1;

		recordAssignments(code, fromScriptDir, fromTemp);

		for (const seg of splitCommands(code)) {
			const target = cdTarget(seg);
			if (target === null) continue;

			// ── R1:cd 到脚本自己所在的目录 ──
			if (mentionsScriptPath(target) || referencesVar(target, fromScriptDir)) {
				issues.push({
					line: lineNo,
					text: excerpt(raw),
					reason:
						"这行把工作目录切到了**脚本自己所在的目录**。verify.sh 是冻结件," +
						"它躺在 missions/state/<id>/generations/<n>/ 下面,那个目录里没有 go.mod、" +
						"没有 package.json,也没有你的源码 —— 切过去之后每条相对路径都会落空," +
						"表现为好几条 AC 同时红、而失败原因跟代码内容毫无关系。",
					fix: FIX_DO_NOTHING,
				});
				continue;
			}

			// ── R2:cd 到临时目录 ──
			if (referencesVar(target, fromTemp) || isInlineMktemp(target)) {
				const builder = sourceConsumingCommand(seg);
				if (builder) {
					issues.push({
						line: lineNo,
						text: excerpt(raw),
						reason:
							`这行先切进 mktemp 建出来的空目录,又在那里跑 \`${builder}\` —— ` +
							"临时目录里没有工程文件,相对路径的包/脚本一个都找不到。" +
							"临时目录是用来放**产物**的(二进制、隔离的 HOME),不是用来当**工作目录**的。",
						fix: FIX_ARTIFACT_ONLY,
					});
					continue;
				}
				if (isTopLevel(seg, code) && !strandedAt) {
					strandedAt = { line: lineNo, text: raw };
				}
				continue;
			}

			// cd 回仓库根(cd "$REPO" / cd - / cd "$OLDPWD")就算把上面那次切换收回来了
			if (looksLikeReturn(target)) strandedAt = null;
		}
	}

	if (strandedAt) {
		issues.push({
			line: strandedAt.line,
			text: excerpt(strandedAt.text),
			reason:
				"这行在脚本顶层切进了 mktemp 建出来的空目录,而且后面没有再切回来 —— " +
				"此后**整份脚本**的相对路径都落在那个空目录里。",
			fix: FIX_ARTIFACT_ONLY,
		});
	}

	return issues;
}

const FIX_DO_NOTHING =
	"把这行删掉。系统调 verify.sh 时工作目录**已经**是仓库根,脚本什么都不用做 —— " +
	"这一点反直觉,所以再说一遍:正确的写法是不写 cd,不是换一种 cd。" +
	"真要显式定位仓库根,用 `REPO=\"$(git rev-parse --show-toplevel)\"` 再 `cd \"$REPO\"`," +
	"而且每个子 shell 里也要用它。";

const FIX_ARTIFACT_ONLY =
	"别在临时目录里跑构建,让产物落进去就行:`go build -o \"$TMP/server\" ./cmd/server` —— " +
	"命令在仓库根跑,`-o` 把二进制写到 TMP。要显式定位就用 " +
	"`REPO=\"$(git rev-parse --show-toplevel)\"`,并且在每个子 shell 里都用它:" +
	"`( cd \"$REPO\" && go build -o \"$TMP/server\" ./cmd/server )`。";

/** 去掉行内注释。带引号的 # 不算注释 */
function stripComment(line: string): string {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
	}
	return line;
}

/**
 * 把一行拆成若干条命令。只按 `;` `&&` `||` `|` 和子 shell 括号切 ——
 * 目的是把 `( cd "$TMP" && go build ./cmd/x )` 里的 cd 和 go build 放进同一段
 * 上下文判断,而不是当成两件无关的事。
 */
function splitCommands(code: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let depth = 0;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (c === "\\") {
			cur += c + (code[i + 1] ?? "");
			i++;
			continue;
		}
		if (quote) {
			cur += c;
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			cur += c;
			continue;
		}
		// $( ... ) 是命令替换,不在这里切开:cd "$(dirname "$0")" 必须整体看
		if (c === "$" && code[i + 1] === "(") {
			depth++;
			cur += "$(";
			i++;
			continue;
		}
		if (c === "(") {
			depth++;
			cur += c;
			continue;
		}
		if (c === ")") {
			depth = Math.max(0, depth - 1);
			cur += c;
			continue;
		}
		if (depth === 0 && (c === ";" || c === "|" || c === "&")) {
			// && 与 || 吃掉第二个字符
			if (code[i + 1] === c) i++;
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	parts.push(cur);
	return parts.filter((p) => p.trim());
}

/** `VAR=$(...)` 形式的赋值:记下它是从脚本目录还是临时目录来的 */
function recordAssignments(code: string, scriptDir: Set<string>, temp: Set<string>): void {
	const re = /(?:^|\s|;|\(|&&|\|\|)\s*([A-Za-z_][A-Za-z0-9_]*)=(.+?)(?=$|;|&&|\|\|)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) {
		const [, name, value] = m;
		if (mentionsScriptPath(value)) scriptDir.add(name);
		if (/\bmktemp\b/.test(value)) temp.add(name);
	}
}

/** 这段文本是不是在推导"脚本自己在哪" */
function mentionsScriptPath(text: string): boolean {
	return /\$\{?0\}?/.test(text) || /BASH_SOURCE/.test(text);
}

/** 内联的 `cd "$(mktemp -d)"` —— 不经变量,一步到位 */
function isInlineMktemp(target: string): boolean {
	return /\bmktemp\b/.test(target);
}

/** target 里是否引用了 set 里的某个变量 */
function referencesVar(target: string, names: Set<string>): boolean {
	for (const n of names) {
		if (new RegExp(`\\$\\{?${n}\\}?`).test(target)) return true;
	}
	return false;
}

/** 看起来是切回来:`cd -`、`cd "$OLDPWD"`、`cd "$REPO"`、`cd "$(git rev-parse --show-toplevel)"` */
function looksLikeReturn(target: string): boolean {
	const t = target.trim().replace(/^["']|["']$/g, "");
	if (t === "-" || /OLDPWD/.test(t)) return true;
	return /git\s+rev-parse|REPO|ROOT|PROJECT/i.test(t);
}

/**
 * 这一段是不是一条 `cd`;是就返回它的参数,不是返回 null。
 *
 * `cd` 后面没有参数(回 $HOME)也算 —— 那同样是离开仓库根,但**不拦**:
 * 见得太少,而且可能是 heredoc 之类的误匹配,按"宁可漏判"放行。
 */
function cdTarget(seg: string): string | null {
	// 只取 cd 后面的**第一个参数**。原来这里用的是"一直吃到行尾",于是
	// `( cd "$TMP" && tar xzf x.tgz )` 里整条复合命令都成了 cd 的目标,
	// 顺带把 tar 那半句也算进"切进临时目录"——一个不该有的误判。
	const m = /(?:^|\s|\()\s*cd\s+(?!-)/.exec(seg);
	if (!m) return null;
	const arg = firstToken(seg.slice(m.index + m[0].length));
	return arg || null;
}

/** 取一个 shell 词:认引号与 $( ) 嵌套,遇到未加引号的空白/分隔符就停 */
function firstToken(text: string): string {
	let out = "";
	let quote: string | null = null;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			out += c + (text[i + 1] ?? "");
			i++;
			continue;
		}
		if (quote) {
			out += c;
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			out += c;
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			depth++;
			out += "$(";
			i++;
			continue;
		}
		if (c === "(") {
			depth++;
			out += c;
			continue;
		}
		if (c === ")") {
			if (depth === 0) break;
			depth--;
			out += c;
			continue;
		}
		if (depth === 0 && /[\s;&|]/.test(c)) break;
		out += c;
	}
	return out.trim();
}

/** 这一段里有没有"消费当前目录源码"的构建命令;有就返回它的可读形态 */
function sourceConsumingCommand(seg: string): string | null {
	for (const [tool, subs] of Object.entries(SOURCE_CONSUMING)) {
		const re = new RegExp(`(?:^|\\s|\\()${tool}\\s+([a-z-]+)`, "g");
		let m: RegExpExecArray | null;
		while ((m = re.exec(seg)) !== null) {
			const sub = m[1];
			if (!subs.includes(sub)) continue;
			if (ESCAPES.some((f) => new RegExp(`\\s${escapeRe(f)}(\\s|=)`).test(seg))) continue;
			// go 这类要求参数是相对包路径才算数:`go build -o "$TMP/x" ./cmd/x`
			// 在仓库根跑是对的,在临时目录里跑才是错的 —— 而我们已经知道 cwd 是临时目录了。
			return `${tool} ${sub}`;
		}
	}
	return null;
}

/** 这条 cd 是不是在脚本顶层(不在子 shell 括号里) */
function isTopLevel(seg: string, line: string): boolean {
	// 段自己就是个子 shell(`( cd "$TMP" && ... )`)时,那次 cd 出了括号就失效,
	// 影响不到脚本余下的部分 —— 不算"顶层滞留"。
	const cdAt = seg.search(/(?:^|\s|\()\s*cd\s/);
	if (cdAt >= 0 && seg.slice(0, cdAt + 1).includes("(")) return false;
	const idx = line.indexOf(seg.trim());
	if (idx < 0) return !line.includes("(");
	return !line.slice(0, idx).includes("(");
}

function excerpt(line: string): string {
	const t = line.trim();
	return t.length <= LINE_EXCERPT ? t : `${t.slice(0, LINE_EXCERPT)}…`;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把问题列表渲染成 validatePlan 用的错误行 */
export function formatVerifyScriptIssues(issues: VerifyScriptIssue[]): string[] {
	return issues.map(
		(i) => `verify.sh 第 ${i.line} 行 \`${i.text}\` 会把工作目录切离仓库根。${i.reason}\n  → ${i.fix}`,
	);
}
