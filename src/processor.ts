import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogEntry, JaegerTrace, JaegerSpan } from './logExplorer';
import { logLineDecorationType } from './decorations';
import fetch from 'node-fetch';
import { Axiom } from '@axiomhq/js';

/**
 * Load trace data from Axiom API
 */
export async function loadAxiomTrace(traceId: string): Promise<LogEntry[]> {
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Fetching Axiom trace...',
        cancellable: false
      },
      async (progress) => {
        // Try to get the stored token first
        let token = process.env.AXIOM_TOKEN;

        if (!token) {
          // Try to get from secrets storage
          token = await vscode.commands.executeCommand('traceback.getAxiomToken');

          // If still no token, prompt the user
          if (!token) {
            token = await vscode.window.showInputBox({
              prompt: 'Enter your Axiom API token',
              password: true,
              ignoreFocusOut: true,
              placeHolder: 'Your Axiom API token'
            });
          }
        }

        if (!token) {
          throw new Error('Axiom API token is required');
        }

        // Store the token in extension secrets storage
        await vscode.commands.executeCommand('traceback.storeAxiomToken', token);

        // Get the dataset name from settings
        const dataset = await getDatasetName();

        const axiom = new Axiom({
          token,
          // Allow for custom Axiom instance in enterprise setups
          url: process.env.AXIOM_URL || undefined
        });

        progress.report({ message: 'Querying Axiom API...' });

        // Execute the APL query
        const aplQuery = `['${dataset}'] | where (trace_id =~ "${traceId}")`;
        const result = await axiom.query(aplQuery);

        // Debug logging to understand the result structure
        console.log('Axiom query result structure:',
          Object.keys(result),
                   result.matches ? `Matches: ${result.matches.length}` : 'No matches');

        if (!result.matches || result.matches.length === 0) {
          vscode.window.showWarningMessage(`No matching traces found in Axiom dataset '${dataset}'`);
          return [];
        }

        // Log a sample match to understand the data structure
        if (result.matches && result.matches.length > 0) {
          console.log('Sample match data keys:', Object.keys(result.matches[0]));
          console.log('Sample span data keys:', Object.keys(result.matches[0].data));
        }

        progress.report({ message: `Processing ${result.matches.length} spans...` });

        // Process the matches into LogEntry objects
        const logs: LogEntry[] = [];
        for (const match of result.matches) {
          // Extract the span data
          const span = match.data;

          // Create a LogEntry from the span data
          // Handle timestamp properly - try different fields and formats
          let timestamp;
          try {
            if (span._time) {
              timestamp = new Date(span._time).toISOString();
            } else if (span.timestamp) {
              timestamp = new Date(span.timestamp).toISOString();
            } else if (span.startTime) {
              // Convert microseconds to milliseconds if needed
              const timeValue = typeof span.startTime === 'number' && span.startTime > 1600000000000000
                ? span.startTime / 1000  // Convert from microseconds
                : span.startTime;
              timestamp = new Date(timeValue).toISOString();
            } else {
              // Default to current time if no time found
              timestamp = new Date().toISOString();
              console.log('No time field found in span, using current time');
            }
          } catch (error) {
            console.error('Invalid time value in span:', error);
            // Fallback to current time
            timestamp = new Date().toISOString();
          }

          const log: LogEntry = {
            // Standard fields
            severity: determineSeverityFromAxiomSpan(span),
            timestamp: timestamp,
            rawText: JSON.stringify(span),

            // Use a custom format for Axiom spans to differentiate them
            axiomSpan: span,

            // Set unified fields for display
            message: span.name || 'Unknown operation',
            target: span.service?.name || span['service.name'] || 'Unknown service',
            serviceName: span.service?.name || span['service.name'] || 'Unknown service',
            parentSpanID: span.parent_span_id,

            // Create minimal jsonPayload for compatibility
            jsonPayload: {
              fields: {
                message: span.name || 'Unknown operation'
              },
              target: span.service?.name || span['service.name'] || 'Unknown service'
            }
          };

          logs.push(log);
        }

        // Sort logs by timestamp
        logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return logs;
      }
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error loading Axiom trace: ${error.message}`);
    return [];
  }
}

/**
 * Determine severity level from Axiom span data
 */
function determineSeverityFromAxiomSpan(span: any): string {
  // Check for error indicators
  if (span.error ||
    span.status?.code === 'ERROR' ||
    span.status_code >= 500 ||
      span['attributes.error.type']) {
    return 'ERROR';
  }

  // Check for warning indicators
  if (span.status_code >= 400 ||
      span['attributes.http.status_code'] >= 400) {
    return 'WARNING';
  }

  // Check if this is a debug span
  if (span.kind === 'internal' ||
      span.name?.toLowerCase().includes('debug')) {
    return 'DEBUG';
  }

  // Default to INFO for most spans
  return 'INFO';
}

/**
 * Interface for log parser strategies. Each parser strategy knows how to
 * parse a specific log format and convert it to LogEntry objects.
 */
export interface LogParser {
  /**
   * Returns true if this parser can handle the given log content
   */
  canParse(content: string): boolean;
  
  /**
   * Parse the content into LogEntry objects
   */
  parse(content: string): Promise<LogEntry[]>;
}

/**
 * Parser for JSON-formatted logs that follow the LogEntry structure already
 */
export class JsonLogParser implements LogParser {
  canParse(content: string): boolean {
    try {
      // Check if content is valid JSON
      const parsed = JSON.parse(content);
      return true;
    } catch (error) {
      return false;
    }
  }

  async parse(content: string): Promise<LogEntry[]> {
    try {
      const parsed = JSON.parse(content);
      
      // Handle array of log entries
      if (Array.isArray(parsed)) {
        return parsed.map(log => this.normalizeLogEntry(log));
      }
      
      // Handle single log entry
      return [this.normalizeLogEntry(parsed)];
    } catch (error) {
      console.error('Error parsing JSON logs:', error);
      return [];
    }
  }
  
  private normalizeLogEntry(log: any): LogEntry {
    // Ensure minimal required fields exist
    return {
      severity: log.severity || log.level || 'INFO',
      timestamp: log.timestamp || new Date().toISOString(),
      rawText: JSON.stringify(log),
      jsonPayload: {
        fields: {
          message: log.message || log.msg || JSON.stringify(log)
        },
        target: log.target || log.service || log.component || 'unknown'
      },
      message: log.message || log.msg || '',
      target: log.target || log.service || log.component || 'unknown'
    };
  }
}

/**
 * Parser for Jaeger trace format
 */
export class JaegerLogParser implements LogParser {
  canParse(content: string): boolean {
    try {
      const parsed = JSON.parse(content);
      return parsed.data && Array.isArray(parsed.data) && 
             parsed.data.length > 0 && 
             parsed.data[0].spans !== undefined;
    } catch (error) {
      return false;
    }
  }

  async parse(content: string): Promise<LogEntry[]> {
    try {
      const parsed = JSON.parse(content);
      return processJaegerFormat(parsed, content);
    } catch (error) {
      console.error('Error parsing Jaeger logs:', error);
      return [];
    }
  }
}

/**
 * Parser for plaintext logs with common formats
 */
export class PlainTextLogParser implements LogParser {
  // Common log patterns we support
  private patterns = [
    // Pattern for standard format with service name, timestamp and message
    // Example: load-generator | Failed to load resource: net::ERR_CONNECTION_REFUSED
    {
      regex: /^([^\s|]+)\s*\|\s*(.*?)$/,
      extract: (matches: RegExpExecArray) => ({
        serviceName: matches[1]?.trim(),
        message: matches[2]?.trim()
      })
    },
    // Timestamped log format with severity
    // Example: 2025-04-11 12:35:57 - oteldemo.AdService - Ad service starting. trace_id= span_id= trace_flags=
    {
      regex: /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s+-\s+|\s+)([^\s-]+)(?:\s+-\s+|\s+)(.+)$/,
      extract: (matches: RegExpExecArray) => ({
        timestamp: matches[1]?.trim(),
        serviceName: matches[2]?.trim(),
        message: matches[3]?.trim()
      })
    },
    // Advanced format with log level
    // Example: info: cart.cartstore.ValkeyCartStore[0] Successfully connected to Redis
    {
      regex: /^(trace|debug|info|warn|warning|error|fatal|critical):\s+([^\[]+)(?:\[\d+\])?\s+(.+)$/i,
      extract: (matches: RegExpExecArray) => ({
        severity: matches[1]?.trim().toUpperCase(),
        serviceName: matches[2]?.trim(),
        message: matches[3]?.trim()
      })
    }
  ];

  canParse(content: string): boolean {
    // Check if it's not a JSON format
    try {
      JSON.parse(content);
      return false; // It's valid JSON, so we don't handle it
    } catch (error) {
      // If at least one line matches any of our patterns, we can parse it
      const lines = content.split('\n').slice(0, 10); // Check first 10 lines
      for (const line of lines) {
        if (line.trim() && this.parseLogLine(line).matched) {
          return true;
        }
      }
      return false;
    }
  }

  async parse(content: string): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const result = this.parseLogLine(line);
      if (result.matched) {
        logs.push(this.createLogEntry(result.data, line));
      } else {
        // For unmatched lines, create a basic log entry
        logs.push({
          severity: 'INFO',
          timestamp: new Date().toISOString(),
          rawText: line,
          jsonPayload: {
            fields: {
              message: line
            }
          },
          message: line,
          target: 'unknown'
        });
      }
    }
    
    return logs;
  }
  
  private parseLogLine(line: string): { matched: boolean; data: any } {
    for (const pattern of this.patterns) {
      const matches = pattern.regex.exec(line);
      if (matches) {
        return {
          matched: true,
          data: pattern.extract(matches)
        };
      }
    }
    
    return { matched: false, data: {} };
  }
  
  private createLogEntry(data: any, rawLine: string): LogEntry {
    // Determine severity
    let severity = data.severity || 'INFO';
    if (rawLine.toLowerCase().includes('error') || rawLine.toLowerCase().includes('exception')) {
      severity = 'ERROR';
    } else if (rawLine.toLowerCase().includes('warn')) {
      severity = 'WARNING';
    }
    
    // Parse timestamp if available or use current time
    let timestamp = data.timestamp || new Date().toISOString();
    if (data.timestamp && !data.timestamp.includes('T')) {
      // Try to convert YYYY-MM-DD HH:MM:SS to ISO format
      try {
        timestamp = new Date(data.timestamp).toISOString();
      } catch (e) {
        // Keep original if parsing fails
      }
    }
    
    return {
      severity,
      timestamp,
      rawText: rawLine,
      jsonPayload: {
        fields: {
          message: data.message || rawLine
        },
        target: data.serviceName || 'unknown'
      },
      message: data.message || rawLine,
      target: data.serviceName || 'unknown'
    };
  }
}

/**
 * Parser for custom plugins/adapters
 */
export class ExtensibleLogParser implements LogParser {
  private plugins: LogParser[] = [];
  
  constructor() {
    // Register built-in parsers
    this.registerParser(new JaegerLogParser());
    this.registerParser(new JsonLogParser());
    this.registerParser(new PlainTextLogParser());
  }
  
  registerParser(parser: LogParser): void {
    this.plugins.push(parser);
  }
  
  canParse(content: string): boolean {
    // We're the fallback parser, so we always return true
    return true;
  }
  
  async parse(content: string): Promise<LogEntry[]> {
    // Try each parser in order
    for (const parser of this.plugins) {
      if (parser.canParse(content)) {
        const result = await parser.parse(content);
        
        // Validate the result to ensure it has the required LogEntry fields
        if (result && result.length > 0) {
          // Log success with the parser type
          console.log(`Log parsed successfully with parser: ${parser.constructor.name}`);
          return result;
        }
      }
    }
    
    // If no parser can handle it, return empty array
    console.warn('No suitable parser found for the log content');
    return [];
  }
}

export async function loadLogs(logPathOrUrl: string): Promise<LogEntry[]> {
  try {
    // Show loading notification
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading logs...',
        cancellable: false
      },
      async (progress) => {
        if (!logPathOrUrl) {
          vscode.window.showErrorMessage('Log source is not set.');
          return [];
        }

        progress.report({ message: 'Reading log file...' });

        // Check if this is an Axiom trace format (indicated by axiom: prefix)
        if (logPathOrUrl.startsWith('axiom:')) {
          const traceId = logPathOrUrl.substring(6); // Remove 'axiom:' prefix
          return await loadAxiomTrace(traceId);
        }

        let rawContent: string;

        // Check if the input is a URL
        if (logPathOrUrl.startsWith('http://') || logPathOrUrl.startsWith('https://')) {
          try {
            progress.report({ message: 'Fetching logs from URL...' });
            
            // Fetch the content from the URL
            const response = await fetch(logPathOrUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch logs: ${response.statusText}`);
            }

            rawContent = await response.text();
          } catch (error: any) {
            vscode.window.showErrorMessage(`Error fetching logs: ${error.message}`);
            return [];
          }
        } else {
          // Handle as a local file path
          if (!fs.existsSync(logPathOrUrl)) {
            vscode.window.showErrorMessage(`Log file not found at ${logPathOrUrl}`);
            return [];
          }

          // Read the file content
          rawContent = fs.readFileSync(logPathOrUrl, 'utf8');
        }

        progress.report({ message: 'Parsing logs...' });

        try {
          // Use the global registry of parsers through extension.ts
          // We need to dynamically import to avoid circular dependency
          const extensionModule = await import('./extension');
          const parser = extensionModule.logParserRegistry;
          
          const logs = await parser.parse(rawContent);
          
          if (logs.length > 0) {
            vscode.window.showInformationMessage(`Successfully loaded ${logs.length} log entries`);
          } else {
            vscode.window.showWarningMessage('No logs found or could not parse the log format');
          }
          
          return logs;
        } catch (error) {
          console.error('Error parsing logs:', error);
          vscode.window.showErrorMessage(`Failed to parse logs: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        }
      }
    );
  } catch (error) {
    console.error('Error loading logs:', error);
    vscode.window.showErrorMessage(`Error loading logs: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Process Jaeger trace format into LogEntry objects
 */
function processJaegerFormat(parsedData: any, rawContent: string): LogEntry[] {
  const logs: LogEntry[] = [];

  // Process each trace in the data array
  for (const trace of parsedData.data) {
    const traceId = trace.traceID;

    // Create a map of span IDs for quicker parent reference lookup
    const spanMap = new Map<string, JaegerSpan>();
    for (const span of trace.spans) {
      spanMap.set(span.spanID, span);
    }

    // Convert each span to a LogEntry
    for (const span of trace.spans) {
      // Find parent span ID if it exists
      let parentSpanID: string | undefined;
      if (span.references && span.references.length > 0) {
        const childOfRef = span.references.find((ref: any) => ref.refType === 'CHILD_OF');
        if (childOfRef) {
          parentSpanID = childOfRef.spanID;
        }
      }

      // Get service name from the process
      const process = trace.processes[span.processID];
      const serviceName = process ? process.serviceName : 'unknown';

      // Map severity from span attributes
      // Use span.kind, error tags, or status_code to determine severity
      let severity = 'INFO'; // Default
      const errorTag = span.tags.find((tag: any) => tag.key === 'error' && tag.value);
      const statusCodeTag = span.tags.find((tag: any) =>
        (tag.key === 'http.status_code' && Number(tag.value) >= 400) ||
        (tag.key === 'rpc.grpc.status_code' && Number(tag.value) > 0)
      );

      if (errorTag) {
        severity = 'ERROR';
      } else if (statusCodeTag) {
        // HTTP 4xx is WARNING, 5xx is ERROR
        const statusCode = Number(statusCodeTag.value);
        if (statusCodeTag.key === 'http.status_code') {
          if (statusCode >= 500) {
            severity = 'ERROR';
          } else if (statusCode >= 400) {
            severity = 'WARNING';
          }
        } else if (statusCode > 0) { // gRPC non-zero status is an error
          severity = 'ERROR';
        }
      }

      // Extract a message from logs if available
      let message = span.operationName;
      if (span.logs && span.logs.length > 0) {
        const eventField = span.logs[0].fields.find((field: any) => field.key === 'event');
        if (eventField) {
          message = `${span.operationName} - ${eventField.value}`;
        }
      }

      // Create unified timestamp from microseconds to ISO string
      const timestamp = new Date(span.startTime / 1000).toISOString();

      // Create the LogEntry
      const logEntry: LogEntry = {
        jaegerSpan: span,
        serviceName,
        parentSpanID,
        message,
        target: serviceName,
        severity,
        timestamp,
        rawText: JSON.stringify(span),
        jsonPayload: {
          fields: {
            message
          },
          target: serviceName
        }
      };

      logs.push(logEntry);
    }
  }

  if (logs.length === 0) {
    vscode.window.showInformationMessage('No spans found in the Jaeger trace file.');
  }

  return logs;
}

/**
 * Process traditional log format into LogEntry objects
 */
function processTraditionalFormat(parsedData: any, rawContent: string): LogEntry[] {
  // Parse as a single JSON array
  const jsonLogs = parsedData as LogEntry[];

  // Store the logs and add rawText
  const logs = jsonLogs.map(log => {
    // Add unified fields for compatibility
    const message = log.jsonPayload?.fields?.message || log.message || '';
    const target = log.jsonPayload?.target || '';

    return {
      ...log,
      message,
      target,
      rawText: JSON.stringify(log)
    };
  });

  if (logs.length === 0) {
    vscode.window.showInformationMessage('No logs found in the file.');
  }

  return logs;
}

/**
 * Find the code location based on log information
 * This function has been simplified to better handle arbitrary log formats
 */
export async function findCodeLocation(log: LogEntry, repoPath: string): Promise<{ file: string; line: number } | undefined> {
  try {
    // Progress indicator
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Finding code location...',
      cancellable: false
    }, async (progress) => {
      // Extract searchable content from the log, prioritizing normalized fields
      let searchContent: string = log.message || '';
      
      // If message is empty or too generic, try format-specific fields
      if (!searchContent || searchContent.trim().length < 3) {
        // Try Jaeger format
        if (log.jaegerSpan) {
          searchContent = log.jaegerSpan.operationName || searchContent;
          
          // Try to extract more context from span tags
          const httpMethod = log.jaegerSpan.tags.find(tag => tag.key === 'http.method');
          const httpPath = log.jaegerSpan.tags.find(tag => tag.key === 'http.target' || tag.key === 'http.url');
          
          if (httpMethod && httpPath) {
            searchContent = `${httpMethod.value} ${httpPath.value}`;
          }
          
          // Check for RPC method
          const rpcMethod = log.jaegerSpan.tags.find(tag => tag.key === 'rpc.method');
          if (rpcMethod) {
            searchContent = rpcMethod.value.toString();
          }
        }
        // Try Axiom format
        else if (log.axiomSpan) {
          if (log.axiomSpan.name) searchContent = log.axiomSpan.name;
        }
        // Try jsonPayload as last resort
        else if (log.jsonPayload?.fields?.message) {
          searchContent = log.jsonPayload.fields.message;
        }
        // If all else fails, use the raw text
        else if (log.rawText) {
          searchContent = log.rawText;
          // Limit length for performance
          if (searchContent.length > 200) {
            searchContent = searchContent.substring(0, 200);
          }
        }
      }
      
      // If we still couldn't find anything searchable, we can't locate the source
      if (!searchContent || searchContent.trim().length < 3) {
        console.warn('No searchable content found in log entry');
        return undefined;
      }
      
      // Extract target path hints from the log
      // Start with the unified target/serviceName fields
      let targetPath = log.target || log.serviceName || '';
      
      // If no target found, try format-specific fields
      if (!targetPath) {
        if (log.jaegerSpan) {
          // Check for source code related tags
          const sourceFileTag = log.jaegerSpan.tags.find(tag =>
            tag.key === 'code.filepath' ||
            tag.key === 'code.function' ||
            tag.key === 'code.namespace'
          );
          
          if (sourceFileTag) {
            targetPath = sourceFileTag.value.toString();
          }
        }
        else if (log.axiomSpan) {
          // Check for source code attributes
          targetPath = log.axiomSpan['attributes.code.filepath'] ||
                       log.axiomSpan['code.filepath'] ||
                       log.axiomSpan['attributes.code.namespace'] ||
                       log.axiomSpan['code.namespace'] || '';
        }
        else if (log.jsonPayload?.target) {
          targetPath = log.jsonPayload.target;
        }
      }
      
      // Normalize the target path
      if (targetPath) {
        targetPath = targetPath.toLowerCase()
          .replace(/::/g, '/')
          .replace(/-/g, '_')
          .replace(/\s+/g, '_');
      }
      
      progress.report({ message: 'Searching for matching source files...' });
      
      // Search through source files
      let files = await findSourceFiles(repoPath);
      
      // If we have a target path, prioritize files that match
      if (targetPath) {
        files.sort((a, b) => {
          // Check for exact name matches first (prioritize)
          const aBasename = path.basename(a).toLowerCase();
          const bBasename = path.basename(b).toLowerCase();
          const targetBasename = targetPath ? path.basename(targetPath).toLowerCase() : '';
          
          // Check if the basename matches with or without extension
          const aMatchesName = aBasename === targetBasename || 
                              aBasename.startsWith(targetBasename + '.') || 
                              aBasename.includes(targetBasename);
          
          const bMatchesName = bBasename === targetBasename || 
                              bBasename.startsWith(targetBasename + '.') || 
                              bBasename.includes(targetBasename);
          
          if (aMatchesName && !bMatchesName) return -1;
          if (!aMatchesName && bMatchesName) return 1;
          
          // Then check for path matches
          const aContainsTarget = a.includes(targetPath) ? -1 : 0;
          const bContainsTarget = b.includes(targetPath) ? -1 : 0;
          return aContainsTarget - bContainsTarget;
        });
      }
      
      // Limit search to a reasonable number of files for performance
      const MAX_FILES_TO_SEARCH = 1000;
      if (files.length > MAX_FILES_TO_SEARCH) {
        console.warn(`Limiting search to ${MAX_FILES_TO_SEARCH} files out of ${files.length}`);
        files = files.slice(0, MAX_FILES_TO_SEARCH);
      }
      
      // Find the best matches by scanning files for the search content
      let bestMatches: Array<{ file: string; line: number; score: number }> = [];
      
      let fileCount = 0;
      for (const file of files) {
        fileCount++;
        
        // Update progress occasionally
        if (fileCount % 100 === 0) {
          progress.report({ message: `Searched ${fileCount}/${files.length} files...` });
        }
        
        try {
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split('\n');
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Calculate a match score for this line
            const matchScore = calculateMatchScore(line, searchContent);
            
            if (matchScore > 0) {
              bestMatches.push({
                file: path.relative(repoPath, file),
                line: i,
                score: matchScore
              });
            }
          }
        } catch (error) {
          console.warn(`Error reading file ${file}:`, error);
        }
      }
      
      // Sort by match score (highest first)
      bestMatches.sort((a, b) => b.score - a.score);
      
      // Return the best match if any found
      if (bestMatches.length > 0) {
        return {
          file: bestMatches[0].file,
          line: bestMatches[0].line
        };
      }
      
      return undefined;
    });
  } catch (error) {
    console.error('Error in findCodeLocation:', error);
    return undefined;
  }
}

/**
 * Calculate a score for how well a line matches the search content
 * Higher score means better match
 */
function calculateMatchScore(line: string, searchContent: string): number {
  // Clean the line and search content
  const cleanedLine = line.replace(/\/\/.*$/, '').trim().toLowerCase();
  const cleanedSearch = searchContent.trim().toLowerCase();
  
  // Quick check - if the search content isn't in the line at all, score is 0
  if (!cleanedLine.includes(cleanedSearch)) {
    return 0;
  }
  
  // Base score for containing the search content
  let score = 10;
  
  // Bonus for exact match
  if (cleanedLine === cleanedSearch) {
    score += 30;
  }
  
  // Bonus for line containing function/method declaration
  if (cleanedLine.includes('function ') || 
      cleanedLine.includes('def ') || 
      cleanedLine.match(/^\s*(public|private|protected)?\s*(static)?\s*(async)?\s*\w+\s*\([^)]*\)/) || 
      cleanedLine.includes(' fn ')) {
    score += 20;
  }
  
  // Bonus for line containing log or error statements
  if (cleanedLine.includes('console.log') || 
      cleanedLine.includes('console.error') || 
      cleanedLine.includes('println') || 
      cleanedLine.includes('log.') || 
      cleanedLine.includes('logger.') || 
      cleanedLine.includes('throw new ')) {
    score += 15;
  }
  
  // Penalty for lines that are just imports or require statements
  if (cleanedLine.startsWith('import ') || 
      cleanedLine.startsWith('from ') || 
      cleanedLine.startsWith('require(') || 
      cleanedLine.startsWith('use ') || 
      cleanedLine.startsWith('include ')) {
    score -= 10;
  }
  
  return Math.max(0, score);
}


async function findSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  // Directories to skip
  const skipDirs = new Set([
    'node_modules',
    'target',
    'dist',
    'build',
    '.git',
    'vendor',
    'bin',
    'obj',
    'coverage',
    '.next',
    '.vscode',
    '.idea'
  ]);

  // Source file extensions to include
  const sourceExtensions = new Set([
    // Web
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    // Backend
    '.rs', '.go', '.py', '.java', '.cs', '.cpp', '.c', '.h',
    // Config/Data
    '.json', '.yaml', '.yml', '.toml',
    // Templates
    '.html', '.css', '.scss', '.sass', '.less'
  ]);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (!skipDirs.has(entry.name)) {
          files.push(...await findSourceFiles(fullPath));
        }
      } else if (entry.isFile()) {
        // Include only source files
        const ext = path.extname(entry.name).toLowerCase();
        if (sourceExtensions.has(ext)) {
          try {
            // Quick check if file is readable and not too large
            const stats = fs.statSync(fullPath);
            const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

            if (stats.size <= MAX_FILE_SIZE) {
              files.push(fullPath);
            }
          } catch (error) {
            console.warn(`Skipping file ${fullPath}: ${error}`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${error}`);
  }

  return files;
}

/**
 * Get the Axiom dataset name from extension settings
 */
async function getDatasetName(): Promise<string> {
  // Get from extension context global state
  const dataset = await vscode.commands.executeCommand<string>('traceback.getAxiomDataset');

  // Fallback to default if not set
  return dataset || 'otel-demo-traces';
}

function isLineMatch(line: string, searchContent: string): boolean {
  // Remove comments and whitespace
  const cleanedLine = line.replace(/\/\/.*$/, '').trim();

  // Case-insensitive search for the content
  return cleanedLine.toLowerCase().includes(searchContent.toLowerCase()) &&
    // Ensure it's not just a variable declaration or import
    !cleanedLine.startsWith('use ') &&
    !cleanedLine.startsWith('let ');
}

