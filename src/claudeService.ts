import * as vscode from 'vscode';
import fetch from 'node-fetch';

export interface LLMLogAnalysis {
    staticSearchString: string;
    variables: Record<string, any>;
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
                        description: "A substring from the log that would help locate the source code, excluding dynamic values"
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
1. A static search string that would help locate the source code that generated this log (exclude dynamic values)
2. Key-value pairs of any variables or dynamic values in the log

Log message: "${logMessage}"

Rules for static search string:
- Must be a substring that appears in the original log
- Remove all variable values, timestamps, IDs, and other dynamic content
- Keep string literals and static text that would appear in the source code
- Make it specific enough to find the source but generic enough to match despite variable values

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
}