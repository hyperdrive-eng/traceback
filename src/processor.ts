import * as fs from 'fs';
import * as vscode from 'vscode';
import { RustLogEntry, RustSpan } from './logExplorer';
import { RustLogParser } from './rustLogParser';

/**
 * Create a default RustLogEntry for when parsing fails
 */
function createDefaultRustLogEntry(message: string, level: 'ERROR' | 'DEBUG' | 'INFO' | 'TRACE' | 'WARN' = 'INFO'): RustLogEntry {
    const defaultSpan: RustSpan = {
        name: 'unknown',
        fields: []
    };

    return {
        level,
        message,
        timestamp: new Date().toISOString(),
        rawText: message,
        span_root: defaultSpan
    };
}

/**
 * Load logs from a file or pasted content and parse them into RustLogEntry objects
 */
export async function loadLogs(content: string): Promise<RustLogEntry[]> {
    const parser = new RustLogParser();
    const logs = await parser.parse(content);
    if (logs.length === 0) {
        throw new Error('No valid Rust logs found in content');
    }
    return logs;
}

export class LogProcessor {
    private _parser: RustLogParser;
    private _logEntries: RustLogEntry[] = [];

    constructor() {
        this._parser = new RustLogParser();
    }

    /**
     * Process a file and return log entries
     */
    async processFile(filePath: string): Promise<RustLogEntry[]> {
        const content = fs.readFileSync(filePath, 'utf8');
        return this.processContent(content);
    }

    /**
     * Process content directly and return log entries
     */
    async processContent(content: string): Promise<RustLogEntry[]> {
        const entries = await this._parser.parse(content);
        if (entries.length === 0) {
            throw new Error('No valid Rust logs found in content');
        }
        this._logEntries = entries;
        return entries;
    }

    /**
     * Get the current log entries
     */
    getLogEntries(): RustLogEntry[] {
        return this._logEntries;
    }
}