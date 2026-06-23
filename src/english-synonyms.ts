import synonyms from "synonyms";
import stem from "wink-porter2-stemmer";

import type { SynonymResolver } from "./document-search";

let normalizedSynonyms: ReadonlyMap<string, readonly string[]> | undefined;

export const englishSynonyms: SynonymResolver = (term) => {
  normalizedSynonyms ??= normalizeSynonymDictionary();
  return normalizedSynonyms.get(term) ?? [];
};

function normalizeSynonymDictionary() {
  const dictionary = new Map<string, Set<string>>();

  for (const [word, entry] of Object.entries(synonyms.dictionary)) {
    const normalizedWord = stem(word);
    const relatedWords = dictionary.get(normalizedWord) ?? new Set<string>();
    for (const synonym of Object.values(entry).flat()) {
      relatedWords.add(synonym);
    }
    dictionary.set(normalizedWord, relatedWords);
  }

  return new Map(
    [...dictionary].map(([word, relatedWords]) => [word, [...relatedWords]]),
  );
}
