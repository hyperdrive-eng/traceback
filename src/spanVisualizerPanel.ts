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
    target?: string;
    fields: RustSpanField[];
    severity: string;
    depth: number;
    serviceName?: string;
    children: RustSpanVisualizerData[];
    isCollapsed?: boolean;
    raw?: RustLogEntry; // Original log entry for lookups
}

/**
 * Manages the span visualizer panel that shows Rust program flow
 * Inspired by Jaeger trace visualization
 */
export class SpanVisualizerPanel {
    public static currentPanel: SpanVisualizerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _spans: RustSpanVisualizerData[] = [];
    private _collapsedSpans: Set<string> = new Set();
    private _currentSortMode: 'service' | 'duration' | 'name' | 'time' = 'time';
    private _globalStartTime: number = 0;
    private _globalEndTime: number = 0;
    private _services: Map<string, string> = new Map(); // Maps service names to colors
    private _searchTerm: string = '';

    /**
     * Create or show the span visualizer panel
     */
    public static createOrShow(context: vscode.ExtensionContext, logs: RustLogEntry[]) {
        // If we already have a panel, show it
        if (SpanVisualizerPanel.currentPanel) {
            SpanVisualizerPanel.currentPanel.updateSpans(logs);
            SpanVisualizerPanel.currentPanel._panel.reveal(vscode.ViewColumn.Eight);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'spanVisualizer',
            'Trace Span Visualizer',
            {
                viewColumn: vscode.ViewColumn.Eight,
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
        this._setEventListeners();
    }

    private _handleSpanClick(spanId: string) {
        const span = this._findSpan(this._spans, spanId);
        if (span) {
            if (span.children.length > 0) {
                // Toggle collapse state
                span.isCollapsed = !span.isCollapsed;
                this._collapsedSpans.clear(); // Reset collapsed state
                this._updateCollapsedStates(this._spans);
                this._update();
            }

            // Notify LogExplorerProvider to filter logs by this span
            vscode.commands.executeCommand('traceback.filterBySpan', span.name);
        }
    }

    private _handleTimelineClick(spanId: string) {
        const span = this._findSpan(this._spans, spanId);
        if (span) {
            // Find the log entry that corresponds to this span
            const logEntry = this._findLogEntryBySpanId(spanId);
            if (logEntry) {
                // Use the existing openLog command
                vscode.commands.executeCommand('traceback.openLog', logEntry);
            }
        }
    }

    private _findLogEntryBySpanId(spanId: string): RustLogEntry | undefined {
        // Find the span that has this ID
        const span = this._findSpan(this._spans, spanId);
        if (span && span.raw) {
            return span.raw;
        }
        return undefined;
    }

    public updateSpans(logs: RustLogEntry[]) {
        this._spans = this._processLogs(logs);
        if (this._panel) {
            this._update();
        }
    }

    private _processLogs(logs: RustLogEntry[]): RustSpanVisualizerData[] {
        // Return empty array if no logs
        if (!logs || logs.length === 0) {
            this._globalStartTime = 0;
            this._globalEndTime = 0;
            return [];
        }

        const spanMap = new Map<string, RustSpanVisualizerData>();
        const rootSpans: RustSpanVisualizerData[] = [];
        const serviceSet = new Set<string>();
        
        // Sort logs by timestamp for consistent processing
        const sortedLogs = [...logs].sort((a, b) => 
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        
        // Calculate the global start time for relative positioning
        this._globalStartTime = new Date(sortedLogs[0].timestamp).getTime();
        
        // First pass: create all span nodes
        for (const log of sortedLogs) {
            const startTime = new Date(log.timestamp).getTime();
            let parentId: string | undefined;
            
            const processSpan = (rustSpan: RustSpan, depth: number = 0): string => {
                // Create a unique and stable ID based on span name, hierarchy, and timestamp
                const spanId = `${rustSpan.name}_${depth}_${startTime}`;
                
                // Try to determine service name from target or fields
                const serviceName = this._determineServiceName(log, rustSpan);
                if (serviceName) {
                    serviceSet.add(serviceName);
                }
                
                if (!spanMap.has(spanId)) {
                    spanMap.set(spanId, {
                        id: spanId,
                        name: rustSpan.name,
                        startTime: startTime - this._globalStartTime,
                        endTime: startTime - this._globalStartTime,
                        duration: 0,
                        parentId,
                        target: log.target,
                        fields: rustSpan.fields,
                        severity: log.level,
                        depth: depth,
                        serviceName,
                        children: [],
                        isCollapsed: this._collapsedSpans.has(spanId),
                        raw: log
                    });

                    if (!parentId) {
                        rootSpans.push(spanMap.get(spanId)!);
                    } else if (spanMap.has(parentId)) {
                        spanMap.get(parentId)!.children.push(spanMap.get(spanId)!);
                    }
                } else {
                    // Update end time if this is a later occurrence
                    spanMap.get(spanId)!.endTime = startTime - this._globalStartTime;
                }

                // Process child span if it exists
                if (rustSpan.child) {
                    const currentParentId = spanId;
                    parentId = currentParentId;
                    processSpan(rustSpan.child, depth + 1);
                }

                return spanId;
            };

            // Process from the root span
            processSpan(log.span_root);
        }

        // Second pass: calculate durations and set global end time
        let maxEndTime = 0;
        spanMap.forEach(span => {
            span.duration = span.endTime - span.startTime || 1; // Ensure at least 1ms duration for visibility
            maxEndTime = Math.max(maxEndTime, span.endTime);
        });
        
        this._globalEndTime = this._globalStartTime + maxEndTime;
        
        // Assign colors to services
        this._assignServiceColors(serviceSet);
        
        return rootSpans;
    }

    private _assignServiceColors(services: Set<string>) {
        // Jaeger-like color palette
        const colorPalette = [
            '#718ff4', // blue
            '#7fc97f', // green
            '#beaed4', // purple
            '#fdc086', // orange
            '#ffff99', // yellow
            '#386cb0', // dark blue
            '#f0027f', // magenta
            '#bf5b17', // brown
            '#666666', // gray
            '#1b9e77', // teal
            '#d95f02', // red-orange
            '#7570b3', // slate blue
            '#e7298a', // pink
            '#66a61e', // olive green
            '#e6ab02', // amber
            '#a6761d'  // gold
        ];
        
        // Clear existing color map
        this._services.clear();
        
        // Assign colors to services
        let colorIndex = 0;
        services.forEach(service => {
            this._services.set(service, colorPalette[colorIndex % colorPalette.length]);
            colorIndex++;
        });
    }

    private _determineServiceName(log: RustLogEntry, span: RustSpan): string {
        // Try to get service name from target
        if (log.target) {
            return log.target.split('::')[0]; // First part of target path
        }
        
        // Try to get from service field
        const serviceField = span.fields.find(f => 
            f.name === 'service' || f.name === 'service_name' || f.name === 'component'
        );
        if (serviceField) {
            return String(serviceField.value);
        }
        
        // Fallback to first part of span name if it has a :: pattern
        if (span.name.includes('::')) {
            return span.name.split('::')[0];
        }
        
        // Default
        return 'unknown';
    }

    private _findSpan(spans: RustSpanVisualizerData[], id: string): RustSpanVisualizerData | undefined {
        for (const span of spans) {
            if (span.id === id) return span;
            const found = this._findSpan(span.children, id);
            if (found) return found;
        }
        return undefined;
    }

    private _updateCollapsedStates(spans: RustSpanVisualizerData[]) {
        for (const span of spans) {
            if (span.isCollapsed) {
                this._collapsedSpans.add(span.id);
            }
            this._updateCollapsedStates(span.children);
        }
    }

    private _sortSpans(spans: RustSpanVisualizerData[]): RustSpanVisualizerData[] {
        // Create a copy to avoid modifying the original
        const result = [...spans];
        
        // Sort based on current mode
        switch (this._currentSortMode) {
            case 'service':
                result.sort((a, b) => {
                    const serviceA = a.serviceName || 'unknown';
                    const serviceB = b.serviceName || 'unknown';
                    return serviceA.localeCompare(serviceB) || a.startTime - b.startTime;
                });
                break;
            case 'duration':
                result.sort((a, b) => b.duration - a.duration);
                break;
            case 'name':
                result.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'time':
            default:
                result.sort((a, b) => a.startTime - b.startTime);
                break;
        }
        
        // Recursively sort children
        for (const span of result) {
            if (span.children.length > 0) {
                span.children = this._sortSpans(span.children);
            }
        }
        
        return result;
    }

    private _filterSpans(spans: RustSpanVisualizerData[], searchTerm: string): RustSpanVisualizerData[] {
        if (!searchTerm) {
            return spans;
        }
        
        const term = searchTerm.toLowerCase().trim();
        
        return spans.filter(span => {
            // Check if this span matches
            const nameMatch = span.name.toLowerCase().includes(term);
            const serviceMatch = (span.serviceName || '').toLowerCase().includes(term);
            const fieldsMatch = span.fields.some(f => 
                f.name.toLowerCase().includes(term) || 
                String(f.value).toLowerCase().includes(term)
            );
            
            // If this span matches, include it
            if (nameMatch || serviceMatch || fieldsMatch) {
                return true;
            }
            
            // If any children match, include this span
            const filteredChildren = this._filterSpans(span.children, searchTerm);
            if (filteredChildren.length > 0) {
                // Replace children with filtered list
                span.children = filteredChildren;
                return true;
            }
            
            return false;
        });
    }

    private _flattenSpans(spans: RustSpanVisualizerData[]): RustSpanVisualizerData[] {
        const result: RustSpanVisualizerData[] = [];
        
        for (const span of spans) {
            result.push(span);
            if (!span.isCollapsed && span.children.length > 0) {
                result.push(...this._flattenSpans(span.children));
            }
        }
        
        return result;
    }

    private _update() {
        // Update title with count
        const totalSpans = this._countTotalSpans(this._spans);
        this._panel.title = `Trace Span Visualizer (${totalSpans} spans)`;
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _countTotalSpans(spans: RustSpanVisualizerData[]): number {
        let count = spans.length;
        for (const span of spans) {
            count += this._countTotalSpans(span.children);
        }
        return count;
    }

    private _setEventListeners() {
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'spanClicked':
                        this._handleSpanClick(message.spanId);
                        return;
                    case 'timelineClicked':
                        this._handleTimelineClick(message.spanId);
                        return;
                    case 'clearFilter':
                        vscode.commands.executeCommand('traceback.filterBySpan', null);
                        return;
                    case 'openSourceLocation':
                        try {
                            const document = await vscode.workspace.openTextDocument(message.file);
                            const editor = await vscode.window.showTextDocument(document);
                            const position = new vscode.Position(message.line - 1, 0);
                            editor.selection = new vscode.Selection(position, position);
                            editor.revealRange(new vscode.Range(position, position));
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
                        }
                        return;
                    case 'changeSortMode':
                        this._currentSortMode = message.mode;
                        this._update();
                        return;
                    case 'searchSpans':
                        this._searchTerm = message.term;
                        this._update();
                        return;
                    case 'expandAll':
                        this._expandAllSpans(this._spans);
                        this._collapsedSpans.clear();
                        this._update();
                        return;
                    case 'collapseAll':
                        this._collapseAllSpans(this._spans);
                        this._update();
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _expandAllSpans(spans: RustSpanVisualizerData[]) {
        for (const span of spans) {
            span.isCollapsed = false;
            this._expandAllSpans(span.children);
        }
    }

    private _collapseAllSpans(spans: RustSpanVisualizerData[]) {
        for (const span of spans) {
            if (span.children.length > 0) {
                span.isCollapsed = true;
                this._collapsedSpans.add(span.id);
                this._collapseAllSpans(span.children);
            }
        }
    }

    private _getHtmlForWebview() {
        // Apply sorting and filtering
        let processedSpans = this._sortSpans(this._spans);
        if (this._searchTerm) {
            processedSpans = this._filterSpans(processedSpans, this._searchTerm);
        }
        
        // Calculate total trace duration in ms
        const traceDuration = Math.max(1, this._globalEndTime - this._globalStartTime);
        
        // Get visible spans for rendering
        const visibleSpans = this._flattenSpans(processedSpans);
        
        // Determine panel height based on number of spans
        const timelineHeight = Math.max(300, visibleSpans.length * 30);
        
        // Generate span elements with Jaeger-style layout
        const spanElements = visibleSpans.map(span => {
            const left = (span.startTime / traceDuration) * 100;
            const width = Math.max(((span.duration) / traceDuration) * 100, 0.5);
            const indentMargin = span.depth * 20;
            const hasChildren = span.children.length > 0;
            
            // Determine color based on service
            const color = this._getSpanColor(span);
            
            // Get duration in human-readable format
            const durationStr = this._formatDuration(span.duration);
            
            // Get source location from fields
            const sourceLocation = span.fields.find(f => f.name === 'source_location')?.value as { file: string; line: number } | undefined;
            
            // Get fields for tooltip
            const fieldStr = span.fields
                .filter(f => f.name !== 'source_location')
                .map(f => `${f.name}=${f.value}`)
                .join(', ');
            
            const tooltipContent = `
                <div class="tooltip-content">
                    <div><strong>Service:</strong> ${span.serviceName || 'unknown'}</div>
                    <div><strong>Name:</strong> ${span.name}</div>
                    <div><strong>Duration:</strong> ${durationStr}</div>
                    ${fieldStr ? `<div><strong>Fields:</strong> ${fieldStr}</div>` : ''}
                    ${sourceLocation ? `<div><strong>Source:</strong> ${sourceLocation.file}:${sourceLocation.line}</div>` : ''}
                </div>
            `;

            return `
                <div class="span-row" data-span-id="${span.id}" style="height: 30px;">
                    <div class="span-name" style="padding-left: ${indentMargin}px;">
                        ${hasChildren ? `<span class="collapse-icon">${span.isCollapsed ? '▶' : '▼'}</span>` : '<span style="width: 16px; display: inline-block;"></span>'}
                        <span class="service-tag" style="background-color: ${color};">${span.serviceName || '?'}</span>
                        <span class="name-label">${span.name}</span>
                        <span class="duration-label">${durationStr}</span>
                        ${sourceLocation ? 
                            `<span class="source-location" 
                                data-file="${sourceLocation.file}" 
                                data-line="${sourceLocation.line}">
                                📄 ${sourceLocation.file}:${sourceLocation.line}
                            </span>` 
                            : ''
                        }
                    </div>
                    <div class="span-timeline">
                        <div class="span-bar" 
                             style="left: ${left}%; width: ${width}%; background-color: ${color};"
                             data-span-id="${span.id}"
                             title="${span.name} (${durationStr})">
                            <div class="span-tooltip">${tooltipContent}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Trace Span Visualizer</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    padding: 0;
                    margin: 0;
                    overflow-x: hidden;
                }
                .main-container {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }
                .toolbar {
                    padding: 8px;
                    display: flex;
                    gap: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    flex-wrap: wrap;
                    align-items: center;
                    position: sticky;
                    top: 0;
                    background: var(--vscode-editor-background);
                    z-index: 100;
                }
                .toolbar button {
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                }
                .toolbar button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .toolbar select {
                    padding: 4px;
                    background: var(--vscode-dropdown-background);
                    color: var(--vscode-dropdown-foreground);
                    border: 1px solid var(--vscode-dropdown-border);
                    border-radius: 2px;
                }
                .search-container {
                    display: flex;
                    align-items: center;
                    background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    padding: 2px 4px;
                    flex: 1;
                    max-width: 300px;
                }
                .search-container input {
                    background: transparent;
                    color: var(--vscode-input-foreground);
                    border: none;
                    flex: 1;
                    padding: 2px 4px;
                    outline: none;
                }
                .timeline-container {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    overflow: auto;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-background);
                }
                .header-row {
                    display: flex;
                    height: 30px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: sticky;
                    top: 0;
                    background: var(--vscode-editor-background);
                    z-index: 10;
                }
                .span-name-header {
                    width: 450px;
                    min-width: 450px;
                    padding: 0 8px;
                    display: flex;
                    align-items: center;
                    font-weight: bold;
                    border-right: 1px solid var(--vscode-panel-border);
                }
                .timeline-header {
                    flex: 1;
                    position: relative;
                    padding: 4px;
                }
                .time-marker {
                    position: absolute;
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                }
                .time-marker::before {
                    content: '';
                    position: absolute;
                    top: 16px;
                    height: 100vh;
                    width: 1px;
                    background-color: var(--vscode-panel-border);
                    opacity: 0.2;
                }
                .span-rows-container {
                    overflow-y: auto;
                }
                .span-row {
                    display: flex;
                    position: relative;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .span-row:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .span-name {
                    width: 450px;
                    min-width: 450px;
                    padding: 0 8px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    border-right: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-background);
                }
                .span-timeline {
                    flex: 1;
                    position: relative;
                    height: 100%;
                    background: var(--vscode-editor-background);
                }
                .service-tag {
                    font-size: 10px;
                    padding: 2px 4px;
                    border-radius: 2px;
                    color: white;
                    margin-right: 6px;
                    white-space: nowrap;
                    max-width: 60px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .name-label {
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    cursor: pointer;
                }
                .duration-label {
                    font-size: 10px;
                    opacity: 0.7;
                    margin-left: 8px;
                    color: var(--vscode-descriptionForeground);
                }
                .collapse-icon {
                    cursor: pointer;
                    font-size: 10px;
                    padding: 4px;
                    opacity: 0.7;
                    width: 8px;
                    display: inline-block;
                    text-align: center;
                }
                .collapse-icon:hover {
                    opacity: 1;
                }
                .span-bar {
                    position: absolute;
                    height: 8px;
                    top: 50%;
                    transform: translateY(-50%);
                    border-radius: 2px;
                    cursor: pointer;
                    opacity: 0.8;
                    transition: all 0.2s;
                }
                .span-bar:hover {
                    opacity: 1;
                    height: 12px;
                }
                .span-tooltip {
                    position: absolute;
                    display: none;
                    background: var(--vscode-editorHoverWidget-background);
                    border: 1px solid var(--vscode-editorHoverWidget-border);
                    border-radius: 3px;
                    padding: 8px;
                    font-size: 12px;
                    z-index: 1000;
                    pointer-events: none;
                    width: max-content;
                    max-width: 300px;
                }
                .span-bar:hover .span-tooltip {
                    display: block;
                    top: -5px;
                    transform: translateY(-100%);
                }
                .tooltip-content {
                    line-height: 1.4;
                }
                .source-location {
                    margin-left: 10px;
                    color: var(--vscode-textLink-foreground);
                    cursor: pointer;
                    font-size: 0.9em;
                }
                .source-location:hover {
                    text-decoration: underline;
                }
                ::-webkit-scrollbar {
                    width: 10px;
                    height: 10px;
                }
                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                    border-radius: 5px;
                }
                .trace-summary {
                    display: flex;
                    align-items: center;
                    background-color: var(--vscode-breadcrumb-background);
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 0.9em;
                }
                .trace-summary span {
                    margin-right: 16px;
                }
                .chip {
                    display: inline-flex;
                    align-items: center;
                    padding: 2px 8px;
                    border-radius: 10px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    font-size: 11px;
                    margin-right: 6px;
                }
                .spacer {
                    flex: 1;
                }
            </style>
        </head>
        <body>
            <div class="main-container">
                <div class="toolbar">
                    <button id="clearFilterBtn">Clear Filter</button>
                    <button id="expandAllBtn">Expand All</button>
                    <button id="collapseAllBtn">Collapse All</button>
                    
                    <div class="spacer"></div>
                    
                    <div class="search-container">
                        <input type="text" id="searchInput" placeholder="Search spans..." value="${this._searchTerm}">
                    </div>
                    
                    <select id="sortSelect">
                        <option value="time" ${this._currentSortMode === 'time' ? 'selected' : ''}>Sort by Time</option>
                        <option value="duration" ${this._currentSortMode === 'duration' ? 'selected' : ''}>Sort by Duration</option>
                        <option value="service" ${this._currentSortMode === 'service' ? 'selected' : ''}>Sort by Service</option>
                        <option value="name" ${this._currentSortMode === 'name' ? 'selected' : ''}>Sort by Name</option>
                    </select>
                </div>
                
                <div class="trace-summary">
                    <span><strong>Total Spans:</strong> ${this._countTotalSpans(this._spans)}</span>
                    <span><strong>Trace Duration:</strong> ${this._formatDuration(traceDuration)}</span>
                    <span><strong>Services:</strong> 
                        ${Array.from(this._services.entries()).map(([name, color]) => 
                            `<span class="chip" style="background-color: ${color}">${name}</span>`
                        ).join('')}
                    </span>
                </div>
                
                <div class="timeline-container">
                    <div class="header-row">
                        <div class="span-name-header">Service & Operation</div>
                        <div class="timeline-header">
                            ${this._generateTimeMarkers(traceDuration)}
                        </div>
                    </div>
                    <div class="span-rows-container">
                        ${spanElements}
                    </div>
                </div>
            </div>
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    
                    // Event listeners
                    document.addEventListener('click', (e) => {
                        const sourceLocation = e.target.closest('.source-location');
                        if (sourceLocation) {
                            const file = sourceLocation.dataset.file;
                            const line = parseInt(sourceLocation.dataset.line, 10);
                            vscode.postMessage({
                                command: 'openSourceLocation',
                                file: file,
                                line: line
                            });
                            e.stopPropagation();
                            return;
                        }
                        
                        const clearFilterBtn = e.target.closest('#clearFilterBtn');
                        if (clearFilterBtn) {
                            vscode.postMessage({
                                command: 'clearFilter'
                            });
                            return;
                        }
                        
                        const expandAllBtn = e.target.closest('#expandAllBtn');
                        if (expandAllBtn) {
                            vscode.postMessage({
                                command: 'expandAll'
                            });
                            return;
                        }
                        
                        const collapseAllBtn = e.target.closest('#collapseAllBtn');
                        if (collapseAllBtn) {
                            vscode.postMessage({
                                command: 'collapseAll'
                            });
                            return;
                        }

                        const spanBar = e.target.closest('.span-bar');
                        if (spanBar) {
                            const spanId = spanBar.dataset.spanId;
                            vscode.postMessage({
                                command: 'timelineClicked',
                                spanId: spanId
                            });
                            e.stopPropagation();
                            return;
                        }

                        const nameLabel = e.target.closest('.name-label');
                        if (nameLabel) {
                            const spanRow = nameLabel.closest('.span-row');
                            if (spanRow) {
                                const spanId = spanRow.dataset.spanId;
                                vscode.postMessage({
                                    command: 'spanClicked',
                                    spanId: spanId
                                });
                            }
                            e.stopPropagation();
                            return;
                        }
                        
                        const collapseIcon = e.target.closest('.collapse-icon');
                        if (collapseIcon) {
                            const spanRow = collapseIcon.closest('.span-row');
                            if (spanRow) {
                                const spanId = spanRow.dataset.spanId;
                                vscode.postMessage({
                                    command: 'spanClicked',
                                    spanId: spanId
                                });
                            }
                            e.stopPropagation();
                            return;
                        }
                    });
                    
                    // Sort selection change
                    const sortSelect = document.getElementById('sortSelect');
                    if (sortSelect) {
                        sortSelect.addEventListener('change', (e) => {
                            vscode.postMessage({
                                command: 'changeSortMode',
                                mode: e.target.value
                            });
                        });
                    }
                    
                    // Search input
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        let debounceTimeout;
                        searchInput.addEventListener('input', (e) => {
                            clearTimeout(debounceTimeout);
                            debounceTimeout = setTimeout(() => {
                                vscode.postMessage({
                                    command: 'searchSpans',
                                    term: e.target.value
                                });
                            }, 300); // Debounce for 300ms
                        });
                    }
                    
                    // Position tooltips within view
                    const positionTooltips = () => {
                        const tooltips = document.querySelectorAll('.span-tooltip');
                        tooltips.forEach(tooltip => {
                            const rect = tooltip.getBoundingClientRect();
                            if (rect.right > window.innerWidth) {
                                tooltip.style.transform = 'translate(-100%, -100%)';
                                tooltip.style.left = 'auto';
                                tooltip.style.right = '0';
                            }
                        });
                    };
                    
                    // Trigger on hover
                    document.querySelectorAll('.span-bar').forEach(bar => {
                        bar.addEventListener('mouseenter', positionTooltips);
                    });
                })();
            </script>
        </body>
        </html>`;
    }

    private _generateTimeMarkers(traceDuration: number): string {
        const numMarkers = 10;
        let html = '';
        
        for (let i = 0; i <= numMarkers; i++) {
            const position = (i / numMarkers) * 100;
            const time = (traceDuration * i) / numMarkers;
            const label = this._formatDuration(time);
            
            html += `
                <div class="time-marker" style="left: ${position}%">
                    ${i === 0 ? '+0' : `+${label}`}
                </div>
            `;
        }
        
        return html;
    }

    private _formatDuration(duration: number): string {
        if (duration < 1) {
            return '<1ms';
        } else if (duration < 1000) {
            return `${Math.round(duration)}ms`;
        } else if (duration < 60000) {
            return `${(duration / 1000).toFixed(2)}s`;
        } else {
            const minutes = Math.floor(duration / 60000);
            const seconds = ((duration % 60000) / 1000).toFixed(1);
            return `${minutes}m ${seconds}s`;
        }
    }

    private _getSpanColor(span: RustSpanVisualizerData): string {
        // If service has a color, use it
        if (span.serviceName && this._services.has(span.serviceName)) {
            return this._services.get(span.serviceName)!;
        }
        
        // Fallback based on severity
        return this._getSeverityColor(span.severity);
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
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}