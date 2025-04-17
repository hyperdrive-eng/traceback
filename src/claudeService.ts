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

    // Use different models for different tasks
    private analysisModel: string = 'claude-3-haiku-20240307'; // Fast model for simple analysis
    private callerModel: string = 'claude-3-7-sonnet-20250219';  // Use Sonnet for better balance of speed and quality

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

    public async analyzeLog(logMessage: string): Promise<LLMLogAnalysis> {
        if (!this.apiKey) {
            throw new Error('Claude API key not set. Please set your API key first.');
        }

        try {
            const response = await this.callClaude(logMessage);
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

    private async callClaude(logMessage: string): Promise<LLMLogAnalysis> {
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
1. The static prefix or template part that would be in the source code
2. Key-value pairs of any variables or dynamic values in the log

Log message: "${logMessage}"

Rules for static search string:
- Only include text that is guaranteed to be constant in the source code
- Do NOT include any key-value pair formatting or variable values
- Do NOT include log level indicators like [INFO], [DEBUG], [ERROR], etc. - they often aren't in the source code
- Do NOT include timestamps or date formats as they are typically generated at runtime
- When in doubt, be conservative and include less rather than more
- Focus on the actual message content that would appear in a logging statement
- You MUST return a non-empty static string

Rules for variables:
- Extract all key-value pairs and dynamic values
- Preserve variable names as they appear in the log
- Keep the original data types where clear

Examples:
Input: "[PlaceOrder] user_id=\"3790d414-165b-11f0-8ee4-96dac6adf53a\" user_currency=\"USD\""
Static: "PlaceOrder"  (Note: brackets and log level removed)
Variables: {
  "user_id": "3790d414-165b-11f0-8ee4-96dac6adf53a",
  "user_currency": "USD"
}

Input: "2023-04-17 12:36:39 [INFO] Tracking ID Created: 448ba545-9a1d-464d-83bc-d0c9e1ece0f9"
Static: "Tracking ID Created:"  (Note: timestamp, [INFO] removed)
Variables: {
  "Tracking ID": "448ba545-9a1d-464d-83bc-d0c9e1ece0f9"
}

Remember: Both staticSearchString and variables fields are required in your response.
If you can't find any static text, return an empty string.
If you can't find any variables, return an empty object.`
            }],
            model: this.analysisModel,
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

All log lines in current session:
${allLogLines.map(log => `- ${log}`).join('\n')}

Potential callers found in codebase:
${potentialCallers.map(caller => `
File: ${caller.filePath}
Function: ${caller.functionName}
Line ${caller.lineNumber}: ${caller.code}
`).join('\n')}

Rules for ranking:
1. Consider the context from all log lines
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
            model: this.callerModel,  // Use full model for complex analysis
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
}