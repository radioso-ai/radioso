import type { ClusteringEmbeddingPort } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type {
  TextChunkingProviderChunk,
  TextChunkingProviderPort,
  TextChunkingProviderRequest,
} from "../domain/chunking/chunkingProvider.js";

const PROVIDER_NAME = "chonkiejs";
const SOURCE_CODE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "fish",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "less",
  "php",
  "py",
  "rb",
  "rs",
  "scala",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);
const LANGUAGE_ALIASES = new Map<string, string>([
  ["bash", "bash"],
  ["js", "javascript"],
  ["node", "javascript"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sh", "bash"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["yml", "yaml"],
]);

type ChunkLike = {
  text: string;
  startIndex: number;
  endIndex: number;
};

type ChunkerInstance = {
  chunk(text: string): Promise<ChunkLike[]> | ChunkLike[];
};

type TokenChunkerInstance = ChunkerInstance;
type RecursiveChunkerInstance = ChunkerInstance;
type SemanticChunkerInstance = ChunkerInstance;
type TableChunkerInstance = ChunkerInstance;
type CodeChunkerInstance = ChunkerInstance;

interface SpecializedRegion {
  kind: "table" | "code";
  sourceStartOffset: number;
  sourceEndOffset: number;
  contentStartOffset: number;
  content: string;
  language?: string;
}

interface LineRecord {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface TreeSitterLanguagePack {
  detectLanguageFromContent(content: string): string | undefined | null;
  detectLanguageFromExtension(extension: string): string | undefined | null;
  detectLanguageFromPath(path: string): string | undefined | null;
  downloadedLanguages(): string[];
  hasLanguage(name: string): boolean;
  download(names: string[]): number;
}

export class ChonkieChunkingProvider implements TextChunkingProviderPort {
  readonly name = PROVIDER_NAME;

  private readonly tokenChunkersByConfig = new Map<string, Promise<TokenChunkerInstance>>();
  private readonly recursiveChunkersByConfig = new Map<string, Promise<RecursiveChunkerInstance>>();
  private readonly tableChunkersByConfig = new Map<string, Promise<TableChunkerInstance>>();
  private readonly codeChunkersByConfig = new Map<string, Promise<CodeChunkerInstance>>();

  constructor(private readonly semanticEmbeddings?: ClusteringEmbeddingPort) {}

  async chunkText(request: TextChunkingProviderRequest): Promise<TextChunkingProviderChunk[]> {
    if (request.method === "fixed_window") {
      return this.chunkBaseText(request, request.content, 0);
    }

    const regions = findSpecializedRegions(request);

    if (regions.length === 0) {
      return this.chunkBaseText(request, request.content, 0);
    }

    const chunks: TextChunkingProviderChunk[] = [];
    let cursor = 0;

    for (const region of regions) {
      if (cursor < region.sourceStartOffset) {
        chunks.push(...await this.chunkBaseText(
          request,
          request.content.slice(cursor, region.sourceStartOffset),
          cursor,
        ));
      }

      chunks.push(...await this.chunkSpecializedRegion(request, region));
      cursor = region.sourceEndOffset;
    }

    if (cursor < request.content.length) {
      chunks.push(...await this.chunkBaseText(request, request.content.slice(cursor), cursor));
    }

    return chunks
      .filter((chunk) => chunk.content.trim().length > 0 && chunk.endOffset > chunk.startOffset)
      .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  }

  private async chunkBaseText(
    request: TextChunkingProviderRequest,
    content: string,
    offset: number,
  ): Promise<TextChunkingProviderChunk[]> {
    if (content.trim().length === 0) {
      return [];
    }

    if (request.method === "semantic") {
      return this.chunkSemanticBaseText(request, content, offset);
    }

    const chunker = await this.getChunker(request);
    const chunks = await Promise.resolve(chunker.chunk(content));
    return offsetChunks(chunks, offset);
  }

  private async chunkSemanticBaseText(
    request: TextChunkingProviderRequest,
    content: string,
    offset: number,
  ): Promise<TextChunkingProviderChunk[]> {
    const chunker = await this.getSemanticChunker(request);
    const chunks = await Promise.resolve(chunker.chunk(content));
    const providerChunks = offsetChunks(chunks, offset);

    if (providerChunks.length !== 1) {
      return providerChunks;
    }

    const sections = findMarkdownHeadingSections(content);
    if (sections.length <= 1) {
      return providerChunks;
    }

    return sections.map((section) => ({
      content: section.content,
      startOffset: offset + section.startOffset,
      endOffset: offset + section.endOffset,
    }));
  }

  private async chunkSpecializedRegion(
    request: TextChunkingProviderRequest,
    region: SpecializedRegion,
  ): Promise<TextChunkingProviderChunk[]> {
    try {
      if (region.kind === "table") {
        const chunker = await this.getTableChunker(request);
        const chunks = await Promise.resolve(chunker.chunk(region.content));

        if (chunks.length > 0) {
          return offsetChunks(chunks, region.contentStartOffset);
        }
      }

      if (region.kind === "code") {
        const language = await this.resolveCodeLanguage(request, region);
        const chunker = await this.getCodeChunker(request, language);
        const chunks = await Promise.resolve(chunker.chunk(region.content));

        if (chunks.length > 0) {
          return offsetChunks(chunks, region.contentStartOffset);
        }
      }
    } catch {
      // Specialized chunking is best-effort. If a parser or language is unavailable,
      // the selected base chunker still keeps ingestion moving.
    }

    return this.chunkBaseText(request, region.content, region.contentStartOffset);
  }

  private async resolveCodeLanguage(
    request: TextChunkingProviderRequest,
    region: SpecializedRegion,
  ): Promise<string> {
    const pack = await loadTreeSitterLanguagePack();
    const detected = normalizeCodeLanguageHint(region.language, pack)
      ?? inferLanguageFromTitle(request.title, pack)
      ?? pack?.detectLanguageFromContent(region.content)
      ?? null;

    if (!pack || !detected) {
      return "auto";
    }

    if (!pack.hasLanguage(detected)) {
      pack.download([detected]);
    }

    return pack.hasLanguage(detected) ? detected : "auto";
  }

  private getChunker(
    request: TextChunkingProviderRequest,
  ): Promise<TokenChunkerInstance    > {
    if (request.method === "fixed_window") {
      return this.getTokenChunker(request);
    }

    if (request.method === "recursive") {
      return this.getRecursiveChunker(request);
    }

    if (request.method === "semantic") {
      return this.getSemanticChunker(request);
    }

    throw new Error(`Unsupported ChonkieJS chunking method: ${String(request.method satisfies never)}`);
  }

  private getTokenChunker(request: TextChunkingProviderRequest): Promise<TokenChunkerInstance> {
    const cacheKey = [
      "fixed_window",
      request.chunkSize,
      request.chunkOverlap ?? 0,
    ].join(":");
    const cached = this.tokenChunkersByConfig.get(cacheKey);

    if (cached) {
      return cached;
    }

    const created = createTokenChunker(request);
    this.tokenChunkersByConfig.set(cacheKey, created);
    return created;
  }

  private getRecursiveChunker(request: TextChunkingProviderRequest): Promise<RecursiveChunkerInstance> {
    const cacheKey = [
      "recursive",
      request.chunkSize,
      request.minCharactersPerChunk ?? "",
    ].join(":");
    const cached = this.recursiveChunkersByConfig.get(cacheKey);

    if (cached) {
      return cached;
    }

    const created = createRecursiveChunker(request);
    this.recursiveChunkersByConfig.set(cacheKey, created);
    return created;
  }

  private getSemanticChunker(request: TextChunkingProviderRequest): Promise<SemanticChunkerInstance> {
    if (!this.semanticEmbeddings) {
      throw new Error("ChonkieJS semantic chunking requires an embedding provider");
    }

    // The embeddings callback closes over request-scoped usage correlation.
    // Reusing it would attribute later documents or workspaces to the first request.
    return createSemanticChunker(request, this.semanticEmbeddings);
  }

  private getTableChunker(request: TextChunkingProviderRequest): Promise<TableChunkerInstance> {
    const cacheKey = [
      "table",
      request.chunkSize,
    ].join(":");
    const cached = this.tableChunkersByConfig.get(cacheKey);

    if (cached) {
      return cached;
    }

    const created = createTableChunker(request);
    this.tableChunkersByConfig.set(cacheKey, created);
    return created;
  }

  private getCodeChunker(request: TextChunkingProviderRequest, language: string): Promise<CodeChunkerInstance> {
    const cacheKey = [
      "code",
      request.chunkSize,
      language,
    ].join(":");
    const cached = this.codeChunkersByConfig.get(cacheKey);

    if (cached) {
      return cached;
    }

    const created = createCodeChunker(request, language);
    this.codeChunkersByConfig.set(cacheKey, created);
    return created;
  }
}

const offsetChunks = (chunks: ChunkLike[], offset: number): TextChunkingProviderChunk[] =>
  chunks.map((chunk) => ({
    content: chunk.text,
    startOffset: offset + chunk.startIndex,
    endOffset: offset + chunk.endIndex,
  }));

const createTokenChunker = async (request: TextChunkingProviderRequest): Promise<TokenChunkerInstance> => {
  const { TokenChunker } = await import("@chonkiejs/core");

  return TokenChunker.create({
    chunkSize: request.chunkSize,
    chunkOverlap: request.chunkOverlap ?? 0,
  });
};

const createRecursiveChunker = async (request: TextChunkingProviderRequest): Promise<RecursiveChunkerInstance> => {
  const { RecursiveChunker } = await import("@chonkiejs/core");

  return RecursiveChunker.create({
    chunkSize: request.chunkSize,
    minCharactersPerChunk: request.minCharactersPerChunk,
  });
};

const createSemanticChunker = async (
  request: TextChunkingProviderRequest,
  embeddings: ClusteringEmbeddingPort,
): Promise<SemanticChunkerInstance> => {
  const { SemanticChunker } = await import("@chonkiejs/core");
  const usageContext = request.embeddingUsageContext;
  if (!usageContext) {
    throw new Error("ChonkieJS semantic chunking requires workspace request context");
  }

  return SemanticChunker.create({
    embeddings: async (texts: string[]) => {
      const result = await embeddings.embedForClustering({
        workspaceId: usageContext.workspaceId,
        texts,
        usageContext,
      });
      return result.vectors.map((vector) => [...vector]);
    },
    chunkSize: request.chunkSize,
    minCharactersPerSentence: request.minCharactersPerChunk,
  });
};

const createTableChunker = async (request: TextChunkingProviderRequest): Promise<TableChunkerInstance> => {
  const { TableChunker } = await import("@chonkiejs/core");

  return TableChunker.create({
    tokenizer: "character",
    chunkSize: request.chunkSize,
  });
};

const createCodeChunker = async (
  request: TextChunkingProviderRequest,
  language: string,
): Promise<CodeChunkerInstance> => {
  const { CodeChunker } = await import("@chonkiejs/core");

  return CodeChunker.create({
    chunkSize: request.chunkSize,
    language,
  });
};

const findSpecializedRegions = (request: TextChunkingProviderRequest): SpecializedRegion[] => {
  const wholeDocumentLanguage = inferLanguageHintFromTitle(request.title) ?? inferLanguageHintFromShebang(request.content);

  if (wholeDocumentLanguage) {
    return [
      {
        kind: "code",
        sourceStartOffset: 0,
        sourceEndOffset: request.content.length,
        contentStartOffset: 0,
        content: request.content,
        language: wholeDocumentLanguage,
      },
    ];
  }

  const regions: SpecializedRegion[] = [];

  for (const region of findFencedCodeRegions(request.content)) {
    addRegionIfAvailable(regions, region);
  }
  for (const region of findHtmlTableRegions(request.content)) {
    addRegionIfAvailable(regions, region);
  }
  for (const region of findMarkdownTableRegions(request.content)) {
    addRegionIfAvailable(regions, region);
  }

  return regions.sort((left, right) => left.sourceStartOffset - right.sourceStartOffset);
};

const addRegionIfAvailable = (regions: SpecializedRegion[], region: SpecializedRegion): void => {
  if (regions.some((existing) => regionsOverlap(existing, region))) {
    return;
  }

  regions.push(region);
};

const regionsOverlap = (left: SpecializedRegion, right: SpecializedRegion): boolean =>
  left.sourceStartOffset < right.sourceEndOffset && right.sourceStartOffset < left.sourceEndOffset;

const findFencedCodeRegions = (content: string): SpecializedRegion[] => {
  const lines = splitLines(content);
  const regions: SpecializedRegion[] = [];
  let index = 0;

  while (index < lines.length) {
    const opener = parseFenceOpener(lines[index]?.text ?? "");

    if (!opener) {
      index += 1;
      continue;
    }

    const endIndex = findFenceEnd(lines, index, opener);

    if (endIndex <= index) {
      index += 1;
      continue;
    }

    const openingLine = lines[index];
    const closingLine = lines[endIndex];
    const contentStartOffset = lines[index + 1]?.startOffset ?? openingLine.endOffset;
    const contentEndOffset = closingLine.startOffset;
    const codeContent = content.slice(contentStartOffset, contentEndOffset);

    if (codeContent.trim().length > 0) {
      regions.push({
        kind: "code",
        sourceStartOffset: openingLine.startOffset,
        sourceEndOffset: closingLine.endOffset,
        contentStartOffset,
        content: codeContent,
        language: opener.language,
      });
    }

    index = endIndex + 1;
  }

  return regions;
};

const findHtmlTableRegions = (content: string): SpecializedRegion[] => {
  const regions: SpecializedRegion[] = [];
  const pattern = /<table\b[\s\S]*?<\/table>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const table = match[0];
    const startOffset = match.index;
    const endOffset = startOffset + table.length;

    regions.push({
      kind: "table",
      sourceStartOffset: startOffset,
      sourceEndOffset: endOffset,
      contentStartOffset: startOffset,
      content: table,
    });
  }

  return regions;
};

const findMarkdownTableRegions = (content: string): SpecializedRegion[] => {
  const lines = splitLines(content);
  const regions: SpecializedRegion[] = [];
  let index = 0;

  while (index < lines.length - 1) {
    if (!isMarkdownTableHeader(lines, index)) {
      index += 1;
      continue;
    }

    let endIndex = index + 1;

    while (endIndex + 1 < lines.length && isMarkdownTableRow(lines[endIndex + 1]?.text ?? "")) {
      endIndex += 1;
    }

    const startOffset = lines[index].startOffset;
    const endOffset = lines[endIndex].endOffset;
    regions.push({
      kind: "table",
      sourceStartOffset: startOffset,
      sourceEndOffset: endOffset,
      contentStartOffset: startOffset,
      content: content.slice(startOffset, endOffset),
    });
    index = endIndex + 1;
  }

  return regions;
};

const findMarkdownHeadingSections = (content: string): TextChunkingProviderChunk[] => {
  const lines = splitLines(content);
  const headingIndexes = lines
    .map((line, index) => isHeadingLine(line.text) ? index : -1)
    .filter((index) => index >= 0);

  if (headingIndexes.length <= 1) {
    return [];
  }

  return headingIndexes
    .map((lineIndex, sectionIndex) => {
      const startOffset = lines[lineIndex]?.startOffset ?? 0;
      const nextHeadingIndex = headingIndexes[sectionIndex + 1];
      const rawEndOffset = typeof nextHeadingIndex === "number"
        ? lines[nextHeadingIndex]?.startOffset ?? content.length
        : content.length;
      const { startOffset: trimmedStartOffset, endOffset } = trimRange(content, startOffset, rawEndOffset);

      if (trimmedStartOffset >= endOffset) {
        return null;
      }

      return {
        content: content.slice(trimmedStartOffset, endOffset),
        startOffset: trimmedStartOffset,
        endOffset,
      };
    })
    .filter((chunk): chunk is TextChunkingProviderChunk => chunk !== null);
};

const splitLines = (content: string): LineRecord[] => {
  const lines: LineRecord[] = [];
  let startOffset = 0;

  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === "\n") {
      lines.push({
        text: content.slice(startOffset, index),
        startOffset,
        endOffset: index,
      });
      startOffset = index + 1;
    }
  }

  return lines;
};

const trimRange = (
  content: string,
  rawStartOffset: number,
  rawEndOffset: number,
): { startOffset: number; endOffset: number } => {
  let startOffset = rawStartOffset;
  let endOffset = rawEndOffset;

  while (startOffset < endOffset && /\s/.test(content[startOffset] ?? "")) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/.test(content[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  return { startOffset, endOffset };
};

const isMarkdownTableHeader = (lines: LineRecord[], index: number): boolean =>
  isMarkdownTableRow(lines[index]?.text ?? "") && isMarkdownTableDelimiter(lines[index + 1]?.text ?? "");

const isMarkdownTableRow = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
};

const isMarkdownTableDelimiter = (value: string): boolean =>
  /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(value);

const isHeadingLine = (value: string): boolean => /^\s{0,3}#{1,6}\s+\S/.test(value);

const parseFenceOpener = (value: string): { marker: string; language?: string } | null => {
  const match = /^\s*(`{3,}|~{3,})([A-Za-z0-9_+.-]+)?/.exec(value);

  if (!match) {
    return null;
  }

  return {
    marker: match[1],
    language: match[2],
  };
};

const findFenceEnd = (lines: LineRecord[], startIndex: number, opener: { marker: string }): number => {
  const markerCharacter = opener.marker[0] ?? "`";
  const minimumLength = opener.marker.length;
  const closerPattern = new RegExp(`^\\s*${escapeRegExp(markerCharacter)}{${minimumLength},}\\s*$`);

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (closerPattern.test(lines[index]?.text ?? "")) {
      return index;
    }
  }

  return startIndex;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const inferLanguageHintFromTitle = (title?: string): string | null => {
  if (!title) {
    return null;
  }

  const match = /\.([A-Za-z0-9_+-]+)$/.exec(title.trim());
  const extension = match?.[1]?.toLowerCase() ?? null;

  if (!extension || !SOURCE_CODE_EXTENSIONS.has(extension)) {
    return null;
  }

  return extension;
};

const inferLanguageHintFromShebang = (content: string): string | null => {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const match = /^#!.*\/(?:env\s+)?([A-Za-z0-9_+.-]+)/.exec(firstLine);
  return match?.[1]?.replace(/\d+(?:\.\d+)*$/, "").toLowerCase() ?? null;
};

const inferLanguageFromTitle = (title: string | undefined, pack: TreeSitterLanguagePack | null): string | null => {
  if (!title || !pack) {
    return null;
  }

  return pack.detectLanguageFromPath(title) ?? normalizeCodeLanguageHint(inferLanguageHintFromTitle(title), pack);
};

const normalizeCodeLanguageHint = (
  language: string | null | undefined,
  pack: TreeSitterLanguagePack | null,
): string | null => {
  if (!language) {
    return null;
  }

  const normalized = language.toLowerCase().trim();
  return pack?.detectLanguageFromExtension(normalized) ?? LANGUAGE_ALIASES.get(normalized) ?? normalized;
};

const loadTreeSitterLanguagePack = async (): Promise<TreeSitterLanguagePack | null> => {
  try {
    const module = await import("@kreuzberg/tree-sitter-language-pack");
    return (module.default ?? module);
  } catch {
    return null;
  }
};
