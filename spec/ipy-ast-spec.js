const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { Point, Range } = require("lumine");

describe("Ruff with the real IPython AST projection", () => {
  let editor, main, service, registration, calls, originalExecutable;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage(path.resolve(__dirname, "..", "..", "language-ipython"));
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    originalExecutable = main.ruffExe;
    service = lumine.packages
      .getActivePackage("language-ipython")
      .mainModule.provideIPythonSource();
    registration = main.consumeIpythonSource(service);
    editor = await lumine.workspace.open("mixed-ruff.ipy");
    editor.setText(
      "# %% [markdown]\n```python\nnot_python = <literal>\n```\n# %% [raw]\nraw <😀>\n# %%\n%%html\n<h1>foreign</h1>\n# %%\n%%time -q\nemoji = '😀'; missing_name\n%pwd\n",
    );
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    await editor.whenGrammarSettled();
    calls = [];
  });
  afterEach(() => {
    registration.dispose();
    main.execFile = require("child_process").execFile;
    main.ruffExe = originalExecutable;
    editor.destroy();
  });
  function fakeProcess(output) {
    main.execFile = (exe, args, options, reply) => {
      const call = { args, text: "" };
      calls.push(call);
      queueMicrotask(() => reply(null, output(call.text), ""));
      return {
        stdin: {
          write(text) {
            call.text += text;
          },
          end() {},
        },
      };
    };
  }
  it("maps a real diagnostic after an astral character and retains Python under %%time", async () => {
    const source = editor.getText();
    const projection = await service.project(editor);
    const start = new Point(11, editor.lineTextForBufferRow(11).indexOf("missing_name"));
    const codepoint = projection.toCodePointPosition(projection.toServerPosition(start));
    fakeProcess(() =>
      JSON.stringify([
        {
          code: "F821",
          message: "undefined",
          location: { row: 12, column: codepoint.column + 1 },
          end_location: { row: 12, column: codepoint.column + 13 },
        },
      ]),
    );
    const messages = await main.lint(editor);
    expect(messages[0].location.position).toEqual(
      new Range(start, start.translate([0, 12])).serialize(),
    );
    expect(calls[0].text).toContain("missing_name");
    for (const hidden of ["not_python", "raw <", "foreign", "%%time", "%pwd"])
      expect(calls[0].text).not.toContain(hidden);
    expect(editor.getText()).toBe(source);
  });
  it("restores actual magic sentinels when formatting Python and preserves literal cells", async () => {
    const source = editor.getText();
    fakeProcess((text) => text.replace("emoji = '😀'; missing_name", "emoji = '😀'\nmissing_name"));
    await main.formatProjected(editor, true);
    expect(calls.length).toBeGreaterThan(0);
    expect(editor.getText()).toBe(
      source.replace("emoji = '😀'; missing_name", "emoji = '😀'\nmissing_name"),
    );
    expect(editor.getText()).toContain("%%time -q\n");
    expect(editor.getText()).toContain("%pwd\n");
  });
  it("releases the ephemeral grammar model after linting a closed file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ruff-closed-model-"));
    const filePath = path.join(directory, "closed.ipy"),
      source = editor.getText();
    const models = lumine.textEditors.getEditors().length;
    await fs.writeFile(filePath, source);
    fakeProcess(() => "[]");
    try {
      expect(await main.lintClosedProjected(filePath)).toEqual([]);
      expect(calls[0].text).toContain("missing_name");
      expect(calls[0].text).not.toContain("raw <");
      expect(lumine.textEditors.getEditors().length).toBe(models);
      expect(service.owned.size).toBe(0);
      expect(await fs.readFile(filePath, "utf8")).toBe(source);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("formats 1000 code cells with one CLI process and preserves all markers", async () => {
    const source = Array.from(
      { length: 1000 },
      (_, index) => `# %% Cell ${index}\nvalue_${index}=1\n`,
    ).join("");
    editor.setText(source);
    await editor.whenGrammarSettled();
    fakeProcess((text) => text.replaceAll("=1", " = 1"));
    const nativeApply = spyOn(editor, "setText").and.callThrough();
    await main.formatProjected(editor, true);
    expect(calls.length).toBe(1);
    expect(editor.getText()).toBe(source.replaceAll("=1", " = 1"));
    expect(main.projectedTasks.size).toBe(0);
    expect(nativeApply).toHaveBeenCalledTimes(1);
  });

  it("skips applying an unchanged pure Python formatter result", async () => {
    editor.setText("# %%\nvalue = 1\n");
    await editor.whenGrammarSettled();
    fakeProcess((text) => text);
    const apply = spyOn(editor, "setText").and.callThrough();
    await main.formatProjected(editor, true);
    expect(calls.length).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("translates multiple reversed selections and preserves one undo entry for pure Python", async () => {
    const source = "#%% First\r\nvalue=1\r\n#%% Last\r\nnext=value\r\n";
    editor.setText(source);
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    editor.setSelectedBufferRanges([new Range([0, 0], [0, 9]), new Range([3, 5], [3, 10])]);
    editor.getSelections()[1].setBufferRange(new Range([3, 5], [3, 10]), { reversed: true });
    fakeProcess((text) =>
      text.replace("value=1", "value = 1").replace("next=value", "next = value"),
    );
    const apply = spyOn(editor, "setText").and.callThrough();
    await main.formatProjected(editor, true);
    const target = source.replace("value=1", "value = 1").replace("next=value", "next = value");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe(target);
    expect(editor.getSelections().map((selection) => selection.getText())).toEqual([
      "#%% First",
      "value",
    ]);
    expect(editor.getSelections()[1].isReversed()).toBe(true);
    editor.undo();
    expect(editor.getText()).toBe(source);
    expect(editor.getSelectedBufferRanges()).toEqual([
      new Range([0, 0], [0, 9]),
      new Range([3, 5], [3, 10]),
    ]);
    editor.redo();
    expect(editor.getText()).toBe(target);
    expect(editor.getSelections().map((selection) => selection.getText())).toEqual([
      "#%% First",
      "value",
    ]);
  });

  it("preserves undo, selections and CRLF when applying a validated complete target", async () => {
    const source = "# %% First\r\nvalue=1\r\n# %% [raw]\r\nraw <😀>\r\n# %% Last\r\nnext=2\r\n";
    editor.setText(source);
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    editor.setSelectedBufferRange([
      [3, 0],
      [3, 9],
    ]);
    const selected = editor.getSelectedText();
    fakeProcess((text) => text.replace("value=1", "value = 1").replace("next=2", "next = 2"));
    await main.formatProjected(editor, true);
    expect(editor.getText()).toBe(
      source.replace("value=1", "value = 1").replace("next=2", "next = 2"),
    );
    expect(editor.getSelectedText()).toBe(selected);
    editor.undo();
    expect(editor.getText()).toBe(source);
    editor.redo();
    expect(editor.getText()).toBe(
      source.replace("value=1", "value = 1").replace("next=2", "next = 2"),
    );
  });
  if (process.env.RUFF_PATH) {
    it("maps the real Ruff CLI's Unicode diagnostics without linting literal bodies", async () => {
      main.ruffExe = process.env.RUFF_PATH;
      const source = editor.getText();
      const messages = await main.lint(editor);
      const missing = messages.find((message) => message.excerpt.includes("missing_name"));
      const column = editor.lineTextForBufferRow(11).indexOf("missing_name");
      expect(missing.location.position).toEqual([
        [11, column],
        [11, column + 12],
      ]);
      expect(messages.every((message) => message.location.position[0][0] === 11)).toBe(true);
      expect(editor.getText()).toBe(source);
      expect(main.projectedTasks.size).toBe(0);
    });

    it("formats a complete batch with the real CLI using one process and retaining opaque bytes", async () => {
      main.ruffExe = process.env.RUFF_PATH;
      const source =
        '# %% Documentation\n"""Module documentation."""\nfrom __future__ import annotations\nfirst=1\n# %% [raw]\nraw <😀>\n# %% Timed\n%%time -q\nvalue=1\n%pwd\n# %% Final\nlast=2\n';
      editor.setText(source);
      await editor.whenGrammarSettled();
      const processes = spyOn(main, "execFile").and.callThrough();
      await main.formatProjected(editor, true);
      const formatted = editor.getText();
      expect(processes).toHaveBeenCalledTimes(1);
      expect(formatted).toContain('"""Module documentation."""');
      expect(formatted).toContain("from __future__ import annotations");
      expect(formatted).toContain("first = 1");
      expect(formatted).toContain("value = 1");
      expect(formatted).toContain("last = 2");
      expect(formatted).toContain("# %% [raw]\nraw <😀>\n# %% Timed\n%%time -q\n");
      expect(formatted).toContain("%pwd\n");
      expect(formatted).not.toContain("__lumine_ipy_batch_");
      expect(main.projectedTasks.size).toBe(0);
    });
  }
});
