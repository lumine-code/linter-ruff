const { CompositeDisposable, Disposable, Point, Range } = require("lumine");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs").promises;
const indie = require("./indie");

// ide-ruff reports the same violations over the language-server protocol, so
// wherever its adapter covers an editor this package reports none. Both stay
// installed and both stay useful: the server never sees a notebook, a file
// nobody opened, or the fix and format commands here.
const IDE_RUFF_ADAPTER_ID = "ide-ruff";
const IPYTHON_VARS_STUB = "_ = 0 ; __ = 0 ; ___ = 0";
const MAGIC_PLACEHOLDER_PREFIX = "linter-ruff-magic:";

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "linter-ruff",
      tips: [
        "{% if keys['linter-ruff:lint-projects'] %}You can lint every Python file in the project, not only the ones you have open, with {{ 'linter-ruff:lint-projects' | keystroke }}{% else %}You can lint every Python file in the project, not only the ones you have open.{% endif %}",
        "You can lint a Jupyter notebook like any other file, with every message landing in the cell it came from.",
      ],
    };
  },

  // Kept as a property so specs can substitute a fake ruff process.
  execFile,

  activate() {
    this.disposables = new CompositeDisposable();
    this.projectedTasks = new Set();
    this.projectedLint = new WeakMap();
    this.projectedFormats = new WeakMap();

    this.disposables.add(
      lumine.config.observe("linter-ruff.state", (value) => {
        this.state = value;
      }),
      lumine.config.observe("linter-ruff.ruffCommand", (value) => {
        const [exe, ...extra] = (value || "ruff").trim().split(/\s+/);
        this.ruffExe = exe;
        this.ruffExtraArgs = extra;
      }),
      lumine.config.observe("linter-ruff.pyVersion", (value) => {
        this.pyVersion = value;
      }),
      lumine.config.observe("linter-ruff.useNoqa", (value) => {
        this.useNoqa = value;
      }),
      lumine.config.observe("linter-ruff.addStar", (value) => {
        this.addStar = value;
      }),
      lumine.config.observe("linter-ruff.allowMagic", (value) => {
        this.allowMagic = value;
      }),
      lumine.config.observe("linter-ruff.select", (value) => {
        this.select = value;
      }),
      lumine.config.observe("linter-ruff.ignore", (value) => {
        this.ignore = value;
      }),
      lumine.config.observe("linter-ruff.fixable", (value) => {
        this.fixable = value;
      }),
      lumine.config.observe("linter-ruff.unfixable", (value) => {
        this.unfixable = value;
      }),
      lumine.config.observe("linter-ruff.error", (value) => {
        this.isError = this.parseClass(value);
      }),
      lumine.config.observe("linter-ruff.warning", (value) => {
        this.isWarning = this.parseClass(value);
      }),
      lumine.config.observe("linter-ruff.info", (value) => {
        this.isInfo = this.parseClass(value);
      }),
      lumine.config.observe("linter-ruff.hint", (value) => {
        this.isHint = this.parseClass(value);
      }),
      lumine.commands.add("lumine-workspace", {
        "linter-ruff:toggle-state": {
          description: "Turn Ruff's linting on or off for this file.",
          didDispatch: () => {
            lumine.config.set("linter-ruff.state", !this.state);
          },
        },
        "linter-ruff:toggle-noqa": {
          description: "Honour or ignore the noqa comments in the file.",
          didDispatch: () => {
            lumine.config.set("linter-ruff.useNoqa", !this.useNoqa);
          },
        },
        "linter-ruff:global-pyproject": {
          description: "Open the pyproject.toml used when a project has none.",
          didDispatch: () => {
            this.openDefaultConfigFile();
          },
        },
        "linter-ruff:lint-projects": {
          description: "Run Ruff over every Python file in the project folders.",
          didDispatch: () => {
            indie.runScan();
          },
        },
        // The tree view is inside the workspace, so its context menu reaches
        // this handler on its own. A second registration on .tree-view would
        // run the scan twice for every dispatch from there.
        "linter-ruff:lint-selected": {
          description: "Run Ruff over the selected lines alone.",
          didDispatch: () => {
            indie.runSelectedScan();
          },
        },
        "linter-ruff:fix-all": {
          description: "Apply every fix Ruff can make to this file.",
          didDispatch: () => {
            const editor = this.pythonEditor();
            if (editor) this.lint(editor, true);
          },
        },
        "linter-ruff:format-editor": {
          description: "Format the whole file with Ruff's formatter.",
          didDispatch: () => {
            this.formatter(true);
          },
        },
        "linter-ruff:format-selected": {
          description: "Format the selected lines with Ruff's formatter.",
          didDispatch: () => {
            this.formatter(false);
          },
        },
      }),
    );
    this.grammarScopes = [
      "source.python",
      "source.python.ipy",
      "source.python.django",
      "source.jupyter",
    ];
  },

  deactivate() {
    for (const task of this.projectedTasks || []) task.abort();
    this.projectedTasks?.clear();
    indie.dispose();
    this.ideClient = null;
    this.ipythonSource = null;
    this.disposables.dispose();
  },

  consumeIpythonSource(service) {
    this.ipythonSource = service;
    this.projectionMissingNotified = false;
    return new Disposable(() => {
      if (this.ipythonSource === service) this.ipythonSource = null;
    });
  },

  async projectionFor(editor, signal) {
    if (!this.ipythonSource?.isApplicable(editor)) {
      if (!this.projectionMissingNotified) {
        this.projectionMissingNotified = true;
        lumine.notifications.addWarning(
          "Enable language-ipython and its grammar to analyze this IPython document.",
        );
      }
      return null;
    }
    try {
      return await this.ipythonSource.project(editor, { signal });
    } catch {
      return null;
    }
  },

  projectedTask(editor, externalSignal) {
    const controller = new AbortController();
    this.projectedTasks?.add(controller);
    const subscriptions = new CompositeDisposable();
    if (editor)
      subscriptions.add(
        editor.getBuffer().onWillChange(() => controller.abort()),
        editor.onDidDestroy(() => controller.abort()),
        editor.onDidChangePath(() => controller.abort()),
        editor.onDidChangeGrammar(() => controller.abort()),
      );
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    return {
      controller,
      signal: controller.signal,
      dispose: () => {
        subscriptions.dispose();
        externalSignal?.removeEventListener("abort", onAbort);
        this.projectedTasks?.delete(controller);
      },
    };
  },

  provideLinter() {
    return {
      name: "Ruff",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: this.grammarScopes,
      lint: this.lint.bind(this),
    };
  },

  consumeLinterRegistry(registerIndie) {
    const delegate = registerIndie({
      name: "Ruff/Project",
      deleteOnOpen: lumine.config.get("linter-ruff.deleteOnOpen"),
    });
    indie.register(delegate, this);
    const registration = new Disposable(() => {
      delegate.dispose();
      if (indie.indieDelegate === delegate) indie.register(null, null);
    });
    this.disposables.add(registration);
    return registration;
  },

  consumeBusySignal(busySignal) {
    indie.setBusySignal(busySignal);
    return new Disposable(() => {
      if (indie.busySignal === busySignal) indie.setBusySignal(null);
    });
  },

  consumeTreeViewSelection(treeView) {
    indie.setTreeView(treeView);
    return new Disposable(() => {
      indie.setTreeView(null);
    });
  },

  consumeIdeClient(ideClient) {
    this.ideClient = ideClient;
    // An adapter that registers after an editor was linted leaves this
    // package's messages on screen beside the server's, until something asks
    // for another pass. The same holds in reverse when ide-ruff is disabled.
    const subscriptions = new CompositeDisposable();
    const relint = () => {
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "linter:lint");
    };
    const adaptersSubscription = ideClient.onDidChangeAdapters?.(relint);
    if (adaptersSubscription) subscriptions.add(adaptersSubscription);
    const featuresSubscription = ideClient.onDidChangeFeatures?.(({ adapter }) => {
      if (adapter.id === IDE_RUFF_ADAPTER_ID) relint();
    });
    if (featuresSubscription) subscriptions.add(featuresSubscription);
    return new Disposable(() => {
      subscriptions.dispose();
      this.ideClient = null;
    });
  },

  // Registration, not a running session: the answer has to be settled before
  // the first lint of a freshly opened file, and it must not flip back while a
  // server starts or restarts. It also stays accurate as ide-ruff's own scope
  // list moves — `source.python.django` is this package's alone only for as
  // long as no adapter claims it.
  //
  // A notebook is the notebook-shaped version of the same question: its hidden
  // source editor never matches an adapter's grammar scopes, so the hub is
  // asked which adapters serve the OPEN NOTEBOOK — jupyter-view's own bridge plus a
  // notebook-syncing ruff server. Absent a bridge, or a ruff without
  // notebook sync, the answer is empty and the CLI route keeps the notebook.
  isServedByIdeRuff(editor) {
    const isNotebook = editor.getGrammar?.()?.scopeName === "source.jupyter";
    const adapters = isNotebook
      ? this.ideClient?.adaptersForNotebook?.(editor.getPath()) || []
      : this.ideClient?.adaptersForEditor?.(editor) || [];
    const registered = adapters.some((adapter) => adapter.id === IDE_RUFF_ADAPTER_ID);
    if (!registered) return false;
    // The scope must match the one ide-client gates its publishes with: for a
    // notebook that is the python cell editors' scope, not the hidden source
    // editor's `source.jupyter` — a scoped toggle would otherwise stand the
    // CLI down while the server's publishes stay off, or the reverse.
    // The public notebook bridge reports adapters, not a live cell editor.
    // Python notebook cells use the original Python grammar; the IPython
    // document scope belongs to standalone .ipy files.
    const scope = isNotebook ? ["source.python"] : editor?.getRootScopeDescriptor?.();
    return lumine.config.get("ide-ruff.features.diagnostics", { scope }) !== false;
  },

  // The active editor, but only when Ruff has anything to say about it. These
  // commands sit in an always-visible menu that dispatches at whatever holds
  // focus, so the grammar the registration used to encode is checked here.
  pythonEditor() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (!editor) {
      return null;
    }
    if (!this.grammarScopes.includes(editor.getGrammar().scopeName)) {
      lumine.notifications.addWarning("Not a Python file");
      return null;
    }
    return editor;
  },

  lint(editor, fix = false, { signal } = {}) {
    const grammarScope = editor.getGrammar().scopeName;
    if (!this.grammarScopes.includes(grammarScope)) {
      return;
    }
    // An empty result rather than nothing at all: the linter keeps the previous
    // messages for a provider that returns nothing, which is exactly the
    // duplicate this is standing down to avoid. `fix` is the explicit command
    // and runs either way — asking for it is asking for this package.
    if (!fix && this.isServedByIdeRuff(editor)) {
      return Promise.resolve([]);
    }
    if (
      grammarScope === "source.python.ipy" ||
      path.extname(editor.getPath() || "").toLowerCase() === ".ipy"
    )
      return this.lintProjected(editor, fix, { signal });
    return new Promise((resolve, reject) => {
      if (!this.state) {
        return resolve([]);
      }
      let editorPath = editor.getPath();
      if (!editorPath) {
        return resolve([]);
      }
      let editorText = editor.getText();
      const isNotebook = grammarScope === "source.jupyter";
      const prepared = this.prepareEditorText(editorText, {
        includeIpythonVars: !fix,
        isNotebook,
      });
      editorText = prepared.text;

      let args = [
        ...this.ruffExtraArgs,
        "check",
        "--quiet",
        "--output-format=json",
        `--stdin-filename=${editorPath}`,
      ];
      this.appendCheckArgs(args);
      if (fix) {
        args.push("--fix-only");
      }
      const editorDir = path.dirname(editorPath);
      const cwd = editor.getBuffer().file?.existsSync() ? editorDir : undefined;
      let opts = {
        timeout: 10 * 1e4,
        cwd,
        maxBuffer: 1024 * 1024 * 100,
      };

      const child = this.execFile(this.ruffExe, args, opts, (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          lumine.notifications.addError(`\`${this.ruffExe}\` not found.`, {
            description: `Check the "Ruff Command" setting in linter-ruff.`,
          });
          return resolve([]);
        }
        if (stderr) {
          reject(error);
          return;
        }
        if (fix) {
          editor.getBuffer().setTextViaDiff(this.restoreEditorText(stdout, prepared));
          resolve();
          return;
        }
        let items;
        try {
          items = JSON.parse(stdout);
        } catch (err) {
          reject(err);
          return;
        }
        let data = [];
        for (let item of Object.values(items)) {
          const msg = this.convertMessage(editorPath, item, prepared.hiddenlines);
          if (msg) data.push(msg);
        }
        resolve(data);
      });

      child.stdin.write(editorText);
      child.stdin.end();
    });
  },

  async lintProjected(editor, fix = false, { signal } = {}) {
    if (!this.state || editor.isDestroyed()) return [];
    const filePath = editor.getPath();
    if (!filePath) return [];
    const task = this.projectedTask(editor, signal);
    this.projectedLint?.get(editor.getBuffer())?.abort();
    this.projectedLint?.set(editor.getBuffer(), task.controller);
    try {
      const projection = await this.projectionFor(editor, task.signal);
      if (!projection?.isCurrent() || task.signal.aborted) return [];
      const args = [
        ...this.ruffExtraArgs,
        "check",
        "--quiet",
        "--output-format=json",
        `--stdin-filename=${filePath}`,
        "--extension=ipy:python",
      ];
      this.appendCheckArgs(args);
      if (fix) args.push("--fix-only");
      const stdout = await this.runProjectedRuff(editor, args, projection.text, task.signal);
      if (stdout === null || !projection.isCurrent()) return [];
      if (fix) {
        const { diffEdits, applyEdits } = require("./projected-edits");
        const edits = projection.mapEdits(diffEdits(projection.text, stdout));
        if (!edits || !projection.isCurrent()) {
          lumine.notifications.addWarning(
            "Ruff's fix would change protected IPython source. No changes were applied.",
          );
          return [];
        }
        applyEdits(editor, edits);
        return [];
      }
      return this.projectedMessages(filePath, JSON.parse(stdout), projection);
    } catch (error) {
      if (task.signal.aborted) return [];
      if (fix) {
        lumine.notifications.addError("Ruff fix failed", { detail: error.message });
        return [];
      }
      throw error;
    } finally {
      if (this.projectedLint?.get(editor.getBuffer()) === task.controller)
        this.projectedLint.delete(editor.getBuffer());
      task.dispose();
    }
  },

  projectedMessages(filePath, items, projection) {
    const data = [];
    for (const item of items) {
      if (!item.location || !item.end_location) continue;
      const start = projection.fromCodePointPosition(
        new Point(item.location.row - 1, item.location.column - 1),
      );
      const end = projection.fromCodePointPosition(
        new Point(item.end_location.row - 1, item.end_location.column - 1),
      );
      if (!start || !end) continue;
      const serverRange = new Range(start, end);
      const range = projection.fromServerRange(serverRange);
      if (!range || !projection.isPythonRange(range)) continue;
      const message = this.convertMessage(filePath, {
        ...item,
        location: { ...item.location },
        end_location: { ...item.end_location },
      });
      if (message) {
        message.location.position = Range.fromObject(range).serialize();
        data.push(message);
      }
    }
    return projection.isCurrent() ? data : [];
  },

  async lintClosedProjected(filePath, { signal } = {}) {
    const provider = this.ipythonSource;
    if (!provider?.projectText) {
      lumine.notifications.addWarning("Enable language-ipython to analyze IPython documents.");
      return [];
    }
    const task = this.projectedTask(null, signal);
    let projection;
    try {
      const before = await fs.stat(filePath);
      const source = await fs.readFile(filePath, "utf8");
      projection = await provider.projectText(source, { filePath, signal: task.signal });
      if (!projection?.isCurrent() || task.signal.aborted) return [];
      const args = [
        ...this.ruffExtraArgs,
        "check",
        "--quiet",
        "--output-format=json",
        `--stdin-filename=${filePath}`,
        "--extension=ipy:python",
      ];
      this.appendCheckArgs(args);
      const editor = {
        getPath: () => filePath,
        getBuffer: () => ({ file: { existsSync: () => true } }),
      };
      const stdout = await this.runProjectedRuff(editor, args, projection.text, task.signal);
      if (stdout === null || !projection.isCurrent() || task.signal.aborted) return [];
      const after = await fs.stat(filePath);
      if (
        after.mtimeMs !== before.mtimeMs ||
        after.size !== before.size ||
        (await fs.readFile(filePath, "utf8")) !== source
      )
        return [];
      return this.projectedMessages(filePath, JSON.parse(stdout), projection);
    } catch (error) {
      if (task.signal.aborted) return [];
      throw error;
    } finally {
      projection?.dispose();
      task.dispose();
    }
  },

  runProjectedRuff(editor, args, text, signal) {
    const filePath = editor.getPath();
    return new Promise((resolve, reject) => {
      const child = this.execFile(
        this.ruffExe,
        args,
        {
          timeout: 100000,
          cwd:
            filePath && editor.getBuffer().file?.existsSync() ? path.dirname(filePath) : undefined,
          maxBuffer: 100 * 1024 * 1024,
          signal,
        },
        (error, stdout, stderr) => {
          if (signal?.aborted) {
            resolve(null);
          } else if (error?.code === "ENOENT") {
            lumine.notifications.addError(`\`${this.ruffExe}\` not found.`);
            resolve(null);
          } else if (stderr) {
            reject(error || new Error(stderr));
          } else {
            resolve(stdout);
          }
        },
      );
      child.stdin.write(text);
      child.stdin.end();
    });
  },

  prepareEditorText(text, { includeIpythonVars, isNotebook }) {
    if (!this.allowMagic || isNotebook) {
      return { text, hiddenlines: 0, magicLines: [], hasIpythonVars: false };
    }

    const magicLines = [];
    const preparedText = this.maskMagicLines(text, magicLines);
    if (!includeIpythonVars) {
      return { text: preparedText, hiddenlines: 0, magicLines, hasIpythonVars: false };
    }

    // Predefine special IPython variables to avoid undefined errors in diagnostics.
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return {
      text: `${IPYTHON_VARS_STUB}${eol}${preparedText}`,
      hiddenlines: 1,
      magicLines,
      hasIpythonVars: true,
    };
  },

  maskMagicLines(text, magicLines) {
    const parts = text.split(/(\r\n|\n|\r)/);

    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index];
      const introspectionMatch = line.match(/^(\s*)(\?\??[\w.]+|\S+\?\??)(\s*)$/);
      if (!line.startsWith("%") && !introspectionMatch) {
        continue;
      }

      const indentation = introspectionMatch ? introspectionMatch[1] : "";
      parts[index] = `${indentation}# ${MAGIC_PLACEHOLDER_PREFIX}${magicLines.length}`;
      magicLines.push(line);
    }

    return parts.join("");
  },

  restoreEditorText(text, prepared) {
    const restoredText = prepared.hasIpythonVars ? this.removeIpythonVarsStub(text) : text;

    if (!prepared.magicLines.length) {
      return restoredText;
    }

    const parts = restoredText.split(/(\r\n|\n|\r)/);
    const placeholderPattern = new RegExp(`^\\s*# ${MAGIC_PLACEHOLDER_PREFIX}(\\d+)\\s*$`);

    for (let index = 0; index < parts.length; index += 2) {
      const match = parts[index].match(placeholderPattern);
      if (!match) {
        continue;
      }

      const originalLine = prepared.magicLines[Number(match[1])];
      if (originalLine != null) {
        parts[index] = originalLine;
      }
    }

    return parts.join("");
  },

  removeIpythonVarsStub(text) {
    for (const eol of ["\r\n", "\n", "\r"]) {
      const prefix = `${IPYTHON_VARS_STUB}${eol}`;
      if (text.startsWith(prefix)) {
        return text.slice(prefix.length);
      }
    }

    return text === IPYTHON_VARS_STUB ? "" : text;
  },

  appendCheckArgs(args) {
    if (this.select.length) {
      args.push(`--select=${this.select.join(",")}`);
    }
    if (this.ignore.length) {
      args.push(`--ignore=${this.ignore.join(",")}`);
    }
    if (this.fixable.length) {
      args.push(`--fixable=${this.fixable.join(",")}`);
    }
    if (this.unfixable.length) {
      args.push(`--unfixable=${this.unfixable.join(",")}`);
    }
    if (!this.useNoqa) {
      args.push("--ignore-noqa");
    }
    if (this.pyVersion) {
      args.push(`--target-version=${this.pyVersion}`);
    }
  },

  convertMessage(filePath, item, hiddenlines = 0) {
    if (item.location.row <= hiddenlines) {
      return null;
    }

    let severity;
    if (item.code === null || item.code === "E999") {
      severity = "error";
      item.location.column = 1;
      item.code = null;
    } else if (this.isError(item.code)) {
      severity = "error";
    } else if (this.isWarning(item.code)) {
      severity = "warning";
    } else if (this.isInfo(item.code)) {
      severity = "info";
    } else if (this.isHint(item.code)) {
      severity = "hint";
    } else {
      severity = "error";
      if (this.addStar) {
        item.code += "*";
      }
    }

    const message = {
      severity,
      excerpt: item.code ? `${item.code}: ${item.message}` : item.message,
      location: {
        file: filePath,
        position: [
          [item.location.row - 1 - hiddenlines, item.location.column - 1],
          [item.end_location.row - 1 - hiddenlines, item.end_location.column - 1],
        ],
      },
    };

    // The cell number alone: jupyter-view projects the message onto every
    // split view's own cell buffer, so a buffer named here would tie the
    // message to one view.
    if (item.cell != null) {
      message.location.cell = item.cell;
    }

    return message;
  },

  parseClass(patterns) {
    return (code) => {
      for (let pattern of patterns) {
        if (code.startsWith(pattern)) {
          return true;
        }
      }
      return false;
    };
  },

  getDefaultConfigPath() {
    let platform = os.platform();
    if (platform === "win32") {
      return path.join(os.homedir(), "AppData", "Roaming", "ruff", "pyproject.toml");
    } else {
      lumine.notifications.addError(
        `Default config path has not been set on platform "${platform}"`,
      );
    }
  },

  openDefaultConfigFile() {
    let configPath = this.getDefaultConfigPath();
    if (!configPath) {
      return;
    }
    lumine.workspace.open(configPath);
  },

  formatter(mode) {
    const editor = this.pythonEditor();
    if (!editor) return;
    if (
      editor.getGrammar().scopeName === "source.python.ipy" ||
      path.extname(editor.getPath() || "").toLowerCase() === ".ipy"
    )
      return this.formatProjected(editor, mode);
    let editorPath = editor.getPath();
    let selections = mode ? [editor] : editor.getSelections();
    for (let selection of selections) {
      if (selection.isEmpty()) {
        continue;
      }
      let selectionText = selection.getText();

      let args = [...this.ruffExtraArgs, "format", `--stdin-filename=${editorPath}`, "--quiet"];
      let opts = {
        timeout: 10 * 1e4,
        cwd: path.dirname(editorPath),
        maxBuffer: 1024 * 1024 * 100,
      };
      const child = this.execFile(this.ruffExe, args, opts, (error, stdout, stderr) => {
        if (stderr) {
          lumine.notifications.addError("`ruff` formatter has failed");
        } else {
          if (mode) {
            let curPos = editor.getCursorBufferPosition();
            editor.setText(stdout);
            editor.setCursorBufferPosition(curPos);
          } else {
            selection.insertText(stdout, { select: true });
          }
        }
      });
      child.stdin.write(selectionText);
      child.stdin.end();
    }
  },

  async formatProjected(editor, entireFile) {
    const task = this.projectedTask(editor);
    this.projectedFormats?.get(editor.getBuffer())?.abort();
    this.projectedFormats?.set(editor.getBuffer(), task.controller);
    const selections = editor.getSelectedBufferRanges().map((range) => range.copy());
    const selectionCurrent = () =>
      editor.getSelectedBufferRanges().length === selections.length &&
      editor.getSelectedBufferRanges().every((range, index) => range.isEqual(selections[index]));
    try {
      const projection = await this.projectionFor(editor, task.signal);
      if (
        !projection?.isCurrent() ||
        task.signal.aborted ||
        !editor.getPath() ||
        !selectionCurrent()
      )
        return;
      const selected = entireFile ? null : selections.filter((range) => !range.isEmpty());
      if (selected && !selected.length) return;
      const { diffEdits, applyEdits } = require("./projected-edits");
      const edits = [];
      const batch = await projection.getFormattingBatch(selected || undefined);
      if (!projection.isCurrent() || task.signal.aborted || !selectionCurrent()) return;
      if (!batch) return;
      const stdout = await this.runProjectedRuff(
        editor,
        [
          ...this.ruffExtraArgs,
          "format",
          `--stdin-filename=${editor.getPath()}`,
          "--extension=ipy:python",
          "--quiet",
        ],
        batch.text,
        task.signal,
      );
      if (stdout === null || !projection.isCurrent() || !selectionCurrent()) return;
      const restored = batch.restore(stdout);
      if (restored === null) {
        lumine.notifications.addWarning(
          "Ruff's format would change protected IPython source. No changes were applied.",
        );
        return;
      }
      for (const block of restored) {
        if (selected && !selected.some((range) => range.intersectsWith(block.range))) continue;
        const original = editor.getTextInBufferRange(block.range);
        for (const edit of diffEdits(original, block.text)) {
          const toSource = (point) =>
            new Point(
              block.range.start.row + point.row,
              point.column + (point.row === 0 ? block.range.start.column : 0),
            );
          const oldRange = new Range(toSource(edit.oldRange.start), toSource(edit.oldRange.end));
          if (
            !block.range.containsRange(oldRange) ||
            (selected && !selected.some((range) => range.containsRange(oldRange)))
          )
            return;
          edits.push({ oldRange, newText: edit.newText });
        }
      }
      if (!projection.isCurrent() || !selectionCurrent()) return;
      applyEdits(editor, edits);
    } catch (error) {
      if (!task.signal.aborted)
        lumine.notifications.addError("Ruff formatter failed", { detail: error.message });
    } finally {
      if (this.projectedFormats?.get(editor.getBuffer()) === task.controller)
        this.projectedFormats.delete(editor.getBuffer());
      task.dispose();
    }
  },
};
