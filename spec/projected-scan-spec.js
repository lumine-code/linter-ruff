const path = require("path");

describe("Ruff project scans of projected IPython", () => {
  let main, indie, registration, editor;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    indie = require("../lib/indie");
  });
  afterEach(() => {
    registration?.dispose();
    registration = null;
    editor?.destroy();
    editor = null;
    main.execFile = require("child_process").execFile;
  });
  it("uses Ruff's discovered paths, scans closed documents serially and routes open buffers through the shared provider", async () => {
    const project = path.resolve(__dirname, "fixtures");
    const openPath = path.join(project, "open.ipy"),
      first = path.join(project, "first.ipy"),
      second = path.join(project, "second.ipy");
    editor = await lumine.workspace.open(openPath);
    const published = jasmine.createSpy("publish");
    registration = main.consumeLinterRegistry(() => ({ dispose() {}, setAllMessages: published }));
    let active = 0,
      maximum = 0;
    const closed = [];
    spyOn(main, "lintClosedProjected").and.callFake(async (filePath, { signal }) => {
      expect(signal.aborted).toBe(false);
      closed.push(filePath);
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return [{ location: { file: filePath } }];
    });
    const open = spyOn(main, "lint").and.resolveTo([{ location: { file: openPath } }]);
    const raw = spyOn(indie, "execRuff").and.resolveTo([]);
    const discoveryCalls = [];
    main.execFile = (exe, args, options, reply) => {
      discoveryCalls.push({ args, options });
      queueMicrotask(() =>
        reply(
          null,
          [first, openPath, second, path.join(project, "sample.py"), first].join("\n"),
          "",
        ),
      );
    };
    await indie.runScan([{ projectPath: project, targetPaths: [project] }]);
    expect(discoveryCalls[0].args).toContain("--show-files");
    expect(discoveryCalls[0].args).toContain("--extension=ipy:python");
    expect(closed).toEqual([first, second]);
    expect(maximum).toBe(1);
    expect(open).toHaveBeenCalledWith(editor, false, { signal: discoveryCalls[0].options.signal });
    expect(raw).toHaveBeenCalledWith(project, [project]);
    expect(published.calls.mostRecent().args[0].length).toBe(3);
    expect(indie.scanAbortController).toBeNull();
  });
  it("does not publish an in-flight scan after the provider is disposed", async () => {
    const project = path.resolve(__dirname, "fixtures");
    const published = jasmine.createSpy("publish");
    registration = main.consumeLinterRegistry(() => ({ dispose() {}, setAllMessages: published }));
    main.execFile = (exe, args, options, reply) =>
      queueMicrotask(() => {
        indie.dispose();
        reply(null, path.join(project, "closed.ipy"), "");
      });
    const raw = spyOn(indie, "execRuff").and.resolveTo([]);
    await indie.runScan([{ projectPath: project, targetPaths: [project] }]);
    expect(raw).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });
});
