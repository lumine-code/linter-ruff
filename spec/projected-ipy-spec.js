const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { Point, Range } = require("lumine");

describe("Ruff projected IPython input", () => {
  let main, editor, registration, directory;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ruff-ipy-"));
    editor = await lumine.workspace.open(path.join(directory, "document.ipy"));
    spyOn(editor, "getGrammar").and.returnValue({ scopeName: "source.python.ipy" });
    editor.setText("# %% [markdown]\n# Literal heading\n# %%\nvalue=1\n");
  });
  afterEach(async () => {
    registration?.dispose();
    registration = null;
    main.execFile = require("child_process").execFile;
    editor.destroy();
    await fs.rm(directory, { force: true, recursive: true });
  });

  function snapshot(overrides = {}) {
    const source = editor.getText();
    const value = {
      source,
      text: "# %% [markdown]\n                 \n# %%\nvalue=1\n",
      isCurrent: () => !editor.isDestroyed() && editor.getText() === source,
      fromCodePointPosition: (point) => point,
      fromServerRange: (range) => range,
      isPythonRange: (range) => range.start.row === 3,
      mapEdits: (edits) => edits,
      ...overrides,
    };
    value.getFormattingBatch ??= async () => {
      const blocks = await value.getFormattingBlocks();
      return {
        text: blocks[0].text,
        restore(formatted) {
          const text = blocks[0].restore(formatted);
          return text === null ? null : [{ range: blocks[0].range, text }];
        },
        async getEditPlan(formatted) {
          const text = blocks[0].restore(formatted);
          return text === null
            ? null
            : {
                text: source.replace(blocks[0].text, text),
                edits: [{ oldRange: blocks[0].range, newText: text }],
                fallback: false,
              };
        },
      };
    };
    return value;
  }
  function provider(value) {
    const service = {
      isApplicable: () => true,
      project: jasmine.createSpy("project").and.resolveTo(value),
    };
    registration = main.consumeIpythonSource(service);
    return service;
  }
  function fakeRuff(stdout, beforeReply = () => {}) {
    const calls = [];
    main.execFile = (exe, args, options, reply) => {
      const call = { exe, args, options, text: "" };
      calls.push(call);
      queueMicrotask(() => {
        beforeReply();
        reply(null, stdout, "");
      });
      return {
        stdin: {
          write: (text) => {
            call.text += text;
          },
          end() {},
        },
      };
    };
    return calls;
  }

  it("sends only shared Python text and filters diagnostics in protected source", async () => {
    const projection = snapshot();
    provider(projection);
    const calls = fakeRuff(
      JSON.stringify([
        {
          code: "F821",
          message: "real",
          location: { row: 4, column: 1 },
          end_location: { row: 4, column: 6 },
        },
        {
          code: "F821",
          message: "opaque",
          location: { row: 2, column: 1 },
          end_location: { row: 2, column: 4 },
        },
      ]),
    );
    const messages = await main.lint(editor);
    expect(calls[0].text).toBe(projection.text);
    expect(calls[0].args).toContain("--extension=ipy:python");
    expect(messages.length).toBe(1);
    expect(messages[0].location.position).toEqual([
      [3, 0],
      [3, 5],
    ]);
    expect(editor.getText()).toBe(projection.source);
  });

  it("maps Ruff Unicode codepoint positions through the shared UTF-16 maps", async () => {
    const convert = jasmine
      .createSpy("CP map")
      .and.callFake((point) => new Point(point.row, point.column + 1));
    provider(snapshot({ fromCodePointPosition: convert }));
    fakeRuff(
      JSON.stringify([
        {
          code: "F821",
          message: "real",
          location: { row: 4, column: 3 },
          end_location: { row: 4, column: 6 },
        },
      ]),
    );
    const messages = await main.lint(editor);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(messages[0].location.position).toEqual([
      [3, 3],
      [3, 6],
    ]);
  });

  it("rejects an entire fix atomically if the shared mapper rejects a protected hunk", async () => {
    const reject = jasmine.createSpy("protected edits").and.returnValue(null);
    const projection = snapshot({ mapEdits: reject });
    provider(projection);
    fakeRuff(projection.text.replace("value=1", "value=2").replace("                 ", "bad = 3"));
    await main.lint(editor, true);
    expect(reject).toHaveBeenCalled();
    expect(editor.getText()).toBe(projection.source);
  });

  it("applies a validated minimal fix while retaining literal Markdown bytes", async () => {
    const projection = snapshot();
    provider(projection);
    fakeRuff(projection.text.replace("value=1", "value=2"));
    await main.lint(editor, true);
    expect(editor.getText()).toBe(projection.source.replace("value=1", "value=2"));
  });

  it("cancels a returned fix if the user edited the document while Ruff was running", async () => {
    const projection = snapshot();
    provider(projection);
    fakeRuff(projection.text.replace("value=1", "value=2"), () =>
      editor.setText("user owns this text"),
    );
    await main.lint(editor, true);
    expect(editor.getText()).toBe("user owns this text");
  });

  it("does not send original IPython text when the shared provider is missing", async () => {
    main.ipythonSource = null;
    const calls = fakeRuff("[]");
    expect(await main.lint(editor)).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("formats only Python blocks and applies nothing if any restore is unsafe", async () => {
    const projection = snapshot({
      getFormattingBlocks: async () => [
        { range: new Range([3, 0], [4, 0]), text: "value=1\n", restore: () => null },
      ],
    });
    provider(projection);
    const calls = fakeRuff("value = 1\n");
    await main.formatProjected(editor, true);
    expect(calls[0].text).toBe("value=1\n");
    expect(editor.getText()).toBe(projection.source);
  });

  it("disposes a closed-file snapshot and refuses to publish after the disk source changes", async () => {
    const filePath = path.join(directory, "closed.ipy");
    await fs.writeFile(filePath, editor.getText());
    const projection = snapshot({ dispose: jasmine.createSpy("dispose") });
    registration = main.consumeIpythonSource({ projectText: async () => projection });
    main.execFile = (exe, args, options, reply) => {
      fs.writeFile(filePath, "changed on disk").then(() => reply(null, "[]", ""));
      return { stdin: { write() {}, end() {} } };
    };
    expect(await main.lintClosedProjected(filePath)).toEqual([]);
    expect(projection.dispose).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("changed on disk");
  });

  it("starts no formatter process when the selection changes during lazy block preparation", async () => {
    let release, started;
    const blocks = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      started = resolve;
    });
    const projection = snapshot({
      getFormattingBlocks: () => {
        started();
        return blocks;
      },
    });
    provider(projection);
    editor.setSelectedBufferRange([
      [3, 0],
      [4, 0],
    ]);
    const calls = fakeRuff("value = 1\n");
    const pending = main.formatProjected(editor, false);
    await preparing;
    editor.setSelectedBufferRange([
      [0, 0],
      [1, 0],
    ]);
    release([{ range: new Range([3, 0], [4, 0]), text: "value=1\n", restore: (text) => text }]);
    await pending;
    expect(calls.length).toBe(0);
    expect(editor.getText()).toBe(projection.source);
    expect(main.projectedTasks.size).toBe(0);
  });

  it("applies no target after cancellation during asynchronous edit planning", async () => {
    let release, started;
    const planned = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      started = resolve;
    });
    const projection = snapshot({
      getFormattingBatch: async () => ({
        text: "value=1\n",
        getEditPlan() {
          started();
          return planned;
        },
      }),
    });
    provider(projection);
    fakeRuff("value = 1\n");
    const pending = main.formatProjected(editor, true);
    await preparing;
    main.projectedFormats.get(editor.getBuffer()).abort();
    release({
      text: projection.source.replace("value=1", "value = 1"),
      edits: [],
      fallback: false,
    });
    await pending;
    expect(editor.getText()).toBe(projection.source);
    expect(main.projectedTasks.size).toBe(0);
  });

  it("keeps the invoking selection while awaiting the projection", async () => {
    const projection = snapshot({
      getFormattingBlocks: async () => [
        { range: new Range([3, 0], [4, 0]), text: "value=1\n", restore: (text) => text },
      ],
    });
    editor.setSelectedBufferRange([
      [3, 0],
      [4, 0],
    ]);
    registration = main.consumeIpythonSource({
      isApplicable: () => true,
      async project() {
        editor.setSelectedBufferRange([
          [0, 0],
          [1, 0],
        ]);
        return projection;
      },
    });
    const calls = fakeRuff("value = 1\n");
    await main.formatProjected(editor, false);
    expect(calls.length).toBe(0);
    expect(editor.getText()).toBe(projection.source);
  });

  it("cancels an open-document project request through the scan signal", async () => {
    const projection = snapshot();
    provider(projection);
    const controller = new AbortController();
    const calls = fakeRuff("[]", () => controller.abort());
    expect(await main.lint(editor, false, { signal: controller.signal })).toEqual([]);
    expect(calls[0].options.signal.aborted).toBe(true);
    expect(main.projectedTasks.size).toBe(0);
  });

  it("discards a result when Save As changes the source pathname during Ruff's request", async () => {
    const projection = snapshot();
    provider(projection);
    fakeRuff("[]", () => editor.getBuffer().setPath(path.join(directory, "renamed.ipy")));
    expect(await main.lint(editor)).toEqual([]);
    expect(editor.getPath()).toBe(path.join(directory, "renamed.ipy"));
    expect(editor.getText()).toBe(projection.source);
    expect(main.projectedTasks.size).toBe(0);
  });
});
