import { listProductDocs, readProductDoc, readProductDocSection } from "@radioso/product-docs";
import type { ProductDoc, ProductDocSection, ProductDocSummary } from "@radioso/product-docs";

export type { ProductDoc, ProductDocSection, ProductDocSummary } from "@radioso/product-docs";

/**
 * Reads the documentation compiled into this build.
 *
 * The corpus is a build artifact rather than a hosted lookup on purpose: an operator running an
 * older release must be told how *their* release works, and an instance that answers documentation
 * questions by calling out would both leak the question and stop working when it could not.
 */
export class ProductDocsService {
  list(): readonly ProductDocSummary[] {
    return listProductDocs();
  }

  read(slug: string): ProductDoc | null {
    return readProductDoc(slug);
  }

  readSection(slug: string, sectionId: string): ProductDocSection | null {
    return readProductDocSection(slug, sectionId);
  }
}
