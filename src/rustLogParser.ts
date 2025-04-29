import { RustLogEntry, RustSpan, RustSpanField } from './logExplorer';

export class RustLogParser {
    // Regex for matching Rust tracing format with support for span fields
    private static readonly SPAN_LOG_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(?:\[([^\]]+)\])?\s*([^:]+(?:\{[^}]+\})?(?::[^:]+(?:\{[^}]+\})?)*): (.+)$/;

    // Regex for simpler log format (updated to handle module paths)
    private static readonly SIMPLE_LOG_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([^:\s]+(?:::[^:\s]+)*)\s*:\s*(.+)$/;

    // Regex for ANSI escape codes
    private static readonly ANSI_REGEX = /\u001b\[[0-9;]*[mGK]/g;

    async parse(content: string): Promise<RustLogEntry[]> {
        const lines = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const logs: RustLogEntry[] = [];

        for (const line of lines) {
            // Strip ANSI escape codes before parsing
            const cleanLine = line.replace(RustLogParser.ANSI_REGEX, '');

            // First try parsing as JSON
            const jsonLog = this.parseJsonLogLine(cleanLine);
            if (jsonLog) {
                jsonLog.rawText = line; // preserve original line
                logs.push(jsonLog);
                continue;
            }

            // Fall back to regex parsing if not JSON
            const rustLog = this.parseRustLogLine(cleanLine);
            if (rustLog) {
                rustLog.rawText = line;
                logs.push(rustLog);
            }
        }

        return logs;
    }

    /**
     * Try to parse a log line as JSON format
     */
    private parseJsonLogLine(line: string): RustLogEntry | null {
        try {
            const json = JSON.parse(line);

            // Validate required fields
            if (!json.timestamp || !json.level || !json.target || !json.fields?.message) {
                return null;
            }

            // Convert JSON log to RustLogEntry format
            return {
                timestamp: json.timestamp,
                level: json.level.toUpperCase() as 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
                target: json.target,
                message: json.fields.message,
                span_root: {
                    name: json.target,
                    fields: Object.entries(json.fields)
                        .filter(([key]) => key !== 'message')
                        .map(([key, value]) => ({
                            name: key,
                            value: String(value)
                        }))
                },
                rawText: line,
                // Optional source location if available
                source_location: json.filename && json.line_number ? {
                    file: json.filename,
                    line: json.line_number
                } : undefined
            };
        } catch (error) {
            return null;
        }
    }

    private parseRustLogLine(line: string): RustLogEntry | null {
        // Try parsing as a span chain log first
        const spanMatch = line.match(RustLogParser.SPAN_LOG_REGEX);
        if (spanMatch) {
            const [_, timestamp, level, target, spanChain, message] = spanMatch;
            try {
                const span_root = this.parseSpanChain(spanChain);
                // Extract any module path from the message
                const cleanMessage = this.stripModulePath(message.trim());
                return {
                    timestamp,
                    level: level as 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
                    target: target || 'unknown',
                    span_root,
                    message: cleanMessage,
                    rawText: line,
                };
            } catch (error) {
                console.debug('Failed to parse span chain:', error);
            }
        }

        // If that fails, try parsing as a simple log
        const simpleMatch = line.match(RustLogParser.SIMPLE_LOG_REGEX);
        if (simpleMatch) {
            const [_, timestamp, level, target, message] = simpleMatch;
            // Extract any module path from the message
            const cleanMessage = this.stripModulePath(message.trim());
            return {
                timestamp,
                level: level as 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
                target: target.trim(),
                span_root: {
                    name: target.trim(),
                    fields: []
                },
                message: cleanMessage,
                rawText: line,
            };
        }

        return null;
    }

    /**
     * Strips module paths from the beginning of a message
     * A module path is something like "crate::module::submodule:" at the start of a message
     */
    private stripModulePath(message: string): string {
        // Only match module paths at the start that are followed by a colon and whitespace
        // Don't match if it's part of an event name or field value
        const modulePathMatch = message.match(/^([a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)+):\s+/);
        if (modulePathMatch) {
            // Return everything after the module path and colon, trimmed
            return message.substring(modulePathMatch[0].length).trim();
        }
        return message;
    }

    private parseSpanChain(spanChain: string): RustSpan {
        if (!spanChain) {
            return {
                name: 'root',
                fields: []
            };
        }

        // Split the span chain into individual spans
        const spans = spanChain.split(':').map(span => span.trim());

        // Parse each span into a name and fields
        const parsedSpans = spans.map(span => {
            const nameMatch = span.match(/^([^{]+)(?:\{([^}]+)\})?$/);
            if (!nameMatch) {
                // Handle spans without fields
                return { name: span, fields: [] };
            }

            const [_, name, fieldsStr] = nameMatch;
            // Use the dedicated parseFields method
            const fields = this.parseFields(fieldsStr || '');

            return { name: name.trim(), fields };
        });

        // Build the span hierarchy
        let rootSpan: RustSpan = {
            name: parsedSpans[0].name,
            fields: parsedSpans[0].fields
        };

        let currentSpan = rootSpan;
        for (let i = 1; i < parsedSpans.length; i++) {
            currentSpan.child = {
                name: parsedSpans[i].name,
                fields: parsedSpans[i].fields
            };
            currentSpan = currentSpan.child;
        }

        return rootSpan;
    }

    private parseFields(fieldsString: string): RustSpanField[] {
        if (!fieldsString || fieldsString.trim() === '') {
            return [];
        }

        // Split on spaces that are followed by a word and equals sign, but not inside square brackets
        const fields = fieldsString.split(/\s+(?=[^[\]]*(?:\[|$))(?=\w+=)/);

        return fields.map(field => {
            const [key, ...valueParts] = field.split('=');
            if (!key || valueParts.length === 0) {
                return null;
            }

            let value = valueParts.join('='); // Rejoin in case value contained =

            // Remove surrounding quotes if present
            value = value.replace(/^["'](.*)["']$/, '$1');

            return {
                name: key,
                value: value
            };
        }).filter((field): field is RustSpanField => field !== null);
    }
}