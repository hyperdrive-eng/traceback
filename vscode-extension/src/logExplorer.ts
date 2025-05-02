import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import { loadLogs } from './processor';
import { logLineDecorationType, variableValueDecorationType, clearDecorations } from './decorations';
import { CallerAnalysis, ClaudeService, LLMLogAnalysis } from './claudeService';

// Base interface for all log entries
export interface BaseLogEntry {
  // Cache fields for IDE features
  codeLocationCache?: {
    file: string;
    line: number;
    lastUpdated: string;
  };
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
  claudeAnalysis?: {
    staticSearchString: string;
    variables: Record<string, any>;
  };
  // Original raw text that was parsed
  rawText: string;
}

// Rust-specific span field
export interface RustSpanField {
    name: string;
    value: string;
}

// Rust-specific span
export interface RustSpan {
    name: string;
    fields: RustSpanField[];
  child?: RustSpan;
}

// Rust-specific log entry
export interface RustLogEntry extends BaseLogEntry {
    // Core fields
    timestamp: string;
    level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    message: string;
    target?: string;  // Optional target field for module/crate name
    
    // Span information
    span_root: RustSpan;
    source_location?: {
        file: string;
        line: number;
    };
}

export interface Span {
  name: string;
  key_id?: string;
  self?: string;
  [key: string]: any;
}

export class LogExplorerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private logs: RustLogEntry[] = [];
  private spanMap: Map<string, RustLogEntry[]> = new Map();
  private context: vscode.ExtensionContext;
  private currentDecorations: vscode.TextEditorDecorationType[] = [];
  private sortByTime: boolean = true;
  private selectedLogLevels: Set<string> = new Set(['INFO', 'DEBUG', 'WARN', 'ERROR']);
  private variableExplorerProvider: { setLog: (log: RustLogEntry | undefined, isAnalyzing?: boolean) => void } | undefined;
  private callStackExplorerProvider: {
    setLogEntry: (log: RustLogEntry | undefined, isAnalyzing?: boolean) => void,
    findPotentialCallers: (sourceFile: string, lineNumber: number) => Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>>,
    analyzeCallers: (currentLogLine: string, staticSearchString: string, allLogs: RustLogEntry[], potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>) => Promise<void>,
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
  private claudeService: ClaudeService = ClaudeService.getInstance();
  private _currentSpanFilter: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    vscode.commands.registerCommand('traceback.openLog', (log: RustLogEntry) => this.openLog(log));
    vscode.commands.registerCommand('traceback.toggleSort', () => this.toggleSort());
    vscode.commands.registerCommand('traceback.importLogs', () => this.importLogs());
    vscode.commands.registerCommand('traceback.pasteLogs', () => this.pasteLogs());

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
  public setVariableExplorer(provider: { setLog: (log: RustLogEntry | undefined, isAnalyzing?: boolean) => void }): void {
    this.variableExplorerProvider = provider;
  }

  /**
   * Set the call stack explorer provider to update when logs are selected
   */
  public setCallStackExplorer(provider: {
    setLogEntry: (log: RustLogEntry | undefined, isAnalyzing?: boolean) => void,
    findPotentialCallers: (sourceFile: string, lineNumber: number) => Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>>,
    analyzeCallers: (currentLogLine: string, staticSearchString: string, allLogs: RustLogEntry[], potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>) => Promise<void>,
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

    // Clear span filter
    this._currentSpanFilter = null;

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
      // Get all logs and sort by timestamp
      let allLogs = Array.from(this.spanMap.values())
        .flat()
        .filter(log => this.selectedLogLevels.has(log.level.toUpperCase()));

      // Apply span filter if set
      if (this._currentSpanFilter) {
        allLogs = allLogs.filter(log => {
          let currentSpan = log.span_root;
          while (currentSpan) {
            if (currentSpan.name === this._currentSpanFilter) {
              return true;
            }
            if (!currentSpan.child) break;
            currentSpan = currentSpan.child;
          }
          return false;
        });
      }

      // Sort by timestamp (most recent first)
      allLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Group only consecutive logs from the same span
      const result: vscode.TreeItem[] = [];
      let currentGroup: RustLogEntry[] = [];
      let currentSpanName: string | null = null;

      allLogs.forEach((log) => {
        const spanName = this.getSpanHierarchyName(log);

        if (spanName === currentSpanName) {
          currentGroup.push(log);
        } else {
          // Add the previous group if it exists
          if (currentGroup.length > 0) {
            if (currentGroup.length === 1) {
              result.push(new LogTreeItem(currentGroup[0]));
            } else {
              result.push(new SpanGroupItem(
                currentSpanName!,
                currentGroup,
                vscode.TreeItemCollapsibleState.Expanded
              ));
            }
          }

          // Start a new group
          currentSpanName = spanName;
          currentGroup = [log];
        }
      });

      // Handle the last group
      if (currentGroup.length > 0) {
        if (currentGroup.length === 1) {
          result.push(new LogTreeItem(currentGroup[0]));
        } else {
          result.push(new SpanGroupItem(
            currentSpanName!,
            currentGroup,
            vscode.TreeItemCollapsibleState.Expanded
          ));
        }
      }

      return Promise.resolve(result);
    } else if (element instanceof SpanGroupItem) {
      return Promise.resolve(
        element.logs
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .map(log => new LogTreeItem(log))
      );
    }
    return Promise.resolve([]);
  }

  private getSpanHierarchyName(log: RustLogEntry): string {
    // Build the full span hierarchy name
    let spanHierarchy = '';
    let currentSpan: RustSpan | undefined = log.span_root;
    while (currentSpan) {
      spanHierarchy += (spanHierarchy ? ' → ' : '') + currentSpan.name;
      currentSpan = currentSpan.child;
    }
    return spanHierarchy;
  }

  private async loadLogs(): Promise<void> {
    try {
      const logContent = this.context.globalState.get<string>('logContent');
      if (!logContent) {
        return;
      }

      // Reset first log time and ID counter before loading new logs
      LogTreeItem.resetFirstLogTime();

      // Clear existing logs and span map
      this.logs = [];
      this.spanMap.clear();

      // Load new logs
      this.logs = await loadLogs(logContent);

      // Clear all caches from loaded logs
      this.logs.forEach(log => {
        log.codeLocationCache = undefined;
        log.callStackCache = undefined;
        log.claudeAnalysis = undefined;
      });

      // Group logs by span hierarchy
      this.spanMap.clear();

      this.logs.forEach(log => {
        const spanName = this.getSpanHierarchyName(log);
        if (!this.spanMap.has(spanName)) {
          this.spanMap.set(spanName, []);
        }
        this.spanMap.get(spanName)!.push(log);
      });
    } catch (error) {
      console.error('Error loading logs:', error);
      this.logs = [];
      this.spanMap.clear();
    }
  }

  /**
   * Import logs from a file
   */
  private async importLogs(): Promise<void> {
    try {
      const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'Log Files': ['log', 'txt'],
          'All Files': ['*']
        }
      });

      if (!fileUris || fileUris.length === 0) {
        return;
      }

      const content = await fs.promises.readFile(fileUris[0].fsPath, 'utf8');
      await this.context.globalState.update('logContent', content);
      this.refresh();
      vscode.window.showInformationMessage('Logs imported successfully');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to import logs: ${error}`);
    }
  }

  /**
   * Import logs from clipboard
   */
  private async pasteLogs(): Promise<void> {
    try {
      const content = await vscode.env.clipboard.readText();
      if (!content) {
        vscode.window.showWarningMessage('No content in clipboard');
        return;
      }

      await this.context.globalState.update('logContent', content);
      this.refresh();
      vscode.window.showInformationMessage('Logs pasted successfully');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to paste logs: ${error}`);
    }
  }

  private async openLog(log: RustLogEntry): Promise<void> {
    console.log('openLog called with:', log);

    // Clear previous decorations
    clearDecorations();

    try {
      // Get repository root path early as we need it for both paths
      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) {
        vscode.window.showErrorMessage('Repository root path is not set.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Analyzing log...',
        cancellable: false
      }, async (progress) => {
        // Update the variable and call stack explorers with the selected log
        if (this.variableExplorerProvider) {
          this.variableExplorerProvider.setLog(log, true);
        }
        if (this.callStackExplorerProvider) {
          this.callStackExplorerProvider.setLogEntry(log, true);
        }

        // Get the log message for analysis
        const logMessage = log.message;

        // Analyze the log with Claude
        progress.report({ message: 'Analyzing log message...' });
        const analysis = await this.claudeService.analyzeLog(logMessage, 'Rust');

        // Update variable explorer with analysis results
        if (this.variableExplorerProvider) {
          this.variableExplorerProvider.setLog(log);
        }

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
  private async startBackgroundAnalysis(log: RustLogEntry, sourceFile: string, lineNumber: number): Promise<void> {
    try {
      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) return;

      if (!log.message) {
        throw new Error('Log message is not set');
      }

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
    log: RustLogEntry,
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
  private async findSourceLocation(log: RustLogEntry, analysis: any, repoPath: string): Promise<{ file: string, line: number, lastUpdated: string }> {
    // Get the static search string from Claude analysis
    const searchString = analysis?.staticSearchString;
    if (!searchString) {
        throw new Error('Could not determine search string from log');
    }
    console.log(`Searching for exact string: "${searchString}"`);

    // Search only in Rust files
    const searchResults = await vscode.workspace.findFiles(
        '**/src/**/*.rs',  // Only search in Rust files
        '**/target/**'      // Exclude target directory
    );

    let matches: Array<{ file: string, line: number }> = [];
    let searchAttempted = `"${searchString}"`; // Keep track for error message

    // --- Initial Search --- 
    for (const file of searchResults) {
        const relativePath = path.relative(repoPath, file.fsPath);
        const content = await vscode.workspace.fs.readFile(file);
        const lines = Buffer.from(content).toString('utf8').split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes(searchString)) {
                console.log(`Found initial match in ${relativePath}:${i}`);
                matches.push({
                    file: relativePath,
                    line: i,
                });
            }
        }
    }

    // --- Fallback Search with Variants --- 
    if (matches.length === 0) {
        console.log(`Initial search for "${searchString}" failed. Trying variants...`);
        const variants = this.generateSearchVariants(searchString);
        searchAttempted = `"${searchString}" or its variants`;

        if (variants.length > 0) {
            console.log('Generated variants:', variants);
            for (const file of searchResults) {
                const relativePath = path.relative(repoPath, file.fsPath);
                // Re-read file content or cache it? Re-reading is simpler for now.
                const content = await vscode.workspace.fs.readFile(file);
                const lines = Buffer.from(content).toString('utf8').split('\n');
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Check if this line already matched the original string (shouldn't happen if matches.length === 0, but safety check)
                    if (matches.some(m => m.file === relativePath && m.line === i)) continue;

                    for (const variant of variants) {
                        if (line.includes(variant)) {
                            console.log(`Found variant "${variant}" in ${relativePath}:${i}`);
                            matches.push({
                                file: relativePath,
                                line: i,
                            });
                            // Found a match for this line, no need to check other variants for it
                            break; 
                        }
                    }
                }
            }
        } else {
            console.log('No variants generated.');
        }
    }

    // --- Process Matches --- 
    if (matches.length === 0) {
        throw new Error(`Could not find source location for ${searchAttempted}`);
    }

    // Prioritize matches where the file path contains the log target, if available
    if (log.target) {
      const targetLower = log.target.toLowerCase();
      const prioritizedMatch = matches.find(match => 
        match.file.toLowerCase().includes(targetLower)
      );
      if (prioritizedMatch) {
        console.log(`Prioritized match found in ${prioritizedMatch.file} based on target "${log.target}"`);
        return {
            file: prioritizedMatch.file,
            line: prioritizedMatch.line,
            lastUpdated: new Date().toISOString()
        };
      } else {
        console.log(`No match found containing target "${log.target}". Using first overall match.`);
      }
    } else {
        console.log(`No log target provided. Using first overall match.`);
    }

    // If no target-based prioritization or no target, return the first match found
    const firstMatch = matches[0];
    return {
        file: firstMatch.file,
        line: firstMatch.line,
        lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Generates variations of a search string by removing words from the start and end.
   */
  private generateSearchVariants(searchString: string): string[] {
    const words = searchString.trim().split(/\s+/);
    const variants = new Set<string>();

    if (words.length > 1) {
      // Remove first word
      variants.add(words.slice(1).join(' '));
      // Remove last word
      variants.add(words.slice(0, -1).join(' '));
    }
    if (words.length > 2) {
      // Remove first two words
      variants.add(words.slice(2).join(' '));
      // Remove last two words
      variants.add(words.slice(0, -2).join(' '));
    }
    if (words.length > 3) {
      // Remove first and last word
      variants.add(words.slice(1, -1).join(' '));
    }

    // Return unique, non-empty variants
    return Array.from(variants).filter(v => v.length > 0);
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
  private filterLogsByLevel(logs: RustLogEntry[]): RustLogEntry[] {
    return logs.filter(log =>
      this.selectedLogLevels.has(log.level)
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

  /**
   * Get the current logs
   */
  public getLogs(): RustLogEntry[] {
    return Array.from(this.spanMap.values()).flat();
  }

  public filterBySpan(spanName: string | null) {
    this._currentSpanFilter = spanName;
    this._onDidChangeTreeData.fire();
  }
}

export class SpanGroupItem extends vscode.TreeItem {
  constructor(
    public readonly spanName: string,
    public readonly logs: RustLogEntry[],
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(
      spanName,
      collapsibleState
    );

    // Count logs by severity
    const severityCounts = logs.reduce((acc, log) => {
      const severity = log.level;
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
  private static idCounter = 0;

  constructor(public readonly log: RustLogEntry) {
    // Use the message directly
    const truncatedMessage = LogTreeItem.truncateMessage(log.message);
    super(truncatedMessage, vscode.TreeItemCollapsibleState.None);

    // Generate a unique ID using timestamp and counter
    this.id = `${log.timestamp}_${LogTreeItem.idCounter++}`;

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

    // Format span information
    let spanInfo = '';
    let currentSpan: RustSpan | undefined = log.span_root;
    while (currentSpan) {
      if (currentSpan.fields.length > 0) {
        const fieldInfo = currentSpan.fields
          .map(f => `${f.name}=${f.value}`)
          .join(', ');
        spanInfo += `${spanInfo ? ' → ' : ''}${currentSpan.name}(${fieldInfo})`;
      } else {
        spanInfo += `${spanInfo ? ' → ' : ''}${currentSpan.name}`;
      }
      currentSpan = currentSpan.child;
    }

    this.description = `(${relativeTime}) [${spanInfo}]`;

    // Set the icon based on severity
    this.iconPath = this.getIcon(log.level);

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
    LogTreeItem.idCounter = 0;
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
