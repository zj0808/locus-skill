const EMPTY_SET = new Set();

let wordSegmenter;

function getWordSegmenter() {
  if (wordSegmenter !== undefined) return wordSegmenter;
  try {
    wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  } catch {
    wordSegmenter = null;
  }
  return wordSegmenter;
}

function isUsefulTerm(term, stopWords) {
  if (!term || stopWords.has(term)) return false;
  if (/^\p{Script=Han}+$/u.test(term)) return term.length >= 2;
  return term.length >= 2;
}

function addTerm(target, value, stopWords = EMPTY_SET) {
  const term = String(value || "").trim().toLowerCase();
  if (isUsefulTerm(term, stopWords)) target.add(term);
}

function identifierParts(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$]+/g, " ")
    .split(/[^A-Za-z0-9\p{Script=Han}]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Expand code-shaped input into forms commonly found in paths and symbols.
 * All returned forms are lowercase because local indexes are case-insensitive.
 */
export function expandCodeToken(value, stopWords = EMPTY_SET) {
  const raw = String(value || "").trim().replace(/^[`'"([{<]+|[`'"\])}>.,;:!?]+$/g, "");
  if (!raw) return [];

  const terms = new Set();
  addTerm(terms, raw.replace(/\\/g, "/"), stopWords);

  const parts = identifierParts(raw);
  for (const part of parts) addTerm(terms, part, stopWords);

  const asciiParts = parts.filter((part) => /^[a-z0-9_$]+$/.test(part));
  if (asciiParts.length > 1) {
    addTerm(terms, asciiParts.join(""), stopWords);
    addTerm(terms, asciiParts.join("_"), stopWords);
  }

  const stripped = raw.replace(/[^A-Za-z0-9_$\p{Script=Han}]/gu, "");
  if (stripped !== raw) addTerm(terms, stripped, stopWords);
  return [...terms];
}

function extractTechnicalTokens(query) {
  const text = String(query || "");
  const found = new Set();
  const patterns = [
    /`([^`\r\n]{1,160})`/g,
    /(?:[A-Za-z]:)?(?:[.@\w$-]+[\\/])+[.@\w$-]+/g,
    /\b[A-Za-z_$][\w$]*(?:[._-][A-Za-z0-9_$@-]+)+\b/g,
    /\b(?:[A-Z][a-z0-9]+){2,}[A-Za-z0-9]*\b/g,
    /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const token = String(match[1] || match[0]).trim();
      if (token) found.add(token);
    }
  }
  return [...found];
}

function addNaturalTerms(target, text, stopWords, maxTerms) {
  const segmenter = getWordSegmenter();
  if (segmenter) {
    for (const segment of segmenter.segment(text)) {
      if (!segment.isWordLike) continue;
      for (const term of expandCodeToken(segment.segment, stopWords)) {
        target.add(term);
        if (target.size >= maxTerms) return;
      }
    }
  } else {
    const fallback = text.match(/[A-Za-z_$][\w$]*|[0-9]+|\p{Script=Han}{1,8}/gu) || [];
    for (const token of fallback) {
      for (const term of expandCodeToken(token, stopWords)) {
        target.add(term);
        if (target.size >= maxTerms) return;
      }
    }
  }

  // Some ICU dictionaries split domain phrases into individual Han chars.
  // Stable bigrams keep query and index behavior aligned across Node builds.
  for (const run of text.match(/\p{Script=Han}{2,}/gu) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      addTerm(target, run.slice(i, i + 2), stopWords);
      if (target.size >= maxTerms) return;
    }
  }
}

const CLAUSE_BOUNDARY = /(?:\r?\n+|[。！？!?；;]+|\s+(?:and\s+then|then|also|plus)\s+|(?:并且|同时|以及|然后|另外|此外|还要|并查找|并定位))/giu;

/**
 * Split a long request into independently retrievable intents. Delimiters are
 * discarded, but every non-empty query fragment is retained in source order.
 */
export function splitSearchQuery(query) {
  const original = String(query || "").trim();
  if (!original) return [];
  const clauses = original
    .split(CLAUSE_BOUNDARY)
    .map((clause) => clause.trim().replace(/^[,，、:\s]+|[,，、:\s]+$/g, ""))
    .filter(Boolean);
  return clauses.length ? clauses : [original];
}

function collectTerms(text, stopWords, maxTerms) {
  const technicalTokens = extractTechnicalTokens(text);
  const technicalTerms = new Set();
  const terms = new Set();
  for (const token of technicalTokens) {
    for (const term of expandCodeToken(token, stopWords)) {
      technicalTerms.add(term);
      terms.add(term);
      if (terms.size >= maxTerms) break;
    }
    if (terms.size >= maxTerms) break;
  }
  if (terms.size < maxTerms) addNaturalTerms(terms, text, stopWords, maxTerms);
  return { terms: [...terms], technicalTerms: [...technicalTerms] };
}

function roundRobinTerms(clauseTerms, maxTerms) {
  const selected = [];
  const seen = new Set();
  let index = 0;
  while (selected.length < maxTerms) {
    let added = false;
    for (const terms of clauseTerms) {
      const term = terms[index];
      if (!term || seen.has(term)) continue;
      seen.add(term);
      selected.push(term);
      added = true;
      if (selected.length >= maxTerms) break;
    }
    if (!added && clauseTerms.every((terms) => index >= terms.length - 1)) break;
    index += 1;
  }
  return selected;
}

/**
 * Normalize a natural-language/code query once so Graph and future lexical
 * radars share identical technical-term and multilingual token behavior.
 */
export function normalizeSearchQuery(query, opts = {}) {
  const original = String(query || "").trim();
  const stopWords = opts.stopWords || EMPTY_SET;
  const maxTerms = Math.max(1, opts.maxTerms ?? 96);
  const clauseTexts = splitSearchQuery(original);
  const clauseBudget = Math.max(16, opts.clauseMaxTerms ?? maxTerms);
  const clauses = clauseTexts.map((text, index) => {
    const collected = collectTerms(text, stopWords, clauseBudget);
    return { index, text, ...collected };
  });
  const allTerms = [];
  const seenAll = new Set();
  for (const clause of clauses) {
    for (const term of clause.terms) {
      if (seenAll.has(term)) continue;
      seenAll.add(term);
      allTerms.push(term);
    }
  }
  // Round-robin selection prevents an early clause from consuming the whole
  // term budget and silently dropping later intents.
  const terms = roundRobinTerms(clauses.map((clause) => clause.terms), maxTerms);
  const technicalTerms = [...new Set(clauses.flatMap((clause) => clause.technicalTerms))];
  const selected = new Set(terms);
  const omittedTerms = allTerms.filter((term) => !selected.has(term));

  return {
    original,
    terms,
    technicalTerms,
    clauses,
    diagnostics: {
      clauseCount: clauses.length,
      discoveredTermCount: allTerms.length,
      usedTerms: terms,
      omittedTerms,
      complete: omittedTerms.length === 0,
    },
    hasCjk: /\p{Script=Han}/u.test(original),
  };
}

/**
 * Extract compact searchable terms from source text without segmenting the
 * entire file. CJK runs are segmented separately to keep index builds cheap.
 */
export function extractIndexTerms(text, opts = {}) {
  const maxTerms = Math.max(1, opts.maxTerms ?? 3500);
  const stopWords = opts.stopWords || EMPTY_SET;
  const terms = new Set();
  const source = String(text || "");
  const codePattern = /[A-Za-z_$][\w$]{1,}|[0-9]{2,}/g;
  let match;
  while ((match = codePattern.exec(source)) !== null) {
    for (const term of expandCodeToken(match[0], stopWords)) {
      terms.add(term);
      if (terms.size >= maxTerms) return [...terms];
    }
  }

  const cjkPattern = /\p{Script=Han}+/gu;
  while ((match = cjkPattern.exec(source)) !== null) {
    addNaturalTerms(terms, match[0], stopWords, maxTerms);
    if (terms.size >= maxTerms) break;
  }
  return [...terms];
}
