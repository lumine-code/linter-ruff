# linter-ruff

A wrapper around the Python linter and formatter ruff.

> [!WARNING]
> **This package is deprecated.** Ruff diagnostics and project scans are now provided by [ide-ruff](https://github.com/lumine-code/ide-ruff) through [ide-client](https://github.com/lumine-code/ide-client) and [linter](https://github.com/lumine-code/linter). Formatting and fixes use the IDE services. This repository is archived and no longer maintained.

The package uses the linter top-level API to visualize [ruff](https://github.com/astral-sh/ruff) errors and other types of messages with ease.

## Features

- **Fast linting**: lints Python buffers on the fly through ruff, an extremely fast linter written in Rust.
- **Notebook support**: lints `.py`, mixed `.ipy` documents and Jupyter notebooks (`.ipynb`); notebook messages are mapped to the correct cell via [jupyter-view](https://github.com/lumine-code/jupyter-view).
- **Autofix**: attempts to automatically fix lint violations for fixable rules.
- **Formatting**: formats the whole editor or only the selected text through `ruff format`.
- **Project scans**: scans whole projects or tree-view selections and reports results through the indie linter API.
- **Severity mapping**: classifies rule codes as error, warning, info or hint via package settings.
- **Magic commands**: optionally bypasses IPython magic commands like `%timeit` in scripts.

Mixed `.ipy` documents use language-ipython's passive `ipython.source` AST projection. Only Python reaches Ruff; literal Markdown, raw content, foreign magic bodies and IPython syntax remain protected. Diagnostics map codepoint positions back to source UTF-16 coordinates. Fixes are applied as validated minimal edits. Formatting combines the requested Python bodies into one Ruff process using comment delimiters, then restores each body and validates every edit before applying anything. Missing projection services and stale results produce no unsafe fallback or changes.

Project and tree-view scans discover `.ipy` paths through Ruff's configuration rules, exclude them from raw disk linting, and analyze them sequentially through the same projection. Open documents use their buffer snapshot; closed files use an ephemeral grammar model that is always disposed. A changed disk source is discarded before messages are published, and scans never rewrite closed files.

## Migration

Disable or uninstall `linter-ruff` and install `ide-ruff` with `ide-client`. Keep `linter` installed to display diagnostics and `linter-panel` to browse project scan results.

```sh
lumine --install lumine-code/ide-client
lumine --install lumine-code/ide-ruff
lumine --install lumine-code/linter
```

Use `ide-ruff:lint-projects` and `ide-ruff:lint-selected` for project and tree-view scans. The adapter uses the Ruff executable selected by its Server Path setting, managed installation, or PATH. Install `code-format` for file, selection, and save formatting, and `intentions` for Ruff fixes and import organization.

Keep `language-ipython` installed for mixed `.ipy` documents and `jupyter-view` for live notebook cell analysis. Rule overrides belong in `ide-ruff` settings or Ruff's configuration files; settings under `linter-ruff` are no longer read. The old per-rule severity classifications, star markers, ordinary-script magic bypass, state toggle, and global configuration-file shortcut are retired.

## Commands

Commands available in `lumine-workspace`:

- `linter-ruff:toggle-state`: toggle config of linter state,
- `linter-ruff:toggle-noqa`: toggle config of noqa setting,
- `linter-ruff:lint-projects`: scan entire project for lint issues,
- `linter-ruff:lint-selected`: scan selected tree-view files or folders for lint issues,
- `linter-ruff:global-pyproject`: open ruff global config file,
- `linter-ruff:fix-all`: attempt to fix violations,
- `linter-ruff:format-editor`: format text of current text-editor,
- `linter-ruff:format-selected`: format selections of current text-editor.

The last three act on the active editor and decline with a notification when its grammar is not Python.

## Services

- `linter.provider`: provided to the linter package; exposes the Ruff file linter with its name, grammar scopes and `lint` function.
- `linter.registry`: consumed to report project-wide scan results through an indie linter delegate.
- `ide-client`: consumed to see which editors a language-server adapter already covers, and to hear when that changes.
- `ipython.source`: consumed for shared AST projection, coordinate maps and protected formatting blocks in `.ipy` documents.
- `busy-signal`: consumed to show a busy message while project scans are running.
- `tree-view.selection`: consumed to resolve the selected files or folders for `linter-ruff:lint-selected`.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
