const { CompositeDisposable, Disposable } = require("lumine");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const indie = require("./indie");

// ide-ruff reports the same violations over the language-server protocol, so
// wherever its adapter covers an editor this package reports none. Both stay
// installed and both stay useful: the server never sees a notebook, a file
// nobody opened, or the fix and format commands here.
const IDE_RUFF_ADAPTER_ID = "ide-ruff";
const IPYTHON_VARS_STUB = "_ = 0 ; __ = 0 ; ___ = 0";
const MAGIC_PLACEHOLDER_PREFIX = "linter-ruff-magic:";

module.exports = {
  // Kept as a property so specs can substitute a fake ruff process.
  execFile,

  activate() {
    this.disposables = new CompositeDisposable();

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
        "linter-ruff:toggle-state": () => {
          lumine.config.set("linter-ruff.state", !this.state);
        },
        "linter-ruff:toggle-noqa": () => {
          lumine.config.set("linter-ruff.useNoqa", !this.useNoqa);
        },
        "linter-ruff:global-pyproject": () => {
          this.openDefaultConfigFile();
        },
        "linter-ruff:lint-projects": () => {
          indie.runScan();
        },
        // The tree view is inside the workspace, so its context menu reaches
        // this handler on its own. A second registration on .tree-view would
        // run the scan twice for every dispatch from there.
        "linter-ruff:lint-selected": () => {
          indie.runSelectedScan();
        },
        "linter-ruff:fix-all": () => {
          const editor = this.pythonEditor();
          if (editor) this.lint(editor, true);
        },
        "linter-ruff:format-editor": () => {
          this.formatter(true);
        },
        "linter-ruff:format-selected": () => {
          this.formatter(false);
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
    indie.dispose();
    this.ideClient = null;
    this.disposables.dispose();
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
    this.disposables.add(delegate);
    indie.register(delegate, this);
  },

  consumeBusySignal(busySignal) {
    indie.setBusySignal(busySignal);
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
  // list moves — the notebook source buffer and `source.python.django` are
  // this package's alone only for as long as no adapter claims them.
  isServedByIdeRuff(editor) {
    const adapters = this.ideClient?.adaptersForEditor?.(editor) || [];
    const registered = adapters.some((adapter) => adapter.id === IDE_RUFF_ADAPTER_ID);
    if (!registered) return false;
    return (
      lumine.config.get("ide-ruff.features.diagnostics", {
        scope: editor?.getRootScopeDescriptor?.(),
      }) !== false
    );
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

  lint(editor, fix = false) {
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
          const msg = this.convertMessage(editorPath, item, prepared.hiddenlines, {
            notebookEditor: isNotebook ? editor.jupyterNotebookEditor : null,
          });
          if (msg) data.push(msg);
        }
        resolve(data);
      });

      child.stdin.write(editorText);
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

  convertMessage(filePath, item, hiddenlines = 0, options = {}) {
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

    if (item.cell != null) {
      message.location.cell = item.cell;

      const cellEditor = options.notebookEditor?.getCellEditor?.(item.cell);
      const cellBuffer = cellEditor?.getBuffer?.();
      if (cellBuffer) {
        message.location.buffer = cellBuffer;
      }
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
};
