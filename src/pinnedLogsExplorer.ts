import * as vscode from 'vscode';
import { LogEntry, LogTreeItem } from './logExplorer';

export class PinnedLogsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private pinnedLogs: Set<string> = new Set(); // Store insertIds of pinned logs
  private logs: Map<string, LogEntry> = new Map(); // Store actual log entries

  constructor(private context: vscode.ExtensionContext) {
    // Load pinned logs from storage
    const savedPins = this.context.globalState.get<string[]>('pinnedLogs', []);
    savedPins.forEach(id => this.pinnedLogs.add(id));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<vscode.TreeItem[]> {
    // Sort logs by timestamp
    const sortedLogs = Array.from(this.logs.values())
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return Promise.resolve(
      sortedLogs.map(log => new LogTreeItem(log, true))
    );
  }

  // Pin a log
  public pinLog(log: LogEntry): void {
    if (log.insertId) {
      this.pinnedLogs.add(log.insertId);
      this.logs.set(log.insertId, log);
      this.savePinnedLogs();
      this._onDidChangeTreeData.fire();
    }
  }

  // Unpin a log
  public unpinLog(log: LogEntry): void {
    if (log.insertId) {
      this.pinnedLogs.delete(log.insertId);
      this.logs.delete(log.insertId);
      this.savePinnedLogs();
      this._onDidChangeTreeData.fire();
    }
  }

  // Check if a log is pinned
  public isPinned(log: LogEntry): boolean {
    return !!log.insertId && this.pinnedLogs.has(log.insertId);
  }

  // Clear all pins
  public clearPins(): void {
    this.pinnedLogs.clear();
    this.logs.clear();
    this.savePinnedLogs();
    this._onDidChangeTreeData.fire();
  }

  // Save pinned logs to storage
  private savePinnedLogs(): void {
    this.context.globalState.update('pinnedLogs', Array.from(this.pinnedLogs));
  }
} 