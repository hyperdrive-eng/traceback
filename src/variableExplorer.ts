import * as vscode from 'vscode';
import { RustLogEntry } from './logExplorer';
import { ClaudeService } from './claudeService';
import { VariableDecorator } from './variableDecorator';

/**
 * Tree view entry representing a variable
 */
export class VariableItem extends vscode.TreeItem {
  public buttons?: { 
    iconPath: vscode.ThemeIcon; 
    tooltip: string;
    command?: string | {
      command: string;
      title: string;
      arguments?: any[];
    };
  }[];

  constructor(
    public readonly label: string,
    public readonly itemValue: any,
    public readonly itemType: string = 'variable', 
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    
    // Set contextValue for context menu and when clause
    this.contextValue = itemType;
    
    // Format the description based on the value type
    this.description = this.formatValueForDisplay(itemValue);
    
    // Set an appropriate icon based on the type
    this.iconPath = this.getIconForType(itemValue);
    
    // Add ability to show variable in editor and also allow copy
    if (itemType === 'property' || itemType === 'variable' || itemType === 'arrayItem') {
      this.command = {
        command: 'traceback.showVariableInEditor',
        title: 'Show Variable in Editor',
        arguments: [label, itemValue],
      };
    } else {
      // Default to copy for non-variable items
      this.command = {
        command: 'traceback.copyVariableValue',
        title: 'Copy Value',
        arguments: [itemValue],
      };
    }
    
    // Set tooltip with extended information
    this.tooltip = `${label}: ${this.description}`;
    
    // Set a specific contextValue for items that can be inspected (for context menu)
    if (itemType === 'header' || itemType === 'property' || itemType === 'variable' || 
        itemType === 'arrayItem' || itemType === 'section') {
      this.contextValue = `${itemType}-inspectable`;
      
      // Add eye button for VS Code 1.74.0+ (buttons property is available)
      this.buttons = [
        {
          iconPath: new vscode.ThemeIcon('eye'),
          tooltip: 'Inspect Value',
          command: 'traceback.inspectVariableFromContext'
        }
      ];
    }
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
  private _onDidChangeTreeData: vscode.EventEmitter<VariableItem | undefined | null | void> = new vscode.EventEmitter<VariableItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<VariableItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private currentLog: RustLogEntry | undefined;
  private isAnalyzing: boolean = false;
  private claudeService: ClaudeService = ClaudeService.getInstance();
  private variableDecorator: VariableDecorator | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  public setVariableDecorator(decorator: VariableDecorator): void {
    this.variableDecorator = decorator;
  }

  public setLog(log: RustLogEntry | undefined, isAnalyzing: boolean = false): void {
    this.currentLog = log;
    this.isAnalyzing = isAnalyzing;
    this._onDidChangeTreeData.fire();
  }

  public getLog(): RustLogEntry | undefined {
    return this.currentLog;
  }

  /**
   * Get the TreeItem for a given element
   */
  getTreeItem(element: VariableItem): VariableItem {
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
          'Analyzing variables...',
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
      const headerMessage = this.currentLog.message;
      
      // For the header, we'll use the entire log object for inspection
      const headerItem = new VariableItem(
        headerMessage,
        this.currentLog,
        'header',
        vscode.TreeItemCollapsibleState.None
      );
      
      // Override description to show timestamp
      headerItem.description = `Log from ${new Date(this.currentLog.timestamp).toLocaleString()}`;
      items.push(headerItem);
      
      // Add Claude's inferred variables if available
      if (this.currentLog.claudeAnalysis?.variables) {
        items.push(new VariableItem(
          'Inferred Variables',
          this.currentLog.claudeAnalysis.variables,
          'section',
          vscode.TreeItemCollapsibleState.Expanded
        ));
      }
      
      // Add span fields section
      if (this.currentLog.span_root.fields.length > 0) {
        items.push(new VariableItem(
          'Fields',
          this.currentLog.span_root.fields,
          'section',
          vscode.TreeItemCollapsibleState.Expanded
        ));
      }
      
      // Basic log metadata
      const metadata: Record<string, any> = {
        severity: this.currentLog.level,
        level: this.currentLog.level,
        timestamp: this.currentLog.timestamp
      };
      
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
  
  // Register the tree view with the updated ID
  const treeView = vscode.window.createTreeView('logVariableExplorer', {
    treeDataProvider: variableExplorerProvider,
    showCollapseAll: true
  });
  
  // Since onDidClickTreeItem isn't available in VS Code 1.74, we'll rely on:
  // 1. The context menu for eye icon in the tree
  // 2. Creating a custom event handler for TreeView selection changes
  
  treeView.onDidChangeSelection((e) => {
    // Only handle single selections
    if (e.selection.length === 1) {
      const item = e.selection[0];
      
      // If the item has the inspect context value, consider opening the inspect UI
      // Note: this will be triggered on any tree item selection, which may not be ideal
      // We'll keep this commented out to avoid unexpected behavior
      // 
      // if (item.contextValue && item.contextValue.endsWith('-inspectable')) {
      //   vscode.commands.executeCommand('traceback.inspectVariableValue', item.label, item.itemValue);
      // }
    }
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
  
  // Register a command to inspect variable value
  const inspectVariableCommand = vscode.commands.registerCommand(
    'traceback.inspectVariableValue',
    // Handle both direct args and context cases
    async (variableNameArg?: string, variableValueArg?: any) => {
      let variableName = variableNameArg;
      let variableValue = variableValueArg;
      
      // If no arguments provided or they're undefined, try to find variable from context
      if (variableName === undefined || variableValue === undefined) {
        console.log('Finding variable from context...');
        
        try {
          // Get the currently focused item from the tree view
          const selection = treeView.selection;
          if (selection.length > 0) {
            const selectedItem = selection[0] as VariableItem;
            variableName = selectedItem.label;
            variableValue = selectedItem.itemValue;
            console.log('Using selected item:', { variableName, variableValue });
          } else {
            // No selection - try to get active tree item by querying visible items
            // This is necessary because button clicks might not select the item
            const msg = 'Cannot inspect: Please select a variable first.';
            vscode.window.showInformationMessage(msg);
            return;
          }
        } catch (err) {
          console.error('Error finding variable context:', err);
          vscode.window.showErrorMessage('Error inspecting variable: ' + String(err));
          return;
        }
      }
      
      // Format the value for display with special handling for undefined
      let stringValue = 'undefined';
      
      if (variableValue !== undefined) {
        stringValue = typeof variableValue === 'object' 
          ? JSON.stringify(variableValue, null, 2)
          : String(variableValue);
      }
      
      // For small values, show in an input box
      if (stringValue.length < 1000) {
        const inputBox = vscode.window.createInputBox();
        
        // Create a truncated title (limit to 30 chars)
        const maxTitleLength = 30;
        const truncatedName = variableName.length > maxTitleLength 
          ? variableName.substring(0, maxTitleLength) + '...'
          : variableName;
          
        inputBox.title = `Inspect: ${truncatedName}`;
        inputBox.value = stringValue;
        inputBox.password = false;
        inputBox.ignoreFocusOut = true;
        inputBox.enabled = false; // Make it read-only
        
        // Show the input box
        inputBox.show();
        
        // Hide it when pressing escape
        inputBox.onDidHide(() => inputBox.dispose());
      } else {
        // For larger values, create a temporary webview panel
        // that can be closed with Escape and allows scrolling
        
        // Create a truncated title (limit to 30 chars)
        const maxTitleLength = 30;
        const truncatedName = variableName.length > maxTitleLength 
          ? variableName.substring(0, maxTitleLength) + '...'
          : variableName;
          
        const panel = vscode.window.createWebviewPanel(
          'variableInspect',
          `Inspect: ${truncatedName}`,
          vscode.ViewColumn.Active,
          {
            enableScripts: false,
            retainContextWhenHidden: false
          }
        );
        
        // Style the webview content for readability with scrolling
        panel.webview.html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Variable Inspector</title>
            <style>
              body {
                padding: 10px;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                line-height: 1.5;
                word-wrap: break-word;
                white-space: pre-wrap;
                max-width: 100%;
                overflow-x: auto;
              }
              .value {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                padding: 10px;
                border-radius: 3px;
                overflow-x: auto;
              }
              .escape-hint {
                font-style: italic;
                opacity: 0.8;
                margin-top: 10px;
                font-size: 0.9em;
              }
            </style>
          </head>
          <body>
            <h3>${escapeHtml(variableName)}</h3>
            <div class="value">${escapeHtml(stringValue)}</div>
          </body>
          </html>
        `;
      }
    }
  );
  
  // Helper function to escape HTML characters
  function escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  // Register a command to inspect variable from context menu or button click
  const inspectVariableFromContextCommand = vscode.commands.registerCommand(
    'traceback.inspectVariableFromContext',
    (contextItem?: VariableItem) => {
      // Convert the provided context to VariableItem type if possible
      if (contextItem && contextItem.label && contextItem.itemValue !== undefined) {
        vscode.commands.executeCommand('traceback.inspectVariableValue', contextItem.label, contextItem.itemValue);
        return;
      }
      
      // If no item provided directly, use the currently selected item
      // This handles button clicks where item context isn't passed
      try {
        if (treeView.selection.length > 0) {
          const selectedItem = treeView.selection[0] as VariableItem;
          if (selectedItem && selectedItem.label && selectedItem.itemValue !== undefined) {
            vscode.commands.executeCommand('traceback.inspectVariableValue', 
                                          selectedItem.label, 
                                          selectedItem.itemValue);
            return;
          }
        }
        // If we got here, we couldn't find a valid item to inspect
        vscode.window.showInformationMessage('Please select a variable to inspect');
      } catch (error) {
        console.error('Error inspecting variable:', error);
        vscode.window.showErrorMessage('Error inspecting variable: ' + String(error));
      }
    }
  );
  
  // Add to the extension context
  context.subscriptions.push(
    treeView, 
    copyValueCommand, 
    inspectVariableCommand,
    inspectVariableFromContextCommand
  );
  
  return variableExplorerProvider;
}