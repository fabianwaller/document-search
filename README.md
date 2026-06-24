- The index is immutable; rebuild it when the source collection changes.
- Documents can have any shape.
- Fields are explicitly selected and may be weighted.
- Expensive synonym expansion can be disabled per field with
  `expandSynonyms: false`.
- The default analyzer only normalizes and tokenizes Unicode text.
- Query-time typo tolerance is enabled by default and can be disabled with
  `typoTolerance: false` or tuned with `maxEditDistance` and
  `minTermLength`.
- English stemming and stop words are opt-in.
- The English synonym dictionary is opt-in and increases bundle size.
- Custom synonym maps are bidirectional and are supplied to `buildIndex`.
- Scores are meaningful only within one query and index, not across indexes.

Example:

```ts
import { buildIndex, defineFields } from "@your-scope/document-search";
import { englishSynonyms } from "@your-scope/document-search/english-synonyms";
import { englishAnalyzer } from "@your-scope/document-search/english";

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

For static Next.js content, build and project the index in a server-only
module:

```ts
import "server-only";

import { buildSerializedIndex } from "@your-scope/document-search";
import { englishAnalyzer } from "@your-scope/document-search/english";
import { englishSynonyms } from "@your-scope/document-search/english-synonyms";

export const searchData = buildSerializedIndex(posts, {
  fields,
  analyzer: englishAnalyzer(),
  synonyms: englishSynonyms,
  store: (post) => ({ slug: post.slug, title: post.title }),
});
```

Pass `searchData` through a statically rendered Server Component, then load it
in the client without rebuilding:

```tsx
"use client";

import { useMemo } from "react";
import { loadIndex } from "@your-scope/document-search";
import { englishAnalyzer } from "@your-scope/document-search/english";

const analyzer = englishAnalyzer();

export function Search({ searchData }) {
  const index = useMemo(
    () => loadIndex(searchData, { analyzer }),
    [searchData],
  );

  return index.search("query");
}
```

Only values returned by `store` are included with results. Source fields used
for indexing are not serialized.

When Next.js prerenders routes in multiple workers, module-level index
construction can still run once per worker. Generate a JSON artifact before
`next build` instead:

```json
{
  "scripts": {
    "search:index": "tsx scripts/build-search-index.ts",
    "prebuild": "npm run search:index",
    "build": "next build"
  }
}
```

The generator calls `buildSerializedIndex` once and writes its output under
`src/generated`. Server Components import that JSON artifact; they must not
call `buildSerializedIndex` themselves.
