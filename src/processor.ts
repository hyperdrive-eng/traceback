import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogEntry } from './logExplorer';
import { logLineDecorationType } from './decorations';
import fetch from 'node-fetch';
import { Axiom } from '@axiomhq/js';
import { ClaudeService, RegexPattern } from './claudeService';

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
      // Try parsing the first non-empty line
      const lines = content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      if (lines.length > 0) {
        JSON.parse(lines[0]);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async parse(content: string): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];
    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          // If a line contains an array, process each item
          logs.push(...parsed.map((log: any) => this.normalizeLogEntry(log)));
        } else {
          // Single log entry
          logs.push(this.normalizeLogEntry(parsed));
        }
      } catch (error) {
        console.debug('Skipping invalid JSON line:', error);
      }
    }

    return logs;
  }

  private normalizeLogEntry(log: any): LogEntry {
    // Ensure minimal required fields exist
    const normalizedLog = {
      severity: log.severity || log.level || 'INFO',
      timestamp: log.timestamp || new Date().toISOString(),
      rawText: JSON.stringify(log),
      jsonPayload: log.jsonPayload,
      message: (log.jsonPayload && log.jsonPayload.fields && log.jsonPayload.fields.message) || log.message || log.msg || '',
      target: (log.jsonPayload && log.jsonPayload.target) || log.target || log.service || log.component || 'unknown',
      fileName: log.fileName || log.file || log.filename || '',
      lineNumber: (log.lineNumber || log.line || log.lineno || log.line_number || 0) - 1
    };
    return normalizedLog;
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
    },
    // ISO8601 timestamp with log level and module path
    // Example: 2025-04-19T17:49:01.282995Z  INFO boomerang_builder::env::build: Action enclave_cycle::__startup is unused, won't build
    {
      regex: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(\w+)\s+([^:]+):\s*(.+)$/,
      extract: (matches: RegExpExecArray) => ({
        timestamp: matches[1]?.trim(),
        severity: matches[2]?.trim().toUpperCase(),
        serviceName: matches[3]?.trim(),
        message: matches[4]?.trim()
      })
    },
    // Rust/Go-style logs with ISO8601 and field labels
    // Example: 2025-04-19T15:04:32.431Z [INFO] server=web module=handler msg="Request processed" status=200
    {
      regex: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[(\w+)\]\s+(.+)$/,
      extract: (matches: RegExpExecArray) => {
        const fields = matches[3]?.trim();
        const fieldMap: Record<string, string> = {};
        
        // Extract key=value pairs, handling quoted values
        const fieldRegex = /([^=\s]+)=(?:"([^"]*)"|([^\s]*))/g;
        let fieldMatch;
        while ((fieldMatch = fieldRegex.exec(fields)) !== null) {
          const key = fieldMatch[1];
          const value = fieldMatch[2] || fieldMatch[3]; // quoted or unquoted value
          fieldMap[key] = value;
        }
        
        return {
          timestamp: matches[1]?.trim(),
          severity: matches[2]?.trim().toUpperCase(),
          serviceName: fieldMap.server || fieldMap.module || fieldMap.service || '',
          message: fieldMap.msg || fieldMap.message || fields // fall back to full fields string if no message field
        };
      }
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
    // Skip empty lines
    if (!line.trim()) {
      return { matched: false, data: {} };
    }
    
    // Try all registered patterns
    for (const pattern of this.patterns) {
      const matches = pattern.regex.exec(line);
      if (matches) {
        return {
          matched: true,
          data: pattern.extract(matches)
        };
      }
    }
    
    // If no pattern matched, perform basic heuristic extraction
    try {
      // Try to extract timestamp and severity using common patterns
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[-+]\d{4})?)/);
      const timestamp = timestampMatch ? timestampMatch[1] : null;
      
      const severityMatch = line.match(/\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i);
      const severity = severityMatch ? severityMatch[0].toUpperCase() : null;
      
      // Try to identify a service name or module
      const remainingText = timestampMatch && severityMatch 
        ? line.replace(timestampMatch[0], '').replace(severityMatch[0], '').trim()
        : line.trim();
      
      // Look for module/service pattern with colon
      const moduleMatch = remainingText.match(/^([a-zA-Z0-9_.:]+):(.+)$/);
      const serviceName = moduleMatch ? moduleMatch[1].trim() : '';
      const message = moduleMatch ? moduleMatch[2].trim() : remainingText;
      
      // If we found at least a timestamp or severity, consider it a match
      if (timestamp || severity) {
        return {
          matched: true,
          data: {
            timestamp: timestamp || new Date().toISOString(),
            severity: severity || 'INFO',
            serviceName: serviceName || '',
            message: message || remainingText
          }
        };
      }
    } catch (error) {
      console.debug('Error in heuristic log parsing:', error);
    }

    return { matched: false, data: {} };
  }

  private createLogEntry(data: any, rawLine: string): LogEntry {
    // Determine severity - first use data.severity if present, then detect from content
    let severity = data.severity || '';
    
    // If severity not provided by pattern, try to detect from line content
    if (!severity) {
      if (rawLine.toLowerCase().includes('error') || rawLine.toLowerCase().includes('exception')) {
        severity = 'ERROR';
      } else if (rawLine.toLowerCase().includes('warn')) {
        severity = 'WARNING';
      } else if (rawLine.toLowerCase().includes('info')) {
        severity = 'INFO';
      } else if (rawLine.toLowerCase().includes('debug')) {
        severity = 'DEBUG';
      } else if (rawLine.toLowerCase().includes('trace')) {
        severity = 'TRACE';
      } else {
        severity = 'INFO'; // Default to INFO if we can't detect
      }
    }
    
    // Normalize severity to standard values
    severity = this.normalizeSeverity(severity);

    // Parse timestamp if available or use current time
    let timestamp = data.timestamp || new Date().toISOString();
    if (data.timestamp) {
      try {
        // Handle various timestamp formats
        if (!data.timestamp.includes('T')) {
          // Try to convert YYYY-MM-DD HH:MM:SS to ISO format
          timestamp = new Date(data.timestamp).toISOString();
        } else if (!data.timestamp.includes('Z') && !data.timestamp.match(/[-+]\d{2}:\d{2}$/)) {
          // Add Z if timestamp has T but no timezone
          timestamp = new Date(data.timestamp + 'Z').toISOString();
        } else {
          // Already in ISO format
          timestamp = data.timestamp;
        }
      } catch (e) {
        console.debug('Failed to parse timestamp:', data.timestamp, e);
        // Keep original if parsing fails
      }
    }

    // Extract service name and message
    const serviceName = data.serviceName || '';
    const message = data.message || rawLine;

    return {
      severity,
      timestamp,
      rawText: rawLine,
      jsonPayload: {
        fields: {
          message: message
        },
        target: serviceName || 'unknown'
      },
      message: message,
      target: serviceName || 'unknown',
      serviceName: serviceName || ''
    };
  }
  
  /**
   * Normalize severity level to standard values
   */
  private normalizeSeverity(severity: string): string {
    const upperSeverity = severity.toUpperCase();
    
    // Map to standard severity levels
    if (upperSeverity.includes('TRACE')) {
      return 'TRACE';
    } else if (upperSeverity.includes('DEBUG')) {
      return 'DEBUG';
    } else if (upperSeverity.includes('INFO')) {
      return 'INFO';
    } else if (upperSeverity.includes('WARN')) {
      return 'WARNING';
    } else if (upperSeverity.includes('ERROR') || upperSeverity.includes('FATAL') || upperSeverity.includes('CRIT')) {
      return 'ERROR';
    }
    
    // Default to INFO if no match
    return 'INFO';
  }
}

/**
 * Parser that uses Claude-generated regex patterns to parse log lines
 */
export class RegexLogParser implements LogParser {
  private claudeService = ClaudeService.getInstance();
  private patterns: RegexPattern[] = [];
  private sampleLogs: string[] = [];
  private maxSampleLogs = 20; // Maximum number of sample logs to collect for pattern generation
  private hasGeneratedPatterns = false;

  constructor() {
    // Initially we don't have any patterns
    // We'll collect sample logs and generate patterns when needed
  }

  canParse(content: string): boolean {
    // This parser is a fallback that can handle anything
    // But it should be tried after JSON parser since it's more expensive
    return true;
  }

  async parse(content: string): Promise<LogEntry[]> {
    // Split content into lines
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    
    // If we have no patterns yet, collect sample logs
    if (this.patterns.length === 0 && !this.hasGeneratedPatterns) {
      // Add new samples to our collection, up to the maximum
      for (const line of lines) {
        if (this.sampleLogs.length < this.maxSampleLogs) {
          // Only add if it's not a duplicate
          if (!this.sampleLogs.includes(line)) {
            this.sampleLogs.push(line);
          }
        } else {
          break;
        }
      }
      
      // If we have enough samples or this is a large log set, generate patterns
      if (this.sampleLogs.length >= this.maxSampleLogs || lines.length > 50) {
        await this.generatePatterns();
      }
    }
    
    // If we're still missing patterns, generate them now
    if (this.patterns.length === 0) {
      // If we don't have enough samples, use what we've got
      if (this.sampleLogs.length === 0) {
        // Take a sample from the current logs
        this.sampleLogs = lines.slice(0, this.maxSampleLogs);
      }
      
      await this.generatePatterns();
    }
    
    // Now we should have patterns - parse the logs
    return this.parseWithPatterns(lines);
  }
  
  /**
   * Use Claude to generate regex patterns based on sample logs
   */
  private async generatePatterns(): Promise<void> {
    try {
      if (this.sampleLogs.length === 0) {
        // Don't attempt to generate patterns with no samples
        console.warn('No sample logs to generate patterns from');
        this.hasGeneratedPatterns = true; // Mark as tried
        return;
      }
      
      console.log(`Generating regex patterns from ${this.sampleLogs.length} sample logs...`);
      
      // Call Claude to generate patterns
      this.patterns = await this.claudeService.generateLogParsingRegex(this.sampleLogs);
      
      console.log(`Generated ${this.patterns.length} regex patterns`);
      
      // Mark that we've generated patterns to avoid repeatedly trying if it fails
      this.hasGeneratedPatterns = true;
      
      // Compile all the patterns for efficiency
      this.patterns.forEach(pattern => {
        try {
          // Pre-compile the regex for efficiency
          new RegExp(pattern.pattern);
        } catch (error) {
          console.error(`Invalid regex pattern: ${pattern.pattern}`, error);
        }
      });
    } catch (error) {
      console.error('Error generating regex patterns:', error);
      // We'll continue without patterns and fall back to heuristic parsing
      this.hasGeneratedPatterns = true; // Mark as tried to avoid retry spam
    }
  }
  
  /**
   * Parse all logs using the generated patterns
   */
  private async parseWithPatterns(lines: string[]): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];
    
    // If no valid patterns, use fallback parsing
    if (!this.patterns || this.patterns.length === 0) {
      console.debug('No valid patterns available, using fallback parsing');
      return Promise.all(lines.map(line => {
        if (!line.trim()) return null;
        return this.createFallbackLogEntry(line);
      })).then(entries => entries.filter(entry => entry !== null) as LogEntry[]);
    }
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      // Try each pattern in order until one matches
      let matched = false;
      
      for (const patternObj of this.patterns) {
        try {
          // Validate pattern object
          if (!patternObj || !patternObj.pattern || !patternObj.extractionMap) {
            console.debug('Invalid pattern object, skipping:', patternObj);
            continue;
          }

          const regex = new RegExp(patternObj.pattern);
          const match = regex.exec(line);
          
          if (match) {
            // Extract fields based on the pattern's extraction map
            const extractedData: Record<string, string> = {};
            
            for (const [logEntryField, captureGroupName] of Object.entries(patternObj.extractionMap)) {
              if (match.groups && match.groups[captureGroupName]) {
                extractedData[logEntryField] = match.groups[captureGroupName];
              }
            }
            
            // Create LogEntry from extracted data
            logs.push(this.createLogEntry(extractedData, line));
            matched = true;
            break;
          }
        } catch (error) {
          console.debug(`Error with pattern ${patternObj?.pattern || 'unknown'}:`, error);
          continue;
        }
      }
      
      // If no pattern matched, fall back to heuristic parsing
      if (!matched) {
        // Try to extract basic fields using heuristics
        logs.push(this.createFallbackLogEntry(line));
      }
    }
    
    return logs;
  }
  
  /**
   * Create a LogEntry from the extracted fields
   */
  private createLogEntry(data: Record<string, string>, rawLine: string): LogEntry {
    // Ensure required fields have sensible defaults
    const severity = this.normalizeSeverity(data.severity || '');
    
    // Process timestamp
    let timestamp = data.timestamp || new Date().toISOString();
    if (data.timestamp) {
      try {
        // Try to normalize various timestamp formats
        timestamp = new Date(data.timestamp).toISOString();
      } catch (e) {
        console.debug('Failed to parse timestamp:', data.timestamp);
        timestamp = new Date().toISOString(); // Use current time as fallback
      }
    }
    
    // Ensure other fields are defined
    const serviceName = data.serviceName || data.target || '';
    const message = data.message || rawLine;
    const target = serviceName || 'unknown';
    const fileName = data.fileName || '';
    const lineNumber = (data.lineNumber && parseInt(data.lineNumber) - 1) || -1;

    // Extract variables if they exist
    const variables: Record<string, string> = {};
    Object.entries(data).forEach(([key, value]) => {
      if (key.startsWith('variable_') && value) {
        // Remove the variable_ prefix from the key
        const varName = key.substring(9);
        variables[varName] = value;
      }
    });
    
    return {
      severity,
      timestamp,
      rawText: rawLine,
      serviceName,
      message,
      target,
      fileName,
      lineNumber,
      jsonPayload: {
        fields: {
          message,
          ...variables
        },
        target
      }
    };
  }
  
  /**
   * Create a basic LogEntry when no pattern matches
   */
  private createFallbackLogEntry(rawLine: string): LogEntry {
    let severity = 'INFO';
    
    // Try to detect severity from content
    if (rawLine.toLowerCase().includes('error') || rawLine.toLowerCase().includes('exception')) {
      severity = 'ERROR';
    } else if (rawLine.toLowerCase().includes('warn')) {
      severity = 'WARNING';
    } else if (rawLine.toLowerCase().includes('debug')) {
      severity = 'DEBUG';
    } else if (rawLine.toLowerCase().includes('info')) {
      severity = 'INFO';
    }
    
    // Try to extract service name if there's a pipe separator
    let serviceName = 'unknown';
    let message = rawLine;
    
    // Common format: service | message
    const pipeMatch = rawLine.match(/^([^|]+)\|\s*(.+)$/);
    if (pipeMatch) {
      serviceName = pipeMatch[1].trim();
      message = pipeMatch[2].trim();
    }
    
    return {
      severity,
      timestamp: new Date().toISOString(),
      rawText: rawLine,
      message,
      target: serviceName,
      serviceName,
      jsonPayload: {
        fields: {
          message
        },
        target: serviceName
      }
    };
  }
  
  /**
   * Normalize severity levels to standard values
   */
  private normalizeSeverity(severity: string): string {
    const upperSeverity = severity.toUpperCase();
    
    if (upperSeverity.includes('TRACE')) {
      return 'TRACE';
    } else if (upperSeverity.includes('DEBUG')) {
      return 'DEBUG';
    } else if (upperSeverity.includes('INFO')) {
      return 'INFO';
    } else if (upperSeverity.includes('WARN')) {
      return 'WARNING';
    } else if (upperSeverity.includes('ERROR') || upperSeverity.includes('FATAL') || upperSeverity.includes('CRIT')) {
      return 'ERROR';
    }
    
    // Default to INFO if no match
    return 'INFO';
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
    this.registerParser(new RegexLogParser());
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
    // Early validation of content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      console.warn('Empty or invalid log content provided');
      return [];
    }
    
    // Detect content format by examining the first few lines
    const sampleLines = content.split('\n').slice(0, 10).filter(line => line.trim().length > 0);
    
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

    // If no dedicated parser handled it, try a fallback approach
    // This is useful for new log formats that don't match any existing pattern
    console.warn('No dedicated parser matched, attempting fallback parsing');
    
    // Create a fallback parser that tries to handle line-by-line
    const fallbackParser = new PlainTextLogParser();
    const fallbackResult = await fallbackParser.parse(content);
    
    // If we got any valid logs from fallback parsing, return them
    if (fallbackResult && fallbackResult.length > 0) {
      console.log(`Log parsed with fallback parser, found ${fallbackResult.length} entries`);
      return fallbackResult;
    }
    
    // If still no results, return empty array
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
 * Find the code location based on log information
 * This function has been simplified to better handle arbitrary log formats
 */
export async function findCodeLocation(log: LogEntry, repoPath: string): Promise<{ file: string; line: number }> {
  try {
    // Progress indicator
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Finding code location...',
      cancellable: false
    }, async (progress) => {
      // Extract searchable content from the log, prioritizing normalized fields
      let searchContent: string = log.message || '';

      // If we still couldn't find anything searchable, we can't locate the source
      if (!searchContent || searchContent.trim().length < 3) {
        console.warn('No searchable content found in log entry');
        throw new Error('No searchable content found in log entry');
      }
      
      // Trim whitespace from resulting search content
      const query = searchContent.trim();
      
      // Verify we still have searchable content after cleaning
      if (!query || query.trim().length < 3) {
        console.warn('No searchable content left after cleaning log patterns');
        throw new Error('No searchable content found after cleaning log patterns');
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

      progress.report({ message: 'Searching for matching source files...' });

      // Get workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open');
      }
      
      // Use the first workspace folder as the root
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      
      // Function to search a file for the query
      async function searchFile(filePath: string, query: string): Promise<{ line: number } | null> {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          
          // First check if the file contains the query at all before line-by-line processing
          if (!content.includes(query)) {
            return null;
          }
          
          // Only if the file contains the query, proceed with line-by-line search
          const lines = content.split('\n');
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.toLowerCase().includes(query.toLowerCase())) {
              return { line: i};
            }
          }
          return null;
        } catch (error) {
          console.debug(`Error reading file ${filePath}:`, error);
          return null;
        }
      }
      
      // Find all applicable source files
      progress.report({ message: 'Finding source files...' });
      let filesToSearch = await vscode.workspace.findFiles(
        '**/*.{ts,tsx,js,jsx,vue,svelte,rs,go,py,java,cs,cpp,c,h,rb,php}',
        '**/[node_modules,dist,build,.git,logs]/**'
      );
      
      // If we have a target path, prioritize matching files
      if (targetPath) {
        const targetLower = targetPath.toLowerCase();
        filesToSearch.sort((a, b) => {
          const aContains = a.fsPath.toLowerCase().includes(targetLower) ? -1 : 0;
          const bContains = b.fsPath.toLowerCase().includes(targetLower) ? -1 : 0;
          return aContains - bContains;
        });
      }
      
      // Remove the file limit to search the entire codebase
      console.log(`Searching all ${filesToSearch.length} files in the codebase`);
      
      // Search through the files
      let searchCount = 0;
      
      
      progress.report({ message: `Searching for "${query}" (processed ${searchCount} files)` });
      
      // Progress files in batches for better responsiveness
      const BATCH_SIZE = 50;
      
      // Function to search all files with a given query
      async function searchAllFiles(searchQuery: string): Promise<{file: string; line: number} | null> {
        for (let i = 0; i < filesToSearch.length; i += BATCH_SIZE) {
          const batch = filesToSearch.map(file => file.fsPath).slice(i, i + BATCH_SIZE);
          
          // Search files in parallel
          const batchPromises = batch.map(async (file) => {
            searchCount++;
            if (searchCount % 100 === 0) {
              progress.report({ message: `Searching for "${searchQuery}" (processed ${searchCount} files)` });
            }
            
            const match = await searchFile(file, searchQuery);
            if (match) {
              const relativePath = path.relative(workspaceRoot, file);
              return { file: relativePath, line: match.line };
            }
            return null;
          });
          
          const batchResults = await Promise.all(batchPromises);
          const validMatches = batchResults.filter(m => m !== null) as Array<{ file: string; line: number }>;
          
          if (validMatches.length > 0) {
            return validMatches[0];
          }
        }
        
        return null; // No matches found
      }
      
      // First, try with the exact query
      progress.report({ message: `Searching for exact match: "${query}"` });
      const exactMatch = await searchAllFiles(query);
      
      if (exactMatch) {
        return exactMatch;
      }
      
      // If exact match failed, try with variations
      const words = query.split(/\s+/).filter(w => w.length > 0);
      
      // Only try variations if we have multiple words
      if (words.length > 4) {
        progress.report({ message: `No exact match found, trying variations...` });
        
        // Generate variations by removing words from front and back
        const variations: string[] = [];
        
        // Remove words from the front (1, 2, 3, etc.)
        for (let i = 1; i < words.length; i++) {
          const frontVariation = words.slice(i).join(' ');
          if (frontVariation.length >= 3) {
            variations.push(frontVariation);
          }
          
          // Remove words from the back (1, 2, 3, etc.)
          const backVariation = words.slice(0, words.length - i).join(' ');
          if (backVariation.length >= 3) {
            variations.push(backVariation);
          }
        }
        
        // Try each variation until we find a match
        for (const variation of variations) {
          progress.report({ message: `Trying variation: "${variation}"` });
          const match = await searchAllFiles(variation);
          if (match) {
            return match;
          }
        }
      }
      
      return null; // No matches found with any variation
    });

    // Check result after withProgress finishes
    if (result) {
      return result;
    }
    throw new Error('No code location found');
  } catch (error) {
    console.error('Error in findCodeLocation:', error);
    throw error;
  }
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