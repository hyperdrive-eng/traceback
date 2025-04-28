import * as vscode from 'vscode';
import { LogEntry, RustSpan, RustSpanField } from './logExplorer';
import dayjs from 'dayjs';

interface SpanData {
    id: string;
    name: string;
    startTime: number;
    endTime: number;
    duration: number;
    parentId?: string;
    serviceName: string;
    severity: string;
    fields?: Record<string, string>;
    depth?: number;
}

// Extend LogEntry interface to include Rust spans
declare module './logExplorer' {
    interface LogEntry {
        rustSpans?: RustSpan[];
    }
}

/**
 * Manages the span visualizer panel that shows concurrent program flow
 */
export class SpanVisualizerPanel {
    public static currentPanel: SpanVisualizerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _spans: SpanData[] = [];

    /**
     * Create or show the span visualizer panel
     */
    public static createOrShow(context: vscode.ExtensionContext, logs: LogEntry[]) {
        // If we already have a panel, show it
        if (SpanVisualizerPanel.currentPanel) {
            SpanVisualizerPanel.currentPanel.updateSpans(logs);
            SpanVisualizerPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'spanVisualizer',
            'Span Visualizer',
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

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, logs: LogEntry[]) {
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
            vscode.window.showInformationMessage(`Span: ${span.name} (${span.duration}ms)`);
        }
    }

    public updateSpans(logs: LogEntry[]) {
        // Process logs into span data
        this._spans = this._processLogs(logs);
        if (this._panel) {
            this._update();
        }
    }

    private _processLogs(logs: LogEntry[]): SpanData[] {
        const spans: SpanData[] = [];
        
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
            let spanData: SpanData | undefined;

            if (log.axiomSpan) {
                // Handle Axiom span format
                const startTime = new Date(log.timestamp).getTime();
                const duration = log.axiomSpan.duration || 0;
                spanData = {
                    id: log.axiomSpan.span_id || log.axiomSpan.id || `span_${spans.length}`,
                    name: log.axiomSpan.name || 'Unknown operation',
                    startTime: startTime - globalStartTime,
                    endTime: startTime + duration - globalStartTime,
                    duration: duration,
                    parentId: log.axiomSpan.parent_span_id,
                    serviceName: log.serviceName || log.axiomSpan['service.name'] || 'unknown',
                    severity: log.severity,
                    fields: log.axiomSpan
                };
            } else if (log.jsonPayload?.span) {
                // Handle standard span format
                const startTime = new Date(log.timestamp).getTime();
                const duration = log.jsonPayload.span.duration || 0;
                const fields = log.jsonPayload.fields || {};
                
                spanData = {
                    id: log.jsonPayload.span.key_id || fields['span_id'] || `span_${spans.length}`,
                    name: log.jsonPayload.span.name || 'Unknown operation',
                    startTime: startTime - globalStartTime,
                    endTime: startTime + duration - globalStartTime,
                    duration: duration,
                    parentId: log.jsonPayload.span.parent_id || fields['parent_span_id'],
                    serviceName: log.serviceName || log.jsonPayload.target || 'unknown',
                    severity: log.severity,
                    fields: fields
                };
            } else if (log.jsonPayload?.fields?.span_root) {
                // Handle Rust spans
                const startTime = new Date(log.timestamp).getTime();
                const processSpan = (rustSpan: RustSpan, depth: number = 0): void => {
                    // Convert RustSpanField array to Record<string, string>
                    const fields: Record<string, string> = {};
                    rustSpan.fields.forEach(field => {
                        fields[field.name] = field.value;
                    });

                    // Calculate an estimated duration based on depth
                    const estimatedDuration = 1000 / (depth + 1); // Shorter duration for deeper spans

                    const spanId = `rust_span_${spans.length}_${depth}`;
                    const parentId = depth > 0 ? `rust_span_${spans.length}_${depth - 1}` : undefined;

                    spans.push({
                        id: spanId,
                        name: rustSpan.name,
                        startTime: startTime - globalStartTime,
                        endTime: startTime + estimatedDuration - globalStartTime,
                        duration: estimatedDuration,
                        parentId: parentId,
                        serviceName: log.serviceName || 'rust-service',
                        severity: log.severity,
                        fields: fields,
                        depth: depth
                    });

                    // Process child span if it exists
                    if (rustSpan.child) {
                        processSpan(rustSpan.child, depth + 1);
                    }
                };

                // Start processing from the root span
                const rootSpan = log.jsonPayload.fields.span_root as RustSpan;
                processSpan(rootSpan);
                continue; // Skip the default spanData push since we've already added spans
            }

            if (spanData) {
                spans.push(spanData);
            }
        }

        return spans;
    }

    private _update() {
        this._panel.title = 'Span Visualizer';
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
            const verticalOffset = span.depth ? span.depth * 5 : 0;
            const top = index * 30 + 10 + verticalOffset;

            // Determine color based on severity
            const color = this._getSeverityColor(span.severity);

            // Create tooltip with span details including fields
            let tooltip = `${span.name} (${span.duration}ms)\nService: ${span.serviceName}\nSeverity: ${span.severity}`;
            if (span.fields) {
                tooltip += '\n\nFields:';
                for (const [key, value] of Object.entries(span.fields)) {
                    if (typeof value === 'string' || typeof value === 'number') {
                        tooltip += `\n${key}: ${value}`;
                    }
                }
            }

            // Add visual indication of nesting
            const indentLevel = span.depth || 0;
            const indentMargin = indentLevel * 20;

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
            <title>Span Visualizer</title>
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
            <h2>Concurrent Program Flow</h2>
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
                return 'var(--vscode-warningForeground)';
            case 'DEBUG':
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