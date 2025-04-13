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

        // Set initial content immediately
        const content = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Log Details</title>
                <style>
                    body {
                        padding: 10px;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        background-color: var(--vscode-editor-background);
                    }
                    .message {
                        margin: 10px 0;
                        font-style: italic;
                    }
                </style>
            </head>
            <body>
                <div class="message">Select a log entry to view details</div>
            </body>
            </html>`;

        webviewView.webview.html = content;

        // If we have a pending update, apply it after initial content
        if (this._pendingLog !== undefined) {
            console.log('Applying pending update');
            this.updateContent(this._pendingLog);
        }
    }

    public updateLogDetails(log: LogEntry | undefined) {
        console.log('updateLogDetails called with:', log);
        this._pendingLog = log;

        if (!this._view) {
            console.log('View not ready, storing update');
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
        
        let content = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Log Details</title>
                <style>
                    body {
                        padding: 10px;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        background-color: var(--vscode-editor-background);
                    }
                    .log-detail { padding: 10px; }
                    .log-detail h3 { 
                        margin-top: 15px; 
                        margin-bottom: 5px;
                        color: var(--vscode-editor-foreground);
                    }
                    .log-detail pre { 
                        margin-top: 10px; 
                        padding: 8px;
                        background-color: var(--vscode-textBlockQuote-background);
                        border-radius: 3px;
                        white-space: pre-wrap;
                    }
                    .severity { 
                        padding: 2px 6px; 
                        border-radius: 3px;
                        font-weight: bold;
                    }
                    .severity-error { 
                        background-color: var(--vscode-errorForeground);
                        color: var(--vscode-editor-background);
                    }
                    .severity-warning { 
                        background-color: var(--vscode-editorWarning-foreground);
                        color: var(--vscode-editor-background);
                    }
                    .severity-info { 
                        background-color: var(--vscode-symbolIcon-informationForeground);
                        color: var(--vscode-editor-background);
                    }
                    .severity-debug { 
                        background-color: var(--vscode-debugIcon-startForeground);
                        color: var(--vscode-editor-background);
                    }
                    .key-value { 
                        display: grid; 
                        grid-template-columns: auto 1fr; 
                        gap: 10px; 
                        margin: 5px 0;
                        align-items: baseline;
                    }
                    .key { 
                        font-weight: bold;
                        color: var(--vscode-symbolIcon-propertyForeground);
                    }
                    .value { 
                        word-break: break-word;
                    }
                </style>
            </head>
            <body>`;

        if (!log) {
            content += `<div class="log-detail">
                <div class="message">Select a log entry to view details</div>
            </div>`;
        } else {
            const timestamp = dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss.SSS');
            const severity = log.severity?.toUpperCase() || 'UNKNOWN';
            const severityClass = `severity-${severity.toLowerCase()}`;
            const target = log.target || log.resource?.labels?.container_name || log.serviceName || 'N/A';

            content += `<div class="log-detail">
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

            if (log.codeLocationCache) {
                content += `<div class="key-value">
                    <span class="key">Source:</span>
                    <span class="value">${this.escapeHtml(log.codeLocationCache.file)}:${log.codeLocationCache.line + 1}</span>
                </div>`;
            }

            if (log.claudeAnalysis?.variables && Object.keys(log.claudeAnalysis.variables).length > 0) {
                content += `<h3>Variables</h3>`;
                for (const [key, value] of Object.entries(log.claudeAnalysis.variables)) {
                    content += `<div class="key-value">
                        <span class="key">${this.escapeHtml(key)}:</span>
                        <span class="value">${this.escapeHtml(JSON.stringify(value))}</span>
                    </div>`;
                }
            }

            content += `<h3>Raw Message</h3>
                <pre><code>${this.escapeHtml(log.rawText || '')}</code></pre>
            </div>`;
        }

        content += `</body></html>`;

        this._view.webview.html = content;
    }

    public dispose() {
        this._view = undefined;
        this._pendingLog = undefined;
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