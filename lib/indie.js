const { BufferedProcess } = require("lumine");
const fs = require("fs");
const path = require("path");

/**
 * Project-wide Ruff linter using the indie linter API.
 * Scans all project files from disk via ruff check and reports
 * results through the linter IndieDelegate.
 */
class ProjectLinter {
  constructor() {
    this.indieDelegate = null;
    this.busySignal = null;
    this.busyProvider = null;
    this.scanning = false;
    /** @type {Object|null} Reference to main module for config access */
    this.main = null;
    this.treeView = null;
  }

  /**
   * Store the IndieDelegate obtained from linter-bundle.
   * @param {IndieDelegate} delegate
   * @param {Object} main - Reference to main module for config access
   */
  register(delegate, main) {
    this.indieDelegate = delegate;
    this.main = main;
  }

  setBusySignal(busySignal) {
    this.busySignal = busySignal;
  }

  setTreeView(treeView) {
    this.treeView = treeView;
  }

  startBusyMessage() {
    this.disposeBusyMessage();
    if (this.busySignal && typeof this.busySignal.create === "function") {
      this.busyProvider = this.busySignal.create();
      this.busyProvider.add("Scanning project with Ruff");
    }
  }

  disposeBusyMessage() {
    this.busyProvider?.dispose();
    this.busyProvider = null;
  }

  /**
   * Run ruff check on a project path and return parsed JSON results.
   * @param {string} projectPath
   * @param {string[]} targetPaths
   * @returns {Promise<Array>}
   */
  execRuff(projectPath, targetPaths = [projectPath]) {
    return new Promise((resolve) => {
      const args = [
        ...this.main.ruffExtraArgs,
        "check",
        "--quiet",
        "--output-format=json",
        "--extend-exclude=*.ipy",
        ...targetPaths,
      ];
      this.main.appendCheckArgs(args);
      let stdout = "";
      let stderr = "";
      const proc = new BufferedProcess({
        command: this.main.ruffExe,
        args,
        options: { cwd: projectPath },
        stdout: (data) => {
          stdout += data;
        },
        stderr: (data) => {
          stderr += data;
        },
        exit: () => {
          if (stderr) {
            console.error("[linter-ruff] Project scan stderr:", stderr);
            resolve([]);
            return;
          }
          if (!stdout || !stdout.trim()) {
            resolve([]);
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (err) {
            console.error("[linter-ruff] Project scan JSON parse error:", err);
            resolve([]);
          }
        },
      });
      proc.onWillThrowError(({ handle }) => {
        handle();
        resolve([]);
      });
    });
  }

  discoverIpythonFiles(projectPath, targetPaths) {
    const signal = this.scanAbortController.signal;
    return new Promise((resolve, reject) => {
      const args = [
        ...this.main.ruffExtraArgs,
        "check",
        "--show-files",
        "--extension=ipy:python",
        ...targetPaths,
      ];
      this.main.appendCheckArgs(args);
      this.main.execFile(
        this.main.ruffExe,
        args,
        { cwd: projectPath, signal, timeout: 100000, maxBuffer: 100 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (signal.aborted) return resolve([]);
          if (error || stderr) return reject(error || new Error(stderr));
          resolve([
            ...new Set(
              stdout
                .split(/\r?\n/)
                .map((file) => file.trim())
                .filter((file) => path.extname(file).toLowerCase() === ".ipy")
                .map((file) => path.resolve(projectPath, file)),
            ),
          ]);
        },
      );
    });
  }

  /**
   * Run the project-wide ruff scan.
   */
  getProjectPathForPath(filePath) {
    return lumine.project.getPaths().find((projectPath) => {
      const relativePath = path.relative(projectPath, filePath);
      return (
        relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
      );
    });
  }

  getSelectedScanItems() {
    if (!this.treeView || typeof this.treeView.selectedPaths !== "function") return [];

    const selectedPaths = this.treeView
      .selectedPaths()
      .filter(Boolean)
      .filter((selectedPath, index, paths) => paths.indexOf(selectedPath) === index)
      .filter((selectedPath) => {
        try {
          return fs.existsSync(selectedPath);
        } catch {
          return false;
        }
      });

    const scanItemsByProject = new Map();
    for (const selectedPath of selectedPaths) {
      const projectPath = this.getProjectPathForPath(selectedPath);
      if (!projectPath) continue;

      if (!scanItemsByProject.has(projectPath)) {
        scanItemsByProject.set(projectPath, {
          projectPath,
          targetPaths: [],
        });
      }
      scanItemsByProject.get(projectPath).targetPaths.push(selectedPath);
    }

    return Array.from(scanItemsByProject.values());
  }

  runSelectedScan() {
    const scanItems = this.getSelectedScanItems();
    if (!scanItems.length) {
      lumine.notifications.addWarning("Ruff selected scan skipped", {
        detail: "Select one or more files or folders in the tree view first.",
        dismissable: true,
      });
      return;
    }

    this.runScan(scanItems);
  }

  async runScan(scanItems = null) {
    if (!this.indieDelegate || !this.main) return;
    if (this.scanning) return;

    this.scanning = true;
    const controller = new AbortController();
    this.scanAbortController = controller;
    const main = this.main;
    const delegate = this.indieDelegate;
    const current = () =>
      !controller.signal.aborted && this.main === main && this.indieDelegate === delegate;
    this.startBusyMessage();

    const resolvedScanItems =
      scanItems ||
      lumine.project.getPaths().map((projectPath) => ({
        projectPath,
        targetPaths: [projectPath],
      }));
    if (!resolvedScanItems.length) {
      this.disposeBusyMessage();
      this.scanning = false;
      this.scanAbortController = null;
      return;
    }

    const allMessages = [];

    try {
      for (const scanItem of resolvedScanItems) {
        const projectPath = scanItem.projectPath || scanItem;
        const requested = scanItem.targetPaths || [projectPath];
        const targetPaths = requested.filter((target) => {
          if (path.extname(target).toLowerCase() !== ".ipy") return true;
          try {
            return fs.statSync(target).isDirectory();
          } catch {
            return false;
          }
        });
        const ipythonFiles = await this.discoverIpythonFiles(projectPath, requested);
        if (!current()) return;
        for (const filePath of ipythonFiles) {
          if (!current()) return;
          const open = lumine.workspace
            .getTextEditors()
            .find((editor) => editor.getPath() === filePath);
          const messages = open
            ? await main.lint(open, false, { signal: controller.signal })
            : await main.lintClosedProjected(filePath, { signal: controller.signal });
          allMessages.push(...(messages || []));
        }
        if (!current()) return;
        const items = targetPaths.length ? await this.execRuff(projectPath, targetPaths) : [];
        if (!current()) return;

        for (const item of items) {
          const filePath = item.filename;
          if (!filePath) continue;
          if (path.extname(filePath).toLowerCase() === ".ipy") continue;

          const msg = main.convertMessage(filePath, item);
          if (msg) allMessages.push(msg);
        }
      }

      if (!current()) return;
      delegate.setAllMessages(allMessages, {
        showProjectView: true,
      });
    } catch (error) {
      console.error("[linter-ruff] Project scan failed:", error);
    } finally {
      this.scanning = false;
      this.scanAbortController = null;
      this.disposeBusyMessage();
    }
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    this.scanAbortController?.abort();
    this.disposeBusyMessage();
    this.busySignal = null;
    this.treeView = null;
    this.main = null;
    this.indieDelegate = null;
  }
}

module.exports = new ProjectLinter();
