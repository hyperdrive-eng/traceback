import * as vscode from 'vscode';
import { LogEntry, Span, JaegerSpan } from './logExplorer';
import { CallerAnalysis } from './claudeService';
import { ClaudeService } from './claudeService';
import * as path from 'path';

/**
 * TreeItem for call stack entries in the Call Stack Explorer
 */
export class CallStackTreeItem extends vscode.TreeItem {
  constructor(
    public readonly span: Span,
    public readonly index: number,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    // Use span name as the primary label
    super(span.name, collapsibleState);

    // Mark as root when appropriate
    this.description = '';

    // All spans are shown with standard stack frame icon
    this.iconPath = new vscode.ThemeIcon('debug-stackframe');

    // Tooltip with all span properties
    this.tooltip = Object.entries(span)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`)
      .join('\n');

    // Set context for menu contributions
    this.contextValue = index === 0 ? 'rootSpan' : 'span';
  }
}

/**
 * Detail item for showing properties of a span
 */
export class SpanDetailItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly value: string,
    public readonly contextValue: string = 'spanDetail'
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = value;

    // Set icon based on property type
    this.iconPath = new vscode.ThemeIcon('symbol-property');
  }
}

/**
 * Tree data provider for the Call Stack Explorer view
 */
export class CallStackExplorerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private spans: Span[] = [];
  private currentLogEntry: LogEntry | undefined;
  private callerAnalysis: CallerAnalysis = { rankedCallers: [] };
  private claudeService: ClaudeService = ClaudeService.getInstance();

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Set the spans for the current log entry and refresh the view
   */
  public setLogEntry(logEntry: LogEntry | undefined): void {
    this.currentLogEntry = logEntry;

    // Reset spans
    this.spans = [];

    if (logEntry) {
      // Case 1: Handle Jaeger spans
      if (logEntry.jaegerSpan) {
        // Build call stack from the references
        const spanId = logEntry.jaegerSpan.spanID;
        const parentSpanID = logEntry.parentSpanID;

        // Start with the current span
        const currentSpan: Span = {
          name: logEntry.jaegerSpan.operationName,
          span_id: spanId,
          parent_id: parentSpanID,
          service: logEntry.serviceName
        };

        // Add any additional properties from tags
        logEntry.jaegerSpan.tags.forEach(tag => {
          currentSpan[tag.key] = tag.value;
        });

        this.spans.push(currentSpan);

        // If we have a parent relation, add a parent span too
        if (parentSpanID) {
          const parentSpan: Span = {
            name: 'Parent Span',
            span_id: parentSpanID,
            service: logEntry.serviceName // Assume same service
          };

          this.spans.push(parentSpan);
        }
      }
      // Case 2: Regular spans from jsonPayload
      else if (logEntry.jsonPayload?.spans && logEntry.jsonPayload.spans.length > 0) {
        // Reverse the spans so the stack shows in correct order (root at top, current at bottom)
        this.spans = [...logEntry.jsonPayload.spans].reverse();
      }
    }

    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear the call stack
   */
  public clearCallStack(): void {
    this.spans = [];
    this.currentLogEntry = undefined;
    this._onDidChangeTreeData.fire();
  }

  async findPotentialCallers(sourceFile: string, lineNumber: number): Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>> {
    const potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }> = [];
    
    try {
        // First, get the document
        const document = await vscode.workspace.openTextDocument(sourceFile);
        console.log('Document language ID:', document.languageId);

        // For Go files, ensure Go extension is installed and language server is ready
        if (document.languageId === 'go') {
            const goExtension = vscode.extensions.getExtension('golang.go');
            if (!goExtension) {
                console.log('Go extension not found');
                vscode.window.showWarningMessage('Go extension is not installed. Some features may not work properly.');
            } else if (!goExtension.isActive) {
                console.log('Activating Go extension...');
                await goExtension.activate();
            }

            // Wait for Go language server to be ready
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // For Go files, try using the Go-specific symbol provider first
        let symbols: vscode.DocumentSymbol[] | undefined;
        
        if (document.languageId === 'go') {
            try {
                // Use standard Go symbol provider instead of test-specific commands
                symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri
                );
                console.log('Go symbols:', symbols);
                
                if (!symbols || symbols.length === 0) {
                    // Try workspace symbols as fallback
                    const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                        'vscode.executeWorkspaceSymbolProvider',
                        path.basename(document.uri.fsPath)
                    );
                    console.log('Go workspace symbols:', workspaceSymbols);
                    
                    if (workspaceSymbols) {
                        symbols = workspaceSymbols.map(s => ({
                            name: s.name,
                            detail: '',
                            kind: s.kind,
                            range: s.location.range,
                            selectionRange: s.location.range,
                            children: []
                        }));
                    }
                }
            } catch (error) {
                console.log('Error getting Go symbols:', error);
            }
        }

        // If no Go-specific symbols found, try generic symbol provider
        if (!symbols || symbols.length === 0) {
            symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            console.log('Generic document symbols:', symbols);
        }

        // If still no symbols, try workspace symbols
        if (!symbols || symbols.length === 0) {
            const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                path.basename(sourceFile)
            );
            console.log('Workspace symbols:', workspaceSymbols);

            if (workspaceSymbols) {
                const fileSymbols = workspaceSymbols.filter(s => 
                    s.location.uri.fsPath === document.uri.fsPath
                );
                symbols = fileSymbols.map(s => ({
                    name: s.name,
                    detail: '',
                    kind: s.kind,
                    range: s.location.range,
                    selectionRange: s.location.range,
                    children: []
                }));
            }
        }

        // If still no symbols, try parsing the file content
        if (!symbols || symbols.length === 0) {
            console.log('No symbols found, attempting manual parse');
            const text = document.getText();
            const lines = text.split('\n');

            // Enhanced Go function detection
            const functionMatches: Array<{ name: string; startLine: number; endLine: number }> = [];
            let bracketCount = 0;
            let currentFunction: { name: string; startLine: number; endLine: number } | undefined;

            const goFuncPattern = /^func\s+(\w+|\(\w+\s+\*?\w+\)\s+\w+)\s*\(/;
            const goMethodPattern = /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Count brackets to track function boundaries
                bracketCount += (line.match(/{/g) || []).length;
                bracketCount -= (line.match(/}/g) || []).length;

                const funcMatch = line.match(goFuncPattern);
                if (funcMatch) {
                    let funcName = funcMatch[1];
                    // If it's a method, extract just the method name
                    const methodMatch = line.match(goMethodPattern);
                    if (methodMatch) {
                        funcName = methodMatch[1];
                    }

                    currentFunction = {
                        name: funcName,
                        startLine: i,
                        endLine: -1
                    };
                    functionMatches.push(currentFunction);
                }

                // When brackets balance and we have a current function, close it
                if (bracketCount === 0 && currentFunction && currentFunction.endLine === -1) {
                    currentFunction.endLine = i;
                }
            }

            // Find the function containing our line
            const containingFunction = functionMatches.find(f => 
                f.startLine <= lineNumber && 
                (f.endLine === -1 || f.endLine >= lineNumber)
            );

            if (containingFunction) {
                symbols = [{
                    name: containingFunction.name,
                    detail: '',
                    kind: vscode.SymbolKind.Function,
                    range: new vscode.Range(
                        containingFunction.startLine, 0,
                        containingFunction.endLine === -1 ? lines.length - 1 : containingFunction.endLine, 0
                    ),
                    selectionRange: new vscode.Range(
                        containingFunction.startLine, 0,
                        containingFunction.startLine, lines[containingFunction.startLine].length
                    ),
                    children: []
                }];
            }
        }

        if (!symbols || symbols.length === 0) {
            console.log('No symbols found for file:', sourceFile);
            // If we still can't find symbols, at least return the current line context
            potentialCallers.push({
                filePath: sourceFile,
                lineNumber: lineNumber,
                code: document.lineAt(lineNumber).text.trim(),
                functionName: 'unknown'
            });
            return potentialCallers;
        }

        // Helper function to find the enclosing symbol
        function findEnclosingSymbol(symbols: vscode.DocumentSymbol[], line: number): vscode.DocumentSymbol | undefined {
            for (const symbol of symbols) {
                if (symbol.range.contains(new vscode.Position(line, 0))) {
                    // Check children first for more specific matches
                    if (symbol.children.length > 0) {
                        const childMatch = findEnclosingSymbol(symbol.children, line);
                        if (childMatch) {
                            return childMatch;
                        }
                    }
                    // If no child contains the line, but this symbol does, return this symbol
                    if (symbol.kind === vscode.SymbolKind.Function ||
                        symbol.kind === vscode.SymbolKind.Method) {
                        return symbol;
                    }
                }
            }
            return undefined;
        }

        // Find the enclosing function/method
        const enclosingSymbol = findEnclosingSymbol(symbols, lineNumber);

        if (!enclosingSymbol) {
            console.log('No enclosing function/method found');
            return potentialCallers;
        }

        // Get the selection range for the function name
        const selectionRange = enclosingSymbol.selectionRange;

        // Find references to this function/method
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            selectionRange.start
        );

        if (locations) {
            for (const location of locations) {
                // Skip self-references (the function definition itself)
                if (location.uri.fsPath === sourceFile &&
                    location.range.start.line === selectionRange.start.line) {
                    continue;
                }

                const callerDoc = await vscode.workspace.openTextDocument(location.uri);

                // Get the enclosing function of the reference
                const callerSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    location.uri
                );

                const callerEnclosingSymbol = callerSymbols ?
                    findEnclosingSymbol(callerSymbols, location.range.start.line) :
                    undefined;

                // Get some context around the calling line
                const startLine = Math.max(0, location.range.start.line - 1);
                const endLine = Math.min(callerDoc.lineCount - 1, location.range.start.line + 1);
                const contextLines = [];
                for (let i = startLine; i <= endLine; i++) {
                    contextLines.push(callerDoc.lineAt(i).text.trim());
                }

                potentialCallers.push({
                    filePath: location.uri.fsPath,
                    lineNumber: location.range.start.line,
                    code: contextLines.join('\n'),
                    functionName: callerEnclosingSymbol?.name || 'unknown',
                    functionRange: callerEnclosingSymbol?.range
                });
            }
        }

        // If we found no references but have an enclosing function,
        // at least return that as a potential location
        if (potentialCallers.length === 0) {
            potentialCallers.push({
                filePath: sourceFile,
                lineNumber: enclosingSymbol.range.start.line,
                code: document.lineAt(enclosingSymbol.range.start.line).text.trim(),
                functionName: enclosingSymbol.name,
                functionRange: enclosingSymbol.range
            });
        }

    } catch (error) {
        console.error('Error finding potential callers:', error);
        console.error('Stack:', error instanceof Error ? error.stack : '');
    }

    return potentialCallers;
  }

  async analyzeCallers(
    currentLogLine: string,
    staticSearchString: string,
    allLogs: LogEntry[],
    potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>
  ): Promise<void> {
    try {
      const allLogLines = allLogs.map(log =>
        log.message ||
        log.jsonPayload?.fields?.message ||
        log.jaegerSpan?.operationName ||
        ''
      ).filter(msg => msg);

      this.callerAnalysis = await this.claudeService.analyzeCallers(
        currentLogLine,
        staticSearchString,
        allLogLines,
        potentialCallers
      );

      this._onDidChangeTreeData.fire();
    } catch (error) {
      console.error('Error analyzing callers:', error);
      vscode.window.showErrorMessage('Failed to analyze potential callers');
    }
  }

  /**
   * Get the tree item for a given element
   */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a given element
   */
  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!this.currentLogEntry) {
      return Promise.resolve([
        new vscode.TreeItem('No log selected', vscode.TreeItemCollapsibleState.None)
      ]);
    }

    if (!element) {
      const items: vscode.TreeItem[] = [];

      if (this.callerAnalysis?.rankedCallers.length) {
        items.push(...this.callerAnalysis.rankedCallers.map(caller => {
          const item = new vscode.TreeItem(
            `${path.basename(caller.filePath)}:${caller.lineNumber}`,
            vscode.TreeItemCollapsibleState.Expanded
          );
          item.description = `(${Math.round(caller.confidence * 100)}% confidence)`;
          item.tooltip = caller.explanation;
          item.iconPath = new vscode.ThemeIcon(
            caller.confidence > 0.7 ? 'debug-stackframe-focused' : 'debug-stackframe'
          );
          item.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [
              vscode.Uri.file(caller.filePath),
              { selection: new vscode.Range(caller.lineNumber, 0, caller.lineNumber, 0) }
            ]
          };
          return item;
        }));
      }

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  // Add method to get current analysis
  public getCallStackAnalysis() {
    return this.callerAnalysis;
  }

  // Add method to set analysis from cache
  public setCallStackAnalysisFromCache(rankedCallers: Array<{
    filePath: string;
    lineNumber: number;
    code: string;
    functionName: string;
    confidence: number;
    explanation: string;
  }>) {
    this.callerAnalysis = {
      rankedCallers
    };
    this._onDidChangeTreeData.fire();
  }
}

/**
 * Register the Call Stack Explorer view and related commands
 */
export function registerCallStackExplorer(context: vscode.ExtensionContext): CallStackExplorerProvider {
  // Create the provider
  const callStackExplorerProvider = new CallStackExplorerProvider(context);

  // Register the tree view
  const treeView = vscode.window.createTreeView('callStackExplorer', {
    treeDataProvider: callStackExplorerProvider,
    showCollapseAll: true
  });

  // Register command to copy span property value
  const copySpanValueCommand = vscode.commands.registerCommand(
    'traceback.copySpanValue',
    (item: SpanDetailItem) => {
      vscode.env.clipboard.writeText(item.value);
      vscode.window.showInformationMessage('Value copied to clipboard');
    }
  );

  // Add to the extension context
  context.subscriptions.push(
    treeView,
    copySpanValueCommand
  );

  return callStackExplorerProvider;
}