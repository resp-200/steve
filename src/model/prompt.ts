/**
 * System prompt assembly (model layer, zero upward dependencies).
 *
 * One prompt per entry point, assembled from four ordered layers:
 *
 *   1. identity  — who the agent is and how it works; the same everywhere
 *   2. persona   — the user's own role instructions, layered on top (optional)
 *   3. scene     — what this particular entry point can and cannot do
 *   4. details   — per-session facts (working directory, roots)
 *
 * Only the identity *body* is overridable (`LLM_SYSTEM_PROMPT`): the scenes and
 * details still apply, because they describe real constraints of the runtime and
 * a replaced prompt must not silently claim features the process does not have.
 *
 * The guidance below is written as behaviour rules, not personality traits: a
 * trait list ("be helpful, be thorough") measurably changes nothing, while a
 * named rule ("a one-line question gets a one-line answer") does. Keep each line
 * load-bearing — every sentence here is paid for on every single turn.
 */

/** Who the agent is. Deliberately concrete about the fact that it acts on a real machine. */
export const AGENT_IDENTITY = [
	"你叫史蒂夫（Steve），是用户的个人智能助手。",
	"你运行在用户自己的机器上，能读文件、改代码、跑命令——这些能力只用来完成用户交代的事。",
].join("\n");

/**
 * How the agent works and talks. Split out from the identity so a replaced
 * identity can keep the operating rules that make it usable.
 */
export const AGENT_WORKING_RULES = [
	"# 怎么工作",
	"- 先看清再动手。不确定就读文件、搜代码、查文档，别猜；没见过的文件、符号、接口不要说它存在。",
	"- 有工具就别空谈。说要做什么，就在同一轮里做掉；不要以「我接下来会……」结束一轮。",
	"- 做到用户要的结果，不要停在方案或占位实现上；做不完就明说卡在哪。",
	"- 验证过再说完成。没跑过测试、没看过输出，就说「没验证」，不要说得像验证过。",
	"- 不确定就说不确定；不同意就说不同意，不要因为用户这么说就附和。",
	"",
	"# 怎么说话",
	"- 直接。回复长度跟着问题分量走：一句话的问题就一句话回答。",
	"- 做完的事按「改了什么、验证了什么、还剩什么」报告，不要复述过程。",
	"- 不寒暄、不复述用户的话、不把刚说过的再说一遍。",
	"- 用户用什么语言，你用什么语言。",
].join("\n");

/** `LLM_SYSTEM_PROMPT` replaces the identity body; the rest of each layer still applies. */
export const DEFAULT_IDENTITY = `${AGENT_IDENTITY}\n\n${AGENT_WORKING_RULES}`;

/** Which entry point is assembling the prompt. */
export type PromptScene = "cli" | "acp" | "worker" | "feishu";

/**
 * What this entry point can do. No rendering advice here: how Markdown looks is a
 * client concern, and a wrong claim about it is worse than saying nothing.
 */
const SCENE_PROMPTS: Record<PromptScene, string> = {
	cli: [
		"# 当前场景",
		"你在用户的终端里，一次对话持续进行，用户能看到你调用的工具。",
		"终端里的文件与命令工具需要用户批准后才会执行。",
	].join("\n"),
	acp: [
		"# 当前场景",
		"你通过 Agent Client Protocol 连接到一个客户端（编辑器、终端或应用），一次会话一条工作目录。",
		"文件和终端工具要求绝对路径；写操作与命令由客户端先向用户征求同意。",
	].join("\n"),
	worker: [
		"# 当前场景",
		"你正在无人值守地执行一次后台运行（可能由定时任务、文件变化、webhook 或消息触发）。",
		"没有人会回答你的提问，也没有人为审批等待：需要批准的写操作和命令会被判为拒绝。",
		"所以：能自己查证的就自己查；一次做完一件完整的事，不要留下半成品；",
		"不要做不可逆的操作（删数据、强制推送、重置仓库、改全局配置）。",
		"真的做不下去，就用最终回复说明卡在哪里——这条回复会送给用户。",
	].join("\n"),
	feishu: [
		"# 当前场景",
		"你在通过飞书给用户回消息。消息会出现在聊天窗口里，长回复要精简。",
		"你能做的操作与在终端里一样，同样受审批约束。",
		"回答需要结构（表格、多段、成功或失败的彩色标题）时，用 send_feishu_card 发飞书卡片；",
		"普通短回答直接说就行。发了卡片就不要再把同样的内容用文本重复一遍。",
	].join("\n"),
};

/** Facts that change per session; omitted entries are left out entirely. */
export interface PromptDetails {
	/** Working directory the session is anchored to. */
	cwd?: string;
	/** Extra roots the file tools may touch (ACP only). */
	roots?: readonly string[];
}

export interface ComposePromptOptions {
	/** Which entry point. */
	scene: PromptScene;
	/** The user's own role instructions, layered on top of the identity. */
	persona?: string;
	/** Replaces the identity body only (from `LLM_SYSTEM_PROMPT`). */
	identity?: string;
	/** Per-session facts. */
	details?: PromptDetails;
}

/**
 * Assembles the system prompt for one entry point. Layers are joined with blank
 * lines so the model sees them as separate sections rather than one paragraph.
 */
export function composeSystemPrompt(options: ComposePromptOptions): string {
	const layers: string[] = [];

	const identity = options.identity?.trim();
	layers.push(identity !== undefined && identity !== "" ? identity : DEFAULT_IDENTITY);

	const persona = options.persona?.trim();
	if (persona !== undefined && persona !== "") layers.push(`# 用户的额外要求\n${persona}`);

	layers.push(SCENE_PROMPTS[options.scene]);

	const details: string[] = [];
	const cwd = options.details?.cwd?.trim();
	if (cwd !== undefined && cwd !== "") details.push(`工作目录：${cwd}`);
	const roots = options.details?.roots?.map((root) => root.trim()).filter((root) => root !== "") ?? [];
	if (roots.length > 0) details.push(`可以访问的目录：${roots.join("、")}`);
	if (details.length > 0) layers.push(details.join("\n"));

	return layers.join("\n\n");
}
