declare module "synonyms" {
  type SynonymEntry = Readonly<Record<string, readonly string[]>>;

  type Synonyms = {
    (word: string, type?: string): SynonymEntry | readonly string[] | undefined;
    readonly dictionary: Readonly<Record<string, SynonymEntry>>;
  };

  const synonyms: Synonyms;
  export default synonyms;
}

declare module "stopword" {
  export const eng: readonly string[];
}

declare module "wink-porter2-stemmer" {
  const stem: (word: string) => string;
  export default stem;
}
