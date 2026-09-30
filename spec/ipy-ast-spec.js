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
  if (process.env.RUFF_PATH)
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
});
