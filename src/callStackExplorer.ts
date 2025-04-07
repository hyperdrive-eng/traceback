import * as vscode from 'vscode';
import { LogEntry, Span, JaegerSpan } from './logExplorer';

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
    if (!this.spans || this.spans.length === 0) {
      return Promise.resolve([
        new vscode.TreeItem('No call stack information available', vscode.TreeItemCollapsibleState.None)
      ]);
    }
    
    if (!element) {
      // Root level - show all spans in the stack
      const items = this.spans.map((span, index) => {
        const item = new CallStackTreeItem(span, index, vscode.TreeItemCollapsibleState.Collapsed);
        // Mark the root span (last element in the reversed array)
        if (index === this.spans.length - 1) {
          item.description = '(root)';
          item.iconPath = new vscode.ThemeIcon('debug-stackframe-dot');
        }
        return item;
      });
      return Promise.resolve(items);
    } else if (element instanceof CallStackTreeItem) {
      // Show details for a span
      const span = element.span;
      return Promise.resolve(
        Object.entries(span)
          .filter(([key]) => key !== 'name') // Skip name as it's already shown in the label
          .map(([key, value]) => 
            new SpanDetailItem(
              key,
              typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
            )
          )
      );
    }
    
    return Promise.resolve([]);
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
    'log-visualizer.copySpanValue',
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