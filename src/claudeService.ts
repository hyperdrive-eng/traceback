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
        functionName: string;
        confidence: number;
        explanation: string;
    }>;
}

export class ClaudeService {
    private static instance: ClaudeService;
    private apiKey: string | undefined;
    private apiEndpoint: string = 'https://api.anthropic.com/v1/messages';
    private model: string = 'claude-3-opus-20240229';

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
                    logMessage: {
                        type: "string",
                        description: "The log message to analyze"
                    },
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
                required: ["logMessage", "staticSearchString", "variables"]
            }
        }];

        const request = {
            messages: [{
                role: 'user',
                content: `Analyze this log message and extract:
1. The static prefix or template part that would be in the source code (e.g. fmt.Printf("User %s logged in", username) -> "User logged in")
2. Key-value pairs of any variables or dynamic values in the log

Log message: "${logMessage}"

Rules for static search string:
- Look for the constant text prefix that would be in a print/log statement
- Exclude all variable values, data structures, timestamps, IDs, and other dynamic content
- For structured data like JSON or arrays, only keep the static message prefix before the data
- Think about how a developer would write the log statement in code:
  - Good: "Message sent to Kafka" (from: fmt.Printf("Message sent to Kafka: %v", data))
  - Bad: "Message sent to Kafka: {orders <nil> []}" (includes dynamic data)
- The static string should be something you'd find in a source file's print/log statement
- When in doubt, be conservative and only include the clearly static prefix

Rules for variables:
- Include all dynamic values found in the log
- Use meaningful key names
- Preserve the original data types (numbers, strings, objects)
- Include any structured data or nested objects

Use the analyze_log function to return the results in the exact format required.`
            }],
            model: this.model,
            max_tokens: 1000,
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

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Claude API error: ${response.statusText}\nDetails: ${errorText}`);
            }

            const data = await response.json();

            if (!data.content || !data.content[0] || !data.content[0].type || !(data.content[0].type === 'tool_use')) {
                throw new Error('Invalid response format from Claude API');
            }
            return (data.content[0].input) as LLMLogAnalysis;
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
            model: this.model,
            max_tokens: 4000,
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

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Claude API error: ${response.statusText}\nDetails: ${errorText}`);
            }

            const data = await response.json();

            if (!data.content || !data.content[0] || !(data.content[0].type === 'tool_use')) {
                throw new Error('Invalid response format: missing tool_calls');
            }

            return (data.content[0].input) as CallerAnalysis;
        } catch (error) {
            console.error('Error calling Claude API:', error);
            throw error;
        }
    }
}