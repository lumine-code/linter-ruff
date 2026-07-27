const path = require("path");

describe("linter-ruff", () => {
  let mainModule, workspaceElement;

  function fakeRuff({ items = [], error = null, stderr = "" } = {}) {
    const calls = [];
    mainModule.execFile = (exe, args, opts, callback) => {
      const call = { exe, args, opts, stdin: "" };
      calls.push(call);
      queueMicrotask(() => callback(error, JSON.stringify(items), stderr));
      return {
        stdin: {
          write(text) {
            call.stdin += text;
          },
          end() {},
        },
      };
    };
    return calls;
  }

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);

    await atom.packages.activatePackage("language-python");

    // The package defers activation until one of its commands is dispatched.
    const activation = atom.packages.activatePackage("linter-ruff");
    atom.commands.dispatch(workspaceElement, "linter-ruff:lint-projects");
    mainModule = (await activation).mainModule;
  });

  afterEach(() => {
    mainModule.execFile = require("child_process").execFile;
  });

  describe("linter provider", () => {
    it("exposes the shape expected by the linter service", () => {
      const provider = mainModule.provideLinter();
      expect(provider.name).toBe("Ruff");
      expect(provider.scope).toBe("file");
      expect(provider.lintsOnChange).toBe(true);
      expect(Array.isArray(provider.grammarScopes)).toBe(true);
      expect(provider.grammarScopes).toContain("source.python");
      expect(typeof provider.lint).toBe("function");
    });
  });

  describe("lint()", () => {
    let editor;

    beforeEach(async () => {
      editor = await atom.workspace.open(path.join(__dirname, "fixtures", "sample.py"));
      expect(editor.getGrammar().scopeName).toBe("source.python");
    });

    it("converts ruff diagnostics into linter messages", async () => {
      const calls = fakeRuff({
        items: [
          {
            code: "F401",
            message: "`os` imported but unused",
            location: { row: 2, column: 1 },
            end_location: { row: 2, column: 10 },
          },
        ],
      });

      const provider = mainModule.provideLinter();
      const messages = await provider.lint(editor);

      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("error");
      expect(messages[0].excerpt).toBe("F401*: `os` imported but unused");
      expect(messages[0].location.file).toBe(editor.getPath());
      // One hidden stub line predefines the IPython variables.
      expect(messages[0].location.position).toEqual([
        [0, 0],
        [0, 9],
      ]);

      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain("check");
      expect(calls[0].args).toContain("--output-format=json");
      expect(calls[0].args).toContain(`--stdin-filename=${editor.getPath()}`);
      expect(calls[0].stdin).toContain("import os");
    });

    it("applies the configured severity classes without a star", async () => {
      atom.config.set("linter-ruff.warning", ["F4"]);
      fakeRuff({
        items: [
          {
            code: "F401",
            message: "`os` imported but unused",
            location: { row: 2, column: 1 },
            end_location: { row: 2, column: 10 },
          },
        ],
      });

      const messages = await mainModule.provideLinter().lint(editor);
      expect(messages[0].severity).toBe("warning");
      expect(messages[0].excerpt).toBe("F401: `os` imported but unused");
    });

    it("classifies codes listed in the hint class as hints", async () => {
      atom.config.set("linter-ruff.hint", ["F4"]);
      fakeRuff({
        items: [
          {
            code: "F401",
            message: "`os` imported but unused",
            location: { row: 2, column: 1 },
            end_location: { row: 2, column: 10 },
          },
        ],
      });

      const messages = await mainModule.provideLinter().lint(editor);
      expect(messages[0].severity).toBe("hint");
      expect(messages[0].excerpt).toBe("F401: `os` imported but unused");
    });

    it("prefers info over hint when a code matches both classes", async () => {
      atom.config.set("linter-ruff.info", ["F4"]);
      atom.config.set("linter-ruff.hint", ["F401"]);
      fakeRuff({
        items: [
          {
            code: "F401",
            message: "`os` imported but unused",
            location: { row: 2, column: 1 },
            end_location: { row: 2, column: 10 },
          },
        ],
      });

      const messages = await mainModule.provideLinter().lint(editor);
      expect(messages[0].severity).toBe("info");
    });

    it("resolves an empty list when the linter state is disabled", async () => {
      atom.config.set("linter-ruff.state", false);
      const calls = fakeRuff();
      const messages = await mainModule.provideLinter().lint(editor);
      expect(messages).toEqual([]);
      expect(calls.length).toBe(0);
    });

    it("skips editors whose grammar is not supported", async () => {
      const textEditor = await atom.workspace.open();
      const calls = fakeRuff();
      expect(mainModule.provideLinter().lint(textEditor)).toBeUndefined();
      expect(calls.length).toBe(0);
    });

    it("notifies and resolves empty when the ruff executable is missing", async () => {
      const error = new Error("spawn ruff ENOENT");
      error.code = "ENOENT";
      fakeRuff({ error });

      const messages = await mainModule.provideLinter().lint(editor);
      expect(messages).toEqual([]);
      const notifications = atom.notifications.getNotifications();
      expect(notifications.some((n) => n.getMessage().includes("not found"))).toBe(true);
    });
  });

  describe("magic command handling", () => {
    it("masks magic lines and restores them after a fix", () => {
      const source = "%timeit foo()\nx = 1\n";
      const prepared = mainModule.prepareEditorText(source, {
        includeIpythonVars: false,
        isNotebook: false,
      });
      expect(prepared.text).not.toContain("%timeit");
      expect(prepared.magicLines).toEqual(["%timeit foo()"]);
      expect(mainModule.restoreEditorText(prepared.text, prepared)).toBe(source);
    });

    it("prepends the IPython variable stub and strips it again", () => {
      const source = "x = _\n";
      const prepared = mainModule.prepareEditorText(source, {
        includeIpythonVars: true,
        isNotebook: false,
      });
      expect(prepared.hiddenlines).toBe(1);
      expect(prepared.text.endsWith(source)).toBe(true);
      expect(mainModule.restoreEditorText(prepared.text, prepared)).toBe(source);
    });
  });

  describe("commands", () => {
    it("toggles the linter state", () => {
      expect(atom.config.get("linter-ruff.state")).toBe(true);
      atom.commands.dispatch(workspaceElement, "linter-ruff:toggle-state");
      expect(atom.config.get("linter-ruff.state")).toBe(false);
      atom.commands.dispatch(workspaceElement, "linter-ruff:toggle-state");
      expect(atom.config.get("linter-ruff.state")).toBe(true);
    });

    it("toggles the noqa setting", () => {
      expect(atom.config.get("linter-ruff.useNoqa")).toBe(true);
      atom.commands.dispatch(workspaceElement, "linter-ruff:toggle-noqa");
      expect(atom.config.get("linter-ruff.useNoqa")).toBe(false);
    });
  });
});
