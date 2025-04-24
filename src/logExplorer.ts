import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import { findCodeLocation, loadLogs } from './processor';
import { logLineDecorationType, variableValueDecorationType, clearDecorations } from './decorations';
import { CallerAnalysis, ClaudeService, LLMLogAnalysis } from './claudeService';
import { VectorStore, findCodeLocationVector, findFullPath } from './vectorSearch';

// Core interfaces for log structure
export interface Span {
  name: string;
  key_id?: string;
  self?: string;
  [key: string]: any;
}


export interface LogEntry {
  // Common fields for all log types
  severity: string;
  timestamp: string;
  rawText: string;
  fileName?: string;
  lineNumber?: number;

  // Original log format fields
  insertId?: string;
  jsonPayload: {
    fields: {
      message: string;
      [key: string]: any;
    };
    level?: string;
    target?: string;
    timestamp?: string;
    span?: Span;
    spans?: Span[];
  };
  labels?: {
    [key: string]: string;
  };
  logName?: string;
  receiveTimestamp?: string;
  resource?: {
    labels: {
      cluster_name: string;
      container_name: string;
      namespace_name: string;
      pod_name: string;
      [key: string]: string;
    };
    type: string;
  };

  // Axiom trace specific fields
  axiomSpan?: any; // Using 'any' for flexibility with Axiom's response format

  // Common trace fields
  serviceName?: string; // Service name from trace data
  parentSpanID?: string; // Parent span ID

  // Unified fields for display purposes
  message?: string;
  target?: string;

  // Add Claude analysis results
  claudeAnalysis?: {
    staticSearchString: string;
    variables: Record<string, any>;
  };

  // Add code location cache
  codeLocationCache?: {
    file: string;
    line: number;
    lastUpdated: string;
  };

  // Add call stack analysis cache
  callStackCache?: {
    potentialCallers: Array<{
      filePath: string;
      lineNumber: number;
      code: string;
      functionName: string;
      confidence: number;
      explanation: string;
    }>;
    lastUpdated: string;
  };
}

export class LogExplorerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private logs: LogEntry[] = [];
  private spanMap: Map<string, LogEntry[]> = new Map();
  private context: vscode.ExtensionContext;
  private currentDecorations: vscode.TextEditorDecorationType[] = [];
  private sortByTime: boolean = true;
  private selectedLogLevels: Set<string> = new Set(['INFO', 'DEBUG', 'WARNING', 'ERROR']);
  private variableExplorerProvider: { setLog: (log: LogEntry | undefined, isAnalyzing?: boolean) => void } | undefined;
  private callStackExplorerProvider: {
    setLogEntry: (log: LogEntry | undefined, isAnalyzing?: boolean) => void,
    findPotentialCallers: (sourceFile: string, lineNumber: number) => Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>>,
    analyzeCallers: (currentLogLine: string, staticSearchString: string, allLogs: LogEntry[], potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>) => Promise<void>,
    getCallStackAnalysis: () => CallerAnalysis,
    setCallStackAnalysisFromCache: (rankedCallers: Array<{
      filePath: string;
      lineNumber: number;
      code: string;
      functionName: string;
      confidence: number;
      explanation: string;
    }>) => void
  } | undefined;
  private codeLocationsProvider: { setLog: (log: LogEntry | undefined) => Promise<void> } | undefined;
  private claudeService: ClaudeService = ClaudeService.getInstance();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    vscode.commands.registerCommand('traceback.openLog', (log: LogEntry) => this.openLog(log));
    vscode.commands.registerCommand('traceback.toggleSort', () => this.toggleSort());

    const setClaudeApiKeyCommand = vscode.commands.registerCommand(
      'traceback.setClaudeApiKey',
      async () => {
        const apiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Claude API key',
          password: true,
          placeHolder: 'Enter your Claude API key here'
        });

        if (apiKey) {
          try {
            await this.claudeService.setApiKey(apiKey);
            vscode.window.showInformationMessage('Claude API key set successfully');
          } catch (error) {
            vscode.window.showErrorMessage('Failed to set Claude API key');
          }
        }
      }
    );

    context.subscriptions.push(setClaudeApiKeyCommand);
  }

  /**
   * Set the variable explorer provider to update when logs are selected
   */
  public setVariableExplorer(provider: { setLog: (log: LogEntry | undefined, isAnalyzing?: boolean) => void }): void {
    this.variableExplorerProvider = provider;
  }

  /**
   * Set the call stack explorer provider to update when logs are selected
   */
  public setCallStackExplorer(provider: {
    setLogEntry: (log: LogEntry | undefined, isAnalyzing?: boolean) => void,
    findPotentialCallers: (sourceFile: string, lineNumber: number) => Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>>,
    analyzeCallers: (currentLogLine: string, staticSearchString: string, allLogs: LogEntry[], potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>) => Promise<void>,
    getCallStackAnalysis: () => CallerAnalysis,
    setCallStackAnalysisFromCache: (rankedCallers: Array<{
      filePath: string;
      lineNumber: number;
      code: string;
      functionName: string;
      confidence: number;
      explanation: string;
    }>) => void
  }): void {
    this.callStackExplorerProvider = provider;
  }

  public setCodeLocationsExplorer(provider: { setLog: (log: LogEntry | undefined) => Promise<void> }): void {
    this.codeLocationsProvider = provider;
  }

  refresh(): void {
    // Clear decorations from editor
    clearDecorations();

    // Clear variable and call stack explorers
    if (this.variableExplorerProvider) {
      this.variableExplorerProvider.setLog(undefined);
    }
    if (this.callStackExplorerProvider) {
      this.callStackExplorerProvider.setLogEntry(undefined);
    }

    this.loadLogs();
    this._onDidChangeTreeData.fire();

    // Clear selection in the logs view
    vscode.commands.executeCommand('list.clear');
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      if (this.sortByTime) {
        // Get all logs and sort by timestamp
        const allLogs = Array.from(this.spanMap.values())
          .flat()
          .filter(log => this.selectedLogLevels.has(log.severity.toUpperCase()))
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Reverse chronological order

        // Group consecutive logs from the same group
        const result: vscode.TreeItem[] = [];
        let currentGroup: LogEntry[] = [];
        let currentGroupName: string | null = null;

        allLogs.forEach((log) => {
          // Handle logs without any group information
          if (!log.jsonPayload?.target && !log.jsonPayload?.span && !log.axiomSpan) {
            // Add ungrouped logs directly as individual items
            result.push(new LogTreeItem(log));
            return;
          }

          const groupName = this.getGroupName(log);

          if (groupName === currentGroupName) {
            // Add to current group if from same group
            currentGroup.push(log);
          } else {
            // Create group item for previous group if it exists
            if (currentGroup.length > 0) {
              if (currentGroup.length === 1) {
                // If group has only one log, add it as individual item
                result.push(new LogTreeItem(currentGroup[0]));
              } else {
                // If group has multiple logs, create a group item
                result.push(new SpanGroupItem(
                  currentGroupName!,
                  currentGroup,
                  vscode.TreeItemCollapsibleState.Expanded
                ));
              }
            }

            // Start new group
            currentGroupName = groupName;
            currentGroup = [log];
          }
        });

        // Handle the last group
        if (currentGroup.length > 0) {
          if (currentGroup.length === 1) {
            result.push(new LogTreeItem(currentGroup[0]));
          } else {
            result.push(new SpanGroupItem(
              currentGroupName!,
              currentGroup,
              vscode.TreeItemCollapsibleState.Expanded
            ));
          }
        }

        return Promise.resolve(result);
      } else {
        // For regular grouping
        const groupedLogs = new Map<string, LogEntry[]>();
        const ungroupedLogs: LogEntry[] = [];

        Array.from(this.spanMap.values())
          .flat()
          .filter(log => this.selectedLogLevels.has(log.severity))
          .forEach(log => {
            if (!log.jsonPayload && !log.axiomSpan) {
              ungroupedLogs.push(log);
            } else {
              const groupName = this.getGroupName(log);
              if (!groupedLogs.has(groupName)) {
                groupedLogs.set(groupName, []);
              }
              groupedLogs.get(groupName)!.push(log);
            }
          });

        const result: vscode.TreeItem[] = [];

        // Add grouped logs first
        result.push(...Array.from(groupedLogs.entries())
          .map(([groupName, logs]) => new SpanGroupItem(
            groupName,
            logs,
            vscode.TreeItemCollapsibleState.Expanded
          ))
          .sort((a, b) => a.spanName.localeCompare(b.spanName))
        );

        // Add ungrouped logs as individual items
        if (ungroupedLogs.length > 0) {
          result.push(...ungroupedLogs
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) // Sort ungrouped logs in reverse chronological order
            .map(log => new LogTreeItem(log))
          );
        }

        return Promise.resolve(result);
      }
    } else if (element instanceof SpanGroupItem) {
      return Promise.resolve(
        element.logs
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) // Sort group logs in reverse chronological order
          .map(log => new LogTreeItem(log))
      );
    }
    return Promise.resolve([]);
  }

  private getGroupName(log: LogEntry): string {
    // Handle Axiom trace format
    if (log.axiomSpan) {
      const serviceName = log.serviceName || log.axiomSpan['service.name'] || 'unknown-service';
      const operationName = log.axiomSpan.name || 'unknown-operation';
      return `${serviceName}::${operationName}`;
    }

    // Handle original log format
    const target = log.jsonPayload?.target || '';
    const spanName = log.jsonPayload?.span?.name;

    if (spanName) {
      return `${target}::${spanName}`;
    }

    // Use unified fields as fallback
    if (log.target) {
      return log.target;
    }

    return target || 'unknown';
  }

  private async loadLogs(): Promise<void> {
    try {
      const logPath = this.context.globalState.get<string>('logFilePath');
      if (!logPath) {
        vscode.window.showErrorMessage('Log file path is not set.');
        return;
      }

      // Reset first log time and ID counter before loading new logs
      LogTreeItem.resetFirstLogTime();

      // Clear existing logs and span map
      this.logs = [];
      this.spanMap.clear();

      // Load new logs
      this.logs = await loadLogs(logPath);

      // Clear all caches from loaded logs
      this.logs.forEach(log => {
        log.codeLocationCache = undefined;
        log.callStackCache = undefined;
        log.claudeAnalysis = undefined;
      });

      // Group logs by span name
      this.spanMap.clear();

      // Create a special "ungrouped" entry for logs without jsonPayload
      const ungroupedLogs: LogEntry[] = [];

      this.logs.forEach(log => {
        // If log has no jsonPayload and no special formats, add to ungrouped
        if (!log.jsonPayload && !log.axiomSpan) {
          ungroupedLogs.push(log);
          return;
        }

        let spanName: string;
        if (log.axiomSpan) {
          // For Axiom format
          const serviceName = log.serviceName || log.axiomSpan['service.name'] || 'unknown';
          const operationName = log.axiomSpan.name || 'unknown';
          spanName = `${serviceName}::${operationName}`;
        } else if (log.jsonPayload?.span) {
          // Original format with span
          spanName = `${log.jsonPayload.target || ''}::${log.jsonPayload.span.name || 'Unknown'}`;
        } else if (log.jsonPayload?.target) {
          // Original format with just target
          spanName = log.jsonPayload.target;
        } else {
          // Shouldn't reach here due to earlier check
          return;
        }

        if (!this.spanMap.has(spanName)) {
          this.spanMap.set(spanName, []);
        }
        this.spanMap.get(spanName)!.push(log);
      });

      // Add ungrouped logs to the map with a special key
      if (ungroupedLogs.length > 0) {
        this.spanMap.set('__ungrouped__', ungroupedLogs);
      }
    } catch (error) {
      console.error('Error loading logs:', error);
      this.logs = [];
      this.spanMap.clear();
    }
  }

  private async openLog(log: LogEntry): Promise<void> {
    console.log('openLog called with:', log);

    // Clear previous decorations
    clearDecorations();

    try {
      // Update all explorers with the selected log
      if (this.variableExplorerProvider) {
        this.variableExplorerProvider.setLog(log, !log.claudeAnalysis);
      }

      if (this.callStackExplorerProvider) {
        this.callStackExplorerProvider.setLogEntry(log);
      }

      if (this.codeLocationsProvider) {
        await this.codeLocationsProvider.setLog(log);
      }

      // Get repository root path early as we need it for both paths
      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) {
        vscode.window.showErrorMessage('Repository root path is not set.');
        return;
      }

      // Only use fileName and lineNumber if fileName contains a path separator
      const hasValidPath = log.fileName && 
                          (log.fileName.includes('/') || log.fileName.includes('\\')) && 
                          typeof log.lineNumber === 'number' && 
                          log.lineNumber >= 0;

      if (hasValidPath) {
        // Try to find the full path if we only have a partial path
        const fullPath = await findFullPath(log.fileName!, repoPath);
        if (fullPath) {
          // Cache the location for future use
          const sourceLocation = {
            file: fullPath,
            line: log.lineNumber!,
            lastUpdated: new Date().toISOString()
          };
          log.codeLocationCache = sourceLocation;

          // Open the file immediately
          const document = await vscode.workspace.openTextDocument(path.join(repoPath, fullPath));
          const editor = await vscode.window.showTextDocument(document);

          // Highlight the line
          const range = new vscode.Range(log.lineNumber!, 0, log.lineNumber!, 0);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          editor.setDecorations(logLineDecorationType, [new vscode.Range(log.lineNumber!, 0, log.lineNumber!, 999)]);

          // Start Claude analysis in the background
          this.startBackgroundAnalysis(log, fullPath, log.lineNumber!);
          return;
        }
      }

      // Show progress indicator for analysis
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Processing log...',
        cancellable: false
      }, async (progress) => {
        // Extract a normalized message for analysis
        const logMessage = log.message || log.rawText || '';

        let analysis = log.claudeAnalysis;
        if (!analysis) {
          progress.report({ message: 'Analyzing log with Claude...' });

          // Detect language based on repository files
          let language = 'unknown';
          try {
            if (fs.existsSync(path.join(repoPath, 'package.json'))) {
              language = 'TypeScript/JavaScript';
            } else if (fs.existsSync(path.join(repoPath, 'requirements.txt')) || fs.existsSync(path.join(repoPath, 'setup.py'))) {
              language = 'Python';
            } else if (fs.existsSync(path.join(repoPath, 'pom.xml')) || fs.existsSync(path.join(repoPath, 'build.gradle'))) {
              language = 'Java';
            } else if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
              language = 'Rust';
            } else if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
              language = 'Go';
            }
          } catch (error) {
            console.error('Error detecting language:', error);
            language = 'unknown';
          }

          analysis = await this.claudeService.analyzeLog(logMessage, language);
          log.claudeAnalysis = analysis;
          // Refresh variable explorer after analysis is complete
          if (this.variableExplorerProvider) {
            this.variableExplorerProvider.setLog(log, false);
          }
        }

        progress.report({ message: 'Finding source code location...' });

        // Find source location - use cached value if available
        let sourceLocation = log.codeLocationCache;

        if (!sourceLocation) {
          sourceLocation = await this.findSourceLocation(log, analysis, repoPath);
          log.codeLocationCache = sourceLocation;
        }

        // Open the file and highlight the relevant line
        const fullPath = path.join(repoPath, sourceLocation.file);
        if (!fs.existsSync(fullPath)) {
          vscode.window.showErrorMessage(`Could not find ${sourceLocation.file} in the repository`);
          return;
        }

        // Open the file
        const document = await vscode.workspace.openTextDocument(fullPath);
        const editor = await vscode.window.showTextDocument(document);

        // Highlight the line
        const range = new vscode.Range(sourceLocation.line, 0, sourceLocation.line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(logLineDecorationType, [new vscode.Range(sourceLocation.line, 0, sourceLocation.line, 999)]);

        // Get the line text and decorate variables
        const lineText = document.lineAt(sourceLocation.line).text;
        this.decorateVariables(editor, sourceLocation.line, lineText, analysis);

        // Start call stack analysis in the background
        if (this.callStackExplorerProvider) {
          this.analyzeCallStackInBackground(log, sourceLocation.file, sourceLocation.line, logMessage, analysis?.staticSearchString);
        }
      });
    } catch (error) {
      console.error('Error in openLog:', error);
      vscode.window.showErrorMessage(`Error opening log: ${error}`);
    }
  }

  // Helper method to start background analysis
  private async startBackgroundAnalysis(log: LogEntry, sourceFile: string, lineNumber: number): Promise<void> {
    try {
      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) return;

      const logMessage = log.message || log.rawText || '';
      let analysis = log.claudeAnalysis;

      if (!analysis) {
        // Detect language based on repository files
        let language = 'unknown';
        try {
          if (fs.existsSync(path.join(repoPath, 'package.json'))) {
            language = 'TypeScript/JavaScript';
          } else if (fs.existsSync(path.join(repoPath, 'requirements.txt')) || fs.existsSync(path.join(repoPath, 'setup.py'))) {
            language = 'Python';
          } else if (fs.existsSync(path.join(repoPath, 'pom.xml')) || fs.existsSync(path.join(repoPath, 'build.gradle'))) {
            language = 'Java';
          } else if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
            language = 'Rust';
          } else if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
            language = 'Go';
          }
        } catch (error) {
          console.error('Error detecting language:', error);
          language = 'unknown';
        }

        analysis = await this.claudeService.analyzeLog(logMessage, language);
        log.claudeAnalysis = analysis;
      }

      // Start call stack analysis in the background
      if (this.callStackExplorerProvider) {
        this.analyzeCallStackInBackground(log, sourceFile, lineNumber, logMessage, analysis?.staticSearchString);
      }
    } catch (error) {
      console.error('Error in background analysis:', error);
    }
  }

  // New method to handle background call stack analysis
  private async analyzeCallStackInBackground(
    log: LogEntry,
    sourceFile: string,
    targetLine: number,
    logMessage: string,
    staticSearchString?: string
  ): Promise<void> {
    try {
      // Check for cached call stack analysis
      if (log.callStackCache) {
        this.callStackExplorerProvider?.setCallStackAnalysisFromCache(log.callStackCache.potentialCallers);
        return;
      }

      // Show a subtle progress indication
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: '$(sync~spin) Analyzing call stack...'
      }, async () => {
        const repoPath = this.context.globalState.get<string>('repoPath');
        if (!repoPath || !this.callStackExplorerProvider) return;

        // Set analyzing state before starting analysis
        this.callStackExplorerProvider.setLogEntry(log, true);

        const potentialCallers = await this.callStackExplorerProvider.findPotentialCallers(
          path.join(repoPath, sourceFile),
          targetLine
        );

        if (!potentialCallers || potentialCallers.length === 0) {
          // If no potential callers found, update the call stack explorer with empty state
          this.callStackExplorerProvider.setLogEntry(log, false);
          return;
        }

        if (staticSearchString) {
          await this.callStackExplorerProvider.analyzeCallers(
            logMessage,
            staticSearchString,
            this.logs,
            potentialCallers
          );

          // Cache the results after analysis
          const analysis = this.callStackExplorerProvider.getCallStackAnalysis();
          if (analysis && analysis.rankedCallers.length > 0) {
            log.callStackCache = {
              potentialCallers: analysis.rankedCallers,
              lastUpdated: new Date().toISOString()
            };
          } else {
            // If no ranked callers found after analysis, update with empty state
            this.callStackExplorerProvider.setLogEntry(log, false);
          }
        } else {
          // If no static search string available, update with empty state
          this.callStackExplorerProvider.setLogEntry(log, false);
        }
      });
    } catch (error) {
      // Log error but don't show to user since this is background processing
      console.error('Error in background call stack analysis:', error);
      // Update call stack explorer to show no results found
      this.callStackExplorerProvider?.setLogEntry(log, false);
    }
  }

  /**
   * Find the source code location based on the log and analysis
   */
  private async findSourceLocation(
    log: LogEntry,
    analysis?: LLMLogAnalysis,
    repoPath?: string
  ): Promise<{ file: string; line: number; lastUpdated: string }> {
    if (!repoPath) throw new Error('Repository path is not set.');

    // Check cache first
    if (log.codeLocationCache) {
      // Verify the file still exists
      const fullPath = path.join(repoPath, log.codeLocationCache.file);
      if (fs.existsSync(fullPath)) {
        return {
          file: log.codeLocationCache.file,
          line: log.codeLocationCache.line,
          lastUpdated: new Date().toISOString()
        };
      }
    }

    // Get vector store instance - it should already be indexed from extension activation
    const vectorStore = VectorStore.getInstance();
    if (!vectorStore.isWorkspaceIndexed()) {
      throw new Error('Workspace not indexed yet. Please wait for indexing to complete.');
    }

    // First try with Claude's static search string if available
    if (analysis?.staticSearchString) {
      console.log('Searching with Claude static string:', analysis.staticSearchString);
      const staticResults = await findCodeLocationVector(analysis.staticSearchString, repoPath);
      if (staticResults) {
        const bestMatch = Array.isArray(staticResults) ? staticResults[0] : staticResults;
        const fullPath = await findFullPath(bestMatch.file, repoPath);
        return {
          file: fullPath || bestMatch.file,
          line: bestMatch.line,
          lastUpdated: new Date().toISOString()
        };
      }
    }

    // Fall back to cleaned log message if static search fails
    const message = log.message || log.rawText || '';
    const cleanMessage = message
      .replace(/\[\s*(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\s*\]\s*/gi, '')
      .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(\.\d+)?(\s*[+-]\d{4})?\s*/, '')
      .replace(/\d{2}:\d{2}:\d{2}(\.\d+)?\s*/, '')
      .trim();

    console.log('Falling back to cleaned message:', cleanMessage);
    const searchResult = await findCodeLocationVector(cleanMessage, repoPath);

    // Last resort: try to find files based on the service/target name
    if (!searchResult) {
      const serviceName = log.target || log.serviceName || '';
      if (serviceName) {
        // Normalize the service name for filename matching
        const normalizedName = serviceName.toLowerCase()
          .replace(/::/g, '/')
          .replace(/-/g, '_')
          .replace(/\s+/g, '_');

        try {
          // Try both exact and wildcard matching
          for (const pattern of [
            `**/${normalizedName}.*`,
            `**/*${normalizedName}*.*`
          ]) {
            const files = await vscode.workspace.findFiles(
              new vscode.RelativePattern(repoPath, pattern),
              '**/node_modules/**'
            );

            if (files.length > 0) {
              // If we found files but don't know the line, return line 0 as a fallback
              return {
                file: path.relative(repoPath, files[0].fsPath),
                line: 0,
                lastUpdated: new Date().toISOString()
              };
            }
          }
        } catch (error) {
          console.error('Error searching for service files:', error);
        }
      }
    }

    if (!searchResult) {
      throw new Error('No search result found');
    }

    const bestMatch = Array.isArray(searchResult) ? searchResult[0] : searchResult;
    const fullPath = await findFullPath(bestMatch.file, repoPath);

    return {
      file: fullPath || bestMatch.file,
      line: bestMatch.line,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Decorate variables in the editor
   */
  private decorateVariables(
    editor: vscode.TextEditor,
    targetLine: number,
    lineText: string,
    analysis?: LLMLogAnalysis
  ): void {
    if (!analysis?.variables) return;

    const decorations: vscode.DecorationOptions[] = [];

    Object.entries(analysis.variables).forEach(([name, value]) => {
      // Use word boundary regex to find the variable
      const regex = new RegExp(`\\b${name}\\b`, 'g');
      let match;

      while ((match = regex.exec(lineText)) !== null) {
        const startIndex = match.index;
        const range = new vscode.Range(
          targetLine,
          startIndex,
          targetLine,
          startIndex + name.length
        );

        decorations.push({
          range,
          renderOptions: {
            after: {
              contentText: ` = ${JSON.stringify(value)}`,
              fontWeight: 'bold',
              color: 'var(--vscode-symbolIcon-variableForeground, var(--vscode-editorInfo-foreground))'
            }
          }
        });
      }
    });

    // Apply all decorations at once
    if (decorations.length > 0) {
      editor.setDecorations(variableValueDecorationType, decorations);
    }
  }

  public toggleSort(): void {
    this.sortByTime = !this.sortByTime;
    vscode.commands.executeCommand('setContext', 'traceback.timeSort', this.sortByTime);
    vscode.window.showInformationMessage(
      this.sortByTime ? 'Showing chronological logs (grouped by consecutive spans)' : 'Showing logs grouped by spans'
    );
    this._onDidChangeTreeData.fire();
  }

  // Optional: Add a method to get the current sort state
  public isSortingByTime(): boolean {
    return this.sortByTime;
  }

  // Modify the filter method to use LogEntry's severity field
  private filterLogsByLevel(logs: LogEntry[]): LogEntry[] {
    return logs.filter(log =>
      this.selectedLogLevels.has(log.severity)
    );
  }

  // Update the log level selection method with correct values
  async selectLogLevels(): Promise<void> {
    const logLevels = ['INFO', 'DEBUG', 'WARNING', 'ERROR'];

    const selectedLevels = await vscode.window.showQuickPick(
      logLevels.map(level => ({
        label: level,
        picked: this.selectedLogLevels.has(level),
        description: this.selectedLogLevels.has(level) ? 'Selected' : undefined
      })),
      {
        canPickMany: true,
        title: 'Select Log Levels to Show',
        placeHolder: 'Choose log levels to display'
      }
    );

    if (selectedLevels) {
      this.selectedLogLevels = new Set(
        selectedLevels.map(item => item.label)
      );

      // If nothing selected, select all (prevent empty view)
      if (this.selectedLogLevels.size === 0) {
        this.selectedLogLevels = new Set(logLevels);
      }

      this._onDidChangeTreeData.fire();
    }
  }
}

export class SpanGroupItem extends vscode.TreeItem {
  constructor(
    public readonly spanName: string,
    public readonly logs: LogEntry[],
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(
      spanName,
      collapsibleState
    );

    // Count logs by severity
    const severityCounts = logs.reduce((acc, log) => {
      const severity = log.severity;
      acc[severity] = (acc[severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Get time range
    const sortedLogs = [...logs].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const firstLog = sortedLogs[0];
    const lastLog = sortedLogs[sortedLogs.length - 1];

    const startTime = dayjs(firstLog.timestamp);
    const endTime = dayjs(lastLog.timestamp);
    const duration = endTime.diff(startTime, 'millisecond');

    // Format duration nicely
    let durationStr;
    if (duration < 1000) {
      durationStr = `${duration}ms`;
    } else if (duration < 60000) {
      durationStr = `${(duration / 1000).toFixed(1)}s`;
    } else {
      durationStr = `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`;
    }

    // Format the description with severity counts and time range
    const severityInfo = Object.entries(severityCounts)
      .map(([level, count]) => `${count} ${level.toLowerCase()}`)
      .join(', ');

    this.description = `(${startTime.format('HH:mm:ss.SSS')} - ${endTime.format('HH:mm:ss.SSS')}, ${durationStr}) [${severityInfo}]`;


    // Determine icon color based on severities present in logs
    if (severityCounts['ERROR'] && severityCounts['ERROR'] > 0) {
      this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.red'));
    } else if (severityCounts['WARNING'] && severityCounts['WARNING'] > 0) {
      this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.yellow'));
    } else if (severityCounts['INFO'] && severityCounts['INFO'] > 0) {
      this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.blue'));
    } else if (severityCounts['DEBUG'] && severityCounts['DEBUG'] > 0) {
      this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('symbol-class');
    }
  }
}

export class LogTreeItem extends vscode.TreeItem {
  private static readonly MAX_MESSAGE_LENGTH = 100;
  private static firstLogTime: number | null = null;
  private static idCounter = 0;  // Keep the counter for unique IDs

  constructor(public readonly log: LogEntry) {
    let fullMessage: string;

    // Handle Axiom trace format
    if (log.axiomSpan) {
      // Use span name as the main message
      const operationName = log.axiomSpan.name || 'Unknown operation';

      // Build extra information from important attributes
      let attributeInfo = '';
      const importantAttrs = [
        'http.method',
        'http.status_code',
        'error',
        'rpc.method',
        'attributes.http.method',
        'attributes.http.status_code',
        'attributes.error.type'
      ];

      for (const attrName of importantAttrs) {
        if (log.axiomSpan[attrName]) {
          attributeInfo += ` [${attrName.replace('attributes.', '')}=${log.axiomSpan[attrName]}]`;
        }
      }

      // Include duration if available
      const duration = log.axiomSpan.duration ? ` (${log.axiomSpan.duration})` : '';

      fullMessage = `${operationName}${duration}${attributeInfo}`;
    }
    // Handle original log format
    else if (log.jsonPayload?.fields) {
      const message = log.jsonPayload.fields.message || '';
      const chain = log.jsonPayload.fields.chain ? `[${log.jsonPayload.fields.chain}] ` : '';
      fullMessage = `${chain}${message}`;
    }
    // Fallback to unified message field or rawText
    else {
      fullMessage = log.message || log.rawText || 'No message';
    }

    const truncatedMessage = LogTreeItem.truncateMessage(fullMessage);
    super(truncatedMessage, vscode.TreeItemCollapsibleState.None);

    // Generate a unique ID by combining available identifiers with a counter
    this.id = log.insertId || `${log.timestamp}_${LogTreeItem.idCounter++}`;

    // Initialize first log time if not set
    if (LogTreeItem.firstLogTime === null) {
      LogTreeItem.firstLogTime = new Date(log.timestamp).getTime();
    }

    // Calculate and format relative time
    const currentLogTime = new Date(log.timestamp).getTime();
    const timeDiff = currentLogTime - LogTreeItem.firstLogTime;

    let relativeTime;
    if (timeDiff === 0) {
      relativeTime = '+0ms';
    } else if (timeDiff < 1000) {
      relativeTime = `+${timeDiff}ms`;
    } else if (timeDiff < 60000) {
      relativeTime = `+${(timeDiff / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(timeDiff / 60000);
      const seconds = ((timeDiff % 60000) / 1000).toFixed(1);
      relativeTime = `+${minutes}m ${seconds}s`;
    }

    this.description = `(${relativeTime})`;

    // Set the icon based on severity
    this.iconPath = this.getIcon(log.severity);

    this.command = {
      command: 'traceback.openLog',
      title: 'Open Log',
      arguments: [log]
    };

    this.contextValue = 'logEntry';
  }

  // Reset both firstLogTime and idCounter when logs are reloaded
  public static resetFirstLogTime(): void {
    LogTreeItem.firstLogTime = null;
    LogTreeItem.idCounter = 0;  // Reset the counter
  }

  private getIcon(level: string): vscode.ThemeIcon {
    switch (level.toUpperCase()) {
      case 'ERROR':
      case 'CRITICAL':
      case 'FATAL':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      case 'WARNING':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      case 'INFO':
        return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.blue'));
      case 'DEBUG':
      case 'TRACE':
        return new vscode.ThemeIcon('debug', new vscode.ThemeColor('charts.green'));
      default:
        return new vscode.ThemeIcon('circle-filled');
    }
  }

  private static truncateMessage(message: string): string {
    if (message.length <= this.MAX_MESSAGE_LENGTH) {
      return message;
    }
    return message.substring(0, this.MAX_MESSAGE_LENGTH - 3) + '...';
  }
}
