/// <reference types="jest" />

import {
  buildIndex,
  buildSerializedIndex,
  defineFields,
  loadIndex,
  type SearchField,
  type SearchIndex,
} from "../src";
import { englishSynonyms } from "../src/english-synonyms";
import { englishAnalyzer } from "../src/english";

type Article = {
  slug: string;
  metadata: {
    title: string;
    summary: string;
  };
  content: string;
};

type Exercise = {
  aliases: string[] | null;
  category: "strength" | "stretching";
  description: string | null;
  equipment: "barbell" | "dumbbell" | null;
  id: string;
  instructions: string[] | null;
  level: "beginner" | "intermediate";
  name: string;
  primary_muscles: string[] | null;
};

const articles: Article[] = [
  {
    slug: "errors",
    metadata: {
      title: "Client side error handling",
      summary: "Typed failures in server actions",
    },
    content:
      "The article explains exceptions, validation faults, and frontend messages.",
  },
  {
    slug: "cdn",
    metadata: {
      title: "Caching and content delivery networks",
      summary: "How edge caches improve website performance",
    },
    content:
      "Store responses near users with stale if error behavior and SSL termination.",
  },
  {
    slug: "clean-code",
    metadata: {
      title: "Heuristics for clean code",
      summary: "Principles for readable software",
    },
    content: "Guidelines keep modules maintainable and tidy.",
  },
];

const articleFields = defineFields<Article>(
  {
    name: "title",
    value: (article) => article.metadata.title,
    weight: 3,
  },
  {
    name: "summary",
    value: (article) => article.metadata.summary,
    weight: 2,
  },
  {
    name: "content",
    value: (article) => article.content,
  },
);

const typoDocuments = [
  {
    id: "successive",
    title: "Successive refinement",
    body: "Iterative methods improve the result in small steps.",
  },
  {
    id: "delivery",
    title: "Delivery pipeline notes",
    body: "Build artifacts move through staging and production.",
  },
];

const typoFields = defineFields<(typeof typoDocuments)[number]>(
  { name: "title", value: (document) => document.title, weight: 3 },
  { name: "body", value: (document) => document.body },
);

function firstResult<T>(results: readonly T[]): T {
  const result = results[0];

  if (result === undefined) {
    throw new Error("Expected at least one search result");
  }

  return result;
}

describe("buildIndex", () => {
  it("returns the public immutable search interface", () => {
    const index: SearchIndex<Article> = buildIndex(articles, {
      fields: articleFields,
    });

    expect(firstResult(index.search("validation")).document.slug).toBe(
      "errors",
    );
    expect("add" in index).toBe(false);
    expect("remove" in index).toBe(false);
  });

  it("serializes an index with projected result documents and reloads it", () => {
    const serialized = buildSerializedIndex(articles, {
      fields: articleFields,
      analyzer: englishAnalyzer(),
      synonyms: englishSynonyms,
      store: (article) => ({
        slug: article.slug,
        title: article.metadata.title,
      }),
    });
    const index = loadIndex(serialized, { analyzer: englishAnalyzer() });

    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
    expect(index.documents[0]).toEqual({
      slug: "errors",
      title: "Client side error handling",
    });
    expect(firstResult(index.search("mistake")).document.slug).toBe("errors");
    expect(JSON.stringify(serialized)).not.toContain("The article explains");
  });

  it("ranks matches in weighted fields above matches in lower-weight fields", () => {
    const documents = [
      { id: "title", title: "distributed systems", body: "short note" },
      {
        id: "body",
        title: "short note",
        body: "distributed systems and distributed computing",
      },
    ];
    const index = buildIndex(documents, {
      fields: defineFields(
        { name: "title", value: (document) => document.title, weight: 5 },
        { name: "body", value: (document) => document.body },
      ),
    });

    expect(firstResult(index.search("distributed")).document.id).toBe("title");
  });

  it("matches query terms with small spelling errors", () => {
    const index = buildIndex(typoDocuments, { fields: typoFields });
    const exactResult = firstResult(index.search("Successive refinement"));
    const typoResult = firstResult(index.search("Sucessive refinement"));

    expect(exactResult.document.id).toBe("successive");
    expect(typoResult.document.id).toBe(exactResult.document.id);
    expect(typoResult.matchedTerms).toEqual(
      expect.arrayContaining(["successive", "refinement"]),
    );
  });

  it("matches a single misspelled query token", () => {
    const index = buildIndex(typoDocuments, { fields: typoFields });
    const result = firstResult(index.search("Sucessive"));

    expect(result.document.id).toBe("successive");
    expect(result.matchedTerms).toContain("successive");
  });

  it("resolves typo tolerance after loading a serialized index", () => {
    const serialized = buildSerializedIndex(typoDocuments, {
      fields: typoFields,
    });
    const index = loadIndex(serialized);

    expect(firstResult(index.search("Sucessive")).document.id).toBe(
      "successive",
    );
  });

  it("can disable typo tolerance", () => {
    const index = buildIndex(typoDocuments, {
      fields: typoFields,
      typoTolerance: false,
    });

    expect(index.search("Sucessive")).toEqual([]);
  });

  it("uses the configured typo tolerance distance", () => {
    const strictIndex = buildIndex(typoDocuments, { fields: typoFields });
    const relaxedIndex = buildIndex(typoDocuments, {
      fields: typoFields,
      typoTolerance: { maxEditDistance: 2 },
    });

    expect(strictIndex.search("Sucesive")).toEqual([]);
    expect(firstResult(relaxedIndex.search("Sucesive")).document.id).toBe(
      "successive",
    );
  });

  it("accepts higher typo tolerance without matching unrelated terms", () => {
    const documents = [
      { id: "alphabet", title: "abcdefghijklmnop" },
      { id: "pipeline", title: "delivery pipeline" },
    ];
    const index = buildIndex(documents, {
      fields: defineFields({
        name: "title",
        value: (document) => document.title,
      }),
      typoTolerance: { maxEditDistance: 5 },
    });

    expect(firstResult(index.search("abcxefghijkymnoz")).document.id).toBe(
      "alphabet",
    );
    expect(index.search("zzzzzzzzzzzzzzzz")).toEqual([]);
  });

  it("uses the external English stop-word collection and Porter stemmer", () => {
    const index = buildIndex(articles, {
      fields: articleFields,
      analyzer: englishAnalyzer(),
    });

    const result = firstResult(index.search("the caches"));

    expect(result.document.slug).toBe("cdn");
    expect(result.matchedTerms).toContain("cach");
    expect(result.matchedTerms).not.toContain("the");
  });

  it("uses the external English synonym dictionary when requested", () => {
    const index = buildIndex(articles, {
      fields: articleFields,
      analyzer: englishAnalyzer(),
      synonyms: englishSynonyms,
    });

    const result = firstResult(index.search("mistake"));

    expect(result.document.slug).toBe("errors");
    expect(result.matchedTerms).toContain("error");
  });

  it("merges consumer synonym maps with collection-backed synonym resolvers", () => {
    const index = buildIndex(articles, {
      fields: articleFields,
      analyzer: englishAnalyzer(),
      synonyms: [
        englishSynonyms,
        {
          resilient: ["stale"],
        },
      ],
    });

    expect(firstResult(index.search("resilient")).document.slug).toBe("cdn");
    expect(firstResult(index.search("stale")).document.slug).toBe("cdn");
  });

  it("supports per-query limits, offsets, and minimum scores", () => {
    const index = buildIndex(articles, { fields: articleFields });
    const firstPage = index.search({ text: "code error", limit: 1 });
    const secondPage = index.search({
      text: "code error",
      limit: 1,
      offset: 1,
    });

    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(firstResult(secondPage).document.slug).not.toBe(
      firstResult(firstPage).document.slug,
    );
    expect(index.search({ text: "code", minScore: Number.MAX_VALUE })).toEqual(
      [],
    );
  });

  it("indexes arbitrary objects, arrays, nullable values, and enum-like values", () => {
    const exercises: Exercise[] = [
      {
        aliases: ["bench press", "chest press"],
        category: "strength",
        description: "Horizontal pressing movement for upper body strength.",
        equipment: "barbell",
        id: "barbell-bench-press",
        instructions: ["Lie on the bench", "Press the bar from the chest"],
        level: "beginner",
        name: "Barbell Bench Press",
        primary_muscles: ["chest", "triceps"],
      },
      {
        aliases: null,
        category: "strength",
        description: "Lower body squat pattern.",
        equipment: "dumbbell",
        id: "goblet-squat",
        instructions: ["Hold a dumbbell", "Squat between the knees"],
        level: "beginner",
        name: "Goblet Squat",
        primary_muscles: ["quadriceps", "glutes"],
      },
    ];
    const fields: readonly SearchField<Exercise>[] = defineFields(
      { name: "name", value: (exercise) => exercise.name, weight: 3 },
      { name: "aliases", value: (exercise) => exercise.aliases, weight: 2 },
      { name: "category", value: (exercise) => exercise.category },
      { name: "description", value: (exercise) => exercise.description },
      { name: "equipment", value: (exercise) => exercise.equipment },
      { name: "instructions", value: (exercise) => exercise.instructions },
      { name: "level", value: (exercise) => exercise.level },
      { name: "muscles", value: (exercise) => exercise.primary_muscles },
    );
    const index = buildIndex(exercises, {
      fields,
      analyzer: englishAnalyzer(),
    });

    expect(
      firstResult(index.search("barbell chest triceps")).document.id,
    ).toBe("barbell-bench-press");
  });

  it("validates field and query configuration", () => {
    expect(() => buildIndex(articles, { fields: [] })).toThrow(
      "at least one field",
    );
    expect(() =>
      buildIndex(articles, {
        fields: [{ name: "title", value: () => "title", weight: 0 }],
      }),
    ).toThrow("positive weight");

    expect(() =>
      buildIndex(typoDocuments, {
        fields: typoFields,
        typoTolerance: { maxEditDistance: -1 },
      }),
    ).toThrow("non-negative integer");
    expect(() =>
      loadIndex(buildSerializedIndex(typoDocuments, { fields: typoFields }), {
        typoTolerance: { minTermLength: 0 },
      }),
    ).toThrow("positive integer");

    const index = buildIndex(articles, { fields: articleFields });
    expect(() => index.search({ text: "error", offset: -1 })).toThrow(
      "non-negative integer",
    );
  });
});
