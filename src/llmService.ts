import * as vscode from 'vscode';

export interface LLMLogAnalysis {
    staticSearchString: string;
    variables: Record<string, any>;
}

export interface CallerAnalysis {
    rankedCallers: Array<{
        filePath: string;
        lineNumber: number;
        code: string;
        functionName: string;
        confidence: number;
        explanation: string;
    }>;
}

export interface RegexPattern {
    pattern: string;
    description: string;
    extractionMap: Record<string, string>;
}

export interface LLMService {
    analyzeLog(logMessage: string, language: string): Promise<LLMLogAnalysis>;
    analyzeCallers(
        currentLogLine: string,
        staticSearchString: string,
        allLogLines: string[],
        potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>
    ): Promise<CallerAnalysis>;
    generateLogParsingRegex(
        logSamples: string[],
        expectedResults?: Record<string, any>[]
    ): Promise<RegexPattern[]>;
}

export class LLMServiceFactory {
    private static instance: LLMServiceFactory;
    private static serviceInstance: LLMService | null = null;
    private static currentProvider: string = '';
    
    private constructor() {}
    
    public static getInstance(): LLMServiceFactory {
        if (!LLMServiceFactory.instance) {
            LLMServiceFactory.instance = new LLMServiceFactory();
        }
        return LLMServiceFactory.instance;
    }
    
    public createLLMService(): LLMService {
        const config = vscode.workspace.getConfiguration('traceback');
        const usedLLMProvider = config.get<string>('llmProvider') || 'claude';
        
        // Only create a new instance if the provider has changed or we don't have an instance yet
        if (LLMServiceFactory.serviceInstance === null || LLMServiceFactory.currentProvider !== usedLLMProvider) {
            console.log(`Creating new LLM service instance for provider: ${usedLLMProvider}`);
            
            if (usedLLMProvider === 'ollama') {
                const ollamaEndpoint = config.get<string>('ollamaEndpoint');
                if (!ollamaEndpoint) {
                    throw new Error('Ollama endpoint not set. Please set an Ollama endpoint first.');
                }
                
                // Dynamically import to avoid circular dependencies
                const OllamaService = require('./ollamaService').OllamaService;
                LLMServiceFactory.serviceInstance = OllamaService.getInstance();
            } else {
                // Default to Claude
                // Dynamically import to avoid circular dependencies
                const ClaudeService = require('./claudeService').ClaudeService;
                LLMServiceFactory.serviceInstance = ClaudeService.getInstance();
            }
            
            // Update the current provider
            LLMServiceFactory.currentProvider = usedLLMProvider;
        }
        
        // Since we either already had a service instance or just created one, it should never be null here
        return LLMServiceFactory.serviceInstance!;
    }
    
    // Force recreate the service instance (useful when settings change)
    public static resetServiceInstance(): void {
        LLMServiceFactory.serviceInstance = null;
        LLMServiceFactory.currentProvider = '';
    }
}

export function filterRelevantLogs(currentLogLine: string, allLogLines: string[], maxLines: number): string[] {
    // Find the index of the current log line
    const currentIndex = allLogLines.indexOf(currentLogLine);
    if (currentIndex === -1) {
        return [currentLogLine];
    }

    // Get surrounding context (prefer more recent logs)
    const beforeCount = Math.floor(maxLines * 0.3); // 30% before
    const afterCount = Math.floor(maxLines * 0.7);  // 70% after

    const start = Math.max(0, currentIndex - beforeCount);
    const end = Math.min(allLogLines.length, currentIndex + afterCount);

    // Get the logs within our window
    const contextLogs = allLogLines.slice(start, end);

    // If we have room for more logs, try to find similar logs by pattern matching
    if (contextLogs.length < maxLines) {
        const remainingSlots = maxLines - contextLogs.length;
        const patternLogs = findSimilarLogs(currentLogLine, allLogLines, contextLogs, remainingSlots);
        return [...new Set([...contextLogs, ...patternLogs])];
    }

    return contextLogs;
}

export function findSimilarLogs(currentLogLine: string, allLogLines: string[], excludeLogs: string[], maxCount: number): string[] {
    // Simple similarity check based on word overlap
    const currentWords = new Set(currentLogLine.toLowerCase().split(/\s+/));

    return allLogLines
        .filter(log => !excludeLogs.includes(log)) // Exclude logs we already have
        .map(log => {
            const words = log.toLowerCase().split(/\s+/);
            const overlap = words.filter(word => currentWords.has(word)).length;
            return { log, similarity: overlap / Math.max(words.length, currentWords.size) };
        })
        .sort((a, b) => b.similarity - a.similarity) // Sort by similarity
        .slice(0, maxCount) // Take top N
        .map(item => item.log);
}