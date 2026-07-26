# linter-ruff

A wrapper around the Python linter and formatter ruff.

The package uses the linter top-level API to visualize [ruff](https://github.com/astral-sh/ruff) errors and other types of messages with ease.

## Features

- **Fast linting**: lints Python buffers on the fly through ruff, an extremely fast linter written in Rust.
- **Notebook support**: lints `.py` files and Jupyter notebooks (`.ipynb`); in notebook mode each code cell is linted individually and messages are mapped to the correct cell via [jupyter-view](https://github.com/lumine-code/jupyter-view).
- **Autofix**: attempts to automatically fix lint violations for fixable rules.
- **Formatting**: formats the whole editor or only the selected text through `ruff format`.
- **Project scans**: scans whole projects or tree-view selections and reports results through the indie linter API.
- **Severity mapping**: classifies rule codes as error, warning or info via package settings.
- **Magic commands**: optionally bypasses IPython magic commands like `%timeit` in scripts.

## Installation

To install `linter-ruff` search for _linter-ruff_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/linter-ruff`.

For command line use, ruff is installed with `pip install ruff`. Ruff supports over 800 lint [rules](https://docs.astral.sh/ruff/rules/), many of which are inspired by popular tools like Flake8, isort and pyupgrade.

## Commands

Commands available in `atom-workspace`:

- `linter-ruff:toggle-state`: toggle config of linter state,
- `linter-ruff:toggle-noqa`: toggle config of noqa setting,
- `linter-ruff:lint-projects`: scan entire project for lint issues,
- `linter-ruff:lint-selected`: scan selected tree-view files or folders for lint issues,
- `linter-ruff:global-pyproject`: open ruff global config file.

Commands available in `atom-text-editor[data-grammar="source python"]:not([mini])`:

- `linter-ruff:fix-all`: attempt to fix violations,
- `linter-ruff:format-editor`: format text of current text-editor,
- `linter-ruff:format-selected`: format selections of current text-editor.

## Services

- **linter.provider** (`1.0.0`): provided to the linter package; exposes the Ruff file linter with its name, grammar scopes and `lint` function.
- **linter.registry** (`^1.0.0`): consumed to report project-wide scan results through an indie linter delegate.
- **busy-signal.reporter** (`^1.0.0`): consumed to show a busy message while project scans are running.
- **tree-view** (`^1.0.0`): consumed to resolve the selected files or folders for `linter-ruff:lint-selected`.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
