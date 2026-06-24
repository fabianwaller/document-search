export type SearchPrimitive = string | number | boolean | null | undefined;
export type SearchValue = SearchPrimitive | readonly SearchValue[];

export type SearchField<TDocument> = {
  readonly name: string;
  readonly value: (document: TDocument) => SearchValue;
  readonly weight?: number;
  readonly expandSynonyms?: boolean;
};

export type SearchQuery = {
  readonly text: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly minScore?: number;
};

export type TypoToleranceOptions = {
  readonly maxEditDistance?: number;
  readonly minTermLength?: number;
};

export type SearchResult<TDocument> = {
  readonly document: TDocument;
  readonly score: number;
  readonly matchedTerms: readonly string[];
};

export type TextAnalyzer = {
  analyze(text: string): readonly string[];
};

export type SynonymMap = Readonly<Record<string, readonly string[]>>;
export type SynonymResolver = (term: string) => readonly string[];
export type SynonymSource = SynonymMap | SynonymResolver;

export type DocumentSearchOptions<TDocument, TStoredDocument = TDocument> = {
  readonly fields: readonly SearchField<TDocument>[];
  readonly analyzer?: TextAnalyzer;
  readonly synonyms?: SynonymSource | readonly SynonymSource[];
  readonly store?: (document: TDocument) => TStoredDocument;
  readonly typoTolerance?: false | TypoToleranceOptions;
};

export type LoadSearchIndexOptions = {
  readonly analyzer?: TextAnalyzer;
  readonly typoTolerance?: false | TypoToleranceOptions;
};

export type SearchIndex<TDocument> = {
  readonly documents: readonly TDocument[];
  search(query: string | SearchQuery): readonly SearchResult<TDocument>[];
};

export type SerializedSearchIndex<TDocument> = {
  readonly version: 1;
  readonly documentCount: number;
  readonly documentFrequency: readonly (readonly [string, number])[];
  readonly queryExpansions: readonly (readonly [string, readonly string[]])[];
  readonly documents: readonly {
    readonly document: TDocument;
    readonly vector: readonly (readonly [string, number])[];
    readonly norm: number;
  }[];
};

type IndexedDocument<TDocument> = {
  document: TDocument;
  vector: Map<string, number>;
  norm: number;
};

type NormalizedTypoToleranceOptions = Required<TypoToleranceOptions>;

type FuzzyTermIndex = {
  readonly deletes: ReadonlyMap<string, readonly string[]>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly maxEditDistance: number;
  readonly minTermLength: number;
};

const DEFAULT_LIMIT = 5;
const DEFAULT_TYPO_TOLERANCE: NormalizedTypoToleranceOptions = {
  maxEditDistance: 1,
  minTermLength: 4,
};
const MAX_TYPO_EDIT_DISTANCE = 2;

const defaultAnalyzer: TextAnalyzer = {
  analyze: tokenize,
};

class TfIdfSearchIndex<TDocument> implements SearchIndex<TDocument> {
  readonly documents: readonly TDocument[];
  private readonly indexedDocuments: readonly IndexedDocument<TDocument>[];
  private readonly documentFrequency: ReadonlyMap<string, number>;
  private readonly queryExpansions: ReadonlyMap<string, readonly string[]>;
  private readonly analyzer: TextAnalyzer;
  private readonly documentCount: number;
  private readonly fuzzyTermIndex?: FuzzyTermIndex;

  constructor(
    serialized: SerializedSearchIndex<TDocument>,
    options: LoadSearchIndexOptions,
  ) {
    if (serialized.version !== 1) {
      throw new RangeError(
        `Unsupported serialized search index version: ${serialized.version}`,
      );
    }

    this.documents = serialized.documents.map(({ document }) => document);
    this.indexedDocuments = serialized.documents.map(
      ({ document, vector, norm }) => ({
        document,
        vector: new Map(vector),
        norm,
      }),
    );
    this.documentFrequency = new Map(serialized.documentFrequency);
    this.queryExpansions = new Map(serialized.queryExpansions);
    this.analyzer = options.analyzer ?? defaultAnalyzer;
    this.documentCount = serialized.documentCount;

    const typoTolerance = normalizeTypoTolerance(options.typoTolerance);
    if (typoTolerance?.maxEditDistance) {
      this.fuzzyTermIndex = buildFuzzyTermIndex(
        this.documentFrequency,
        this.queryExpansions.keys(),
        typoTolerance,
      );
    }
  }

  search(query: string | SearchQuery): readonly SearchResult<TDocument>[] {
    const options = normalizeQuery(query);
    if (!options.text.trim() || options.limit === 0) return [];

    const terms = termFrequencies(
      this.resolveTypoTolerantTerms(this.analyzer.analyze(options.text)),
    );
    for (const term of [...terms.keys()]) {
      for (const expansion of this.queryExpansions.get(term) ?? []) {
        terms.set(
          expansion,
          Math.max(terms.get(expansion) ?? 0, terms.get(term)!),
        );
      }
    }

    const queryVector = toTfIdfVector(
      terms,
      this.documentFrequency,
      this.documentCount,
    );
    const queryNorm = vectorNorm(queryVector);
    if (queryNorm === 0) return [];

    return this.indexedDocuments
      .map(({ document, vector, norm }) => ({
        document,
        score: cosineSimilarity(queryVector, queryNorm, vector, norm),
        matchedTerms: intersectTerms(queryVector, vector),
      }))
      .filter((result) => result.score > options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(options.offset, options.offset + options.limit);
  }

  private resolveTypoTolerantTerms(terms: readonly string[]) {
    if (!this.fuzzyTermIndex) return terms;

    const resolvedTerms: string[] = [];
    for (const term of terms) {
      if (this.documentFrequency.has(term) || this.queryExpansions.has(term)) {
        resolvedTerms.push(term);
        continue;
      }

      const fuzzyMatches = findFuzzyMatches(term, this.fuzzyTermIndex);
      resolvedTerms.push(...(fuzzyMatches.length ? fuzzyMatches : [term]));
    }

    return resolvedTerms;
  }
}

export function buildIndex<TDocument, TStoredDocument = TDocument>(
  documents: readonly TDocument[],
  options: DocumentSearchOptions<TDocument, TStoredDocument>,
): SearchIndex<TStoredDocument> {
  const serialized = buildSerializedIndex(documents, options);
  return loadIndex(serialized, {
    analyzer: options.analyzer,
    typoTolerance: options.typoTolerance,
  });
}

export function buildSerializedIndex<TDocument, TStoredDocument = TDocument>(
  documents: readonly TDocument[],
  options: DocumentSearchOptions<TDocument, TStoredDocument>,
): SerializedSearchIndex<TStoredDocument> {
  validateFields(options.fields);
  normalizeTypoTolerance(options.typoTolerance);

  const analyzer = options.analyzer ?? defaultAnalyzer;
  const documentFrequency = new Map<string, number>();
  const synonymTerms = new Set<string>();
  const termFrequenciesByDocument = documents.map((document) => {
    const terms = documentTermFrequencies(
      document,
      options.fields,
      analyzer,
      synonymTerms,
    );
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    return { document, terms };
  });
  const resolveSynonyms = createSynonymResolver(options.synonyms, analyzer);
  const queryExpansions = buildQueryExpansions(
    synonymTerms,
    resolveSynonyms,
    analyzer,
  );
  const store = options.store ?? ((document: TDocument) => document);

  return {
    version: 1,
    documentCount: documents.length,
    documentFrequency: [...documentFrequency],
    queryExpansions: [...queryExpansions].map(([term, expansions]) => [
      term,
      [...expansions],
    ]),
    documents: termFrequenciesByDocument.map(({ document, terms }) => {
      const vector = toTfIdfVector(terms, documentFrequency, documents.length);
      return {
        document: store(document) as TStoredDocument,
        vector: [...vector],
        norm: vectorNorm(vector),
      };
    }),
  };
}

export function loadIndex<TDocument>(
  serialized: SerializedSearchIndex<TDocument>,
  options: LoadSearchIndexOptions = {},
): SearchIndex<TDocument> {
  return new TfIdfSearchIndex(serialized, options);
}

export function defineFields<TDocument>(
  ...fields: readonly SearchField<TDocument>[]
): readonly SearchField<TDocument>[] {
  return fields;
}

function validateFields<TDocument>(fields: readonly SearchField<TDocument>[]) {
  if (fields.length === 0) {
    throw new TypeError("A search index requires at least one field.");
  }

  for (const field of fields) {
    if (!field.name.trim()) {
      throw new TypeError("Search field names cannot be empty.");
    }
    if (field.weight !== undefined && field.weight <= 0) {
      throw new RangeError(
        `Search field "${field.name}" must have a positive weight.`,
      );
    }
  }
}

function documentTermFrequencies<TDocument>(
  document: TDocument,
  fields: readonly SearchField<TDocument>[],
  analyzer: TextAnalyzer,
  synonymTerms: Set<string>,
) {
  const terms = new Map<string, number>();

  for (const field of fields) {
    const weight = field.weight ?? 1;
    const text = flattenSearchValue(field.value(document)).join(" ");
    const analyzedTerms = analyzer.analyze(text);
    for (const term of analyzedTerms) {
      terms.set(term, (terms.get(term) ?? 0) + weight);
    }
    if (field.expandSynonyms !== false) {
      for (const term of analyzedTerms) synonymTerms.add(term);
    }
  }

  return terms;
}

function buildQueryExpansions(
  indexedTerms: Iterable<string>,
  resolveSynonyms: SynonymResolver,
  analyzer: TextAnalyzer,
) {
  const expansions = new Map<string, Set<string>>();

  for (const indexedTerm of indexedTerms) {
    for (const synonym of resolveSynonyms(indexedTerm)) {
      for (const normalizedSynonym of analyzer.analyze(synonym)) {
        if (normalizedSynonym === indexedTerm) continue;
        const terms = expansions.get(normalizedSynonym) ?? new Set<string>();
        terms.add(indexedTerm);
        expansions.set(normalizedSynonym, terms);
      }
    }
  }

  return expansions;
}

function termFrequencies(termsToCount: readonly string[]) {
  const terms = new Map<string, number>();
  for (const term of termsToCount) {
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return terms;
}

function toTfIdfVector(
  terms: ReadonlyMap<string, number>,
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
) {
  const vector = new Map<string, number>();
  for (const [term, count] of terms) {
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(documentCount + 1) - Math.log(df + 1) + 1;
    vector.set(term, (1 + Math.log(count)) * idf);
  }
  return vector;
}

function normalizeQuery(query: string | SearchQuery) {
  const options = typeof query === "string" ? { text: query } : query;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  const minScore = options.minScore ?? 0;

  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("Search query limit must be a non-negative integer.");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError("Search query offset must be a non-negative integer.");
  }
  if (!Number.isFinite(minScore) || minScore < 0) {
    throw new RangeError(
      "Search query minScore must be a non-negative number.",
    );
  }

  return { text: options.text, limit, offset, minScore };
}

function normalizeTypoTolerance(
  options: false | TypoToleranceOptions | undefined,
): NormalizedTypoToleranceOptions | undefined {
  if (options === false) return undefined;

  const maxEditDistance =
    options?.maxEditDistance ?? DEFAULT_TYPO_TOLERANCE.maxEditDistance;
  const minTermLength =
    options?.minTermLength ?? DEFAULT_TYPO_TOLERANCE.minTermLength;

  if (
    !Number.isInteger(maxEditDistance) ||
    maxEditDistance < 0 ||
    maxEditDistance > MAX_TYPO_EDIT_DISTANCE
  ) {
    throw new RangeError(
      `Search typoTolerance maxEditDistance must be an integer between 0 and ${MAX_TYPO_EDIT_DISTANCE}.`,
    );
  }
  if (!Number.isInteger(minTermLength) || minTermLength < 1) {
    throw new RangeError(
      "Search typoTolerance minTermLength must be a positive integer.",
    );
  }

  return { maxEditDistance, minTermLength };
}

function buildFuzzyTermIndex(
  documentFrequency: ReadonlyMap<string, number>,
  expansionTerms: Iterable<string>,
  options: NormalizedTypoToleranceOptions,
): FuzzyTermIndex {
  const deletes = new Map<string, Set<string>>();
  const terms = new Set([...documentFrequency.keys(), ...expansionTerms]);

  for (const term of terms) {
    if (term.length < options.minTermLength) continue;

    for (const deletion of deletionKeys(term, options.maxEditDistance)) {
      const matches = deletes.get(deletion) ?? new Set<string>();
      matches.add(term);
      deletes.set(deletion, matches);
    }
  }

  return {
    deletes: new Map(
      [...deletes].map(([deletion, matches]) => [deletion, [...matches]]),
    ),
    documentFrequency,
    maxEditDistance: options.maxEditDistance,
    minTermLength: options.minTermLength,
  };
}

function findFuzzyMatches(term: string, index: FuzzyTermIndex) {
  if (term.length < index.minTermLength) return [];

  const candidates = new Map<string, number>();
  for (const deletion of deletionKeys(term, index.maxEditDistance)) {
    for (const candidate of index.deletes.get(deletion) ?? []) {
      if (Math.abs(candidate.length - term.length) > index.maxEditDistance) {
        continue;
      }

      const distance = boundedEditDistance(
        term,
        candidate,
        index.maxEditDistance,
      );
      if (distance <= index.maxEditDistance) {
        candidates.set(
          candidate,
          Math.min(
            candidates.get(candidate) ?? Number.POSITIVE_INFINITY,
            distance,
          ),
        );
      }
    }
  }

  const shortestDistance = Math.min(...candidates.values());
  if (!Number.isFinite(shortestDistance)) return [];

  return [...candidates]
    .filter(([, distance]) => distance === shortestDistance)
    .sort(([a], [b]) => {
      const frequencyDifference =
        (index.documentFrequency.get(b) ?? 0) -
        (index.documentFrequency.get(a) ?? 0);
      return frequencyDifference || a.localeCompare(b);
    })
    .map(([candidate]) => candidate);
}

function deletionKeys(term: string, maxEditDistance: number) {
  const keys = new Set([term]);
  let frontier = new Set([term]);

  for (let distance = 0; distance < maxEditDistance; distance += 1) {
    const nextFrontier = new Set<string>();
    for (const key of frontier) {
      for (let index = 0; index < key.length; index += 1) {
        const deleted = key.slice(0, index) + key.slice(index + 1);
        if (!keys.has(deleted)) {
          keys.add(deleted);
          nextFrontier.add(deleted);
        }
      }
    }
    frontier = nextFrontier;
  }

  return keys;
}

function boundedEditDistance(a: string, b: string, maxEditDistance: number) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxEditDistance) {
    return maxEditDistance + 1;
  }

  let previousPrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    let rowMinimum = aIndex;

    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      const substitutionCost = a[aIndex - 1] === b[bIndex - 1] ? 0 : 1;
      const fallbackDistance = maxEditDistance + 1;
      let distance = Math.min(
        (previous[bIndex] ?? fallbackDistance) + 1,
        (current[bIndex - 1] ?? fallbackDistance) + 1,
        (previous[bIndex - 1] ?? fallbackDistance) + substitutionCost,
      );

      if (
        aIndex > 1 &&
        bIndex > 1 &&
        a[aIndex - 1] === b[bIndex - 2] &&
        a[aIndex - 2] === b[bIndex - 1]
      ) {
        distance = Math.min(
          distance,
          (previousPrevious[bIndex - 2] ?? maxEditDistance) + 1,
        );
      }

      current[bIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }

    if (rowMinimum > maxEditDistance) return maxEditDistance + 1;

    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length] ?? maxEditDistance + 1;
}

function tokenize(text: string) {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  return normalized ? normalized.split(/\s+/) : [];
}

function flattenSearchValue(value: SearchValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSearchValue(item));
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [String(value)];
}

function createSynonymResolver(
  sources: DocumentSearchOptions<unknown>["synonyms"],
  analyzer: TextAnalyzer,
): SynonymResolver {
  const sourceList = sources
    ? Array.isArray(sources)
      ? sources
      : [sources]
    : [];
  const maps = sourceList
    .filter((source): source is SynonymMap => typeof source !== "function")
    .map((source) => normalizeSynonymMap(source, analyzer));
  const resolvers = sourceList.filter(
    (source): source is SynonymResolver => typeof source === "function",
  );

  return (term) => {
    const synonyms = new Set<string>();
    for (const map of maps) {
      for (const synonym of map.get(term) ?? []) synonyms.add(synonym);
    }
    for (const resolver of resolvers) {
      for (const synonym of resolver(term)) synonyms.add(synonym);
    }
    synonyms.delete(term);
    return [...synonyms];
  };
}

function normalizeSynonymMap(synonyms: SynonymMap, analyzer: TextAnalyzer) {
  const map = new Map<string, Set<string>>();

  for (const [term, relatedTerms] of Object.entries(synonyms)) {
    const normalizedTerms = analyzer.analyze(term);
    for (const relatedTerm of relatedTerms) {
      const normalizedRelatedTerms = analyzer.analyze(relatedTerm);
      for (const normalizedTerm of normalizedTerms) {
        for (const normalizedRelatedTerm of normalizedRelatedTerms) {
          addSynonym(map, normalizedTerm, normalizedRelatedTerm);
          addSynonym(map, normalizedRelatedTerm, normalizedTerm);
        }
      }
    }
  }

  return map;
}

function addSynonym(
  map: Map<string, Set<string>>,
  term: string,
  synonym: string,
) {
  const values = map.get(term) ?? new Set<string>();
  values.add(synonym);
  map.set(term, values);
}

function vectorNorm(vector: ReadonlyMap<string, number>) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

function cosineSimilarity(
  a: ReadonlyMap<string, number>,
  aNorm: number,
  b: ReadonlyMap<string, number>,
  bNorm: number,
) {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (const [term, value] of a) {
    dot += value * (b.get(term) ?? 0);
  }
  return dot / (aNorm * bNorm);
}

function intersectTerms(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
) {
  return [...a.keys()].filter((term) => b.has(term));
}
