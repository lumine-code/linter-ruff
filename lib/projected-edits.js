const { TextBuffer, Point, Range } = require("lumine");

// Diff a returned document without ever installing it in the user's buffer.
// The scratch buffer has no editor or maintained grammar and is always released.
function diffEdits(before, after) {
  if (before === after) return [];
  const buffer = new TextBuffer({ text: before });
  try {
    const checkpoint = buffer.createCheckpoint();
    buffer.setTextViaDiff(after);
    return buffer.getChangesSinceCheckpoint(checkpoint).map(({ oldRange, newText }) => ({
      oldRange: Range.fromObject(oldRange),
      newText,
    }));
  } finally {
    buffer.destroy();
  }
}

function applyEdits(editor, edits) {
  editor.transact(() => {
    for (const edit of [...edits].sort((a, b) => b.oldRange.start.compare(a.oldRange.start))) {
      editor.setTextInBufferRange(edit.oldRange, edit.newText);
    }
  });
}

function translatedSelections(selections, edits) {
  const sorted = edits.toSorted((a, b) => a.oldRange.start.compare(b.oldRange.start));
  const translate = (position, affinity) => {
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle].oldRange.start.compare(position) <= 0) low = middle + 1;
      else high = middle;
    }
    const change = sorted[low - 1];
    if (!change) return Point.fromObject(position).copy();
    if (position.compare(change.oldRange.end) <= 0) {
      return affinity === "left" &&
        !change.oldRange.isEmpty() &&
        position.isEqual(change.oldRange.start)
        ? change.newRange.start.copy()
        : change.newRange.end.copy();
    }
    return change.newRange.end.traverse(position.traversalFrom(change.oldRange.end));
  };
  return selections.map(({ range, reversed }) => ({
    range: new Range(
      translate(range.start, range.isEmpty() ? "right" : "left"),
      translate(range.end, "right"),
    ),
    reversed,
  }));
}

module.exports = { diffEdits, applyEdits, translatedSelections };
