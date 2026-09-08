/** One `##` section of a documentation page, addressable on its own so a long page reads in parts. */
export interface ProductDocSection {
  readonly id: string;
  readonly heading: string;
  readonly body: string;
}

/** What a caller needs to choose a page without loading one. */
export interface ProductDocSummary {
  readonly slug: string;
  /** Absolute URL of the published page, for citing it back to a reader. */
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly section: string;
  readonly lastUpdated: string | null;
  readonly headings: readonly string[];
}

export interface ProductDoc extends ProductDocSummary {
  /** Page text before the first `##` heading. */
  readonly intro: string;
  readonly sections: readonly ProductDocSection[];
}

export interface ProductDocsCorpus {
  readonly generatedFrom: string;
  readonly pageCount: number;
  readonly pages: readonly ProductDoc[];
}
