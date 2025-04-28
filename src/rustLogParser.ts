import { LogParser } from './processor';
import { LogEntry, RustLogEntry, RustSpan, RustSpanField } from './logExplorer';

export class RustLogParser implements LogParser {
    canParse(content: string): boolean {
        try {
            // Check first non-empty line for Rust tracing format
            const lines = content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            
            if (lines.length === 0) return false;

            // Match Rust tracing format:
            // timestamp LEVEL name{field=value}:span{field=value}: message
            const rustLogRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[\w_]+(?:\{[^}]+\})?(?::[^:]+(?:\{[^}]+\})?)*:/;
            return rustLogRegex.test(lines[0]);
        } catch (error) {
            return false;
        }
    }

    async parse(content: string): Promise<LogEntry[]> {
        const lines = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const logs: LogEntry[] = [];

        for (const line of lines) {
            try {
                const rustLog = this.parseRustLogLine(line);
                if (rustLog) {
                    // Convert RustLogEntry to general LogEntry
                    logs.push(this.convertToLogEntry(rustLog));
                }
            } catch (error) {
                console.debug('Failed to parse Rust log line:', error);
                // Add as basic log entry if parsing fails
                logs.push({
                    severity: 'INFO',
                    timestamp: new Date().toISOString(),
                    rawText: line,
                    jsonPayload: { fields: { message: line } },
                    message: line,
                    target: 'unknown'
                });
            }
        }

        return logs;
    }

    private parseRustLogLine(line: string): RustLogEntry | null {
        // Match the basic structure: timestamp LEVEL spans: message
        const basicMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.+?):\s*(.*)$/);
        if (!basicMatch) return null;

        const [_, timestamp, level, spanChain, message] = basicMatch;

        // Parse the span chain
        const spans = this.parseSpanChain(spanChain);

        // Check for error information in the message
        const errorInfo = this.parseErrorInfo(message);

        return {
            timestamp,
            level: level as 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
            span_root: spans,
            message,
            error: errorInfo,
            raw_text: line
        };
    }

    private parseSpanChain(spanChain: string): RustSpan {
        // Split the span chain by colons
        const spanParts = spanChain.split(':');
        let currentSpan: RustSpan | null = null;
        let rootSpan: RustSpan | null = null;

        for (const part of spanParts) {
            // Match span name and fields: name{field=value,field2=value2}
            const spanMatch = part.match(/^(\w+)(?:\{([^}]+)\})?$/);
            if (!spanMatch) continue;

            const [_, name, fieldsStr] = spanMatch;
            
            // Parse fields if present
            const fields: RustSpanField[] = [];
            if (fieldsStr) {
                const fieldPairs = fieldsStr.split(/,\s*/);
                for (const pair of fieldPairs) {
                    const [name, value] = pair.split('=');
                    if (name && value) {
                        fields.push({ name, value: value.replace(/^"(.*)"$/, '$1') });
                    }
                }
            }

            // Create new span
            const newSpan: RustSpan = {
                name,
                fields,
                child: undefined
            };

            // Link in the chain
            if (!rootSpan) {
                rootSpan = newSpan;
                currentSpan = newSpan;
            } else if (currentSpan) {
                currentSpan.child = newSpan;
                currentSpan = newSpan;
            }
        }

        // If no valid spans were found, create a default span
        if (!rootSpan) {
            rootSpan = {
                name: 'unknown',
                fields: [],
                child: undefined
            };
        }

        return rootSpan;
    }

    private parseErrorInfo(message: string): { kind: string; message: string; os_error?: number } | undefined {
        // Match error patterns like "Operation canceled (os error 125)"
        const errorMatch = message.match(/([^:]+):\s*([^(]+)(?:\(os error (\d+)\))?/);
        if (errorMatch) {
            const [_, kind, errorMessage, osError] = errorMatch;
            return {
                kind: kind.trim(),
                message: errorMessage.trim(),
                ...(osError ? { os_error: parseInt(osError, 10) } : {})
            };
        }
        return undefined;
    }

    private convertToLogEntry(rustLog: RustLogEntry): LogEntry {
        // Get the deepest span for the target
        let currentSpan: RustSpan | undefined = rustLog.span_root;
        let lastSpan: RustSpan = rustLog.span_root;
        while (currentSpan?.child) {
            lastSpan = currentSpan;
            currentSpan = currentSpan.child;
        }

        // Collect all fields from the span chain
        const allFields: Record<string, string> = {};
        currentSpan = rustLog.span_root;
        while (currentSpan) {
            for (const field of currentSpan.fields) {
                allFields[`${currentSpan.name}.${field.name}`] = field.value;
            }
            currentSpan = currentSpan.child;
        }

        return {
            severity: rustLog.level,
            timestamp: rustLog.timestamp,
            rawText: rustLog.raw_text,
            message: rustLog.message,
            target: lastSpan.name,
            serviceName: rustLog.span_root.name,
            jsonPayload: {
                fields: {
                    message: rustLog.message,
                    ...allFields
                },
                target: lastSpan.name,
                // Include span information
                span: {
                    name: lastSpan.name,
                    key_id: allFields['span_id'] || undefined,
                    parent_id: allFields['parent_span_id'] || undefined
                }
            }
        };
    }
} 