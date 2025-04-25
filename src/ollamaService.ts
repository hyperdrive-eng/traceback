import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { LLMService, LLMLogAnalysis, CallerAnalysis, RegexPattern, filterRelevantLogs } from './llmService';

export class OllamaService implements LLMService {
    private static instance: OllamaService;
    private endpoint: string | undefined;
    private model: string = 'llama3'; // Default model

    private constructor() {
        // Load endpoint from workspace state if available
        const config = vscode.workspace.getConfiguration('traceback');
        this.endpoint = config.get('ollamaEndpoint');
        
        // Load model from workspace state if available
        const configModel = config.get<string>('ollamaModel');
        if (configModel) {
            this.model = configModel;
        }
    }

    public static getInstance(): OllamaService {
        if (!OllamaService.instance) {
            OllamaService.instance = new OllamaService();
        }
        return OllamaService.instance;
    }

    public async setEndpoint(endpoint: string): Promise<void> {
        this.endpoint = endpoint;
        await vscode.workspace.getConfiguration('traceback').update('ollamaEndpoint', endpoint, true);
    }
    
    public async setModel(model: string): Promise<void> {
        this.model = model;
        await vscode.workspace.getConfiguration('traceback').update('ollamaModel', model, true);
    }

    public async analyzeLog(logMessage: string, language: string): Promise<LLMLogAnalysis> {
        if (!this.endpoint) {
            throw new Error('Ollama endpoint not set. Please set your endpoint first.');
        }

        try {
            console.log('OllamaService: Analyzing log message with model:', this.model);
            console.log('OllamaService: Using endpoint:', this.endpoint);
            
            const prompt = `Analyze this log message and extract:
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
}

Your response must be in JSON format with the following structure:
{
  "staticSearchString": "the static search string",
  "variables": {
    "key1": "value1",
    "key2": "value2"
  }
}`;

            const response = await this.callOllama(prompt);
            console.log('OllamaService: Got response from Ollama');
            const jsonResponse = this.extractJsonFromResponse(response);
            console.log('OllamaService: Extracted JSON:', JSON.stringify(jsonResponse).substring(0, 100) + '...');
            return this.validateLogAnalysisResponse(jsonResponse, logMessage);
        } catch (error) {
            console.error('Error calling Ollama API:', error);
            if (error instanceof Error) {
                console.error('Error details:', error.message);
                console.error('Error stack:', error.stack);
                throw new Error(`Failed to analyze log message with Ollama: ${error.message}`);
            }
            throw new Error('Failed to analyze log message with Ollama');
        }
    }

    public async analyzeCallers(
        currentLogLine: string,
        staticSearchString: string,
        allLogLines: string[],
        potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>
    ): Promise<CallerAnalysis> {
        if (!this.endpoint) {
            throw new Error('Ollama endpoint not set. Please set your endpoint first.');
        }

        try {
            // Filter and limit log lines to prevent prompt too long errors
            const MAX_LOG_LINES = 10; // Smaller limit for Ollama to prevent context overflow
            const filteredLogs = filterRelevantLogs(currentLogLine, allLogLines, MAX_LOG_LINES);

            const prompt = `Analyze these potential callers and rank them based on likelihood of being the actual caller.

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

Your response must be in JSON format with the following structure:
{
  "rankedCallers": [
    {
      "filePath": "path/to/file.js",
      "lineNumber": 123,
      "functionName": "someFunction",
      "confidence": 0.95,
      "explanation": "Explanation for why this is ranked here"
    },
    {
      "filePath": "path/to/another/file.js",
      "lineNumber": 456,
      "functionName": "anotherFunction",
      "confidence": 0.7, 
      "explanation": "Explanation for why this is ranked here"
    }
  ]
}`;

            const response = await this.callOllama(prompt);
            const jsonResponse = this.extractJsonFromResponse(response);
            return this.validateCallerAnalysisResponse(jsonResponse);
        } catch (error) {
            console.error('Error analyzing callers with Ollama:', error);
            throw new Error('Failed to analyze callers with Ollama');
        }
    }

    public async generateLogParsingRegex(
        logSamples: string[],
        expectedResults?: Record<string, any>[]
    ): Promise<RegexPattern[]> {
        if (!this.endpoint) {
            throw new Error('Ollama endpoint not set. Please set your endpoint first.');
        }

        try {
            // Limit number of samples to avoid token limits
            const MAX_SAMPLES = 10; // Smaller limit for Ollama
            const selectedSamples = logSamples.slice(0, MAX_SAMPLES);

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

Ensure the regex patterns:
- Are compatible with JavaScript's regular expression engine
- Use named capture groups for all extracted fields
- Are flexible enough to handle variations in format
- Are precise enough to avoid false positives
- Collectively cover all the provided log samples
- Handle both structured and unstructured log formats

Your response must be in JSON format with the following structure:
{
  "patterns": [
    {
      "pattern": "regex pattern string",
      "description": "Description of what this pattern matches",
      "extractionMap": {
        "severity": "severityGroup",
        "timestamp": "timestampGroup",
        "message": "messageGroup"
      }
    }
  ]
}`;

            const response = await this.callOllama(prompt);
            const jsonResponse = this.extractJsonFromResponse(response);
            return this.validateRegexPatternsResponse(jsonResponse);
        } catch (error) {
            console.error('Error generating regex patterns with Ollama:', error);
            throw new Error('Failed to generate regex patterns with Ollama');
        }
    }

    private async callOllama(prompt: string): Promise<string> {
        if (!this.endpoint) {
            throw new Error('Ollama endpoint not set');
        }

        try {
            console.log(`OllamaService: Calling Ollama at ${this.endpoint} with model ${this.model}`);
            
            // Format the request according to Ollama API
            const request = {
                model: this.model,
                prompt: prompt,
                stream: false,
                options: {
                    temperature: 0.1, // Low temperature for more deterministic responses
                    num_predict: 2048 // Reasonable token limit for responses
                },
                format: 'json' // Request JSON format if the model supports it
            };

            console.log('OllamaService: Sending request to Ollama');
            
            // Try to catch connection errors
            let response;
            try {
                response = await fetch(`${this.endpoint}/api/generate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(request),
                    // Add a reasonable timeout
                    timeout: 30000
                });
            } catch (fetchError) {
                console.error('OllamaService: Network error when connecting to Ollama:', fetchError);
                if (fetchError instanceof Error) {
                    if (fetchError.message.includes('ECONNREFUSED')) {
                        throw new Error(`Connection refused to Ollama at ${this.endpoint}. Is Ollama running?`);
                    }
                    if (fetchError.message.includes('ETIMEDOUT') || fetchError.message.includes('timeout')) {
                        throw new Error(`Connection to Ollama timed out. Check if Ollama is running at ${this.endpoint}`);
                    }
                }
                throw new Error(`Network error connecting to Ollama: ${fetchError}`);
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`OllamaService: Ollama API error: ${response.status} ${response.statusText}`);
                console.error(`OllamaService: Error details: ${errorText}`);
                throw new Error(`Ollama API error: ${response.statusText}\nDetails: ${errorText}`);
            }

            console.log('OllamaService: Received successful response from Ollama');
            
            const responseData = await response.json();
            return responseData.response || '';
        } catch (error) {
            console.error('Error calling Ollama API:', error);
            throw error;
        }
    }

    // Helper method to extract JSON from text response
    private extractJsonFromResponse(text: string): any {
        // Try to find JSON content in the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.warn('Failed to parse JSON from response:', e);
            }
        }

        // If no JSON found or parsing failed, try to extract from markdown code block
        const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            try {
                return JSON.parse(codeBlockMatch[1]);
            } catch (e) {
                console.warn('Failed to parse JSON from code block:', e);
            }
        }

        throw new Error('Failed to extract valid JSON from Ollama response');
    }

    // Validate and fix log analysis response
    private validateLogAnalysisResponse(response: any, logMessage: string): LLMLogAnalysis {
        if (!response) {
            response = {};
        }

        // Validate required fields are present
        if (!Object.prototype.hasOwnProperty.call(response, 'staticSearchString')) {
            console.warn('Ollama response missing staticSearchString, using empty string');
            response.staticSearchString = '';
        }

        if (!Object.prototype.hasOwnProperty.call(response, 'variables')) {
            console.warn('Ollama response missing variables, using empty object');
            response.variables = {};
        }

        // Ensure types are correct
        if (typeof response.staticSearchString !== 'string') {
            console.warn('Ollama response staticSearchString is not a string, converting');
            response.staticSearchString = String(response.staticSearchString || '');
        }

        if (typeof response.variables !== 'object' || response.variables === null) {
            console.warn('Ollama response variables is not an object, using empty object');
            response.variables = {};
        }

        // Clean up the static search string by removing log level indicators
        // This helps with matching source code that doesn't include these markers
        if (response.staticSearchString) {
            const logLevelPattern = /\[\s*(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\s*\]\s*/gi;
            // Store the original search string for debugging
            const originalSearchString = response.staticSearchString;
            // Remove log level indicators
            response.staticSearchString = response.staticSearchString.replace(logLevelPattern, '');

            // Log the change if we modified the search string
            if (originalSearchString !== response.staticSearchString) {
                console.log(`Cleaned log level indicators from search string: "${originalSearchString}" → "${response.staticSearchString}"`);
            }
        }

        return response as LLMLogAnalysis;
    }

    // Validate and fix caller analysis response
    private validateCallerAnalysisResponse(response: any): CallerAnalysis {
        if (!response || !response.rankedCallers || !Array.isArray(response.rankedCallers)) {
            console.warn('Invalid rankedCallers in Ollama response, using empty array');
            response = { rankedCallers: [] };
        }

        // Validate each ranked caller
        response.rankedCallers = response.rankedCallers.filter((caller: any) => {
            if (!caller || typeof caller !== 'object') return false;
            
            // Ensure required fields exist and have correct types
            if (!caller.filePath || typeof caller.filePath !== 'string') return false;
            if (!caller.functionName || typeof caller.functionName !== 'string') return false;
            if (typeof caller.lineNumber !== 'number') {
                try {
                    caller.lineNumber = parseInt(caller.lineNumber, 10);
                    if (isNaN(caller.lineNumber)) return false;
                } catch {
                    return false;
                }
            }
            
            if (typeof caller.confidence !== 'number') {
                try {
                    caller.confidence = parseFloat(caller.confidence);
                    if (isNaN(caller.confidence)) caller.confidence = 0.5;
                } catch {
                    caller.confidence = 0.5;
                }
            }
            
            if (!caller.explanation || typeof caller.explanation !== 'string') {
                caller.explanation = 'No explanation provided';
            }
            
            return true;
        });

        return response as CallerAnalysis;
    }

    // Validate and fix regex patterns response
    private validateRegexPatternsResponse(response: any): RegexPattern[] {
        let patterns: RegexPattern[] = [];
        
        if (!response || !response.patterns || !Array.isArray(response.patterns)) {
            console.warn('Invalid patterns in Ollama response, using empty array');
            return patterns;
        }
        
        // Process and validate each pattern
        patterns = response.patterns.filter((pattern: any) => {
            if (!pattern || typeof pattern !== 'object') return false;
            
            // Ensure required fields exist
            if (!pattern.pattern || typeof pattern.pattern !== 'string') return false;
            if (!pattern.description || typeof pattern.description !== 'string') return false;
            if (!pattern.extractionMap || typeof pattern.extractionMap !== 'object') {
                pattern.extractionMap = {};
            }
            
            // Validate pattern is a valid regex
            try {
                new RegExp(pattern.pattern);
            } catch (error) {
                console.warn(`Invalid regex pattern: ${pattern.pattern}`, error);
                return false;
            }
            
            return true;
        });
        
        return patterns;
    }
}