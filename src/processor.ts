import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogEntry } from './logExplorer';
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
            
            // Store the URL as the last successful URL
            await vscode.commands.executeCommand('setContext', 'traceback.lastSuccessfulUrl', logPathOrUrl);
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
export async function findCodeLocation(log: LogEntry, repoPath: string): Promise<{ file: string; line: number }> {
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
        // Try Axiom format
        if (log.axiomSpan) {
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
        throw new Error('No searchable content found in log entry');
      }
      
      // Extract target path hints from the log
      // Start with the unified target/serviceName fields
      let targetPath = log.target || log.serviceName || '';
      
      // If no target found, try format-specific fields
      if (!targetPath) {
        if (log.axiomSpan) {
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
      let bestMatches: Array<{ file: string; line: number; score: number; fileScore: number }> = [];
      
      // Calculate file relevance scores first (based on filename/path)
      const fileScores = new Map<string, number>();
      for (const file of files) {
        const relativePath = path.relative(repoPath, file);
        const fileName = path.basename(file).toLowerCase();
        const fileExt = path.extname(file).toLowerCase();
        
        // Base file score
        let fileScore = 0;
        
        // Boost score for files with relevant names
        if (targetPath && fileName.includes(path.basename(targetPath).toLowerCase())) {
          fileScore += 50; // Strong bonus for filename match
        }
        
        // Boost for primary code files (not utility, config, etc)
        const isPrimaryCodeFile = 
          !fileName.includes('util') && 
          !fileName.includes('helper') && 
          !fileName.includes('common') && 
          !fileName.startsWith('_') &&
          !fileName.includes('test');
          
        if (isPrimaryCodeFile) {
          fileScore += 20;
        }
        
        // Boost for source files in key directories
        const isInSourceDir = 
          relativePath.includes('/src/') || 
          relativePath.includes('/lib/') || 
          relativePath.includes('/app/') || 
          relativePath.startsWith('src/') || 
          relativePath.startsWith('lib/') || 
          relativePath.startsWith('app/');
          
        if (isInSourceDir) {
          fileScore += 15;
        }
        
        // Store the file score
        fileScores.set(file, fileScore);
      }
      
      // Sort files by relevance score for prioritized search
      files.sort((a, b) => (fileScores.get(b) || 0) - (fileScores.get(a) || 0));
      
      // Limit to most relevant files first
      const topFiles = files.slice(0, Math.min(files.length, 1000));
      
      // Search through files in priority order
      let fileCount = 0;
      for (const file of topFiles) {
        fileCount++;
        
        // Update progress occasionally
        if (fileCount % 50 === 0) {
          progress.report({ message: `Searched ${fileCount}/${topFiles.length} files...` });
        }
        
        try {
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split('\n');
          const fileScore = fileScores.get(file) || 0;
          
          // Check up to 5000 lines (for extremely large files)
          const maxLines = Math.min(lines.length, 5000);
          
          for (let i = 0; i < maxLines; i++) {
            const line = lines[i];
            // Calculate a match score for this line
            const matchScore = calculateMatchScore(line, searchContent);
            
            if (matchScore > 0) {
              // Combine line match score with file relevance score
              bestMatches.push({
                file: path.relative(repoPath, file),
                line: i,
                score: matchScore,
                fileScore: fileScore
              });
            }
          }
        } catch (error) {
          console.warn(`Error reading file ${file}:`, error);
        }
      }
      
      // Sort by combined score (line match score + file relevance score)
      bestMatches.sort((a, b) => {
        const totalScoreA = a.score + a.fileScore;
        const totalScoreB = b.score + b.fileScore;
        return totalScoreB - totalScoreA;
      });
      
      // Return the best match if any found
      if (bestMatches.length > 0) {
        return {
          file: bestMatches[0].file,
          line: bestMatches[0].line
        };
      }
      
      throw new Error('No code location found');
    });
  } catch (error) {
    console.error('Error in findCodeLocation:', error);
    throw error;
  }
}

/**
 * Calculate a score for how well a line matches the search content
 * Higher score means better match
 */
function calculateMatchScore(line: string, searchContent: string): number {
  // Strip comments for code files
  const strippedLine = line.replace(/\/\/.*$/, '')  // C-style single line comments
                           .replace(/\/\*[\s\S]*?\*\//, '')  // C-style block comments
                           .replace(/#.*$/, '')  // Python/Ruby/Shell comments
                           .trim();
  
  // Clean the line and search content for comparison
  const cleanedLine = strippedLine.toLowerCase();
  const cleanedSearch = searchContent.trim().toLowerCase();
  
  // Skip empty lines after comment removal
  if (!cleanedLine) {
    return 0;
  }
  
  // Quick check - if the search content isn't in the line at all, score is 0
  if (!cleanedLine.includes(cleanedSearch)) {
    return 0;
  }
  
  // Base score for containing the search content
  let score = 10;
  
  // Factors that suggest this is actual code that generated the log, not a log itself
  
  // 1. Bonus for context clues indicating the line is inside actual code, not a printed log
  const isLikelySourceCode = 
    // Contains code structure indicators
    strippedLine.includes('{') || 
    strippedLine.includes('}') ||
    strippedLine.includes('(') ||
    strippedLine.includes(')') ||
    // Contains typical code keywords
    /\b(if|else|for|while|switch|case|return|try|catch|class|interface)\b/.test(cleanedLine) ||
    // Contains variable assignments
    /[a-zA-Z0-9_]+ *= */.test(cleanedLine) ||
    // Contains method/function calls
    /[a-zA-Z0-9_]+\([^)]*\)/.test(cleanedLine);
  
  if (isLikelySourceCode) {
    score += 15;
  }
  
  // 2. Bonus for exact match but only if it appears to be source code
  if (cleanedLine === cleanedSearch && isLikelySourceCode) {
    score += 35;
  }
  
  // 3. Significant bonus for line containing function/method declaration
  if (cleanedLine.includes('function ') || 
      cleanedLine.includes('def ') || 
      cleanedLine.match(/^\s*(public|private|protected)?\s*(static)?\s*(async)?\s*\w+\s*\([^)]*\)/) || 
      cleanedLine.includes(' fn ') || 
      /\bfunc\s+\w+\s*\(/.test(cleanedLine)) { // Go
    score += 25;
  }
  
  // 4. Bonus for line containing logging, printing or error statements - these are typically the source of logs
  if (cleanedLine.includes('console.log') || 
      cleanedLine.includes('console.error') || 
      cleanedLine.includes('console.info') || 
      cleanedLine.includes('console.warn') || 
      cleanedLine.includes('println') || 
      cleanedLine.includes('print(') || 
      cleanedLine.includes('printf') || 
      cleanedLine.includes('log.') || 
      cleanedLine.includes('logger.') || 
      /\blog\s*\(/.test(cleanedLine) ||
      cleanedLine.includes('throw new ')) {
    score += 20;
  }
  
  // 5. Special bonus for common logging level patterns
  const loggingLevelPatterns = [
    /log\s*\.\s*(info|debug|warning|error|critical)\s*\(/i,
    /logger\s*\.\s*(info|debug|warning|error|critical)\s*\(/i,
    /console\s*\.\s*(log|info|debug|warn|error)\s*\(/i,
    /println\s*!\s*\(/i,  // Rust
    /print\s*f\s*!\s*\(/i, // Rust
    /System\s*\.\s*out\s*\.\s*println/i, // Java
    /fmt\s*\.\s*Printf/i, // Go
    /printf\s*\(/i, // C
    /NSLog\s*\(/i, // Objective-C
    /Debug\s*\.\s*Log/i  // C#
  ];
  
  for (const pattern of loggingLevelPatterns) {
    if (pattern.test(strippedLine)) {
      score += 25;
      break;
    }
  }
  
  // Penalties for lines that are likely not the source of a log
  
  // 1. Penalty for likely being a printed log, not the source code 
  if (line.includes('│') || // Table/tree view character
      line.includes('|') || // Pipe character (often in logs)
      line.match(/\d{4}-\d{2}-\d{2}/) || // Date string
      line.match(/\d{2}:\d{2}:\d{2}/) || // Time string
      line.includes('[INFO]') || // Common log level indicator
      line.includes('[DEBUG]') ||
      line.includes('[WARN]') ||
      line.includes('[WARNING]') ||
      line.includes('[ERROR]') ||
      line.includes('[TRACE]')) {
    score -= 40; // Large penalty for log-like lines
  }
  
  // 2. Penalty for generated log data or serialized data (looks like a log, not like code)
  if (line.match(/^\s*{.*}$/) || // JSON-like
      line.match(/^\s*\[.*\]$/) || // Array-like
      line.match(/^\s*<.*>$/) || // XML-like
      line.match(/^\s*-\s+\w+:/) || // YAML-like
      line.includes(' = ') && line.includes(',') && !line.includes(';') && !line.includes('{')) { // Config-like
    score -= 30;
  }
  
  // 3. Penalty for lines that are just imports or require statements
  if (cleanedLine.startsWith('import ') || 
      cleanedLine.startsWith('from ') || 
      cleanedLine.startsWith('require(') || 
      cleanedLine.startsWith('use ') || 
      cleanedLine.startsWith('include ')) {
    score -= 15;
  }
  
  // 4. Penalty for documentation or comment markers
  if (line.startsWith('/**') || 
      line.startsWith('*') || 
      line.startsWith(' *') || 
      line.includes('TODO:') || 
      line.includes('NOTE:') || 
      line.includes('@param') || 
      line.includes('@return')) {
    score -= 20;
  }
  
  // Bonus for search terms appearing as actual code elements
  // This looks for the search term as a complete word/identifier in the code
  const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(cleanedSearch)}\\b`, 'i');
  if (wordBoundaryRegex.test(cleanedLine)) {
    score += 10;
  }
  
  return Math.max(0, score);
}

/**
 * Escape special regex characters to use a string in a regex pattern
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    '.idea',
    'logs',          // Exclude logs directory
    'log',           // Common logs directory name
    'logger',
    'example',       // Typically contains examples that might include log snippets
    'examples',
    'sample',
    'samples',
    'docs',          // Documentation often contains log samples
    'doc',
    'test-fixtures', // Often contains test log data
    'fixtures'
  ]);

  // Source file extensions to include
  const sourceExtensions = new Set([
    // Web
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    // Backend
    '.rs', '.go', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.rb', '.php',
    // Config/Data (limited to actionable ones, exclude most data files)
    '.toml'
  ]);

  // Excluded extensions that might contain log samples
  const excludedExtensions = new Set([
    '.log',
    '.md',
    '.txt',
    '.json', // Often contains log samples or fixtures
    '.yaml', '.yml', // Config but often with log examples
    '.html', // May contain log examples in docs
    '.csv',
    '.xml'
  ]);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip files/dirs that match exclude patterns explicitly
      if (shouldExcludePath(fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (!skipDirs.has(entry.name.toLowerCase()) && 
            !entry.name.toLowerCase().includes('log') && // Skip any dir with 'log' in the name
            !entry.name.toLowerCase().includes('test')) { // Skip test directories
          files.push(...await findSourceFiles(fullPath));
        }
      } else if (entry.isFile()) {
        // Include only source files
        const ext = path.extname(entry.name).toLowerCase();
        if (sourceExtensions.has(ext) && !excludedExtensions.has(ext)) {
          // Additional checks for filenames indicating logs
          const lowerName = entry.name.toLowerCase();
          const isLikelyLogFile = 
            lowerName.includes('log') || 
            lowerName.includes('sample') || 
            lowerName.includes('example') || 
            lowerName.includes('fixture') ||
            lowerName.includes('test');
          
          if (!isLikelyLogFile) {
            try {
              // Quick check if file is readable and not too large
              const stats = fs.statSync(fullPath);
              const MAX_FILE_SIZE = 512 * 1024; // 512KB limit (reduced from 1MB)

              if (stats.size <= MAX_FILE_SIZE) {
                files.push(fullPath);
              }
            } catch (error) {
              console.warn(`Skipping file ${fullPath}: ${error}`);
            }
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
 * Determines if a path should be excluded from code search
 */
function shouldExcludePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  
  // Exclude common paths that might contain log samples or test data
  return normalizedPath.includes('/logs/') || 
         normalizedPath.includes('/test/') ||
         normalizedPath.includes('/tests/') ||
         normalizedPath.includes('/fixtures/') ||
         normalizedPath.includes('/examples/') ||
         normalizedPath.includes('/sample/') ||
         normalizedPath.includes('/samples/') ||
         normalizedPath.includes('/doc/') ||
         normalizedPath.includes('/docs/');
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

