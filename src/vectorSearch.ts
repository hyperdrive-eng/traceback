import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OllamaService } from './ollamaService';

// Interface for a code chunk with its vector embedding
interface CodeChunk {
  file: string;
  line: number;
  content: string;
  embedding: number[];
  contextLines: {
    content: string;
    lineNumber: number;
  }[];
}

// Distance metric options
enum DistanceMetric {
  Euclidean = 'euclidean',
  Manhattan = 'manhattan',
  Cosine = 'cosine'
}

export class VectorStore {
  private chunks: CodeChunk[] = [];
  private static instance: VectorStore;
  private isIndexed: boolean = false;
  private indexingPromise: Promise<void> | null = null;
  private ollamaService: OllamaService;

  private constructor() {
    this.ollamaService = OllamaService.getInstance();
  }

  public static getInstance(): VectorStore {
    if (!VectorStore.instance) {
      VectorStore.instance = new VectorStore();
    }
    return VectorStore.instance;
  }

  // Check if workspace is indexed
  public isWorkspaceIndexed(): boolean {
    return this.isIndexed;
  }

  // Get current chunks count
  public getChunksCount(): number {
    return this.chunks.length;
  }

  // Convert text to vector embedding using Ollama
  private async textToVector(text: string): Promise<number[]> {
    return await this.ollamaService.generateEmbedding(text);
  }

  // Calculate cosine similarity between two vectors
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same length');
    }
    
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const mag1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const mag2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (mag1 * mag2);
  }

  // Calculate Euclidean distance between two vectors
  private euclideanDistance(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same length');
    }
    const sumSquares = vec1.reduce((sum, val, i) => sum + Math.pow(val - vec2[i], 2), 0);
    return Math.sqrt(sumSquares);
  }

  // Calculate Manhattan distance between two vectors
  private manhattanDistance(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same length');
    }
    return vec1.reduce((sum, val, i) => sum + Math.abs(val - vec2[i]), 0);
  }

  // Calculate distance/similarity between two vectors using specified metric
  private calculateDistance(vec1: number[], vec2: number[], metric: DistanceMetric): number {
    switch (metric) {
      case DistanceMetric.Euclidean:
        return this.euclideanDistance(vec1, vec2);
      case DistanceMetric.Manhattan:
        return this.manhattanDistance(vec1, vec2);
      case DistanceMetric.Cosine:
        // Convert cosine similarity to a distance (1 - similarity)
        // This way, lower values are always better across all metrics
        return 1 - this.cosineSimilarity(vec1, vec2);
      default:
        throw new Error(`Unsupported distance metric: ${metric}`);
    }
  }

  // Index a file for vector search
  private async indexFile(filePath: string): Promise<void> {
    try {
      console.log(`Indexing file: ${filePath}`);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const startChunks = this.chunks.length;
      
      // Process each line and create chunks
      for (const [index, line] of lines.entries()) {
        // Skip empty lines or lines with just whitespace
        if (line.trim().length === 0) continue;
        
        // Create a chunk with context (include surrounding lines)
        const contextStart = Math.max(0, index - 2);
        const contextEnd = Math.min(lines.length - 1, index + 2);
        const contextLines = lines.slice(contextStart, contextEnd + 1).map((content, i) => ({
          content,
          lineNumber: contextStart + i
        }));
        const chunkContent = contextLines.map(c => c.content).join('\n');
        
        const chunk: CodeChunk = {
          file: filePath,
          line: index,  // Store the original line number
          content: chunkContent,
          embedding: await this.textToVector(chunkContent),
          contextLines
        };
        
        this.chunks.push(chunk);
      }
      
      const chunksAdded = this.chunks.length - startChunks;
      console.log(`Indexed ${chunksAdded} chunks from ${filePath}`);
    } catch (error) {
      console.error(`Error indexing file ${filePath}:`, error);
      throw error;
    }
  }

  // Index all code files in the workspace
  public async indexWorkspace(workspaceRoot: string): Promise<void> {
    // If already indexed, return immediately
    if (this.isIndexed) {
      console.log('Workspace already indexed, skipping indexing');
      return;
    }

    // If indexing is in progress, wait for it
    if (this.indexingPromise) {
      console.log('Indexing already in progress, waiting for completion');
      return this.indexingPromise;
    }

    // Start indexing
    this.indexingPromise = (async () => {
      console.log('Starting workspace indexing...');
      const startTime = Date.now();
      
      try {
        // Initialize Ollama service
        await this.ollamaService.initialize();
        console.log('Successfully initialized Ollama service');

        // Clear existing chunks
        this.chunks = [];
        
        // Find all code files
        console.log('Finding code files in workspace...');
        const files = await vscode.workspace.findFiles(
          '**/*.{ts,tsx,js,jsx,vue,svelte,rs,go,py,java,cs,cpp,c,h,rb,php}',
          '**/[node_modules,dist,build,.git,logs]/**'
        );
        
        console.log(`Found ${files.length} files to index`);
        
        // Index each file
        for (const [index, file] of files.entries()) {
          if (index > 0 && index % 100 === 0) {
            console.log(`Indexed ${index}/${files.length} files...`);
          }
          await this.indexFile(file.fsPath);
        }
        
        const duration = (Date.now() - startTime) / 1000;
        console.log(`Completed indexing ${files.length} files with ${this.chunks.length} chunks in ${duration.toFixed(1)}s`);
        
        this.isIndexed = true;
      } catch (error) {
        console.error('Error during workspace indexing:', error);
        vscode.window.showErrorMessage('Failed to index workspace: The nomic-embed-text model is required. Please run "ollama pull nomic-embed-text" in your terminal and try again.');
        throw error;
      } finally {
        this.indexingPromise = null;
      }
    })();

    return this.indexingPromise;
  }

  // Search for the most similar code chunks
  public async search(
    query: string,
    topK: number = 5
  ): Promise<Array<{ file: string; line: number; similarity: number }>> {
    if (!this.isIndexed) {
      throw new Error('Workspace not indexed yet. Please wait for indexing to complete.');
    }

    // Handle exact: prefix
    const isExactSearch = query.startsWith('exact:');
    const searchQuery = isExactSearch ? query.slice(6).trim() : query;

    console.log(`Searching for: "${searchQuery}" (${isExactSearch ? 'exact match' : 'semantic match'})`);
    const startTime = Date.now();
    
    const queryVector = await this.textToVector(searchQuery);
    
    // Calculate similarities with all chunks
    const results = this.chunks.map(chunk => {
      let similarity = this.cosineSimilarity(queryVector, chunk.embedding);
      
      // Find the line within the chunk that best matches the query
      let bestLine = chunk.line;
      let bestScore = 0;
      let hasExactMatch = false;
      
      for (const line of chunk.contextLines) {
        // For exact search, prioritize exact substring matches
        if (isExactSearch) {
          if (line.content.includes(searchQuery)) {
            bestLine = line.lineNumber;
            bestScore = 1.0;
            hasExactMatch = true;
            break;
          }
        }
        
        // If not exact search or no exact match found, use text similarity
        const lineScore = this.calculateTextSimilarity(searchQuery, line.content);
        if (lineScore > bestScore) {
          bestScore = lineScore;
          bestLine = line.lineNumber;
        }
      }

      // For exact search, boost similarity score if we found an exact match
      if (isExactSearch && hasExactMatch) {
        similarity = 1.0;
      }
      
      return {
        file: chunk.file,
        line: bestLine,
        similarity
      };
    });
    
    // For exact search, filter out non-exact matches
    const filteredResults = isExactSearch 
      ? results.filter(r => r.similarity > 0.99)
      : results;
    
    // Sort by similarity and return top K results
    const topResults = filteredResults
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    const duration = (Date.now() - startTime);
    console.log(`Search completed in ${duration}ms, found ${topResults.length} results`);
    if (topResults.length > 0) {
      console.log('Top result:', topResults[0]);
    }
    
    return topResults;
  }

  // Simple text similarity calculation
  private calculateTextSimilarity(query: string, text: string): number {
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const textWords = text.toLowerCase().split(/\s+/);
    
    let matches = 0;
    for (const word of textWords) {
      if (queryWords.has(word)) {
        matches++;
      }
    }
    
    return matches / Math.max(queryWords.size, textWords.length);
  }
}

// Helper function to find the full file path from a partial filename
export async function findFullPath(partialPath: string, repoPath: string): Promise<string | undefined> {
  try {
    // If it's already a full path and exists, return it
    const fullPath = path.join(repoPath, partialPath);
    if (fs.existsSync(fullPath)) {
      return partialPath;
    }

    // Extract the filename from the partial path
    const fileName = path.basename(partialPath);
    
    // Search for files with this name in the workspace
    const files = await vscode.workspace.findFiles(
      `**/${fileName}`,
      '**/[node_modules,dist,build,.git,logs]/**'
    );

    if (files.length === 0) {
      return undefined;
    }

    // If we have multiple matches, try to find the best one
    if (files.length > 1) {
      // If the partial path has directories, use them to find the best match
      const pathParts = partialPath.split(/[\/\\]/).filter(Boolean);
      if (pathParts.length > 1) {
        // Score each file based on how many path parts match
        const scores = files.map(file => {
          const fileParts = file.fsPath.split(/[\/\\]/).filter(Boolean);
          let score = 0;
          for (const part of pathParts) {
            if (fileParts.includes(part)) {
              score++;
            }
          }
          return { file, score };
        });

        // Sort by score and get the best match
        scores.sort((a, b) => b.score - a.score);
        return path.relative(repoPath, scores[0].file.fsPath);
      }
    }

    // If we only have one match or couldn't find a better match, use the first one
    return path.relative(repoPath, files[0].fsPath);
  } catch (error) {
    console.error('Error finding full path:', error);
    return undefined;
  }
}

// Export a function to find code location using vector search
export async function findCodeLocationVector(
  query: string,
  repoPath?: string,
  returnAllMatches: boolean = false
): Promise<{ file: string; line: number; similarity: number }[] | { file: string; line: number } | undefined> {
  try {
    if (!repoPath) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open');
      }
      repoPath = workspaceFolders[0].uri.fsPath;
    }

    const vectorStore = VectorStore.getInstance();
    
    // Search for the most similar code chunks
    const results = await vectorStore.search(query);
    
    if (results.length > 0) {
      if (returnAllMatches) {
        // Return all matches with their similarity scores
        return results.map(result => ({
          file: result.file,
          line: result.line,
          similarity: result.similarity
        }));
      } else {
        // Return just the best match without similarity score
        const bestMatch = results[0];
        // Try to find the full path if we only have a partial path
        const fullPath = await findFullPath(bestMatch.file, repoPath);
        return {
          file: fullPath || bestMatch.file,
          line: bestMatch.line
        };
      }
    }
    
    return undefined;
  } catch (error) {
    console.error('Error in findCodeLocationVector:', error);
    throw error;
  }
} 