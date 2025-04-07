import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import { findCodeLocation, loadLogs } from './processor';
import { logLineDecorationType, variableValueDecorationType, clearDecorations } from './decorations';
import { PinnedLogsProvider } from './pinnedLogsProvider';

// Core interfaces for log structure
export interface Span {
  name: string;
  key_id?: string;
  self?: string;
  [key: string]: any;
}

// Jaeger trace specific interfaces
export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references?: {
    refType: string;
    traceID: string;
    spanID: string;
  }[];
  startTime: number;
  duration: number;
  tags: {
    key: string;
    type: string;
    value: any;
  }[];
  logs: {
    timestamp: number;
    fields: {
      key: string;
      type: string;
      value: any;
    }[];
  }[];
  processID: string;
  warnings: string[] | null;
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: {
    [processID: string]: {
      serviceName: string;
      tags: {
        key: string;
        type: string;
        value: any;
      }[];
    };
  };
  warnings: string[] | null;
}

export interface LogEntry {
  // Common fields for all log types
  severity: string;
  timestamp: string;
  rawText: string;
  
  // Original log format fields
  insertId?: string;
  jsonPayload: {
    fields: {
      message: string;
      chain?: string;
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
  
  // Jaeger trace specific fields
  jaegerSpan?: JaegerSpan;
  
  // Axiom trace specific fields
  axiomSpan?: any; // Using 'any' for flexibility with Axiom's response format
  
  // Common trace fields
  serviceName?: string; // Service name from trace data
  parentSpanID?: string; // Parent span ID
  
  // Unified fields for display purposes
  message?: string;
  target?: string;
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
  private variableExplorerProvider: { setLog: (log: LogEntry | undefined) => void } | undefined;
  private callStackExplorerProvider: { setLogEntry: (log: LogEntry | undefined) => void } | undefined;
  private pinnedLogsProvider: PinnedLogsProvider | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    vscode.commands.registerCommand('log-visualizer.openLog', (log: LogEntry) => this.openLog(log));
    vscode.commands.registerCommand('log-visualizer.toggleSort', () => this.toggleSort());
  }
  
  /**
   * Set the variable explorer provider to update when logs are selected
   */
  public setVariableExplorer(provider: { setLog: (log: LogEntry | undefined) => void }): void {
    this.variableExplorerProvider = provider;
  }
  
  /**
   * Set the call stack explorer provider to update when logs are selected
   */
  public setCallStackExplorer(provider: { setLogEntry: (log: LogEntry | undefined) => void }): void {
    this.callStackExplorerProvider = provider;
  }

  /**
   * Set the pinned logs provider to check pin status
   */
  public setPinnedLogsProvider(provider: PinnedLogsProvider): void {
    this.pinnedLogsProvider = provider;
  }

  refresh(): void {
    this.loadLogs();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      if (this.sortByTime) {
        // Get all logs and sort by timestamp
        const allLogs = Array.from(this.spanMap.values()).flat()
          .filter(log => this.selectedLogLevels.has(log.severity))
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        // Group consecutive logs with same target/span
        const result: vscode.TreeItem[] = [];
        let currentGroup: LogEntry[] = [];
        let currentGroupName: string | null = null;

        allLogs.forEach((log) => {
          const groupName = this.getGroupName(log);
          
          if (groupName === currentGroupName) {
            // Add to current group
            currentGroup.push(log);
          } else {
            // Create group for previous logs if exists
            if (currentGroup.length > 0) {
              result.push(new SpanGroupItem(currentGroupName!, currentGroup, vscode.TreeItemCollapsibleState.Expanded));
            }
            
            // Start new group
            currentGroupName = groupName;
            currentGroup = [log];
          }
        });

        // Handle the last group
        if (currentGroup.length > 0) {
          result.push(new SpanGroupItem(currentGroupName!, currentGroup, vscode.TreeItemCollapsibleState.Expanded));
        }

        return Promise.resolve(result);
      } else {
        // For regular grouping, group by target and span
        const groupedLogs = new Map<string, LogEntry[]>();
        
        Array.from(this.spanMap.values())
          .flat()
          .filter(log => this.selectedLogLevels.has(log.severity))
          .forEach(log => {
            const groupName = this.getGroupName(log);
            if (!groupedLogs.has(groupName)) {
              groupedLogs.set(groupName, []);
            }
            groupedLogs.get(groupName)!.push(log);
          });

        return Promise.resolve(
          Array.from(groupedLogs.entries())
            .map(([groupName, logs]) => new SpanGroupItem(
              groupName,
              logs,
              vscode.TreeItemCollapsibleState.Expanded
            ))
            .sort((a, b) => a.spanName.localeCompare(b.spanName))
        );
      }
    } else if (element instanceof SpanGroupItem) {
      return Promise.resolve(
        element.logs.map(log => new LogTreeItem(
          log,
          this.pinnedLogsProvider?.isPinned(log) ?? false
        ))
      );
    }
    return Promise.resolve([]);
  }

  private getGroupName(log: LogEntry): string {
    // Handle Jaeger trace format
    if (log.jaegerSpan) {
      const serviceName = log.serviceName || 'unknown-service';
      const operationName = log.jaegerSpan.operationName || 'unknown-operation';
      return `${serviceName}::${operationName}`;
    }
    
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

      // Reset first log time before loading new logs
      LogTreeItem.resetFirstLogTime();

      this.logs = await loadLogs(logPath);

      // Group logs by span name
      this.spanMap.clear();
      this.logs.forEach(log => {
        let spanName: string;
        
        if (log.jaegerSpan) {
          // For Jaeger format, use a combination of service and operation name
          const serviceName = log.serviceName || 'unknown';
          const operationName = log.jaegerSpan.operationName || 'unknown';
          spanName = `${serviceName}::${operationName}`;
        } else if (log.jsonPayload?.span) {
          // Original format with span
          spanName = log.jsonPayload.span.name || 'Unknown';
        } else {
          // Fallback for any format
          spanName = log.target || 'Unknown';
        }
        
        if (!this.spanMap.has(spanName)) {
          this.spanMap.set(spanName, []);
        }
        this.spanMap.get(spanName)!.push(log);
      });
    } catch (error) {
      console.error('Error loading logs:', error);
      this.logs = [];
    }
  }

  private async openLog(log: LogEntry): Promise<void> {
    try {
      clearDecorations();

      // Update the variable explorer with the selected log
      if (this.variableExplorerProvider) {
        this.variableExplorerProvider.setLog(log);
      }
      
      // Update the call stack explorer with the selected log
      if (this.callStackExplorerProvider) {
        this.callStackExplorerProvider.setLogEntry(log);
      }

      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) {
        vscode.window.showErrorMessage('Repository root path is not set.');
        return;
      }

      let sourceFile: string | undefined;
      let targetLine = -1;

      // Find source file location using the findCodeLocation function
      const searchResult = await findCodeLocation(log, repoPath);
      if (searchResult) {
        sourceFile = searchResult.file;
        targetLine = searchResult.line;
      }

      // If no result from findCodeLocation, try format-specific approaches
      if (!sourceFile) {
        // For Jaeger format, try to find source based on service name and operation
        if (log.jaegerSpan) {
          // Try to find a source file based on the service name
          const serviceName = log.serviceName || '';
          if (serviceName) {
            // Convert service name to a likely filename pattern
            const normalizedName = serviceName.toLowerCase()
              .replace(/-/g, '_')
              .replace(/\s+/g, '_');
            
            // Search for files that might match this pattern
            try {
              const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(repoPath, `**/${normalizedName}.*`),
                '**/node_modules/**'
              );
              
              if (files.length > 0) {
                sourceFile = path.relative(repoPath, files[0].fsPath);
              }
            } catch (error) {
              console.error('Error searching for service files:', error);
            }
          }
        }
        // For original format with target
        else if (log.jsonPayload?.target) {
          const targetPath = log.jsonPayload.target
            .replace(/::/g, '/')
            .replace(/-/g, '_')
            + '.rs';
          
          try {
            // Look for a file matching the target path
            const files = await vscode.workspace.findFiles(
              new vscode.RelativePattern(repoPath, `**/${targetPath}`),
              '**/node_modules/**'
            );
            
            if (files.length > 0) {
              sourceFile = path.relative(repoPath, files[0].fsPath);
            }
          } catch (error) {
            console.error('Error searching for target files:', error);
          }
        }
      }

      if (!sourceFile) {
        vscode.window.showErrorMessage('Could not determine source file location');
        return;
      }

      const fullPath = path.join(repoPath, sourceFile);

      if (!fs.existsSync(fullPath)) {
        vscode.window.showErrorMessage(`Could not find ${sourceFile} in the repository`);
        return;
      }

      // Open the file
      const document = await vscode.workspace.openTextDocument(fullPath);
      const editor = await vscode.window.showTextDocument(document);

      if (targetLine >= 0) {
        const range = new vscode.Range(targetLine, 0, targetLine, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(logLineDecorationType, [new vscode.Range(targetLine, 0, targetLine, 999)]);

        // Get the line text
        const lineText = document.lineAt(targetLine).text;

        // Create decorations based on the log type
        const decorations: vscode.DecorationOptions[] = [];
        
        if (log.jaegerSpan) {
          // For Jaeger spans, show tag values as decorations
          log.jaegerSpan.tags.forEach(tag => {
            // Use word boundary regex to find the tag key in the line
            const regex = new RegExp(`\\b${tag.key.replace(/\./g, '\\.')}\\b`, 'g');
            let match;
            
            while ((match = regex.exec(lineText)) !== null) {
              const startIndex = match.index;
              const range = new vscode.Range(
                targetLine,
                startIndex,
                targetLine,
                startIndex + tag.key.length
              );
              
              decorations.push({
                range,
                renderOptions: {
                  after: {
                    contentText: ` = ${JSON.stringify(tag.value)}`,
                    fontWeight: 'bold',
                    color: 'var(--vscode-symbolIcon-variableForeground, var(--vscode-editorInfo-foreground))'
                  }
                }
              });
            }
          });
        } 
        // For regular logs, show fields as decorations
        else if (log.jsonPayload?.fields) {
          const fields = log.jsonPayload.fields;
          
          Object.entries(fields).forEach(([name, value]) => {
            if (name !== 'message') {
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
            }
          });
        }

        // Apply all decorations at once
        if (decorations.length > 0) {
          editor.setDecorations(variableValueDecorationType, decorations);
        }
      }
    } catch (error) {
      console.error('Error in openLog:', error);
      vscode.window.showErrorMessage(`Error opening log: ${error}`);
    }
  }

  private toggleSort(): void {
    this.sortByTime = !this.sortByTime;
    vscode.commands.executeCommand('setContext', 'log-visualizer.timeSort', this.sortByTime);
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
    
    // Enhanced tooltip with all details
    this.tooltip = [
      `Group: ${spanName}`,
      '',
      'Time Range:',
      `  Start: ${startTime.format('YYYY-MM-DD HH:mm:ss.SSS')}`,
      `  End: ${endTime.format('YYYY-MM-DD HH:mm:ss.SSS')}`,
      `  Duration: ${durationStr}`,
      '',
      `Total logs: ${logs.length}`,
      'Log levels:',
      ...Object.entries(severityCounts).map(([level, count]) => 
        `  ${level}: ${count}`
      )
    ].join('\n');

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

  constructor(protected log: LogEntry, private isPinned: boolean = false) {
    let fullMessage: string;
    
    // Handle Jaeger trace format
    if (log.jaegerSpan) {
      // Use operationName as the main message
      const operationName = log.jaegerSpan.operationName;
      
      // Extract an event message if available (from log entries)
      let eventMessage = '';
      if (log.jaegerSpan.logs && log.jaegerSpan.logs.length > 0) {
        // Find event field in the first log entry
        const eventField = log.jaegerSpan.logs[0].fields.find(field => field.key === 'event');
        if (eventField) {
          eventMessage = ` - ${eventField.value}`;
        }
      }
      
      // Look for important tags to display
      let tagInfo = '';
      const importantTags = ['http.method', 'http.status_code', 'error', 'rpc.method'];
      for (const tagName of importantTags) {
        const tag = log.jaegerSpan.tags.find(t => t.key === tagName);
        if (tag) {
          tagInfo += ` [${tag.key}=${tag.value}]`;
        }
      }
      
      fullMessage = `${operationName}${eventMessage}${tagInfo}`;
    }
    // Handle Axiom trace format
    else if (log.axiomSpan) {
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
    // Fallback to unified message field
    else {
      fullMessage = log.message || 'No message';
    }
    
    const truncatedMessage = LogTreeItem.truncateMessage(fullMessage);

    // Add pin icon to the label if pinned
    super(truncatedMessage, vscode.TreeItemCollapsibleState.None);
    
    // Initialize first log time if not set
    if (LogTreeItem.firstLogTime === null) {
      LogTreeItem.firstLogTime = new Date(log.timestamp).getTime();
    }

    // Calculate relative time
    const currentLogTime = new Date(log.timestamp).getTime();
    const timeDiff = currentLogTime - LogTreeItem.firstLogTime;
    
    // Format relative time
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
    
    // Set contextValue for pin/unpin menu visibility
    this.contextValue = isPinned ? 'pinned' : 'unpinned';

    // Set the icon based on severity
    this.iconPath = this.getIcon(log.severity);

    // Create tooltip with details
    let location: string;
    if (log.jaegerSpan) {
      location = log.serviceName || 'Unknown service';
    } else {
      location = log.jsonPayload?.target || log.target || 'Unknown';
    }
    
    const tooltipDetails = [
      `Time: ${new Date(log.timestamp).toLocaleString()}`,
      `Level: ${log.severity}`,
      `Location: ${location}`,
      '',
      isPinned ? 'Click to unpin' : 'Click to pin'
    ];
    
    const tooltip = new vscode.MarkdownString(tooltipDetails.join('\n\n'));
    tooltip.isTrusted = true;
    this.tooltip = tooltip;
    
    this.command = {
      command: 'log-visualizer.openLog',
      title: 'Open Log',
      arguments: [log],
    };
  }

  // Reset first log time when logs are reloaded
  public static resetFirstLogTime(): void {
    LogTreeItem.firstLogTime = null;
  }

  private getIcon(level: string): vscode.ThemeIcon {
    switch (level) {
      case 'INFO':
        return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.blue'));
      case 'WARNING':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      case 'ERROR':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      case 'DEBUG':
        return new vscode.ThemeIcon('debug', new vscode.ThemeColor('charts.green'));
      default:
        return new vscode.ThemeIcon('symbol-text', new vscode.ThemeColor('terminal.ansiWhite'));
    }
  }

  // Getter for the log entry
  public getLogEntry(): LogEntry {
    return this.log;
  }

  // Getter for pin status
  public isPinnedLog(): boolean {
    return this.isPinned;
  }

  private static truncateMessage(message: string): string {
    if (message.length <= this.MAX_MESSAGE_LENGTH) {
      return message;
    }
    return message.substring(0, this.MAX_MESSAGE_LENGTH - 3) + '...';
  }
}
