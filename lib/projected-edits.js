const { TextBuffer, Range } = require("lumine");

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

module.exports = { diffEdits, applyEdits };
