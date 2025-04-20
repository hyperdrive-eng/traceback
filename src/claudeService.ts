import * as vscode from 'vscode';
import fetch from 'node-fetch';

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

export class ClaudeService {
    private static instance: ClaudeService;
    private apiKey: string | undefined;
    private apiEndpoint: string = 'https://api.anthropic.com/v1/messages';

    // Use a single model for all tasks since we're using the same one
    private model: string = 'claude-3-7-sonnet-20250219';

    private constructor() {
        // Load API key from workspace state if available
        const config = vscode.workspace.getConfiguration('traceback');
        this.apiKey = config.get('claudeApiKey');
    }

    public static getInstance(): ClaudeService {
        if (!ClaudeService.instance) {
            ClaudeService.instance = new ClaudeService();
        }
        return ClaudeService.instance;
    }

    public async setApiKey(key: string): Promise<void> {
        this.apiKey = key;
        await vscode.workspace.getConfiguration('traceback').update('claudeApiKey', key, true);
    }

    public async analyzeLog(logMessage: string, language: string): Promise<LLMLogAnalysis> {
        if (!this.apiKey) {
            throw new Error('Claude API key not set. Please set your API key first.');
        }

        try {
            const response = await this.callClaude(logMessage, language);
            return response;
        } catch (error) {
            console.error('Error calling Claude API:', error);
            throw new Error('Failed to analyze log message with Claude');
        }
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

    private async callClaude(logMessage: string, language: string): Promise<LLMLogAnalysis> {
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
            max_tokens: 500,
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

            // Validate required fields are present
            if (!Object.prototype.hasOwnProperty.call(toolOutput, 'staticSearchString')) {
                console.warn('Claude response missing staticSearchString, using empty string');
                toolOutput.staticSearchString = '';
            }

            if (!Object.prototype.hasOwnProperty.call(toolOutput, 'variables')) {
                console.warn('Claude response missing variables, using empty object');
                toolOutput.variables = {};
            }

            // Ensure types are correct
            if (typeof toolOutput.staticSearchString !== 'string') {
                console.warn('Claude response staticSearchString is not a string, converting');
                toolOutput.staticSearchString = String(toolOutput.staticSearchString || '');
            }

            if (typeof toolOutput.variables !== 'object' || toolOutput.variables === null) {
                console.warn('Claude response variables is not an object, using empty object');
                toolOutput.variables = {};
            }

            // Clean up the static search string by removing log level indicators
            // This helps with matching source code that doesn't include these markers
            if (toolOutput.staticSearchString) {
                const logLevelPattern = /\[\s*(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\s*\]\s*/gi;
                // Store the original search string for debugging
                const originalSearchString = toolOutput.staticSearchString;
                // Remove log level indicators
                toolOutput.staticSearchString = toolOutput.staticSearchString.replace(logLevelPattern, '');

                // Log the change if we modified the search string
                if (originalSearchString !== toolOutput.staticSearchString) {
                    console.log(`Cleaned log level indicators from search string: "${originalSearchString}" → "${toolOutput.staticSearchString}"`);
                }
            }

            return toolOutput as LLMLogAnalysis;
        } catch (error) {
            console.error('Error calling Claude API:', error);
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