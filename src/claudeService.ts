import * as vscode from 'vscode';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

export interface LLMLogAnalysis {
    staticSearchString: string;
    variables: Record<string, any>;
}

interface PotentialCaller {
    filePath: string;
    lineNumber: number;
    code: string;
    functionName: string;
    functionRange?: vscode.Range;
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

export class ClaudeService {
    private static instance: ClaudeService;
    private apiKey: string | undefined;
    private apiEndpoint: string = 'https://api.anthropic.com/v1/messages';
    private anthropic: Anthropic | undefined;

    // Use a single model for all tasks since we're using the same one
    private model: string = 'claude-3-7-sonnet-20250219';
    // Use Claude Haiku for regex generation for faster responses and lower cost
    private haikuModel: string = 'claude-3-haiku-20240307';

    private constructor() {
        this.apiKey = vscode.workspace.getConfiguration('traceback').get<string>('claudeApiKey');
        if (this.apiKey) {
            this.anthropic = new Anthropic({
                apiKey: this.apiKey
            });
        }
    }

    public static getInstance(): ClaudeService {
        if (!ClaudeService.instance) {
            ClaudeService.instance = new ClaudeService();
        }
        return ClaudeService.instance;
    }

    public async setApiKey(apiKey: string): Promise<void> {
        this.apiKey = apiKey;
        this.anthropic = new Anthropic({
            apiKey: apiKey
        });
        await vscode.workspace.getConfiguration('traceback').update('claudeApiKey', apiKey, true);
    }

    public async analyzeLog(logMessage: string, language: string = 'unknown'): Promise<LLMLogAnalysis> {
        if (!this.apiKey || !this.anthropic) {
            throw new Error('Claude API key not set. Please set it in settings.');
        }
        return this.analyzeLogWithClaude(logMessage, language);
    }

    public async analyzeCallers(
        currentLogLine: string,
        staticSearchString: string,
        allLogLines: string[],
        potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>
    ): Promise<CallerAnalysis> {
        if (!this.apiKey) {
            throw new Error('Claude API key not set. Please set your API key first.');
        }

        try {
            const response = await this.callClaudeForCallerAnalysis(
                currentLogLine,
                staticSearchString,
                allLogLines,
                potentialCallers
            );
            return response;
        } catch (error) {
            console.error('Error analyzing callers with Claude:', error);
            throw new Error('Failed to analyze callers with Claude');
        }
    }

    /**
     * Generate regex patterns for parsing log lines
     * @param logSamples Array of log line samples to analyze
     * @param expectedResults Optional map of expected parsing results for some samples
     * @returns Array of regex patterns with extraction maps
     */
    public async generateLogParsingRegex(
        logSamples: string[],
        expectedResults?: Record<string, any>[]
    ): Promise<RegexPattern[]> {
        if (!this.apiKey) {
            throw new Error('Claude API key not set. Please set your API key first.');
        }

        try {
            return await this.callClaudeForRegexPatterns(logSamples, expectedResults);
        } catch (error) {
            console.error('Error generating regex patterns with Claude:', error);
            throw new Error('Failed to generate regex patterns with Claude');
        }
    }

    private async analyzeLogWithClaude(logMessage: string, language: string): Promise<LLMLogAnalysis> {
        if (!this.anthropic) {
            throw new Error('Claude API client not initialized. Please set your API key first.');
        }

        const tools = [{
            name: "analyze_log",
            description: "Analyze a log message to extract static search string and variables",
            input_schema: {
                type: "object",
                properties: {
                    staticSearchString: {
                        type: "string",
                        description: "The static prefix or template part of the log message that would be in the source code"
                    },
                    variables: {
                        type: "object",
                        description: "Key-value pairs of variables and dynamic values found in the log",
                        additionalProperties: true
                    }
                },
                required: ["staticSearchString", "variables"]
            }
        }];

        const request = {
            messages: [{
                role: 'user',
                content: `Analyze this log message and extract:
1. Think and infer a possibly longest static substring that can be searched in the code base.
2. Key-value pairs of any variables or dynamic values in the log

Log message: "${logMessage}"

Rules for static search string:
- Predicted staticSearchString should be exact substring of logMessage. 
- logMessage.substring(staticSearchString) should be true.
- No regular expressions allowed.
- Consider ${language} logging patterns.

Rules for variables:
- Extract all key-value pairs and dynamic values
- Preserve variable names as they appear in the log

Examples:
Input: "[PlaceOrder] user_id=\"3790d414-165b-11f0-8ee4-96dac6adf53a\" user_currency=\"USD\""
Static: "PlaceOrder"  (Note: brackets and log level removed)
Variables: {
  "user_id": "3790d414-165b-11f0-8ee4-96dac6adf53a",
  "user_currency": "USD"
}`
            }],
            model: this.model,
            max_tokens: 1000,
            temperature: 0,
            tools: tools,
            tool_choice: {
                type: "tool",
                name: "analyze_log"
            }
        };

        try {
            const response = await fetch(this.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.apiKey!,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(request)
            });

            let responseData;
            try {
                responseData = await response.json();
            } catch (e) {
                throw new Error(`Invalid JSON response: ${e}`);
            }

            if (!response.ok) {
                throw new Error(`Claude API error: ${response.statusText}\nDetails: ${JSON.stringify(responseData)}`);
            }

            console.log("Log Message: ", logMessage);
            console.log("Static Search String: ", responseData.content[0].input.staticSearchString);

            // Validate response structure
            if (!responseData.content ||
                !Array.isArray(responseData.content) ||
                responseData.content.length === 0 ||
                responseData.content[0].type !== 'tool_use' ||
                !responseData.content[0].input) {
                throw new Error('Invalid response format from Claude API: Missing required structure');
            }

            const toolOutput = responseData.content[0].input;

            // Clean up the static search string by removing log level indicators
            if (toolOutput.staticSearchString) {
                const logLevelPattern = /\[\s*(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\s*\]\s*/gi;
                toolOutput.staticSearchString = toolOutput.staticSearchString.replace(logLevelPattern, '');
            }

            return toolOutput as LLMLogAnalysis;
        } catch (error) {
            console.error('Error analyzing log with Claude:', error);
            throw error;
        }
    }

    private async callClaudeForCallerAnalysis(
        currentLogLine: string,
        staticSearchString: string,
        allLogLines: string[],
        potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; }>
    ): Promise<CallerAnalysis> {
        // Filter and limit log lines to prevent prompt too long errors
        const MAX_LOG_LINES = 20; // Reasonable limit to prevent context overflow
        const filteredLogs = this.filterRelevantLogs(currentLogLine, allLogLines, MAX_LOG_LINES);

        const tools = [{
            name: "analyze_callers",
            description: "Analyze potential callers and rank them based on likelihood",
            input_schema: {
                type: "object",
                properties: {
                    logMessage: {
                        type: "string",
                        description: "The log message to analyze"
                    },
                    rankedCallers: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                filePath: {
                                    type: "string",
                                    description: "Path to the file containing the caller"
                                },
                                lineNumber: {
                                    type: "number",
                                    description: "Line number of the caller"
                                },
                                functionName: {
                                    type: "string",
                                    description: "Name of the calling function"
                                },
                                confidence: {
                                    type: "number",
                                    description: "Confidence score between 0 and 1"
                                },
                                explanation: {
                                    type: "string",
                                    description: "Explanation of why this caller is ranked at this position"
                                }
                            },
                            required: ["filePath", "lineNumber", "functionName", "confidence", "explanation"]
                        }
                    }
                },
                required: ["logMessage", "rankedCallers"]
            }
        }];

        const request = {
            messages: [{
                role: 'user',
                content: `Analyze these potential callers and rank them based on likelihood of being the actual caller.

Current log line: "${currentLogLine}"
Static search string used: "${staticSearchString}"

Most relevant log lines from current session:
${filteredLogs.map(log => `- ${log}`).join('\n')}

Potential callers found in codebase:
${potentialCallers.map(caller => `
File: ${caller.filePath}
Function: ${caller.functionName}
Line ${caller.lineNumber}: ${caller.code}
`).join('\n')}

Rules for ranking:
1. Consider the context from the provided log lines
2. Look for patterns in function names and variable usage
3. Consider the proximity of the code to related functionality
4. Consider common logging patterns and practices
5. Higher confidence for direct matches with the static search string
6. Lower confidence for generic or utility functions that might just pass through the message

Return a ranked list of callers, each with:
- File path
- Line number
- Function name
- Confidence score (0-1)
- Explanation for the ranking

Use the analyze_callers function to return the results in the exact format required.`
            }],
            model: this.model,  // Use same model for all tasks
            max_tokens: 4000,         // Keep full token limit for detailed analysis
            tools: tools,
            tool_choice: {
                type: "tool",
                name: "analyze_callers"
            }
        };

        try {
            const response = await fetch(this.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.apiKey!,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(request)
            });

            let responseData;
            try {
                responseData = await response.json();
            } catch (e) {
                throw new Error(`Invalid JSON response: ${e}`);
            }

            if (!response.ok) {
                throw new Error(`Claude API error: ${response.statusText}\nDetails: ${JSON.stringify(responseData)}`);
            }

            if (!responseData.content || !responseData.content[0] || !(responseData.content[0].type === 'tool_use')) {
                throw new Error('Invalid response format: missing tool_calls');
            }

            return (responseData.content[0].input) as CallerAnalysis;
        } catch (error) {
            console.error('Error calling Claude API:', error);
            throw error;
        }
    }

    private async callClaudeForRegexPatterns(
        logSamples: string[],
        expectedResults?: Record<string, any>[]
    ): Promise<RegexPattern[]> {
        // Limit number of samples to avoid token limits
        const MAX_SAMPLES = 20;
        const selectedSamples = logSamples.slice(0, MAX_SAMPLES);

        const tools = [{
            name: "generate_log_regex",
            description: "Generate regex patterns for parsing log lines",
            input_schema: {
                type: "object",
                properties: {
                    patterns: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                pattern: {
                                    type: "string",
                                    description: "The regular expression pattern in JavaScript syntax"
                                },
                                description: {
                                    type: "string",
                                    description: "Description of what this pattern matches"
                                },
                                extractionMap: {
                                    type: "object",
                                    description: "Maps regex capture group names to LogEntry fields",
                                    properties: {
                                        severity: {
                                            type: "string",
                                            description: "Capture group name for severity level"
                                        },
                                        timestamp: {
                                            type: "string",
                                            description: "Capture group name for timestamp"
                                        },
                                        message: {
                                            type: "string",
                                            description: "Capture group name for message content"
                                        },
                                        serviceName: {
                                            type: "string",
                                            description: "Capture group name for service name"
                                        },
                                        fileName: {
                                            type: "string",
                                            description: "Capture group name for source file name"
                                        },
                                        lineNumber: {
                                            type: "string",
                                            description: "Capture group name for source line number"
                                        }
                                    },
                                    additionalProperties: true
                                }
                            },
                            required: ["pattern", "description", "extractionMap"]
                        }
                    }
                },
                required: ["patterns"]
            }
        }];

        let prompt = `Generate regular expression patterns to parse these log lines into a structured format. We need to extract key components:

1. Severity level (e.g., INFO, DEBUG, ERROR) - if present
2. Message content - the main content of the log (required)
3. Variables - values shown in the log (e.g., "user_id=123") - if present
4. Timestamp - in any format - if present
5. Service name or component - if present
6. File name - source file where the log originated - if present
7. Line number - source line number in the file - if present

Pay special attention to file names and line numbers which might appear in formats like:
- at fileName:lineNumber
- in fileName line lineNumber
- fileName(lineNumber)
- [fileName:lineNumber]
- fileName.ext:lineNumber

Log samples:
${selectedSamples.map((sample, i) => `${i+1}. ${sample}`).join('\n')}`;

        // Add expected results for some samples if provided
        if (expectedResults && expectedResults.length > 0) {
            prompt += `\n\nFor some log lines, these are examples of the expected parsing results:`;
            
            for (let i = 0; i < Math.min(expectedResults.length, selectedSamples.length); i++) {
                prompt += `\n\nLog: ${selectedSamples[i]}\nParsed:`;
                
                Object.entries(expectedResults[i]).forEach(([key, value]) => {
                    prompt += `\n  ${key}: ${JSON.stringify(value)}`;
                });
            }
        }

        prompt += `\n
Create one or more regex patterns that collectively handle these different log formats.

For each pattern:
1. Use JavaScript regex syntax with named capture groups (e.g., "(?<severity>INFO|ERROR)")
2. Include a clear description of what types of logs the pattern matches
3. Include an "extractionMap" that maps regex capture group names to LogEntry field names

The pattern should be comprehensive enough to extract:
- severity: The log severity level if present (INFO, DEBUG, ERROR, etc.)
- timestamp: The timestamp in any format, if present
- message: The main log message content
- serviceName: The name of the service or component generating the log
- fileName: The source file name if present (with or without extension)
- lineNumber: The line number in the source file if present
- Any other relevant fields

For file names and line numbers, ensure the patterns can handle:
- Various delimiters between file name and line number (:, line, at line, etc.)
- File names with or without extensions
- File paths (partial or full)
- Line numbers in different formats (parentheses, brackets, after "line", etc.)

Ensure the regex patterns:
- Are compatible with JavaScript's regular expression engine
- Use named capture groups for all extracted fields
- Are flexible enough to handle variations in format
- Are precise enough to avoid false positives
- Collectively cover all the provided log samples
- Handle both structured and unstructured log formats

Return the patterns using the generate_log_regex function.`;

        const request = {
            messages: [{
                role: 'user',
                content: prompt
            }],
            model: this.haikuModel,  // Use Haiku for regex generation (faster, cheaper)
            max_tokens: 4000,
            tools: tools,
            tool_choice: {
                type: "tool",
                name: "generate_log_regex"
            }
        };

        try {
            const response = await fetch(this.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.apiKey!,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(request)
            });

            let responseData;
            try {
                responseData = await response.json();
            } catch (e) {
                throw new Error(`Invalid JSON response: ${e}`);
            }

            if (!response.ok) {
                throw new Error(`Claude API error: ${response.statusText}\nDetails: ${JSON.stringify(responseData)}`);
            }

            // Validate response structure
            if (!responseData.content ||
                !Array.isArray(responseData.content) ||
                responseData.content.length === 0 ||
                responseData.content[0].type !== 'tool_use' ||
                !responseData.content[0].input ||
                !responseData.content[0].input.patterns) {
                throw new Error('Invalid response format from Claude API: Missing required structure');
            }

            // Extract patterns from response
            const patterns = responseData.content[0].input.patterns;
            
            // Validate each pattern
            for (const pattern of patterns) {
                if (!pattern.pattern || !pattern.description || !pattern.extractionMap) {
                    console.warn('Invalid pattern in Claude response:', pattern);
                    continue;
                }
                
                // Test if the pattern is a valid regex
                try {
                    new RegExp(pattern.pattern);
                } catch (error) {
                    console.warn(`Invalid regex pattern: ${pattern.pattern}`, error);
                    // Remove invalid patterns
                    patterns.splice(patterns.indexOf(pattern), 1);
                }
            }

            return patterns as RegexPattern[];
        } catch (error) {
            console.error('Error calling Claude API for regex patterns:', error);
            throw error;
        }
    }

    /**
     * Filter and limit log lines to the most relevant ones for analysis
     * @param currentLogLine The log line being analyzed
     * @param allLogLines All available log lines
     * @param maxLines Maximum number of log lines to return
     * @returns Array of filtered and limited log lines
     */
    private filterRelevantLogs(currentLogLine: string, allLogLines: string[], maxLines: number): string[] {
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
            const patternLogs = this.findSimilarLogs(currentLogLine, allLogLines, contextLogs, remainingSlots);
            return [...new Set([...contextLogs, ...patternLogs])];
        }

        return contextLogs;
    }

    /**
     * Find logs that have similar patterns to the current log line
     * @param currentLogLine The log line being analyzed
     * @param allLogLines All available log lines
     * @param excludeLogs Logs to exclude from the search
     * @param maxCount Maximum number of similar logs to return
     * @returns Array of similar log lines
     */
    private findSimilarLogs(currentLogLine: string, allLogLines: string[], excludeLogs: string[], maxCount: number): string[] {
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
}