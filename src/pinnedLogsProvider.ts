import * as vscode from 'vscode';
import { LogEntry, LogTreeItem } from './logExplorer';

export class PinnedLogsProvider implements vscode.TreeDataProvider<LogTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<LogTreeItem | undefined | null | void> = new vscode.EventEmitter<LogTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<LogTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  private pinnedLogs: Set<LogEntry> = new Set();

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LogTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): LogTreeItem[] {
    // Sort logs by timestamp from earliest to latest
    const sortedLogs = Array.from(this.pinnedLogs).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return sortedLogs.map(log => new LogTreeItem(log, true));
  }

  pinLog(log: LogEntry): void {
    this.pinnedLogs.add(log);
    this.refresh();
  }

  unpinLog(log: LogEntry): void {
    this.pinnedLogs.delete(log);
    this.refresh();
  }

  clearPins(): void {
    this.pinnedLogs.clear();
    this.refresh();
  }

  isPinned(log: LogEntry): boolean {
    return this.pinnedLogs.has(log);
  }
} 