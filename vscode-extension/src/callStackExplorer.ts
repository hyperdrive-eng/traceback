import * as vscode from 'vscode';
import { RustLogEntry } from './logExplorer';
import { CallerAnalysis } from './claudeService';
import { ClaudeService } from './claudeService';
import * as path from 'path';
import { logLineDecorationType } from './decorations';

interface LanguageSupport {
  extensionId: string;
  displayName: string;
  symbolProvider?: boolean;  // Whether to use VSCode's symbol provider
  referenceProvider?: boolean;  // Whether to use VSCode's reference provider
}

// Map of supported languages and their required extensions
const SUPPORTED_LANGUAGES: Record<string, LanguageSupport> = {
  'go': {
    extensionId: 'golang.go',
    displayName: 'Go',
    symbolProvider: true,
    referenceProvider: true
  },
  'rust': {
    extensionId: 'rust-lang.rust-analyzer',
    displayName: 'Rust',
    symbolProvider: true,
    referenceProvider: true
  },
  'typescript': {
    extensionId: 'vscode.typescript-language-features',
    displayName: 'TypeScript',
    symbolProvider: true,
    referenceProvider: true
  },
  'javascript': {
    extensionId: 'vscode.typescript-language-features',
    displayName: 'JavaScript',
    symbolProvider: true,
    referenceProvider: true
  },
  'python': {
    extensionId: 'ms-python.python',
    displayName: 'Python',
    symbolProvider: true,
    referenceProvider: true
  },
  'java': {
    extensionId: 'redhat.java',
    displayName: 'Java',
    symbolProvider: true,
    referenceProvider: true
  }
};

interface CallerNode {
  filePath: string;
  lineNumber: number;
  code: string;
  functionName: string;
  confidence: number;
  explanation: string;
  children?: CallerNode[];
  isLoading?: boolean;
}

interface CallStackCache {
  children: CallerNode[];
  lastUpdated: string;
}

/**
 * Helper function to check if a file path is a test file
 */
function isTestPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return normalizedPath.includes('/test/') ||
         normalizedPath.includes('/tests/') ||
         normalizedPath.includes('/__tests__/') ||
         normalizedPath.includes('/__test__/') ||
         normalizedPath.includes('.test.') ||
         normalizedPath.includes('.spec.') ||
         normalizedPath.includes('_test.') ||
         normalizedPath.includes('_spec.');
}

/**
 * TreeItem for call stack entries in the Call Stack Explorer
 */
export class CallStackTreeItem extends vscode.TreeItem {
  constructor(
    public readonly caller: CallerNode,
    public readonly provider: CallStackExplorerProvider,
    public readonly isExpanded: boolean = false
  ) {
    super(
      caller.filePath ? `${path.basename(caller.filePath)}:${caller.lineNumber + 1}` : caller.code,
      caller.isLoading ? vscode.TreeItemCollapsibleState.None : 
        caller.children || isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.description = caller.confidence ? `(${Math.round(caller.confidence * 100)}% confidence)` : '';
    this.iconPath = new vscode.ThemeIcon(
      caller.confidence > 0.7 ? 'debug-stackframe-focused' : 'debug-stackframe'
    );
    
    this.command = {
      command: 'traceback.openCallStackLocation',
      title: 'Open File',
      arguments: [caller, this]
    };

    if (caller.isLoading) {
      this.description = '$(sync~spin) Analyzing...';
    }
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
export class CallStackExplorerProvider implements vscode.TreeDataProvider<CallStackTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CallStackTreeItem | undefined | null | void> = 
    new vscode.EventEmitter<CallStackTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CallStackTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private currentLogEntry: RustLogEntry | undefined;
  private callerAnalysis: CallerNode[] = [];
  private claudeService: ClaudeService = ClaudeService.getInstance();
  private isAnalyzing: boolean = false;
  private callStackCache: Map<string, CallStackCache> = new Map();

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Set the spans for the current log entry and refresh the view
   */
  public setLogEntry(log: RustLogEntry | undefined, isAnalyzing: boolean = false): void {
    this.currentLogEntry = log;
    this.callerAnalysis = [];
    this.isAnalyzing = isAnalyzing;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear the call stack
   */
  public clearCallStack(): void {
    this.callerAnalysis = [];
    this.currentLogEntry = undefined;
    this._onDidChangeTreeData.fire();
  }

  public getCallStackAnalysis(): CallerAnalysis {
    return {
      rankedCallers: this.callerAnalysis.map(caller => ({
        filePath: caller.filePath,
        lineNumber: caller.lineNumber,
        code: caller.code,
        functionName: caller.functionName,
        confidence: caller.confidence,
        explanation: caller.explanation
      }))
    };
  }

  public setCallStackAnalysisFromCache(analysis: CallerNode[]): void {
    // Set the top-level analysis
    this.callerAnalysis = analysis;

    // Recursively load cached children for the entire top-level analysis
    for (const topLevelCaller of this.callerAnalysis) {
      this.loadChildrenFromCacheRecursive(topLevelCaller);
    }

    // Force a full refresh of the tree to show the loaded cache
    this._onDidChangeTreeData.fire(undefined);
  }

  async findPotentialCallers(sourceFile: string, lineNumber: number): Promise<Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>> {
    const potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }> = [];
    
    try {
        // First, get the document
        const document = await vscode.workspace.openTextDocument(sourceFile);
        const languageId = document.languageId;
        console.log('Document language ID:', languageId);

        // Check if language is supported
        const languageSupport = SUPPORTED_LANGUAGES[languageId];
        if (!languageSupport) {
            console.log('Language not supported:', languageId);
            vscode.window.showWarningMessage(`Call stack analysis is not supported for ${languageId} files yet.`);
            return potentialCallers;
        }

        // Check and activate required extension
        const extension = vscode.extensions.getExtension(languageSupport.extensionId);
        if (!extension) {
            console.log(`${languageSupport.displayName} extension not found`);
            vscode.window.showWarningMessage(
                `${languageSupport.displayName} extension (${languageSupport.extensionId}) is not installed. ` +
                `Please install it for better call stack analysis.`
            );
        } else if (!extension.isActive) {
            console.log(`Activating ${languageSupport.displayName} extension...`);
            await extension.activate();
            // Wait for language server to be ready
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Try using language server's symbol provider if available
        let symbols: vscode.DocumentSymbol[] | undefined;
        
        if (languageSupport.symbolProvider) {
            try {
                // Use standard symbol provider
                symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri
                );
                console.log(`${languageSupport.displayName} symbols:`, symbols);
                
                if (!symbols || symbols.length === 0) {
                    // Try workspace symbols as fallback
                    const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                        'vscode.executeWorkspaceSymbolProvider',
                        path.basename(document.uri.fsPath)
                    );
                    console.log(`${languageSupport.displayName} workspace symbols:`, workspaceSymbols);
                    
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
                console.log(`Error getting ${languageSupport.displayName} symbols:`, error);
            }
        }

        // If no symbols found, try generic symbol provider
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

        // If still no symbols found, return current line context
        if (!symbols || symbols.length === 0) {
            console.log('No symbols found for file:', sourceFile);
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
                        symbol.kind === vscode.SymbolKind.Method ||
                        symbol.kind === vscode.SymbolKind.Constructor) {
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

        // Find references to this function/method if the language supports it
        if (languageSupport.referenceProvider) {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                selectionRange.start
            );

            if (locations) {
                for (const location of locations) {
                    // Skip test files
                    if (isTestPath(location.uri.fsPath)) {
                        continue;
                    }

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
    allLogs: RustLogEntry[],
    potentialCallers: Array<{ filePath: string; lineNumber: number; code: string; functionName: string; functionRange?: vscode.Range }>
  ): Promise<void> {
    try {
      this.isAnalyzing = true;
      this._onDidChangeTreeData.fire();
      
      vscode.window.showInformationMessage('Computing call stack analysis...');
      const allLogLines = allLogs.map(log => log.message || '').filter(msg => msg);

      const analysis = await this.claudeService.analyzeCallers(
        currentLogLine,
        staticSearchString,
        allLogLines,
        potentialCallers
      );

      // Convert to CallerNode structure
      this.callerAnalysis = analysis.rankedCallers.map(rc => ({
        filePath: rc.filePath,
        lineNumber: rc.lineNumber,
        code: rc.code,
        functionName: rc.functionName,
        confidence: rc.confidence,
        explanation: rc.explanation
      }));

      vscode.window.showInformationMessage('Call stack analysis complete');
      this.isAnalyzing = false;
      this._onDidChangeTreeData.fire();
    } catch (error) {
      console.error('Error analyzing callers:', error);
      vscode.window.showErrorMessage('Failed to analyze potential callers');
      this.isAnalyzing = false;
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Get the tree item for a given element
   */
  getTreeItem(element: CallStackTreeItem): CallStackTreeItem {
    return element;
  }

  /**
   * Get children for a given element
   */
  async getChildren(element?: CallStackTreeItem): Promise<CallStackTreeItem[]> {
    if (!this.currentLogEntry && !element) {
      return [new CallStackTreeItem({
        filePath: '',
        lineNumber: 0,
        code: 'No log selected',
        functionName: '',
        confidence: 0,
        explanation: ''
      }, this)];
    }

    if (this.isAnalyzing && !element) {
      return [new CallStackTreeItem({
        filePath: '',
        lineNumber: 0,
        code: 'Computing call stack analysis...',
        functionName: '',
        confidence: 0,
        explanation: 'Please wait while we analyze the call stack'
      }, this)];
    }

    if (!element) {
      // Root level - show initial callers
      if (this.callerAnalysis.length === 0) {
        return [new CallStackTreeItem({
          filePath: '',
          lineNumber: 0,
          code: 'No call stack found',
          functionName: '',
          confidence: 0,
          explanation: 'Could not determine the call stack for this log entry'
        }, this)];
      }
      return this.callerAnalysis.map(caller => new CallStackTreeItem(caller, this, true));
    }

    // Return children if they exist
    return (element.caller.children || []).map(child => new CallStackTreeItem(child, this, true));
  }

  public async openCallStackLocation(
    caller: CallerNode,
    treeItem: CallStackTreeItem
  ): Promise<void> {
    try {
      // Open the file and reveal the line
      const document = await vscode.workspace.openTextDocument(caller.filePath);
      const editor = await vscode.window.showTextDocument(document);
      const range = new vscode.Range(
        caller.lineNumber,
        0,
        caller.lineNumber,
        document.lineAt(caller.lineNumber).text.length
      );
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      
      // Apply the yellow highlight decoration
      editor.setDecorations(logLineDecorationType, [range]);

      // If children haven't been analyzed yet, do it now
      if (!caller.children && !caller.isLoading) {
        // Check cache first
        const cacheKey = `${caller.filePath}:${caller.lineNumber}`;
        const cached = this.callStackCache.get(cacheKey);
        
        if (cached) {
          // Use cached results for the immediate children
          caller.children = cached.children;

          // Now, recursively load the children of these children from the cache
          for (const child of caller.children) {
            this.loadChildrenFromCacheRecursive(child);
          }

          // Refresh the specific item that was clicked. Since all descendants
          // are now loaded in the data model, the tree view should render them.
          this._onDidChangeTreeData.fire(treeItem);
          return; // Return after handling cache
        }

        // Mark as loading (only if not cached)
        caller.isLoading = true;
        this._onDidChangeTreeData.fire(treeItem); // Refresh item to show loading state

        vscode.window.showInformationMessage('Finding potential callers...');
        // Find potential callers for this location
        const potentialCallers = await this.findPotentialCallers(
          caller.filePath,
          caller.lineNumber
        );

        if (potentialCallers.length > 0) {
          vscode.window.showInformationMessage('Analyzing call locations...');
          // Get the code content for analysis
          const lineText = document.lineAt(caller.lineNumber).text;
          
          // Analyze callers
          const analysis = await this.claudeService.analyzeCallers(
            lineText,
            lineText,
            [],
            potentialCallers
          );

          // Update the caller's children
          caller.children = analysis.rankedCallers.map(rc => ({
            filePath: rc.filePath,
            lineNumber: rc.lineNumber,
            code: rc.code,
            functionName: rc.functionName,
            confidence: rc.confidence,
            explanation: rc.explanation,
            children: undefined,
            isLoading: false
          }));

          // Cache the results (only the direct children)
          this.callStackCache.set(cacheKey, {
            children: caller.children, // Store only the direct children structure
            lastUpdated: new Date().toISOString()
          });

          vscode.window.showInformationMessage('Call location analysis complete');
        } else {
          caller.children = []; // Empty array to indicate analysis is complete
          
          // Cache empty results too
          this.callStackCache.set(cacheKey, {
            children: [],
            lastUpdated: new Date().toISOString()
          });

          vscode.window.showInformationMessage('No potential callers found');
        }

        // Clear loading state
        caller.isLoading = false;
        this._onDidChangeTreeData.fire(treeItem);
      }
    } catch (error) {
      console.error('Error in openCallStackLocation:', error);
      vscode.window.showErrorMessage('Failed to analyze call stack location');
      
      // Clear loading state on error
      if (caller.isLoading) {
        caller.isLoading = false;
        caller.children = [];
        this._onDidChangeTreeData.fire(treeItem);
      }
    }
  }

  public clearCache(): void {
    this.callStackCache.clear();
  }

  private loadChildrenFromCacheRecursive(node: CallerNode): void {
    // Base case: If the node already has children defined (even an empty array),
    // it means it was either analyzed or already processed by this function.
    if (node.children !== undefined) {
      // Still need to check descendants even if this node's children are loaded
      for (const child of node.children) {
         this.loadChildrenFromCacheRecursive(child);
      }
      return;
    }

    const cacheKey = `${node.filePath}:${node.lineNumber}`;
    const cached = this.callStackCache.get(cacheKey);

    if (cached) {
      // Assign cached children
      node.children = cached.children;
      // Recursively load children for each newly assigned child
      for (const child of node.children) {
        this.loadChildrenFromCacheRecursive(child);
      }
    } else {
      // If not in cache, mark children as undefined so it can be analyzed on demand later
      node.children = undefined;
    }
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