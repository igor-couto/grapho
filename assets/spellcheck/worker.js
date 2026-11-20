/* global Typo */
importScripts("./typo.js");

const dictionary = Promise.all(["en-US.aff", "en-US.dic"].map(async (name) => {
  const response = await fetch(new URL(name, self.location));
  if (!response.ok) throw new Error("Could not load the spelling dictionary");
  return response.text();
})).then(([affixes, words]) => new Typo("en_US", affixes, words));

// Ignore URLs, email addresses, numeric tokens and identifiers with underscores.
// Keep contractions together, and check each part of a hyphenated word.
const TOKENS = /(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*/giu;
const WORD = /^\p{Script=Latin}[\p{Script=Latin}\p{M}'’]*$/u;
const MAX_WORD_LENGTH = 40;

function misspellings(checker, text, codeRanges) {
  const ranges = [];
  let codeIndex = 0;
  for (const { 0: word, index: start } of text.matchAll(TOKENS)) {
    const end = start + word.length;
    while (codeRanges[codeIndex]?.end <= start) codeIndex += 1;
    if (codeRanges[codeIndex]?.start < end) continue;
    const normalized = word.normalize("NFC");
    if (normalized.length <= MAX_WORD_LENGTH && WORD.test(normalized) && !checker.check(normalized)) {
      ranges.push({ start, end, word });
    }
  }
  return ranges;
}

self.addEventListener("message", async ({ data }) => {
  try {
    const checker = await dictionary;
    if (data.type === "check") {
      const ranges = data.blocks.map(({ text, codeRanges }) => misspellings(checker, text, codeRanges));
      self.postMessage({ type: "checked", ranges });
    } else if (data.type === "suggest") {
      const word = data.word.normalize("NFC");
      const suggestions = suggestionsFor(checker, word);
      self.postMessage({ type: "suggested", id: data.id, suggestions });
    }
  } catch (error) {
    self.postMessage({ type: "failed", message: String(error) });
  }
});

function suggestionsFor(checker, word) {
  // A neighboring-key transposition should rank ahead of less direct edits.
  const swaps = [];
  const letters = Array.from(word);
  for (let i = 0; i < letters.length - 1; i += 1) {
    if (letters[i] === letters[i + 1]) continue;
    const candidate = [...letters.slice(0, i), letters[i + 1], letters[i], ...letters.slice(i + 2)].join("");
    if (checker.check(candidate)) swaps.push(candidate);
  }
  return [...new Set([...swaps, ...checker.suggest(word, 5)])].slice(0, 5);
}
