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
};

export type LoadSearchIndexOptions = {
  readonly analyzer?: TextAnalyzer;
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

const DEFAULT_LIMIT = 5;

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
  }

  search(query: string | SearchQuery): readonly SearchResult<TDocument>[] {
    const options = normalizeQuery(query);
    if (!options.text.trim() || options.limit === 0) return [];

    const terms = termFrequencies(this.analyzer.analyze(options.text));
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
}

export function buildIndex<TDocument, TStoredDocument = TDocument>(
  documents: readonly TDocument[],
  options: DocumentSearchOptions<TDocument, TStoredDocument>,
): SearchIndex<TStoredDocument> {
  const serialized = buildSerializedIndex(documents, options);
  return loadIndex(serialized, { analyzer: options.analyzer });
}

export function buildSerializedIndex<TDocument, TStoredDocument = TDocument>(
  documents: readonly TDocument[],
  options: DocumentSearchOptions<TDocument, TStoredDocument>,
): SerializedSearchIndex<TStoredDocument> {
  validateFields(options.fields);

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
