import * as vscode from 'vscode';
import { LogEntry } from './logExplorer';
import dayjs from 'dayjs';

export class LogDetailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'logDetailView';
    private _view?: vscode.WebviewView;
    private _pendingLog?: LogEntry;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        console.log('LogDetailViewProvider constructed');
    }

    public dispose() {
        // Clear any resources
        this._view = undefined;
        this._pendingLog = undefined;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('resolveWebviewView called');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // If we have a pending update, apply it now
        if (this._pendingLog !== undefined) {
            console.log('Applying pending update');
            this.updateContent(this._pendingLog);
        } else {
            this.updateContent();
        }
    }

    public updateLogDetails(log: LogEntry | undefined) {
        console.log('updateLogDetails called with:', log);
        this._pendingLog = log; // Always store the most recent log

        if (!this._view) {
            console.log('View not ready, storing update');
            // Fix the Promise chain and add proper error handling
            Promise.resolve()
                .then(() => vscode.commands.executeCommand('workbench.view.extension.traceback'))
                .then(() => vscode.commands.executeCommand('workbench.view.extension.traceback.logDetailView'))
                .then(() => {
                    console.log('Focused log detail view');
                    // The view should be resolved shortly after this
                })
                .catch((error: Error) => {
                    console.error('Failed to focus view:', error);
                });
            return;
        }

        console.log('Updating content immediately');
        this.updateContent(log);
    }

    private updateContent(log?: LogEntry) {
        if (!this._view) {
            return;
        }

        const webview = this._view.webview;
        
        // Generate CSS URIs
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        // Generate content based on whether we have a log
        let content = this.generateContent(log);

        this._view.webview.html = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>Log Details</title>
                <style>
                    .log-detail { padding: 10px; }
                    .log-detail h3 { margin-top: 15px; margin-bottom: 5px; }
                    .log-detail pre { margin-top: 10px; white-space: pre-wrap; }
                    .severity { padding: 2px 6px; border-radius: 3px; }
                    .severity-error { background-color: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
                    .severity-warning { background-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
                    .severity-info { background-color: var(--vscode-symbolIcon-informationForeground); color: var(--vscode-editor-background); }
                    .severity-debug { background-color: var(--vscode-debugIcon-startForeground); color: var(--vscode-editor-background); }
                    .key-value { display: grid; grid-template-columns: auto 1fr; gap: 10px; margin: 5px 0; }
                    .key { font-weight: bold; }
                    .value { word-break: break-word; }
                </style>
            </head>
            <body>
                ${content}
            </body>
            </html>`;
    }

    private generateContent(log?: LogEntry): string {
        if (!log) {
            return `<div class="log-detail">
                <p>Select a log entry to view details</p>
            </div>`;
        }

        const timestamp = dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss.SSS');
        const severity = log.severity?.toUpperCase() || 'UNKNOWN';
        const severityClass = `severity-${severity.toLowerCase()}`;
        const target = log.target || log.resource?.labels?.container_name || log.serviceName || 'N/A';

        let content = `<div class="log-detail">
            <div class="key-value">
                <span class="key">Timestamp:</span>
                <span class="value">${this.escapeHtml(timestamp)}</span>
            </div>
            <div class="key-value">
                <span class="key">Severity:</span>
                <span class="value"><span class="severity ${severityClass}">${this.escapeHtml(severity)}</span></span>
            </div>
            <div class="key-value">
                <span class="key">Target:</span>
                <span class="value">${this.escapeHtml(target)}</span>
            </div>`;

        // Add source location if available
        if (log.codeLocationCache) {
            content += `
            <div class="key-value">
                <span class="key">Source:</span>
                <span class="value">${this.escapeHtml(log.codeLocationCache.file)}:${log.codeLocationCache.line + 1}</span>
            </div>`;
        }

        // Add variables if available
        if (log.claudeAnalysis?.variables && Object.keys(log.claudeAnalysis.variables).length > 0) {
            content += `<h3>Variables</h3>`;
            for (const [key, value] of Object.entries(log.claudeAnalysis.variables)) {
                content += `
                <div class="key-value">
                    <span class="key">${this.escapeHtml(key)}:</span>
                    <span class="value">${this.escapeHtml(JSON.stringify(value))}</span>
                </div>`;
            }
        }

        // Add raw message
        content += `
            <h3>Raw Message</h3>
            <pre><code>${this.escapeHtml(log.rawText || '')}</code></pre>
        </div>`;

        return content;
    }

    private escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
} 