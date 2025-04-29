import * as vscode from 'vscode';
import { RustLogEntry, RustSpan, RustSpanField } from './logExplorer';
import dayjs from 'dayjs';

interface RustSpanVisualizerData {
    id: string;
    name: string;
    startTime: number;
    endTime: number;
    duration: number;
    parentId?: string;
    fields: RustSpanField[];
    severity: string;
    depth: number;
}

/**
 * Manages the span visualizer panel that shows Rust program flow
 */
export class SpanVisualizerPanel {
    public static currentPanel: SpanVisualizerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _spans: RustSpanVisualizerData[] = [];

    /**
     * Create or show the span visualizer panel
     */
    public static createOrShow(context: vscode.ExtensionContext, logs: RustLogEntry[]) {
        // If we already have a panel, show it
        if (SpanVisualizerPanel.currentPanel) {
            SpanVisualizerPanel.currentPanel.updateSpans(logs);
            SpanVisualizerPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'spanVisualizer',
            'Rust Span Visualizer',
            {
                viewColumn: vscode.ViewColumn.Two,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        SpanVisualizerPanel.currentPanel = new SpanVisualizerPanel(panel, context, logs);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, logs: RustLogEntry[]) {
        this._panel = panel;

        // Process initial logs
        this.updateSpans(logs);

        // Set initial content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Update the content based on view changes
        this._panel.onDidChangeViewState(
            e => {
                if (this._panel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'spanClicked':
                        this._handleSpanClick(message.spanId);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _handleSpanClick(spanId: string) {
        const span = this._spans.find(s => s.id === spanId);
        if (span) {
            // Create a formatted message with all fields
            const fieldsStr = span.fields
                .map(f => `${f.name}: ${f.value}`)
                .join('\n');
            
            vscode.window.showInformationMessage(
                `Span: ${span.name}\nDuration: ${span.duration}ms\nFields:\n${fieldsStr}`
            );
        }
    }

    public updateSpans(logs: RustLogEntry[]) {
        this._spans = this._processLogs(logs);
        if (this._panel) {
            this._update();
        }
    }

    private _processLogs(logs: RustLogEntry[]): RustSpanVisualizerData[] {
        const spans: RustSpanVisualizerData[] = [];
        
        // Sort logs by timestamp
        const sortedLogs = [...logs].sort((a, b) => 
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        if (sortedLogs.length === 0) {
            return spans;
        }

        // Calculate the global start time for relative positioning
        const globalStartTime = new Date(sortedLogs[0].timestamp).getTime();

        for (const log of sortedLogs) {
            const startTime = new Date(log.timestamp).getTime();
            
            const processSpan = (rustSpan: RustSpan, depth: number = 0, parentId?: string): void => {
                // Calculate an estimated duration based on depth
                const estimatedDuration = 1000 / (depth + 1); // Shorter duration for deeper spans

                const spanId = `rust_span_${spans.length}_${depth}`;

                spans.push({
                    id: spanId,
                    name: rustSpan.name,
                    startTime: startTime - globalStartTime,
                    endTime: startTime + estimatedDuration - globalStartTime,
                    duration: estimatedDuration,
                    parentId: parentId,
                    fields: rustSpan.fields,
                    severity: log.level,
                    depth: depth
                });

                // Process child span if it exists
                if (rustSpan.child) {
                    processSpan(rustSpan.child, depth + 1, spanId);
                }
            };

            // Process from the root span
            processSpan(log.span_root);
        }

        return spans;
    }

    private _update() {
        this._panel.title = 'Rust Span Visualizer';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview() {
        // Calculate timeline dimensions
        const timelineWidth = 100; // percentage
        const timelineHeight = Math.max(200, this._spans.length * 30); // pixels

        // Find the maximum end time for scaling
        const maxEndTime = Math.max(...this._spans.map(s => s.endTime), 1);

        // Generate span elements with improved nesting visualization
        const spanElements = this._spans.map((span, index) => {
            const left = (span.startTime / maxEndTime) * 100;
            const width = ((span.endTime - span.startTime) / maxEndTime) * 100;
            
            // Adjust vertical position based on depth for nested spans
            const verticalOffset = span.depth * 5;
            const top = index * 30 + 10 + verticalOffset;

            // Determine color based on severity
            const color = this._getSeverityColor(span.severity);

            // Create tooltip with span details including fields
            let tooltip = `${span.name} (${span.duration}ms)\nSeverity: ${span.severity}`;
            if (span.fields.length > 0) {
                tooltip += '\n\nFields:';
                for (const field of span.fields) {
                    tooltip += `\n${field.name}: ${field.value}`;
                }
            }

            // Add visual indication of nesting
            const indentMargin = span.depth * 20;

            return `
                <div class="span" 
                    style="left: ${left}%; width: ${width}%; top: ${top}px; background-color: ${color}; margin-left: ${indentMargin}px;"
                    title="${tooltip.replace(/"/g, '&quot;')}"
                    data-span-id="${span.id}">
                    <div class="span-label">${span.name}</div>
                </div>
            `;
        }).join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Rust Span Visualizer</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    padding: 20px;
                    overflow-x: hidden;
                }
                .timeline {
                    width: ${timelineWidth}%;
                    height: ${timelineHeight}px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    margin-top: 20px;
                    position: relative;
                    overflow: visible;
                    padding-left: 20px;
                }
                .span {
                    position: absolute;
                    height: 20px;
                    opacity: 0.7;
                    border-radius: 3px;
                    cursor: pointer;
                    transition: opacity 0.2s;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    border-left: 2px solid rgba(255, 255, 255, 0.3);
                }
                .span:hover {
                    opacity: 1;
                    z-index: 1000;
                }
                .span-label {
                    font-size: 12px;
                    padding: 2px 4px;
                    color: var(--vscode-editor-foreground);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .timeline-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 10px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <h2>Rust Program Flow</h2>
            <div class="timeline-header">
                <span>0ms</span>
                <span>${maxEndTime}ms</span>
            </div>
            <div class="timeline">
                ${spanElements}
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                // Add click handlers for spans
                document.querySelectorAll('.span').forEach(span => {
                    span.addEventListener('click', () => {
                        const spanId = span.getAttribute('data-span-id');
                        vscode.postMessage({
                            command: 'spanClicked',
                            spanId: spanId
                        });
                    });
                });
            </script>
        </body>
        </html>`;
    }

    private _getSeverityColor(severity: string): string {
        switch (severity.toUpperCase()) {
            case 'ERROR':
                return 'var(--vscode-errorForeground)';
            case 'WARNING':
            case 'WARN':
                return 'var(--vscode-warningForeground)';
            case 'DEBUG':
            case 'TRACE':
                return 'var(--vscode-debugIcon-startForeground)';
            default:
                return 'var(--vscode-textLink-foreground)';
        }
    }

    public dispose() {
        SpanVisualizerPanel.currentPanel = undefined;

        // Clean up resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
} 