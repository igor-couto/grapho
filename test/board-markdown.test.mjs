import assert from "node:assert/strict";
import { test } from "node:test";
import { changeBoardCard, parseBoard, renderBoardMarkdown, setBoardHeading } from "../assets/board-markdown.js";

function cardContents(column) {
  return column.cards.map(({ title, description }) => ({ title, description }));
}

test("board Markdown supports indented cards, fenced details, and empty columns", () => {
  const source = [
    "# Release board",
    "",
    "Prepare the **next release**.",
    "",
    "## To do",
    "    - Internal review: Read the release checklist.",
    "    - Release notes:",
    "    ```",
    "        ## Changes",
    "        - Fix a bug",
    "          - Add a regression check",
    "    ```",
    "## In progress",
    "## Done",
    "## Follow-up",
  ].join("\r\n");

  const board = parseBoard(source);
  assert.equal(board.title, "Release board");
  assert.equal(board.description, "Prepare the **next release**.");
  assert.deepEqual(board.columns.map((column) => column.title), ["To do", "In progress", "Done", "Follow-up"]);
  assert.deepEqual(cardContents(board.columns[0]), [
    { title: "Internal review", description: "Read the release checklist." },
    { title: "Release notes", description: "## Changes\n- Fix a bug\n  - Add a regression check" },
  ]);
  assert.deepEqual(board.columns[1].cards, []);
});

test("inline and multiline Markdown can coexist and code fences protect board structure", () => {
  const source = [
    "Intro",
    "```",
    "## Not a column",
    "```",
    "## Ready",
    "- Deploy\\: staging: Check **logs**",
    "  - Keep this nested below the card",
    "- Document usage:",
    "  ````markdown",
    "  ### Example",
    "  ```sh",
    "  echo 'release'",
    "  ```",
    "  ````",
    "- Without a description",
  ].join("\n");

  const board = parseBoard(source);
  assert.equal(board.title, "");
  assert.equal(board.columns.length, 1);
  assert.deepEqual(cardContents(board.columns[0]), [
    { title: "Deploy: staging", description: "Check **logs**\n\n- Keep this nested below the card" },
    { title: "Document usage", description: "### Example\n```sh\necho 'release'\n```" },
    { title: "Without a description", description: "" },
  ]);
  assert.equal(
    renderBoardMarkdown(board.columns[0].cards[1].description),
    "<h3>Example</h3><pre>echo 'release'</pre>",
  );
  assert.equal(
    renderBoardMarkdown(board.columns[0].cards[0].description),
    "<p>Check <b>logs</b></p><p></p><ul><li>Keep this nested below the card</li></ul>",
  );
});

test("moves rebase card indentation without changing the fenced description or other source", () => {
  const source = [
    "# Release",
    "",
    "Intro",
    "",
    "## Queue",
    "    - Draft:",
    "    ```",
    "        ## Details",
    "        - Paragraph",
    "    ```",
    "    - Review",
    "",
    "## Doing",
    "- Publish",
    "",
    "## Done",
    "",
  ].join("\r\n");
  const [queue, doing] = parseBoard(source).columns;
  const draft = queue.cards[0];
  const moved = changeBoardCard(source, draft, doing, doing.cards[0]);
  assert.equal(moved, [
    "# Release", "", "Intro", "", "## Queue", "    - Review", "", "## Doing",
    "- Draft:", "```", "    ## Details", "    - Paragraph", "```", "- Publish", "", "## Done", "",
  ].join("\r\n"));
  const [, nextDoing, done] = parseBoard(moved).columns;
  assert.equal(nextDoing.cards[0].description, draft.description);
  assert.equal(changeBoardCard(moved, nextDoing.cards[0], nextDoing, nextDoing.cards[1]), moved);
  const reordered = changeBoardCard(moved, nextDoing.cards[1], nextDoing, nextDoing.cards[0]);
  assert.deepEqual(parseBoard(reordered).columns[1].cards.map((card) => card.title), ["Publish", "Draft"]);
  const finished = changeBoardCard(moved, nextDoing.cards[0], done);
  assert.deepEqual(cardContents(parseBoard(finished).columns[2]), [{ title: "Draft", description: draft.description }]);
});

test("visual edits preserve heading placement and serialize multiline card details", () => {
  let source = "\uFEFF# Original\n\nDescription\n\n## Backlog\n";
  source = setBoardHeading(source, 1, parseBoard(source).titleLine, "Planning");
  source = setBoardHeading(source, 2, -1, "Review");
  const board = parseBoard(source);
  assert.equal(board.title, "Planning");
  assert.equal(board.description, "Description");
  assert.deepEqual(board.columns.map((column) => column.title), ["Backlog", "Review"]);
  assert.ok(source.startsWith("\uFEFF"));
  const description = "Markdown **details**\n\n```sh\nls\n```";
  const added = changeBoardCard(source, null, board.columns[1], undefined, { title: "Task: one", description });
  const column = parseBoard(added).columns[1];
  assert.deepEqual(cardContents(column), [{ title: "Task: one", description }]);
  const edited = changeBoardCard(added, column.cards[0], column, undefined, { title: "Task two", description: "Summary" });
  assert.deepEqual(cardContents(parseBoard(edited).columns[1]), [{ title: "Task two", description: "Summary" }]);
  const appended = changeBoardCard(added, undefined, column, undefined, { title: "Last task", description: "" });
  assert.deepEqual(parseBoard(appended).columns[1].cards.map((card) => card.title), ["Task: one", "Last task"]);
});

test("moving a card with an unfinished fence keeps later columns visible", () => {
  const source = "# Plan\n\n## Next\n- Existing\n\n## Later\n- Review:\n  ```\n    Check links.\n";
  const [next, later] = parseBoard(source).columns;
  const moved = changeBoardCard(source, later.cards[0], next, next.cards[0]);
  assert.deepEqual(parseBoard(moved).columns.map((column) => column.title), ["Next", "Later"]);
  assert.deepEqual(cardContents(parseBoard(moved).columns[0]), [
    { title: "Review", description: "Check links." },
    { title: "Existing", description: "" },
  ]);
  const appended = setBoardHeading(source, 2, -1, "Done");
  assert.deepEqual(parseBoard(appended).columns.map((column) => column.title), ["Next", "Later", "Done"]);
});
