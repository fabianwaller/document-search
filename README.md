# Document Search

[![Publish Package](https://github.com/fabianwaller/document-search/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/fabianwaller/document-search/actions/workflows/npm-publish.yml)

`@fabianwaller/document-search` is a small TypeScript search library for
in-memory document collections. It builds an immutable TF-IDF index from plain
objects, lets you choose exactly which fields are searchable, and returns ranked
results without asking you to reshape your data first.

It is meant for product lists, documentation pages, static site content, local
datasets, and other cases where a full search service would be more machinery
than the job needs. You can keep the default Unicode tokenizer, opt into the
English analyzer for stemming and stop words, add synonyms when they help, and
serialize the index when you want to build it once and load it later.

## Install

```sh
npm install @fabianwaller/document-search
```

## A First Index

Start with your documents and describe the fields that should matter for
search. Fields can point anywhere inside each document, can return strings,
numbers, booleans, arrays, or nullable values, and can be weighted when some
fields should rank higher than others.

```ts
import { buildIndex, defineFields } from "@fabianwaller/document-search";
import { englishAnalyzer } from "@fabianwaller/document-search/english";
import { englishSynonyms } from "@fabianwaller/document-search/english-synonyms";

const index = buildIndex(products, {
  fields: defineFields(
    { name: "name", value: (product) => product.name, weight: 3 },
    { name: "description", value: (product) => product.description },
    { name: "tags", value: (product) => product.tags, weight: 2 },
  ),
  analyzer: englishAnalyzer(),
  synonyms: [
    englishSynonyms,
    {
      sneaker: ["trainer", "running shoe"],
    },
  ],
});

const results = index.search({
  text: "lightweight trainers",
  limit: 20,
  offset: 0,
  minScore: 0.05,
});
```

Each result contains the stored document, its score, and the matched terms. The
score is useful for ordering results from one query against one index; it is not
intended to be compared across separate indexes.

## Analysis, Synonyms, and Typos

The default analyzer keeps things deliberately simple: it normalizes Unicode
text, lowercases it, and tokenizes it. The English analyzer is opt-in and adds
English stop-word removal plus stemming.

Typo tolerance is enabled by default. You can turn it off with
`typoTolerance: false`, or tune it with `maxEditDistance` and `minTermLength`.
Large edit-distance settings are filtered by token length so typo tolerance can
help long words without turning unrelated short terms into matches.

Synonyms are also opt-in. Custom synonym maps are treated bidirectionally, so a
map such as `{ sneaker: ["trainer"] }` allows searches for either word to find
the other. The bundled English synonym dictionary is available from
`@fabianwaller/document-search/english-synonyms`, but it increases bundle size,
so import it only where you need it. If one field should not contribute synonym
expansions, set `expandSynonyms: false` on that field.

## Serializable Indexes

For static content or client-side search, build the index once and serialize
only the result data you want to expose. `store` controls what is included with
search results; source fields used only for indexing are not serialized.

```ts
import { buildSerializedIndex, loadIndex } from "@fabianwaller/document-search";
import { englishAnalyzer } from "@fabianwaller/document-search/english";

const serialized = buildSerializedIndex(posts, {
  fields,
  analyzer: englishAnalyzer(),
  store: (post) => ({ slug: post.slug, title: post.title }),
});

const index = loadIndex(serialized, {
  analyzer: englishAnalyzer(),
});
```

The index is immutable. When the source collection changes, rebuild and reload
it rather than mutating it in place.

## Using It With Static Next.js Content

In a Next.js app, keep index construction on the server. For small static
collections, a server-only module can build and project the serialized index.

```ts
import "server-only";

import { buildSerializedIndex } from "@fabianwaller/document-search";
import { englishAnalyzer } from "@fabianwaller/document-search/english";
import { englishSynonyms } from "@fabianwaller/document-search/english-synonyms";

export const searchData = buildSerializedIndex(posts, {
  fields,
  analyzer: englishAnalyzer(),
  synonyms: englishSynonyms,
  store: (post) => ({ slug: post.slug, title: post.title }),
});
```

Pass that data through a statically rendered Server Component, then load it in a
client component without rebuilding the index there.

```tsx
"use client";

import { useMemo } from "react";
import { loadIndex } from "@fabianwaller/document-search";
import { englishAnalyzer } from "@fabianwaller/document-search/english";

const analyzer = englishAnalyzer();

export function Search({ searchData }) {
  const index = useMemo(
    () => loadIndex(searchData, { analyzer }),
    [searchData],
  );

  return index.search("query");
}
```

When Next.js prerenders routes in multiple workers, module-level index
construction can still run once per worker. For larger collections, generate a
JSON artifact before `next build` and import that artifact from your Server
Components.

```json
{
  "scripts": {
    "search:index": "tsx scripts/build-search-index.ts",
    "prebuild": "npm run search:index",
    "build": "next build"
  }
}
```

The generator should call `buildSerializedIndex` once and write the result under
`src/generated`. Server Components can import that JSON file directly and should
not call `buildSerializedIndex` themselves.

## API

The main package exports `buildIndex`, `buildSerializedIndex`, `loadIndex`, and
`defineFields`, along with the TypeScript types for fields, queries, results,
analyzers, synonym sources, serialized indexes, and typo-tolerance options.

Optional exports are available from:

- `@fabianwaller/document-search/english` for `englishAnalyzer`
- `@fabianwaller/document-search/english-synonyms` for `englishSynonyms`
