import * as fs from "node:fs";
import * as path from "node:path";
import { LocalLlmClient } from "./client.js";

export interface SearchMatch {
  file: string;
  line: number;
  snippet: string;
  score: number;
  mode: "hybrid" | "semantic" | "lexical";
}

export interface ChunkMetadata {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Tokenizes text for BM25 keyword and lexical matching.
 */
export function tokenizeCode(text: string): string[] {
  // Splits on non-alphanumeric (except underscores) and handles camelCase/snake_case
  const tokens: string[] = [];
  const rawWords = text.toLowerCase().match(/[a-z0-9_]+/g) || [];

  for (const word of rawWords) {
    tokens.push(word);
    if (word.includes("_")) {
      const subParts = word.split("_").filter(Boolean);
      tokens.push(...subParts);
    }
  }
  return tokens;
}

/**
 * Okapi BM25 Lexical Scoring Index
 */
export class BM25Index {
  private k1: number = 1.2;
  private b: number = 0.75;
  private docCount: number = 0;
  private docLengths: Map<string, number> = new Map();
  private docTerms: Map<string, Map<string, number>> = new Map();
  private docMetadata: Map<string, ChunkMetadata> = new Map();
  private termDocFreq: Map<string, number> = new Map();
  private avgDocLength: number = 0;

  public addDocument(id: string, text: string, metadata: ChunkMetadata): void {
    const tokens = tokenizeCode(text);
    if (tokens.length === 0) return;

    this.docCount++;
    this.docLengths.set(id, tokens.length);
    this.docMetadata.set(id, metadata);

    const termFreqs: Map<string, number> = new Map();
    const uniqueTerms = new Set<string>();

    for (const t of tokens) {
      termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
      uniqueTerms.add(t);
    }

    this.docTerms.set(id, termFreqs);

    for (const t of uniqueTerms) {
      this.termDocFreq.set(t, (this.termDocFreq.get(t) || 0) + 1);
    }

    let totalLength = 0;
    for (const len of this.docLengths.values()) {
      totalLength += len;
    }
    this.avgDocLength = totalLength / Math.max(1, this.docCount);
  }

  public search(query: string, limit: number = 20): Array<{ id: string; score: number; metadata: ChunkMetadata }> {
    const queryTokens = tokenizeCode(query);
    if (queryTokens.length === 0 || this.docCount === 0) return [];

    const scores: Map<string, number> = new Map();

    for (const term of queryTokens) {
      const df = this.termDocFreq.get(term) || 0;
      if (df === 0) continue;

      // Robertson-Spärck Jones IDF
      const idf = Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, termFreqs] of this.docTerms.entries()) {
        const tf = termFreqs.get(term) || 0;
        if (tf === 0) continue;

        const docLen = this.docLengths.get(docId) || 1;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / Math.max(1, this.avgDocLength)));
        const termScore = idf * (numerator / denominator);

        scores.set(docId, (scores.get(docId) || 0) + termScore);
      }
    }

    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    for (const [id, score] of scores.entries()) {
      const meta = this.docMetadata.get(id);
      if (meta) {
        results.push({ id, score, metadata: meta });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/**
 * Computes Cosine Similarity between two dense embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Dense Vector Index for Cosine Similarity
 */
export class VectorIndex {
  private vectors: Map<string, { embedding: number[]; metadata: ChunkMetadata }> = new Map();

  public addVector(id: string, embedding: number[], metadata: ChunkMetadata): void {
    this.vectors.set(id, { embedding, metadata });
  }

  public search(queryEmbedding: number[], limit: number = 20): Array<{ id: string; score: number; metadata: ChunkMetadata }> {
    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];

    for (const [id, entry] of this.vectors.entries()) {
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (sim > 0.05) {
        results.push({ id, score: sim, metadata: entry.metadata });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/**
 * Blends dense semantic vector rankings and sparse BM25 rankings
 * using standard Reciprocal Rank Fusion (RRF).
 */
export function reciprocalRankFusion<T extends { id: string; metadata: ChunkMetadata }>(
  denseRanked: T[],
  sparseRanked: T[],
  k: number = 60,
  limit: number = 10,
): Array<{ id: string; score: number; rrfScore: number; metadata: ChunkMetadata }> {
  const scores: Map<string, { rrf: number; rawDense: number; rawSparse: number; metadata: ChunkMetadata }> = new Map();

  denseRanked.forEach((item, index) => {
    const rank = index + 1;
    const rrfContrib = 1 / (k + rank);
    const existing = scores.get(item.id) || { rrf: 0, rawDense: 0, rawSparse: 0, metadata: item.metadata };
    existing.rrf += rrfContrib;
    existing.rawDense = (item as any).score || 0;
    scores.set(item.id, existing);
  });

  sparseRanked.forEach((item, index) => {
    const rank = index + 1;
    const rrfContrib = 1 / (k + rank);
    const existing = scores.get(item.id) || { rrf: 0, rawDense: 0, rawSparse: 0, metadata: item.metadata };
    existing.rrf += rrfContrib;
    existing.rawSparse = (item as any).score || 0;
    scores.set(item.id, existing);
  });

  const merged: Array<{ id: string; score: number; rrfScore: number; metadata: ChunkMetadata }> = [];
  for (const [id, val] of scores.entries()) {
    merged.push({
      id,
      score: val.rawDense || val.rawSparse,
      rrfScore: val.rrf,
      metadata: val.metadata,
    });
  }

  return merged.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, limit);
}

/**
 * Hybrid Search Engine integrating BM25 lexical search, dense semantic embeddings,
 * and Reciprocal Rank Fusion for local code intelligence.
 */
export class HybridSearchEngine {
  private workspace: string;
  private bm25: BM25Index;
  private vectorIndex: VectorIndex;
  private client?: LocalLlmClient;
  private indexed: boolean = false;

  constructor(workspace: string, client?: LocalLlmClient) {
    this.workspace = path.resolve(workspace);
    this.bm25 = new BM25Index();
    this.vectorIndex = new VectorIndex();
    this.client = client;
  }

  private isIgnored(relPath: string): boolean {
    const ignoredDirs = [
      "node_modules",
      ".git",
      ".nexus",
      "target",
      "dist",
      "build",
      ".vscode",
      ".idea",
      "coverage",
    ];
    const parts = relPath.split(path.sep);
    return parts.some((p) => ignoredDirs.includes(p));
  }

  public async indexWorkspace(maxFiles: number = 300): Promise<{ totalIndexed: number; totalChunks: number }> {
    const filesToIndex: string[] = [];

    const walk = (dir: string) => {
      if (filesToIndex.length >= maxFiles) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        if (filesToIndex.length >= maxFiles) break;
        const fullPath = path.join(dir, ent.name);
        const rel = path.relative(this.workspace, fullPath);
        if (this.isIgnored(rel)) continue;

        if (ent.isDirectory()) {
          walk(fullPath);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          const codeExts = [
            ".ts", ".js", ".tsx", ".jsx", ".rs", ".py", ".go", ".c", ".cpp",
            ".h", ".hpp", ".java", ".json", ".md", ".toml", ".yaml", ".yml",
          ];
          if (codeExts.includes(ext)) {
            filesToIndex.push(fullPath);
          }
        }
      }
    };

    walk(this.workspace);

    let totalChunks = 0;
    for (const filePath of filesToIndex) {
      try {
        const relPath = path.relative(this.workspace, filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        // Chunk file into ~40 line blocks with 10 line overlap
        const chunkSize = 40;
        const overlap = 10;
        let lineIdx = 0;

        while (lineIdx < lines.length) {
          const slice = lines.slice(lineIdx, lineIdx + chunkSize);
          const chunkText = slice.join("\n");
          const chunkId = `${relPath}#L${lineIdx + 1}-L${lineIdx + slice.length}`;

          const meta: ChunkMetadata = {
            file: relPath,
            startLine: lineIdx + 1,
            endLine: lineIdx + slice.length,
            content: chunkText,
          };

          this.bm25.addDocument(chunkId, chunkText, meta);
          totalChunks++;

          // Attempt embedding if client configured
          if (this.client) {
            try {
              const emb = await this.client.generateEmbedding(chunkText);
              this.vectorIndex.addVector(chunkId, emb, meta);
            } catch {
              // Gracefully continue with lexical BM25 if embedding endpoint unavailable
            }
          }

          lineIdx += chunkSize - overlap;
        }
      } catch {}
    }

    this.indexed = true;
    return { totalIndexed: filesToIndex.length, totalChunks };
  }

  public async search(
    query: string,
    options: { mode?: "hybrid" | "semantic" | "lexical"; path?: string; limit?: number } = {},
  ): Promise<SearchMatch[]> {
    if (!this.indexed) {
      await this.indexWorkspace();
    }

    const mode = options.mode || "hybrid";
    const limit = options.limit || 10;
    const filterPath = options.path;

    const lexicalMatches = this.bm25.search(query, limit * 2);

    let semanticMatches: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    if (this.client && (mode === "hybrid" || mode === "semantic")) {
      try {
        const queryEmb = await this.client.generateEmbedding(query);
        semanticMatches = this.vectorIndex.search(queryEmb, limit * 2);
      } catch {}
    }

    let finalResults: Array<{ metadata: ChunkMetadata; score: number }> = [];

    if (mode === "lexical" || semanticMatches.length === 0) {
      finalResults = lexicalMatches.map((m) => ({ metadata: m.metadata, score: m.score }));
    } else if (mode === "semantic") {
      finalResults = semanticMatches.map((m) => ({ metadata: m.metadata, score: m.score }));
    } else {
      // Reciprocal Rank Fusion
      const fused = reciprocalRankFusion(semanticMatches, lexicalMatches, 60, limit * 2);
      finalResults = fused.map((f) => ({ metadata: f.metadata, score: f.rrfScore }));
    }

    if (filterPath) {
      finalResults = finalResults.filter((r) => r.metadata.file.startsWith(filterPath));
    }

    return finalResults.slice(0, limit).map((r) => ({
      file: r.metadata.file,
      line: r.metadata.startLine,
      snippet: r.metadata.content.slice(0, 300).trim(),
      score: parseFloat(r.score.toFixed(4)),
      mode,
    }));
  }
}
