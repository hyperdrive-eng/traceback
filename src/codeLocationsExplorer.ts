import * as vscode from 'vscode';
import * as path from 'path';
import { LogEntry } from './logExplorer';
import { findCodeLocationVector } from './vectorSearch';

export interface CodeLocation {
    file: string;
    line: number;
    similarity: number;
    preview: string;
}

export class CodeLocationsProvider implements vscode.TreeDataProvider<CodeLocationTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CodeLocationTreeItem | undefined | null | void> = new vscode.EventEmitter<CodeLocationTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CodeLocationTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private currentLocations: CodeLocation[] = [];
    private currentLog: LogEntry | undefined;
    private callStackExplorerProvider: any;

    constructor() {
        // Initialize
    }

    setCallStackExplorer(provider: any): void {
        this.callStackExplorerProvider = provider;
    }

    async setLog(log: LogEntry | undefined): Promise<void> {
        this.currentLog = log;
        this.currentLocations = [];

        if (!log) {
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const repoPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!repoPath) {
                throw new Error('No workspace folder is open');
            }

            // Clean the message for search
            const message = log.message || log.rawText || '';
            const cleanMessage = message
                .replace(/\[\s*(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\s*\]\s*/gi, '')
                .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(\.\d+)?(\s*[+-]\d{4})?\s*/, '')
                .replace(/\d{2}:\d{2}:\d{2}(\.\d+)?\s*/, '')
                .trim();

            // Get all possible locations from vector search
            const searchResults = await findCodeLocationVector(cleanMessage, repoPath, true);
            if (!searchResults || !Array.isArray(searchResults)) {
                this._onDidChangeTreeData.fire();
                return;
            }

            // For each location, read the file and get a preview of the line
            this.currentLocations = await Promise.all(
                searchResults.map(async (result) => {
                    try {
                        // Ensure we store the relative path by removing the repo path prefix
                        const relativePath = path.isAbsolute(result.file) 
                            ? path.relative(repoPath, result.file)
                            : result.file;
                            
                        const fullPath = path.join(repoPath, relativePath);
                        const document = await vscode.workspace.openTextDocument(fullPath);
                        const lineText = document.lineAt(result.line).text.trim();
                        
                        return {
                            file: relativePath,
                            line: result.line,
                            similarity: result.similarity,
                            preview: lineText
                        };
                    } catch (error) {
                        console.error('Error getting preview:', error);
                        return {
                            file: result.file,
                            line: result.line,
                            similarity: result.similarity,
                            preview: 'Unable to load preview'
                        };
                    }
                })
            );

            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('Error setting log:', error);
            this.currentLocations = [];
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(element: CodeLocationTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CodeLocationTreeItem): Thenable<CodeLocationTreeItem[]> {
        if (!this.currentLog || this.currentLocations.length === 0) {
            return Promise.resolve([]);
        }

        return Promise.resolve(
            this.currentLocations.map(
                location => new CodeLocationTreeItem(location, this.callStackExplorerProvider)
            )
        );
    }
}

export class CodeLocationTreeItem extends vscode.TreeItem {
    constructor(
        public readonly location: CodeLocation,
        private callStackExplorerProvider: any
    ) {
        const similarity = Math.round(location.similarity * 100);
        const label = `${path.basename(location.file)}:${location.line + 1}`;
        super(label, vscode.TreeItemCollapsibleState.None);

        this.description = `(${similarity}% match) ${location.preview}`;
        this.tooltip = `${location.file}:${location.line + 1}\n${location.preview}`;

        // Use file icon
        this.iconPath = new vscode.ThemeIcon('file-code');

        // Command to open file and analyze call stack
        this.command = {
            command: 'traceback.openCodeLocation',
            title: 'Open Code Location',
            arguments: [this]
        };
    }
} 