import { eng } from "stopword";
import stem from "wink-porter2-stemmer";

import type { TextAnalyzer } from "./document-search";

export type EnglishAnalyzerOptions = {
  readonly additionalStopWords?: Iterable<string>;
  readonly stopWords?: Iterable<string>;
};

export function englishAnalyzer(
  options: EnglishAnalyzerOptions = {},
): TextAnalyzer {
  const stopWords = new Set(options.stopWords ?? eng);
  for (const word of options.additionalStopWords ?? []) {
    stopWords.add(word.toLocaleLowerCase());
  }

  return {
    analyze(text) {
      const normalized = text
        .normalize("NFKC")
        .toLocaleLowerCase("en")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

      if (!normalized) return [];

      return normalized
        .split(/\s+/)
        .filter((term) => term.length > 1 && !stopWords.has(term))
        .map(stem);
    },
  };
}
