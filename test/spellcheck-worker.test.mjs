import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import vm from "node:vm";

const assets = new URL("../assets/spellcheck/", import.meta.url);
const loads = [];
let send;

before(async () => {
  const files = ["worker.js", "typo.js", "en-US.aff", "en-US.dic"];
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, assets), "utf8")));
  const sources = Object.fromEntries(files.map((file, index) => [file, contents[index]]));
  let handleMessage;
  let reply;
  const context = vm.createContext({
    URL,
    importScripts(name) {
      assert.equal(name, "./typo.js");
      vm.runInContext(sources["typo.js"], context);
    },
    fetch(url) {
      assert.equal(url.origin, "http://grapho.test");
      const name = url.pathname.split("/").pop();
      loads.push(name);
      return Promise.resolve({ ok: true, text: () => sources[name] });
    },
    self: {
      location: new URL("http://grapho.test/assets/spellcheck/worker.js"),
      addEventListener(type, handler) {
        assert.equal(type, "message");
        handleMessage = handler;
      },
      postMessage(data) {
        reply = JSON.parse(JSON.stringify(data));
      },
    },
  });
  vm.runInContext(sources["worker.js"], context);
  send = async (data) => {
    await handleMessage({ data });
    return reply;
  };
});

test("the worker checks US English and keeps editor offsets through accents and emoji", async () => {
  const accent = "nai\u0308vve";
  const text = `We recieve letters 😂 and ${accent} notes. Don’t worry.`;
  const reply = await send({ type: "check", blocks: [{ text, codeRanges: [] }] });
  assert.deepEqual(loads, ["en-US.aff", "en-US.dic"]);
  assert.deepEqual(reply, {
    type: "checked",
    ranges: [["recieve", accent].map((word) => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length, word }))],
  });
});

test("the worker skips links, email, code runs, and identifiers but checks nearby prose", async () => {
  const text = "visit https://misspeling.example, email misspeling@example.com, misspeling2, misspeling_abc, misspeling; read teh notes";
  const start = text.indexOf("misspeling;");
  const codeRanges = [{ start, end: start + "misspeling".length }];
  const reply = await send({ type: "check", blocks: [{ text, codeRanges }] });
  assert.deepEqual(reply.ranges, [[{ start: text.indexOf("teh"), end: text.indexOf("teh") + 3, word: "teh" }]]);
});

test("the bundled dictionary suggests common spelling repairs first", async () => {
  for (const [id, word, correction] of [[1, "recieve", "receive"], [2, "teh", "the"], [3, "Recieve", "Receive"]]) {
    const reply = await send({ type: "suggest", id, word });
    assert.equal(reply.type, "suggested");
    assert.equal(reply.id, id);
    assert.equal(reply.suggestions[0], correction);
    assert.ok(reply.suggestions.length <= 5);
    assert.equal(new Set(reply.suggestions).size, reply.suggestions.length);
  }
});
