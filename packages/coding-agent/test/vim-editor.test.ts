import { type EditorTheme, type Terminal, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { VimEditor } from "../examples/extensions/vim-editor.js";
import { KeybindingsManager } from "../src/core/keybindings.js";

// Minimal terminal for testing — no real rendering needed
class TestTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	write(_data: string): void {}
	async drainInput(): Promise<void> {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

const testTheme: EditorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (t: string) => t,
		selectedText: (t: string) => t,
		description: (t: string) => t,
		scrollInfo: (t: string) => t,
		noMatch: (t: string) => t,
	},
};

function createVimEditor(): VimEditor {
	const tui = new TUI(new TestTerminal());
	const kb = KeybindingsManager.inMemory();
	return new VimEditor(tui, testTheme, kb);
}

/** Type text character by character */
function type(editor: VimEditor, text: string): void {
	for (const ch of text) {
		editor.handleInput(ch);
	}
}

// Escape sequence constants
const ESC = "\x1b";
const ESCAPE = ESC; // escape key press (raw ESC byte)

describe("VimEditor", () => {
	describe("mode switching", () => {
		it("starts in insert mode", () => {
			const editor = createVimEditor();
			expect(editor.getMode()).toBe("insert");
		});

		it("switches to normal mode on Escape", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE);
			expect(editor.getMode()).toBe("normal");
		});

		it("switches back to insert mode with i", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE); // → normal
			editor.handleInput("i"); // → insert
			expect(editor.getMode()).toBe("insert");
		});

		it("moves cursor one char back on Escape (vim behavior)", () => {
			const editor = createVimEditor();
			type(editor, "abc"); // cursor at col 3
			editor.handleInput(ESCAPE); // → normal, cursor back to col 2
			expect(editor.getCursor().col).toBe(2);
		});

		it("does not move back on Escape when at col 0", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE); // empty editor, col 0
			expect(editor.getCursor().col).toBe(0);
		});

		it("passes Escape through to super in normal mode (for app abort)", () => {
			const editor = createVimEditor();
			let interrupted = false;
			editor.onEscape = () => {
				interrupted = true;
			};
			editor.handleInput(ESCAPE); // → normal
			editor.handleInput(ESCAPE); // → should pass through
			expect(interrupted).toBe(true);
		});
	});

	describe("insert mode", () => {
		it("inserts characters normally", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			expect(editor.getText()).toBe("hello");
		});

		it("handles newline via shift+enter", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~"); // shift+enter
			type(editor, "line2");
			expect(editor.getLines()).toEqual(["line1", "line2"]);
		});

		it("does not intercept printable chars", () => {
			const editor = createVimEditor();
			type(editor, "hjkl"); // these should be inserted, not treated as motions
			expect(editor.getText()).toBe("hjkl");
		});
	});

	describe("normal mode - blocks text insertion", () => {
		it("does not insert printable chars in normal mode", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE); // → normal
			editor.handleInput("z"); // 'z' is unmapped — should be ignored
			expect(editor.getText()).toBe("hello");
		});
	});

	describe("normal mode - ctrl passthrough", () => {
		it("passes ctrl+c through in normal mode", () => {
			const editor = createVimEditor();
			type(editor, "text");
			editor.handleInput(ESCAPE);
			// ctrl+c should not crash and should pass through
			editor.handleInput("\x03"); // ctrl+c
			// Just verifying it doesn't throw or insert text
			expect(editor.getText()).toBe("text");
		});

		it("passes ctrl+d through in normal mode when empty", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE);
			let exited = false;
			editor.onCtrlD = () => {
				exited = true;
			};
			editor.handleInput("\x04"); // ctrl+d
			expect(exited).toBe(true);
		});
	});

	describe("normal mode - hjkl motions", () => {
		it("h moves cursor left", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE); // col 2 (on 'c', vim moves back one)
			editor.handleInput("h"); // col 1
			expect(editor.getCursor().col).toBe(1);
		});

		it("l moves cursor right", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE); // col 2 (on 'c')
			editor.handleInput("h"); // col 1
			editor.handleInput("h"); // col 0
			editor.handleInput("l"); // col 1
			expect(editor.getCursor().col).toBe(1);
		});

		it("j moves cursor down", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~"); // shift+enter → newline
			type(editor, "line2");
			editor.handleInput(ESCAPE);
			// cursor at line 1. Go up then verify down works.
			editor.handleInput("k"); // line 0
			expect(editor.getCursor().line).toBe(0);
			editor.handleInput("j"); // line 1
			expect(editor.getCursor().line).toBe(1);
		});

		it("k moves cursor up", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line2");
			editor.handleInput(ESCAPE);
			expect(editor.getCursor().line).toBe(1);
			editor.handleInput("k");
			expect(editor.getCursor().line).toBe(0);
		});
	});

	describe("normal mode - 0 and $", () => {
		it("0 moves to line start", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			expect(editor.getCursor().col).toBe(0);
		});

		it("$ moves to line end", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // go to start
			editor.handleInput("$"); // go to end
			expect(editor.getCursor().col).toBe(5);
		});
	});

	describe("normal mode - word motions", () => {
		it("w moves to next word start", () => {
			const editor = createVimEditor();
			type(editor, "hello world foo");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("w"); // col 6 (start of "world")
			expect(editor.getCursor().col).toBe(6);
		});

		it("b moves to previous word start", () => {
			const editor = createVimEditor();
			type(editor, "hello world foo");
			editor.handleInput(ESCAPE);
			// cursor at end (col 15)
			editor.handleInput("b"); // start of "foo" (col 12)
			expect(editor.getCursor().col).toBe(12);
		});

		it("e moves to end of current/next word", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("e"); // col 4 (end of "hello")
			expect(editor.getCursor().col).toBe(4);
		});
	});

	describe("normal mode - ^ (first non-blank)", () => {
		it("moves to first non-blank character", () => {
			const editor = createVimEditor();
			type(editor, "   hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("^");
			expect(editor.getCursor().col).toBe(3);
		});
	});

	describe("normal mode - gg and G", () => {
		it("gg goes to first line", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line2");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line3");
			editor.handleInput(ESCAPE);
			expect(editor.getCursor().line).toBe(2);
			editor.handleInput("g");
			editor.handleInput("g");
			expect(editor.getCursor().line).toBe(0);
		});

		it("G goes to last line", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line2");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line3");
			editor.handleInput(ESCAPE);
			editor.handleInput("g");
			editor.handleInput("g"); // go to top
			expect(editor.getCursor().line).toBe(0);
			editor.handleInput("G"); // go to bottom
			expect(editor.getCursor().line).toBe(2);
		});
	});

	describe("normal mode - count prefix", () => {
		it("3j moves down 3 lines", () => {
			const editor = createVimEditor();
			type(editor, "a");
			editor.handleInput("\x1b[13;2~");
			type(editor, "b");
			editor.handleInput("\x1b[13;2~");
			type(editor, "c");
			editor.handleInput("\x1b[13;2~");
			type(editor, "d");
			editor.handleInput(ESCAPE);
			editor.handleInput("g");
			editor.handleInput("g"); // line 0
			type(editor, "3");
			editor.handleInput("j"); // should be at line 3
			expect(editor.getCursor().line).toBe(3);
		});

		it("2w moves forward 2 words", () => {
			const editor = createVimEditor();
			type(editor, "one two three four");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			type(editor, "2");
			editor.handleInput("w"); // skip "one" and "two", land on "three" (col 8)
			expect(editor.getCursor().col).toBe(8);
		});

		it("0 alone goes to line start (not count)", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			expect(editor.getCursor().col).toBe(0);
		});

		it("10 then 0 builds count 10 (not line start)", () => {
			// After typing 1, we're accumulating count. Then 0 extends to 10.
			const editor = createVimEditor();
			// Create 12 lines
			for (let i = 0; i < 12; i++) {
				if (i > 0) editor.handleInput("\x1b[13;2~");
				type(editor, `line${i}`);
			}
			editor.handleInput(ESCAPE);
			editor.handleInput("g");
			editor.handleInput("g"); // line 0
			type(editor, "10");
			editor.handleInput("j"); // should be at line 10
			expect(editor.getCursor().line).toBe(10);
		});
	});

	describe("insert mode entry variants", () => {
		it("a enters insert mode after cursor", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("a"); // insert after cursor (col 1)
			type(editor, "X");
			expect(editor.getText()).toBe("aXbc");
		});

		it("A enters insert mode at end of line", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("A"); // insert at end
			type(editor, "!");
			expect(editor.getText()).toBe("hello!");
		});

		it("I enters insert mode at start of line", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("I"); // insert at start
			type(editor, ">");
			expect(editor.getText()).toBe(">hello");
		});

		it("o opens line below and enters insert mode", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput(ESCAPE);
			editor.handleInput("o");
			expect(editor.getMode()).toBe("insert");
			type(editor, "new line");
			expect(editor.getLines()).toEqual(["line1", "new line"]);
			expect(editor.getCursor().line).toBe(1);
		});

		it("O opens line above and enters insert mode", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line2");
			editor.handleInput(ESCAPE);
			editor.handleInput("O"); // open above line2
			expect(editor.getMode()).toBe("insert");
			type(editor, "between");
			expect(editor.getLines()).toEqual(["line1", "between", "line2"]);
		});
	});

	describe("editing - x and X", () => {
		it("x deletes character under cursor", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("x"); // delete 'a'
			expect(editor.getText()).toBe("bc");
		});

		it("X deletes character before cursor", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE); // col 2 (on 'c')
			editor.handleInput("X"); // delete char before cursor ('b')
			expect(editor.getText()).toBe("ac");
		});
	});

	describe("editing - dd, yy, p, P", () => {
		it("dd deletes current line", () => {
			const editor = createVimEditor();
			type(editor, "line1");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line2");
			editor.handleInput("\x1b[13;2~");
			type(editor, "line3");
			editor.handleInput(ESCAPE);
			editor.handleInput("k"); // go to line1 (line index 1)
			editor.handleInput("d");
			editor.handleInput("d"); // delete line2
			expect(editor.getLines()).toEqual(["line1", "line3"]);
		});

		it("yy + p yanks and pastes line below", () => {
			const editor = createVimEditor();
			type(editor, "first");
			editor.handleInput("\x1b[13;2~");
			type(editor, "second");
			editor.handleInput(ESCAPE);
			editor.handleInput("k"); // go to "first" (line 0)
			editor.handleInput("y");
			editor.handleInput("y"); // yank "first"
			editor.handleInput("p"); // paste below
			expect(editor.getLines()).toEqual(["first", "first", "second"]);
		});

		it("yy + P pastes line above", () => {
			const editor = createVimEditor();
			type(editor, "first");
			editor.handleInput("\x1b[13;2~");
			type(editor, "second");
			editor.handleInput(ESCAPE);
			// on "second" (line 1)
			editor.handleInput("y");
			editor.handleInput("y"); // yank "second"
			editor.handleInput("P"); // paste above
			expect(editor.getLines()).toEqual(["first", "second", "second"]);
		});

		it("2dd deletes 2 lines", () => {
			const editor = createVimEditor();
			type(editor, "a");
			editor.handleInput("\x1b[13;2~");
			type(editor, "b");
			editor.handleInput("\x1b[13;2~");
			type(editor, "c");
			editor.handleInput("\x1b[13;2~");
			type(editor, "d");
			editor.handleInput(ESCAPE);
			editor.handleInput("g");
			editor.handleInput("g"); // line 0
			type(editor, "2");
			editor.handleInput("d");
			editor.handleInput("d"); // delete lines 0-1
			expect(editor.getLines()).toEqual(["c", "d"]);
		});
	});

	describe("editing - cc", () => {
		it("cc clears current line and enters insert mode", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput("\x1b[13;2~");
			type(editor, "world");
			editor.handleInput(ESCAPE);
			editor.handleInput("k"); // line 0
			editor.handleInput("c");
			editor.handleInput("c"); // change line
			expect(editor.getMode()).toBe("insert");
			expect(editor.getLines()[0]).toBe("");
			type(editor, "replaced");
			expect(editor.getLines()).toEqual(["replaced", "world"]);
		});
	});

	describe("editing - D and C", () => {
		it("D deletes to end of line", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			editor.handleInput("w"); // on "world" (col 6)
			editor.handleInput("D"); // delete "world"
			expect(editor.getText()).toBe("hello ");
		});

		it("C changes to end of line", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			editor.handleInput("w"); // on "world" (col 6)
			editor.handleInput("C"); // change to end
			expect(editor.getMode()).toBe("insert");
			type(editor, "vim");
			expect(editor.getText()).toBe("hello vim");
		});
	});

	describe("editing - J (join lines)", () => {
		it("joins current line with next", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput("\x1b[13;2~");
			type(editor, "world");
			editor.handleInput(ESCAPE);
			editor.handleInput("k"); // line 0
			editor.handleInput("J"); // join
			expect(editor.getLines()).toEqual(["hello world"]);
		});
	});

	describe("editing - r (replace char)", () => {
		it("replaces character under cursor", () => {
			const editor = createVimEditor();
			type(editor, "abc");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("r");
			editor.handleInput("X"); // replace 'a' with 'X'
			expect(editor.getText()).toBe("Xbc");
			expect(editor.getMode()).toBe("normal"); // stays in normal
		});
	});

	describe("editing - u (undo)", () => {
		it("undoes last change", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("d");
			editor.handleInput("d"); // delete the line
			editor.handleInput("u"); // undo
			expect(editor.getText()).toBe("hello");
		});
	});

	describe("operator + motion combos", () => {
		it("dw deletes a word", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("d");
			editor.handleInput("w"); // delete "hello "
			expect(editor.getText()).toBe("world");
		});

		it("d$ deletes to end of line", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			editor.handleInput("w"); // col 6 ("world")
			editor.handleInput("d");
			editor.handleInput("$"); // delete "world"
			expect(editor.getText()).toBe("hello ");
		});

		it("cw changes a word", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("c");
			editor.handleInput("w"); // delete "hello " and enter insert
			expect(editor.getMode()).toBe("insert");
			type(editor, "hi ");
			expect(editor.getText()).toBe("hi world");
		});

		it("yw yanks a word and p pastes it", () => {
			const editor = createVimEditor();
			type(editor, "hello world");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("y");
			editor.handleInput("w"); // yank "hello "
			editor.handleInput("$"); // go to end
			editor.handleInput("p"); // paste
			expect(editor.getText()).toBe("hello worldhello ");
		});

		it("2dw deletes 2 words", () => {
			const editor = createVimEditor();
			type(editor, "one two three");
			editor.handleInput(ESCAPE);
			editor.handleInput("0");
			type(editor, "2");
			editor.handleInput("d");
			editor.handleInput("w"); // delete "one two "
			expect(editor.getText()).toBe("three");
		});
	});

	describe("mode indicator in render", () => {
		it("shows NORMAL indicator in normal mode", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE);
			const lines = editor.render(80);
			const lastLine = lines[lines.length - 1] || "";
			expect(lastLine).toContain("NORMAL");
		});

		it("shows INSERT indicator in insert mode", () => {
			const editor = createVimEditor();
			const lines = editor.render(80);
			const lastLine = lines[lines.length - 1] || "";
			expect(lastLine).toContain("INSERT");
		});
	});

	describe("edge cases", () => {
		it("escape in normal mode resets pending state", () => {
			const editor = createVimEditor();
			type(editor, "hello");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			// Start a pending operator, then escape to abort
			editor.handleInput("d"); // pending operator
			let interrupted = false;
			editor.onEscape = () => {
				interrupted = true;
			};
			editor.handleInput(ESCAPE); // should cancel pending + pass to app
			expect(interrupted).toBe(true);
			// Verify next command works clean (no stale pending)
			editor.handleInput("x"); // should just delete 'h'
			expect(editor.getText()).toBe("ello");
		});

		it("p pastes characterwise text after cursor mid-line", () => {
			const editor = createVimEditor();
			type(editor, "abcd");
			editor.handleInput(ESCAPE);
			editor.handleInput("0"); // col 0
			editor.handleInput("x"); // delete 'a', register = implicit (via x)
			// x doesn't store in our register, use yw + p instead
			const editor2 = createVimEditor();
			type(editor2, "ab cd");
			editor2.handleInput(ESCAPE);
			editor2.handleInput("0"); // col 0
			editor2.handleInput("y");
			editor2.handleInput("w"); // yank "ab "
			editor2.handleInput("l"); // col 1 (on "b")
			editor2.handleInput("p"); // paste "ab " after cursor
			expect(editor2.getText()).toBe("abab  cd");
		});

		it("r on empty line does nothing", () => {
			const editor = createVimEditor();
			editor.handleInput(ESCAPE);
			editor.handleInput("r");
			editor.handleInput("X");
			expect(editor.getText()).toBe("");
			expect(editor.getMode()).toBe("normal");
		});

		it("dd on last remaining line leaves empty editor", () => {
			const editor = createVimEditor();
			type(editor, "only line");
			editor.handleInput(ESCAPE);
			editor.handleInput("d");
			editor.handleInput("d");
			expect(editor.getLines()).toEqual([""]);
		});

		it("w on line with leading spaces skips them after wrap", () => {
			const editor = createVimEditor();
			type(editor, "end");
			editor.handleInput("\x1b[13;2~"); // newline
			type(editor, "   indented");
			editor.handleInput(ESCAPE);
			editor.handleInput("k"); // go to "end" line
			editor.handleInput("0"); // col 0
			editor.handleInput("w"); // should go to end of "end"... actually w skips "end" and lands on next word
			// "end" is one word. w from col 0 skips "end" → col 3, then past line end → wraps to next line
			// Next line is "   indented", skip spaces → col 3 ("indented")
			expect(editor.getCursor().line).toBe(1);
			expect(editor.getCursor().col).toBe(3);
		});
	});
});
