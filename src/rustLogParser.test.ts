import { RustLogParser } from './rustLogParser';
import '@jest/globals';

describe('RustLogParser', () => {
    let parser: RustLogParser;

    beforeEach(() => {
        parser = new RustLogParser();
    });

    test('parses complex span chain with nested fields', async () => {
        const logLine = '2025-04-20T03:16:50.160897Z TRACE event_loop:startup:release_tag_downstream{tag=[-1ns+18446744073709551615]}: boomerang_runtime::sched: Releasing downstream downstream=EnclaveKey(1) event=TagRelease[enclave=EnclaveKey(2),tag=[-1ns+18446744073709551615]]';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-20T03:16:50.160897Z');
        expect(log.level).toBe('TRACE');
        
        // Verify span chain
        expect(log.span_root.name).toBe('event_loop');
        expect(log.span_root.child?.name).toBe('startup');
        expect(log.span_root.child?.child?.name).toBe('release_tag_downstream');
        expect(log.span_root.child?.child?.fields).toHaveLength(1);
        expect(log.span_root.child?.child?.fields[0]).toEqual({
            name: 'tag',
            value: '[-1ns+18446744073709551615]'
        });
        
        // Message should not include the module path prefix but preserve event data
        expect(log.message).toBe('Releasing downstream downstream=EnclaveKey(1) event=TagRelease[enclave=EnclaveKey(2),tag=[-1ns+18446744073709551615]]');
    });

    test('parses log lines with ANSI color codes', async () => {
        const logLine = '\u001b[2m2025-04-20T03:16:50.160295Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mboomerang_builder::env::build\u001b[0m\u001b[2m:\u001b[0m Action enclave_cycle::__shutdown is unused, won\'t build';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-20T03:16:50.160295Z');
        expect(log.level).toBe('INFO');
        expect(log.target).toBe('boomerang_builder::env::build');
        expect(log.span_root.name).toBe('boomerang_builder::env::build');
        // Message should preserve module paths that are part of the actual message
        expect(log.message).toBe('Action enclave_cycle::__shutdown is unused, won\'t build');
        
        // Original text with ANSI codes should be preserved
        expect(log.rawText).toBe(logLine);
    });

    test('parses simple log with module path in message', async () => {
        const logLine = '2025-04-20T03:16:50.160355Z  INFO boomerang_builder::env::build: Action enclave_cycle::con_reactor_src::__startup is unused, won\'t build';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-20T03:16:50.160355Z');
        expect(log.level).toBe('INFO');
        expect(log.target).toBe('boomerang_builder::env::build');
        // Message should preserve module paths that are part of the actual message
        expect(log.message).toBe('Action enclave_cycle::con_reactor_src::__startup is unused, won\'t build');
    });

    test('parses Neon log format with multiple fields', async () => {
        const logLine = '2025-03-31T14:38:43.945268Z  WARN ephemeral_file_buffered_writer{tenant_id=3a885e0a8859fb7839d911d0143dca24 shard_id=0000 timeline_id=e26d9e4c6cd04a9c0b613ef7d1b77b9e path=/tmp/test_output/test_pageserver_catchup_while_compute_down[release-pg15]-1/repo/pageserver_1/tenants/3a885e0a8859fb7839d911d0143dca24/timelines/e26d9e4c6cd04a9c0b613ef7d1b77b9e/ephemeral-2}:flush_attempt{attempt=1}: error flushing buffered writer buffer to disk, retrying after backoff err=Operation canceled (os error 125)';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-03-31T14:38:43.945268Z');
        expect(log.level).toBe('WARN');
        
        // Verify root span
        expect(log.span_root.name).toBe('ephemeral_file_buffered_writer');
        expect(log.span_root.fields).toHaveLength(4);
        expect(log.span_root.fields).toEqual([
            { name: 'tenant_id', value: '3a885e0a8859fb7839d911d0143dca24' },
            { name: 'shard_id', value: '0000' },
            { name: 'timeline_id', value: 'e26d9e4c6cd04a9c0b613ef7d1b77b9e' },
            { name: 'path', value: '/tmp/test_output/test_pageserver_catchup_while_compute_down[release-pg15]-1/repo/pageserver_1/tenants/3a885e0a8859fb7839d911d0143dca24/timelines/e26d9e4c6cd04a9c0b613ef7d1b77b9e/ephemeral-2' }
        ]);

        // Verify child span
        expect(log.span_root.child?.name).toBe('flush_attempt');
        expect(log.span_root.child?.fields).toHaveLength(1);
        expect(log.span_root.child?.fields[0]).toEqual({
            name: 'attempt',
            value: '1'
        });
        
        expect(log.message).toBe('error flushing buffered writer buffer to disk, retrying after backoff err=Operation canceled (os error 125)');
    });

    test('parses JSON format log', async () => {
        const logLine = '{"timestamp":"2025-04-23T11:40:40.926094Z","level":"INFO","fields":{"message":"Action enclave_cycle::__startup is unused, won\'t build"},"target":"boomerang_builder::env::build","filename":"boomerang_builder/src/env/build.rs","line_number":244}';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-23T11:40:40.926094Z');
        expect(log.level).toBe('INFO');
        expect(log.target).toBe('boomerang_builder::env::build');
        expect(log.message).toBe('Action enclave_cycle::__startup is unused, won\'t build');
        expect(log.rawText).toBe(logLine);
    });

    test('parses JSON format log with additional fields', async () => {
        const logLine = '{"timestamp":"2025-04-23T11:40:40.926094Z","level":"INFO","fields":{"message":"Processing request","request_id":"123","user":"alice"},"target":"api::handler"}';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-23T11:40:40.926094Z');
        expect(log.level).toBe('INFO');
        expect(log.target).toBe('api::handler');
        expect(log.message).toBe('Processing request');
        
        // Additional fields should be captured in span_root.fields
        expect(log.span_root.fields).toHaveLength(2);
        expect(log.span_root.fields).toContainEqual({ name: 'request_id', value: '123' });
        expect(log.span_root.fields).toContainEqual({ name: 'user', value: 'alice' });
    });

    test('parses JSON format log with source location', async () => {
        const logLine = '{"timestamp":"2025-04-23T11:40:40.926094Z","level":"INFO","fields":{"message":"Releasing downstream downstream=EnclaveKey(1) event=TagRelease[enclave=EnclaveKey(2),tag=[-1ns+18446744073709551615]]"},"target":"boomerang_runtime::sched","filename":"boomerang_runtime/src/sched.rs","line_number":244}';
        
        const logs = await parser.parse(logLine);
        expect(logs).toHaveLength(1);
        
        const log = logs[0];
        expect(log.timestamp).toBe('2025-04-23T11:40:40.926094Z');
        expect(log.level).toBe('INFO');
        expect(log.target).toBe('boomerang_runtime::sched');
        expect(log.message).toBe('Releasing downstream downstream=EnclaveKey(1) event=TagRelease[enclave=EnclaveKey(2),tag=[-1ns+18446744073709551615]]');
        
        // Verify source location is parsed correctly
        expect(log.source_location).toBeDefined();
        expect(log.source_location).toEqual({
            file: 'boomerang_runtime/src/sched.rs',
            line: 244
        });
    });
}); 