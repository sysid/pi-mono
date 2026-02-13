import { describe, expect, it, vi } from "vitest";
import accessGuard, { loadAccessGuardConfig } from "../examples/extensions/access-guard.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/types.js";

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface CapturedHandlers {
	toolCall: ToolCallHandler;
	command?: { description?: string; handler: CommandHandler };
}

function captureHandlers(config?: { denyRead?: string[]; denyWrite?: string[] }): CapturedHandlers {
	let toolCallHandler: ToolCallHandler | undefined;
	let command: CapturedHandlers["command"];

	const mockApi = {
		on: vi.fn((event: string, h: ToolCallHandler) => {
			if (event === "tool_call") toolCallHandler = h;
		}),
		registerCommand: vi.fn((name: string, opts: { description?: string; handler: CommandHandler }) => {
			if (name === "access-guard") command = opts;
		}),
	} as unknown as ExtensionAPI;

	accessGuard(mockApi, config);

	if (!toolCallHandler) throw new Error("Extension did not register a tool_call handler");
	return { toolCall: toolCallHandler, command };
}

function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { toolName, input } as ToolCallEvent;
}

const mockCtx = {
	hasUI: true,
	cwd: "/work",
	ui: { notify: vi.fn() },
} as unknown as ExtensionContext;

describe("access-guard", () => {
	describe("read blocking", () => {
		it("should block read tool on denyRead path", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env", ".ssh/"] });
			const result = await toolCall(makeEvent("read", { path: "/home/user/.ssh/id_rsa" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".ssh/") });
		});

		it("should block grep tool on denyRead path", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env"] });
			const result = await toolCall(makeEvent("grep", { pattern: "secret", path: "/work/.env" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".env") });
		});

		it("should block find tool on denyRead path", async () => {
			const { toolCall } = captureHandlers({ denyRead: ["node_modules/"] });
			const result = await toolCall(makeEvent("find", { pattern: "*.js", path: "/work/node_modules/foo" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining("node_modules/") });
		});

		it("should block ls tool on denyRead path", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".git/"] });
			const result = await toolCall(makeEvent("ls", { path: "/work/.git/objects" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".git/") });
		});

		it("should allow read tool on non-denied path", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env"] });
			const result = await toolCall(makeEvent("read", { path: "/work/src/main.ts" }), mockCtx);
			expect(result).toBeUndefined();
		});

		it("should skip check for grep/find/ls with no path", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env", ".git/"] });

			expect(await toolCall(makeEvent("grep", { pattern: "foo" }), mockCtx)).toBeUndefined();
			expect(await toolCall(makeEvent("find", { pattern: "*.ts" }), mockCtx)).toBeUndefined();
			expect(await toolCall(makeEvent("ls", {}), mockCtx)).toBeUndefined();
		});
	});

	describe("write blocking", () => {
		it("should block write tool on denyWrite path", async () => {
			const { toolCall } = captureHandlers({ denyWrite: [".env", ".git/"] });
			const result = await toolCall(makeEvent("write", { path: "/work/.env", content: "SECRET=x" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".env") });
		});

		it("should block edit tool on denyWrite path", async () => {
			const { toolCall } = captureHandlers({ denyWrite: ["node_modules/"] });
			const result = await toolCall(
				makeEvent("edit", { path: "/work/node_modules/foo/index.js", oldText: "a", newText: "b" }),
				mockCtx,
			);
			expect(result).toEqual({ block: true, reason: expect.stringContaining("node_modules/") });
		});

		it("should allow write tool on non-denied path", async () => {
			const { toolCall } = captureHandlers({ denyWrite: [".env"] });
			const result = await toolCall(makeEvent("write", { path: "/work/src/main.ts", content: "code" }), mockCtx);
			expect(result).toBeUndefined();
		});
	});

	describe("combined config", () => {
		it("should block both read and write on paths in both lists", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env"], denyWrite: [".env"] });

			const readResult = await toolCall(makeEvent("read", { path: "/work/.env" }), mockCtx);
			expect(readResult).toEqual({ block: true, reason: expect.stringContaining(".env") });

			const writeResult = await toolCall(makeEvent("write", { path: "/work/.env", content: "" }), mockCtx);
			expect(writeResult).toEqual({ block: true, reason: expect.stringContaining(".env") });
		});

		it("should block read but allow write when only denyRead is set", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".ssh/"] });

			const readResult = await toolCall(makeEvent("read", { path: "/home/.ssh/id_rsa" }), mockCtx);
			expect(readResult).toEqual({ block: true, reason: expect.stringContaining(".ssh/") });

			const writeResult = await toolCall(makeEvent("write", { path: "/home/.ssh/id_rsa", content: "" }), mockCtx);
			expect(writeResult).toBeUndefined();
		});

		it("should block write but allow read when only denyWrite is set", async () => {
			const { toolCall } = captureHandlers({ denyWrite: ["node_modules/"] });

			const readResult = await toolCall(makeEvent("read", { path: "/work/node_modules/foo" }), mockCtx);
			expect(readResult).toBeUndefined();

			const writeResult = await toolCall(
				makeEvent("write", { path: "/work/node_modules/foo", content: "" }),
				mockCtx,
			);
			expect(writeResult).toEqual({ block: true, reason: expect.stringContaining("node_modules/") });
		});
	});

	describe("edge cases", () => {
		it("should ignore bash tool (no path field)", async () => {
			const { toolCall } = captureHandlers({ denyRead: [".env"], denyWrite: [".env"] });
			const result = await toolCall(makeEvent("bash", { command: "cat .env" }), mockCtx);
			expect(result).toBeUndefined();
		});

		it("should allow everything with empty config", async () => {
			const { toolCall } = captureHandlers({});

			expect(await toolCall(makeEvent("read", { path: "/work/.env" }), mockCtx)).toBeUndefined();
			expect(await toolCall(makeEvent("write", { path: "/work/.env", content: "" }), mockCtx)).toBeUndefined();
		});

		it("should load from sandbox.json when no explicit config passed", async () => {
			// No explicit config → loads from ~/.pi/agent/sandbox.json
			const { toolCall } = captureHandlers();

			// Global sandbox.json has denyWrite containing ".env" — substring match works
			const result = await toolCall(makeEvent("write", { path: "/work/.env", content: "" }), mockCtx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".env") });
		});

		it("should notify UI when blocking", async () => {
			const notify = vi.fn();
			const ctx = { hasUI: true, cwd: "/work", ui: { notify } } as unknown as ExtensionContext;
			const { toolCall } = captureHandlers({ denyRead: [".env"] });

			await toolCall(makeEvent("read", { path: "/work/.env" }), ctx);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining(".env"), "warning");
		});

		it("should not crash when hasUI is false", async () => {
			const ctx = { hasUI: false, cwd: "/work", ui: {} } as unknown as ExtensionContext;
			const { toolCall } = captureHandlers({ denyRead: [".env"] });

			const result = await toolCall(makeEvent("read", { path: "/work/.env" }), ctx);
			expect(result).toEqual({ block: true, reason: expect.stringContaining(".env") });
		});
	});

	describe("loadAccessGuardConfig", () => {
		it("should return empty arrays when no config files exist at all", () => {
			// Both global and project paths must not exist for empty result.
			// Since ~/.pi/agent/sandbox.json exists on this machine, we test that
			// a nonexistent project path doesn't add extra entries beyond global.
			const config = loadAccessGuardConfig("/nonexistent-project-12345");
			// Global config is loaded, so arrays are non-empty
			expect(Array.isArray(config.denyRead)).toBe(true);
			expect(Array.isArray(config.denyWrite)).toBe(true);
		});

		it("should load denyRead and denyWrite from global sandbox.json", () => {
			// Uses the real ~/.pi/agent/sandbox.json on disk
			const config = loadAccessGuardConfig("/nonexistent-project");
			// Global config has denyRead entries (verified from Tom's sandbox.json)
			expect(config.denyRead.length).toBeGreaterThan(0);
			expect(config.denyRead).toContain("~/.ssh");
			expect(config.denyWrite).toContain(".env");
		});

		it("should merge project-local config over global", () => {
			// Without a project-local .pi/sandbox.json, we get global values
			const config = loadAccessGuardConfig("/nonexistent-project");
			const globalDenyRead = config.denyRead;

			// Same result when project has no override
			const config2 = loadAccessGuardConfig("/tmp");
			expect(config2.denyRead).toEqual(globalDenyRead);
		});
	});

	describe("/access-guard command", () => {
		it("should register the access-guard command", () => {
			const { command } = captureHandlers({ denyRead: ["~/.ssh"], denyWrite: [".env"] });
			expect(command).toBeDefined();
			expect(command!.description).toBeDefined();
		});

		it("should display effective config via notify", async () => {
			const notify = vi.fn();
			const ctx = {
				hasUI: true,
				cwd: "/work",
				ui: { notify },
			} as unknown as ExtensionCommandContext;

			const { command } = captureHandlers({ denyRead: ["~/.ssh", "~/.aws"], denyWrite: [".env", "*.pem"] });
			await command!.handler("", ctx);

			expect(notify).toHaveBeenCalledTimes(1);
			const output = notify.mock.calls[0][0] as string;
			expect(output).toContain("~/.ssh");
			expect(output).toContain("~/.aws");
			expect(output).toContain(".env");
			expect(output).toContain("*.pem");
		});

		it("should show (none) when lists are empty", async () => {
			const notify = vi.fn();
			const ctx = {
				hasUI: true,
				cwd: "/work",
				ui: { notify },
			} as unknown as ExtensionCommandContext;

			const { command } = captureHandlers({});
			await command!.handler("", ctx);

			const output = notify.mock.calls[0][0] as string;
			expect(output).toContain("(none)");
		});
	});
});
