const path = require("path");
const { Disposable } = require("atom");

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

  describe("coexistence with ide-ruff", () => {
    let editor, registration;

    // The half of the ide-client service this package uses. `adaptersForEditor`
    // reports registrations, so it answers for an editor no server has reached.
    function fakeIdeClient(adaptersByScope = {}) {
      const listeners = new Set();
      return {
        adaptersForEditor: (textEditor) => adaptersByScope[textEditor.getGrammar().scopeName] || [],
        onDidChangeAdapters(callback) {
          listeners.add(callback);
          return new Disposable(() => listeners.delete(callback));
        },
        emitChange(event) {
          for (const callback of listeners) callback(event);
        },
      };
    }

    beforeEach(async () => {
      editor = await atom.workspace.open(path.join(__dirname, "fixtures", "sample.py"));
    });

    afterEach(() => {
      registration?.dispose();
      registration = null;
    });

    it("reports nothing for an editor the ide-ruff adapter covers", async () => {
      registration = mainModule.consumeIdeClient(
        fakeIdeClient({ "source.python": [{ id: "ide-ruff" }] }),
      );
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

      // An empty list, not `undefined`: the linter keeps the last messages a
      // provider gave it when a lint resolves with nothing.
      expect(await mainModule.provideLinter().lint(editor)).toEqual([]);
      expect(calls.length).toBe(0);
    });

    it("keeps linting when the adapters covering the editor are other packages", async () => {
      registration = mainModule.consumeIdeClient(
        fakeIdeClient({ "source.python": [{ id: "ide-pyright" }] }),
      );
      const calls = fakeRuff();

      expect(await mainModule.provideLinter().lint(editor)).toEqual([]);
      expect(calls.length).toBe(1);
    });

    it("keeps linting the scopes ide-ruff does not serve", async () => {
      // The notebook's own buffer among them: ide-ruff declares the Python
      // scopes, and the mapping of ruff's cell diagnostics onto notebook cells
      // has no language-server equivalent.
      registration = mainModule.consumeIdeClient(
        fakeIdeClient({ "source.python": [{ id: "ide-ruff" }] }),
      );
      const calls = fakeRuff();
      // What jupyter-view hands the linter: the notebook's source buffer, file
      // backed and carrying the notebook grammar.
      spyOn(editor, "getGrammar").and.returnValue({ scopeName: "source.jupyter" });

      expect(await mainModule.provideLinter().lint(editor)).toEqual([]);
      expect(calls.length).toBe(1);
    });

    it("still fixes on request, which is this package being asked for by name", async () => {
      registration = mainModule.consumeIdeClient(
        fakeIdeClient({ "source.python": [{ id: "ide-ruff" }] }),
      );
      const calls = fakeRuff();

      await mainModule.lint(editor, true);
      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain("--fix-only");
    });

    it("asks for another pass when the set of adapters changes", () => {
      const ideClient = fakeIdeClient();
      registration = mainModule.consumeIdeClient(ideClient);
      // The duplicate that is already on screen: this package linted the file
      // before ide-ruff activated, and nothing would ask it again.
      const lints = [];
      const command = atom.commands.add(workspaceElement, "linter:lint", () => lints.push(true));

      ideClient.emitChange({ adapter: { id: "ide-ruff" }, registered: true });
      expect(lints.length).toBe(1);
      command.dispose();
    });

    it("takes the editors back when ide-client goes away", async () => {
      registration = mainModule.consumeIdeClient(
        fakeIdeClient({ "source.python": [{ id: "ide-ruff" }] }),
      );
      registration.dispose();
      registration = null;
      const calls = fakeRuff();

      expect(await mainModule.provideLinter().lint(editor)).toEqual([]);
      expect(calls.length).toBe(1);
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
