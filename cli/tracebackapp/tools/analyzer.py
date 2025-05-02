"""Root cause analysis tools for the Traceback CLI."""

import re
import subprocess
from typing import List, Dict, Optional, Tuple, Any, Callable


class RootCauseAnalyzer:
    """Provides tools for analyzing and debugging programs based on logs."""

    def __init__(self):
        """Initialize the analyzer."""
        self.context = {}  # Store analysis context for continued analysis

    def analyze_root_cause(self, 
                           logs: Optional[str] = None, 
                           entry_point: Optional[str] = None,
                           stack_trace: Optional[str] = None,
                           code_location: Optional[str] = None) -> Dict[str, Any]:
        """
        Analyze logs, stack traces, or code to determine the root cause of an issue.
        
        Args:
            logs: Full log output to analyze
            entry_point: A specific entry point to begin analysis
            stack_trace: Stack trace information
            code_location: Code location in format "file:line"
            
        Returns:
            Dictionary with analysis results and potential next steps
        """
        # Store inputs in context
        self.context.update({
            "logs": logs,
            "entry_point": entry_point,
            "stack_trace": stack_trace,
            "code_location": code_location
        })
        
        results = {
            "analysis": "",
            "potential_causes": [],
            "next_steps": []
        }
        
        # Analyze based on available information
        if logs:
            # Parse logs to extract key error information
            error_patterns = self._find_error_patterns(logs)
            results["potential_causes"].extend(error_patterns)
            
        if stack_trace:
            # Analyze stack trace to find potential error sources
            trace_analysis = self._analyze_stack_trace(stack_trace)
            results["analysis"] += trace_analysis["analysis"]
            results["potential_causes"].extend(trace_analysis["potential_causes"])
            
        if code_location:
            # Analyze code at the specified location
            code_analysis = self._analyze_code_location(code_location)
            results["analysis"] += code_analysis["analysis"]
            results["potential_causes"].extend(code_analysis["potential_causes"])
        
        # Generate next steps based on the analysis
        if not results["potential_causes"]:
            if logs:
                results["next_steps"].append({
                    "type": "present_options",
                    "message": "No clear error patterns found. Consider checking these log sections:"
                })
                # Find potential entry points in the logs
                entry_points = self._find_potential_entry_points(logs)
                results["next_steps"].extend(entry_points)
            else:
                results["next_steps"].append({
                    "type": "request",
                    "message": "Please provide more information (logs, stack trace, or specific code location)"
                })
        else:
            # For each potential cause, suggest next steps
            for cause in results["potential_causes"]:
                if "file_path" in cause:
                    results["next_steps"].append({
                        "type": "send_code",
                        "file_path": cause["file_path"],
                        "line": cause.get("line", 1),
                        "message": f"Examine code at {cause['file_path']}:{cause.get('line', 1)}"
                    })
                    
                    results["next_steps"].append({
                        "type": "get_callers",
                        "file_path": cause["file_path"],
                        "line": cause.get("line", 1),
                        "message": f"Find callers of function at {cause['file_path']}:{cause.get('line', 1)}"
                    })
        
        return results

    def present_options(self, options: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Present analysis options to the user.
        
        Args:
            options: List of options to present
            
        Returns:
            Formatted options for display
        """
        formatted_options = []
        for i, option in enumerate(options):
            formatted_options.append({
                "id": i + 1,
                "message": option.get("message", ""),
                "action": option.get("type", ""),
                "data": option
            })
        return formatted_options

    def analyze_log_line(self, log_line: str) -> Dict[str, Any]:
        """
        Analyze a specific log line to extract useful patterns for searching.
        
        Args:
            log_line: The log line to analyze
            
        Returns:
            Dictionary with search patterns and analysis
        """
        results = {
            "patterns": [],
            "analysis": "",
            "grep_commands": []
        }
        
        # Extract identifiers, error codes, timestamps, etc.
        id_pattern = re.compile(r'[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}', re.IGNORECASE)
        ids = id_pattern.findall(log_line)
        
        error_pattern = re.compile(r'error|exception|fail|timeout', re.IGNORECASE)
        has_error = error_pattern.search(log_line)
        
        # Add identified patterns
        if ids:
            for id_str in ids:
                results["patterns"].append(id_str)
                results["grep_commands"].append(f"grep -r '{id_str}' /path/to/logs")
                
        # Extract file paths and line numbers
        path_pattern = re.compile(r'(/[\w\d./-]+\.\w+)(?::(\d+))?')
        paths = path_pattern.findall(log_line)
        
        if paths:
            for path, line in paths:
                if line:
                    results["patterns"].append(f"{path}:{line}")
                    results["grep_commands"].append(f"grep -r -n '{path.split('/')[-1]}' /path/to/code")
                else:
                    results["patterns"].append(path)
                    results["grep_commands"].append(f"grep -r '{path.split('/')[-1]}' /path/to/code")
        
        # Add analysis of the log line
        if has_error:
            results["analysis"] = "This log line indicates an error condition."
        else:
            results["analysis"] = "This log line appears to be informational."
            
        return results

    def get_stack_trace(self, code_location: str) -> Dict[str, Any]:
        """
        Compute potential callers recursively for a given code location.
        
        Args:
            code_location: Code location in format "file:line"
            
        Returns:
            Dictionary with stack trace information
        """
        parts = code_location.split(":", 1)
        file_path = parts[0]
        line = int(parts[1]) if len(parts) > 1 else 1
        
        # Get the callers for this location
        callers = self.get_callers(code_location)["callers"]
        
        # Build a synthetic stack trace
        stack_frames = []
        for caller in callers:
            stack_frames.append({
                "file": caller["file_path"],
                "line": caller["line"],
                "function": caller.get("function", "unknown"),
                "context": caller.get("context", "")
            })
            
        # Add the original location
        stack_frames.append({
            "file": file_path,
            "line": line,
            "function": "unknown",
            "context": ""
        })
        
        # Format stack trace
        formatted_trace = ""
        for i, frame in enumerate(reversed(stack_frames)):
            formatted_trace += f"  File \"{frame['file']}\", line {frame['line']}, in {frame['function']}\n"
            if frame["context"]:
                formatted_trace += f"    {frame['context']}\n"
        
        return {
            "stack_trace": formatted_trace,
            "frames": stack_frames
        }

    def get_callers(self, code_location: str) -> Dict[str, Any]:
        """
        Get all potential callers for a given code location.
        
        Args:
            code_location: Code location in format "file:line"
            
        Returns:
            Dictionary with caller information
        """
        parts = code_location.split(":", 1)
        file_path = parts[0]
        line = int(parts[1]) if len(parts) > 1 else 1
        
        # This would normally use a code analysis tool
        # For this prototype, we'll return mock data
        callers = [
            {
                "file_path": "/path/to/caller1.py",
                "line": 42,
                "function": "caller_function1",
                "context": "result = problematic_function()"
            },
            {
                "file_path": "/path/to/caller2.py",
                "line": 123,
                "function": "caller_function2",
                "context": "data = self.process_with_problem()"
            }
        ]
        
        return {
            "code_location": code_location,
            "callers": callers
        }

    def send_code(self, code_location: str, context_lines: int = 20) -> Dict[str, Any]:
        """
        Retrieve code at a specific location with surrounding context.
        
        Args:
            code_location: Code location in format "file:line"
            context_lines: Number of lines of context before and after
            
        Returns:
            Dictionary with code and location information
        """
        parts = code_location.split(":", 1)
        file_path = parts[0]
        target_line = int(parts[1]) if len(parts) > 1 else 1
        
        try:
            with open(file_path, 'r') as f:
                lines = f.readlines()
                
            start_line = max(1, target_line - context_lines)
            end_line = min(len(lines), target_line + context_lines)
            
            # Extract the relevant code section
            code_section = []
            for i in range(start_line - 1, end_line):
                code_section.append(f"{i+1}: {lines[i]}")
                
            return {
                "file_path": file_path,
                "start_line": start_line,
                "end_line": end_line,
                "target_line": target_line,
                "code": "".join(code_section)
            }
        except Exception as e:
            return {
                "file_path": file_path,
                "error": f"Could not read file: {str(e)}"
            }

    def _find_error_patterns(self, logs: str) -> List[Dict[str, Any]]:
        """Extract error patterns from logs."""
        patterns = []
        
        # Simple error detection - look for common error terms
        error_lines = []
        for line in logs.split('\n'):
            if re.search(r'error|exception|failed|traceback|panic|fatal', line, re.IGNORECASE):
                error_lines.append(line)
        
        # Extract file paths and line numbers
        for line in error_lines:
            path_pattern = re.compile(r'(/[\w\d./-]+\.\w+)(?::(\d+))?')
            paths = path_pattern.findall(line)
            
            for path, line_num in paths:
                patterns.append({
                    "type": "code_location",
                    "file_path": path,
                    "line": int(line_num) if line_num else 1,
                    "context": line
                })
        
        return patterns

    def _analyze_stack_trace(self, stack_trace: str) -> Dict[str, Any]:
        """Analyze a stack trace for potential error sources."""
        results = {
            "analysis": "Stack trace analysis:\n",
            "potential_causes": []
        }
        
        # Look for file paths and line numbers in the stack trace
        path_pattern = re.compile(r'File "([^"]+)", line (\d+)')
        matches = path_pattern.findall(stack_trace)
        
        if matches:
            # The last frame is typically closest to the error
            for file_path, line_num in matches:
                results["potential_causes"].append({
                    "type": "code_location",
                    "file_path": file_path,
                    "line": int(line_num),
                    "context": "From stack trace"
                })
            
            results["analysis"] += f"Found {len(matches)} frames in the stack trace.\n"
            results["analysis"] += "The most likely source of the error is in the last frame.\n"
        else:
            results["analysis"] += "No valid stack trace frames found.\n"
        
        return results

    def _analyze_code_location(self, code_location: str) -> Dict[str, Any]:
        """Analyze code at a specific location."""
        parts = code_location.split(":", 1)
        file_path = parts[0]
        line = int(parts[1]) if len(parts) > 1 else 1
        
        # Get the code at this location
        code_info = self.send_code(code_location)
        
        results = {
            "analysis": f"Code analysis for {code_location}:\n",
            "potential_causes": []
        }
        
        if "error" in code_info:
            results["analysis"] += f"Error: {code_info['error']}\n"
            return results
        
        # Very simple code analysis - look for error-prone patterns
        code = code_info.get("code", "")
        if any(pattern in code for pattern in ["except:", "except Exception:", "# TODO", "FIXME"]):
            results["analysis"] += "Found generic exception handling or TODO/FIXME comments that may indicate known issues.\n"
            
        if "assert" in code:
            results["analysis"] += "Found assertions that might be failing.\n"
            
        results["potential_causes"].append({
            "type": "code_location",
            "file_path": file_path,
            "line": line,
            "context": "Direct analysis"
        })
        
        return results

    def _find_potential_entry_points(self, logs: str) -> List[Dict[str, Any]]:
        """Find potential entry points for analysis in logs."""
        entry_points = []
        
        # Look for timestamps to divide logs into segments
        log_segments = []
        current_segment = []
        last_timestamp = None
        
        timestamp_pattern = re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}')
        
        for line in logs.split('\n'):
            timestamp_match = timestamp_pattern.search(line)
            if timestamp_match:
                timestamp = timestamp_match.group(0)
                if last_timestamp and timestamp != last_timestamp:
                    log_segments.append('\n'.join(current_segment))
                    current_segment = []
                last_timestamp = timestamp
            current_segment.append(line)
            
        if current_segment:
            log_segments.append('\n'.join(current_segment))
        
        # For each segment, check if it contains errors
        for i, segment in enumerate(log_segments):
            if re.search(r'error|exception|failed|traceback|panic|fatal', segment, re.IGNORECASE):
                entry_points.append({
                    "type": "log_segment",
                    "segment_id": i,
                    "segment": segment[:200] + ("..." if len(segment) > 200 else ""),
                    "message": f"Log segment {i+1} contains errors"
                })
        
        return entry_points