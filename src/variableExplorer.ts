import * as vscode from 'vscode';
import { LogEntry } from './logExplorer';

/**
 * Tree view entry representing a variable
 */
export class VariableItem extends vscode.TreeItem {
  // Make value accessible for tree data provider
  public readonly itemValue: any;
  // Make itemType accessible for tree data provider
  public readonly itemType: string;
  
  constructor(
    public readonly label: string,
    value: any,
    itemType: string = 'variable', 
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    
    // Store value and type as public properties
    this.itemValue = value;
    this.itemType = itemType;
    
    // Set contextValue for context menu and when clause
    this.contextValue = itemType;
    
    // Format the description based on the value type
    this.description = this.formatValueForDisplay(value);
    
    // Set an appropriate icon based on the type
    this.iconPath = this.getIconForType(value);
    
    // Add ability to show variable in editor and also allow copy
    if (itemType === 'property' || itemType === 'variable' || itemType === 'arrayItem') {
      this.command = {
        command: 'traceback.showVariableInEditor',
        title: 'Show Variable in Editor',
        arguments: [label, value],
      };
    } else {
      // Default to copy for non-variable items
      this.command = {
        command: 'traceback.copyVariableValue',
        title: 'Copy Value',
        arguments: [value],
      };
    }
    
    // Set tooltip with extended information
    this.tooltip = `${label}: ${this.description}`;
  }
  
  /**
   * Format a value nicely for display in the tree view
   */
  private formatValueForDisplay(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    
    const type = typeof value;
    
    if (type === 'string') {
      if (value.length > 50) {
        return `"${value.substring(0, 47)}..."`;
      }
      return `"${value}"`;
    }
    
    if (type === 'object') {
      if (Array.isArray(value)) {
        return `Array(${value.length})`;
      }
      return value.constructor.name;
    }
    
    return String(value);
  }
  
  /**
   * Get an appropriate icon for the value type
   */
  private getIconForType(value: any): vscode.ThemeIcon {
    if (value === null || value === undefined) {
      return new vscode.ThemeIcon('circle-outline');
    }
    
    const type = typeof value;
    
    switch (type) {
      case 'string':
        return new vscode.ThemeIcon('symbol-string');
      case 'number':
        return new vscode.ThemeIcon('symbol-number');
      case 'boolean':
        return new vscode.ThemeIcon('symbol-boolean');
      case 'object':
        if (Array.isArray(value)) {
          return new vscode.ThemeIcon('symbol-array');
        }
        return new vscode.ThemeIcon('symbol-object');
      case 'function':
        return new vscode.ThemeIcon('symbol-method');
      default:
        return new vscode.ThemeIcon('symbol-property');
    }
  }
}

/**
 * Tree data provider for the variable explorer
 */
export class VariableExplorerProvider implements vscode.TreeDataProvider<VariableItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<VariableItem | undefined | null | void> = 
    new vscode.EventEmitter<VariableItem | undefined | null | void>();
  
  readonly onDidChangeTreeData: vscode.Event<VariableItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;
  
  private currentLog: LogEntry | undefined;
  private variableDecorator: any; // Will be set from extension.ts
  private isAnalyzing: boolean = false;
  
  constructor(private context: vscode.ExtensionContext) {}
  
  /**
   * Set the current log and refresh the view
   */
  public setLog(log: LogEntry | undefined, isAnalyzing: boolean = false): void {
    this.currentLog = log;
    this.isAnalyzing = isAnalyzing;
    this._onDidChangeTreeData.fire();
  }
  
  /**
   * Get the current log
   */
  public getLog(): LogEntry | undefined {
    return this.currentLog;
  }
  
  /**
   * Set the variable decorator to use
   */
  public setVariableDecorator(decorator: any): void {
    this.variableDecorator = decorator;
  }
  
  /**
   * Show a variable in the editor
   */
  public showVariableInEditor(variableName: string, variableValue: any): void {
    if (this.variableDecorator && this.currentLog) {
      this.variableDecorator.decorateVariable(variableName, variableValue, this.currentLog);
    }
  }
  
  /**
   * Get the TreeItem for a given element
   */
  getTreeItem(element: VariableItem): vscode.TreeItem {
    return element;
  }
  
  /**
   * Get children for a given element
   */
  getChildren(element?: VariableItem): Thenable<VariableItem[]> {
    if (!this.currentLog) {
      // No log selected, show a placeholder
      return Promise.resolve([
        new VariableItem(
          'No log selected',
          'Click on a log in the Log Explorer view',
          'message',
          vscode.TreeItemCollapsibleState.None
        )
      ]);
    }
    
    if (this.isAnalyzing) {
      return Promise.resolve([
        new VariableItem(
          '$(sync~spin) Analyzing variables...',
          'Please wait while we analyze the log',
          'message',
          vscode.TreeItemCollapsibleState.None
        )
      ]);
    }
    
    if (!element) {
      // Root level - show log sections
      const items: VariableItem[] = [];
      
      // Add a header showing the log message
      const headerMessage = this.currentLog.message || 
                            (this.currentLog.jsonPayload?.fields?.message) || 
                            (this.currentLog.jaegerSpan?.operationName) ||
                            'Log Entry';
                            
      items.push(new VariableItem(
        headerMessage,
        `Log from ${new Date(this.currentLog.timestamp).toLocaleString()}`,
        'header',
        vscode.TreeItemCollapsibleState.None
      ));
      
      // Add Claude's inferred variables if available
      if (this.currentLog.claudeAnalysis?.variables) {
        items.push(new VariableItem(
          'Inferred Variables',
          this.currentLog.claudeAnalysis.variables,
          'section',
          vscode.TreeItemCollapsibleState.Expanded
        ));
      }
      
      // Handle Jaeger trace format
      if (this.currentLog.jaegerSpan) {
        // Add span information section
        items.push(new VariableItem(
          'Span',
          this.currentLog.jaegerSpan,
          'section',
          vscode.TreeItemCollapsibleState.Expanded
        ));
        
        // Extract tags into their own section for easier viewing
        if (this.currentLog.jaegerSpan.tags && this.currentLog.jaegerSpan.tags.length > 0) {
          // Convert tags array to an object for easier viewing
          const tagsObject: Record<string, any> = {};
          for (const tag of this.currentLog.jaegerSpan.tags) {
            tagsObject[tag.key] = tag.value;
          }
          
          items.push(new VariableItem(
            'Tags',
            tagsObject,
            'section',
            vscode.TreeItemCollapsibleState.Expanded
          ));
        }
        
        // Extract span logs into their own section
        if (this.currentLog.jaegerSpan.logs && this.currentLog.jaegerSpan.logs.length > 0) {
          items.push(new VariableItem(
            'Span Logs',
            this.currentLog.jaegerSpan.logs,
            'section',
            vscode.TreeItemCollapsibleState.Collapsed
          ));
        }
        
        // Add process information if available
        if (this.currentLog.serviceName) {
          const serviceInfo = {
            name: this.currentLog.serviceName,
            spanId: this.currentLog.jaegerSpan.spanID,
            parentSpanId: this.currentLog.parentSpanID
          };
          
          items.push(new VariableItem(
            'Service',
            serviceInfo,
            'section',
            vscode.TreeItemCollapsibleState.Collapsed
          ));
        }
      }
      // Handle original log format
      else {
        // Add common sections
        
        // Fields section
        const fields = this.currentLog.jsonPayload?.fields;
        if (fields && Object.keys(fields).length > 0) {
          items.push(new VariableItem(
            'Fields',
            fields,
            'Fields', // Use 'Fields' as specific type to filter message in children
            vscode.TreeItemCollapsibleState.Expanded
          ));
        }
        
        // Span information
        if (this.currentLog.jsonPayload?.span) {
          items.push(new VariableItem(
            'Span',
            this.currentLog.jsonPayload.span,
            'section',
            vscode.TreeItemCollapsibleState.Expanded
          ));
        }
        
        // Multiple spans array
        if (this.currentLog.jsonPayload?.spans && this.currentLog.jsonPayload.spans.length > 0) {
          items.push(new VariableItem(
            'Spans',
            this.currentLog.jsonPayload.spans,
            'section',
            vscode.TreeItemCollapsibleState.Collapsed
          ));
        }
        
        // Labels
        if (this.currentLog.labels && Object.keys(this.currentLog.labels).length > 0) {
          items.push(new VariableItem(
            'Labels',
            this.currentLog.labels,
            'section',
            vscode.TreeItemCollapsibleState.Collapsed
          ));
        }
        
        // Resource information
        if (this.currentLog.resource) {
          items.push(new VariableItem(
            'Resource',
            this.currentLog.resource,
            'section',
            vscode.TreeItemCollapsibleState.Collapsed
          ));
        }
      }
      
      // Basic log metadata for all log types
      const metadata: Record<string, any> = {
        severity: this.currentLog.severity,
        timestamp: this.currentLog.timestamp
      };
      
      // Add additional metadata for traditional logs
      if (this.currentLog.insertId) {
        metadata.insertId = this.currentLog.insertId;
      }
      if (this.currentLog.receiveTimestamp) {
        metadata.receiveTimestamp = this.currentLog.receiveTimestamp;
      }
      if (this.currentLog.logName) {
        metadata.logName = this.currentLog.logName;
      }
      
      items.push(new VariableItem(
        'Metadata',
        metadata,
        'section',
        vscode.TreeItemCollapsibleState.Collapsed
      ));
      
      return Promise.resolve(items);
    } else {
      // Child elements - handle different types of values
      const value = element.itemValue;
      
      if (value === null || value === undefined) {
        return Promise.resolve([]);
      }
      
      if (typeof value !== 'object') {
        return Promise.resolve([]);
      }
      
      // Handle arrays
      if (Array.isArray(value)) {
        return Promise.resolve(
          value.map((item, index) => {
            const itemValue = item;
            const isExpandable = typeof itemValue === 'object' && itemValue !== null;
            
            return new VariableItem(
              `[${index}]`,
              itemValue,
              'arrayItem',
              isExpandable 
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
            );
          })
        );
      }
      
      // Handle objects
      return Promise.resolve(
        Object.entries(value)
          .filter(([key, val]) => key !== 'message' || element.itemType !== 'Fields')
          .map(([key, val]) => {
            const isExpandable = typeof val === 'object' && val !== null;
            
            return new VariableItem(
              key,
              val,
              'property',
              isExpandable 
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
            );
          })
      );
    }
  }
}

/**
 * Register the variable explorer view and related commands
 */
export function registerVariableExplorer(context: vscode.ExtensionContext): VariableExplorerProvider {
  // Create the provider
  const variableExplorerProvider = new VariableExplorerProvider(context);
  
  // Register the tree view
  const treeView = vscode.window.createTreeView('logVariableExplorer', {
    treeDataProvider: variableExplorerProvider,
    showCollapseAll: true
  });
  
  // Register a command to copy variable values
  const copyValueCommand = vscode.commands.registerCommand(
    'traceback.copyVariableValue',
    (value: any) => {
      const stringValue = typeof value === 'object' 
        ? JSON.stringify(value, null, 2)
        : String(value);
      
      vscode.env.clipboard.writeText(stringValue);
      vscode.window.showInformationMessage('Value copied to clipboard');
    }
  );
  
  // Register a command to show variable in editor
  const showVariableCommand = vscode.commands.registerCommand(
    'traceback.showVariableInEditor',
    (variableName: string, variableValue: any) => {
      variableExplorerProvider.showVariableInEditor(variableName, variableValue);
    }
  );
  
  // Add to the extension context
  context.subscriptions.push(treeView, copyValueCommand, showVariableCommand);
  
  return variableExplorerProvider;
}