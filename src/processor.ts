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
          token = await vscode.commands.executeCommand('log-visualizer.getAxiomToken');
          
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
        await vscode.commands.executeCommand('log-visualizer.storeAxiomToken', token);

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

export async function loadLogs(logPathOrUrl: string): Promise<LogEntry[]> {
  try {
    if (!logPathOrUrl) {
      vscode.window.showErrorMessage('Log source is not set.');
      return [];
    }

    // Check if this is an Axiom trace format (indicated by axiom: prefix)
    if (logPathOrUrl.startsWith('axiom:')) {
      const traceId = logPathOrUrl.substring(6); // Remove 'axiom:' prefix
      return await loadAxiomTrace(traceId);
    }

    let parsedData: any;
    let rawContent: string;

    // Check if the input is a URL
    if (logPathOrUrl.startsWith('http://') || logPathOrUrl.startsWith('https://')) {
      try {
        // Show a progress notification while fetching
        return await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching Jaeger trace...',
            cancellable: false
          },
          async (progress) => {
            // Fetch the JSON from the URL
            const response = await fetch(logPathOrUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch trace: ${response.statusText}`);
            }
            
            rawContent = await response.text();
            parsedData = JSON.parse(rawContent);
            
            progress.report({ message: 'Processing trace data...' });
            
            // Detect if this is a Jaeger trace format
            if (parsedData.data && Array.isArray(parsedData.data)) {
              return processJaegerFormat(parsedData, rawContent);
            } else {
              vscode.window.showWarningMessage('The fetched data is not in the expected Jaeger trace format.');
              return [];
            }
          }
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error fetching trace: ${error.message}`);
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
      parsedData = JSON.parse(rawContent);

      // Detect if this is a Jaeger trace or regular log format
      if (parsedData.data && Array.isArray(parsedData.data)) {
        // This is a Jaeger trace format
        return processJaegerFormat(parsedData, rawContent);
      } else {
        // Assume traditional log format
        return processTraditionalFormat(parsedData, rawContent);
      }
    }
  } catch (error) {
    console.error('Error loading logs:', error);
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
    const message = log.jsonPayload?.fields?.message || '';
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

export async function findCodeLocation(log: LogEntry, repoPath: string): Promise<{ file: string; line: number } | undefined> {
  try {
    let searchContent: string;
    let targetPath: string | undefined;
    
    // Handle different log formats
    if (log.jaegerSpan) {
      // For Jaeger spans, use the operation name and look for additional context in tags
      searchContent = log.jaegerSpan.operationName;
      
      // Look for source code related tags
      const sourceFileTag = log.jaegerSpan.tags.find(tag => 
        tag.key === 'code.filepath' || 
        tag.key === 'code.function' || 
        tag.key === 'code.namespace'
      );
      
      if (sourceFileTag) {
        targetPath = sourceFileTag.value.toString().replace(/::/g, '/');
      } else if (log.serviceName) {
        // Use service name as a fallback path hint
        targetPath = log.serviceName.toLowerCase().replace(/-/g, '_');
      }
      
      // For HTTP requests, also look for path/method information
      const httpMethod = log.jaegerSpan.tags.find(tag => tag.key === 'http.method');
      const httpPath = log.jaegerSpan.tags.find(tag => tag.key === 'http.target' || tag.key === 'http.url');
      
      if (httpMethod && httpPath) {
        // Add HTTP method and path to search content for better matching
        searchContent = `${httpMethod.value} ${httpPath.value}`;
      }
      
      // For RPC calls, look for method information
      const rpcMethod = log.jaegerSpan.tags.find(tag => tag.key === 'rpc.method');
      if (rpcMethod) {
        searchContent = rpcMethod.value.toString();
      }
    }
    // Handle Axiom trace format
    else if (log.axiomSpan) {
      // Use span name as the main search content
      searchContent = log.axiomSpan.name || '';
      
      // Look for code filepath attributes
      const codeFilepath = log.axiomSpan['attributes.code.filepath'] || 
                           log.axiomSpan['code.filepath'];
      
      const codeFunction = log.axiomSpan['attributes.code.function'] || 
                           log.axiomSpan['code.function'];
                           
      const codeNamespace = log.axiomSpan['attributes.code.namespace'] || 
                            log.axiomSpan['code.namespace'];
      
      if (codeFilepath) {
        targetPath = codeFilepath.toString().replace(/::/g, '/');
      }
      else if (codeNamespace) {
        targetPath = codeNamespace.toString().replace(/::/g, '/');
      }
      else if (log.serviceName) {
        // Use service name as a fallback path hint
        targetPath = log.serviceName.toLowerCase().replace(/-/g, '_');
      }
      
      // For HTTP requests, add path/method information if available
      const httpMethod = log.axiomSpan['attributes.http.method'] || 
                         log.axiomSpan['http.method'];
                         
      const httpPath = log.axiomSpan['attributes.http.target'] || 
                       log.axiomSpan['attributes.http.url'] ||
                       log.axiomSpan['http.target'] || 
                       log.axiomSpan['http.url'];
      
      if (httpMethod && httpPath) {
        // Add HTTP method and path to search content for better matching
        searchContent = `${httpMethod} ${httpPath}`;
      }
      
      // For RPC calls, look for method information
      const rpcMethod = log.axiomSpan['attributes.rpc.method'] || 
                        log.axiomSpan['rpc.method'];
                        
      if (rpcMethod) {
        searchContent = rpcMethod.toString();
      }
      
      // Use function name if available and we still don't have good search content
      if (!searchContent && codeFunction) {
        searchContent = codeFunction.toString();
      }
    } 
    // Original log format 
    else if (log.jsonPayload && log.jsonPayload.fields) {
      searchContent = log.jsonPayload.fields.message;
      if (!searchContent) {
        return undefined;
      }
      
      if (log.jsonPayload.target) {
        targetPath = log.jsonPayload.target.replace(/::/g, '/');
      }
    }
    // Use unified fields if available
    else if (log.message) {
      searchContent = log.message;
      targetPath = log.target?.replace(/::/g, '/');
    }
    else {
      // No searchable content
      return undefined;
    }

    // Search through source files in the repository
    const files = await findSourceFiles(repoPath);

    // If we have a target path, prioritize files that match
    if (targetPath) {
      files.sort((a, b) => {
        const aContainsTarget = a.includes(targetPath as string) ? -1 : 0;
        const bContainsTarget = b.includes(targetPath as string) ? -1 : 0;
        return aContainsTarget - bContainsTarget;
      });
    }

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isLineMatch(line, searchContent)) {
          return {
            file: path.relative(repoPath, file),
            line: i
          };
        }
      }
    }

    return undefined;
  } catch (error) {
    console.error('Error in findCodeLocation:', error);
    return undefined;
  }
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
  const dataset = await vscode.commands.executeCommand<string>('log-visualizer.getAxiomDataset');
  
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

