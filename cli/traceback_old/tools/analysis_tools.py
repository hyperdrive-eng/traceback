"""Tools for analyzing logs, stack traces, and code locations."""

import os
import re
import ast
import json
from dataclasses import dataclass, asdict
from typing import List, Optional, Callable, Any, Dict, Union, Set, TypedDict
from pathlib import Path
from .claude_client import ClaudeClient, ToolResponse

@dataclass
class CodeLocation:
    file_path: str
    line_number: int
    function_name: Optional[str] = None
    
    def __str__(self) -> str:
        return f"{self.file_path}:{self.line_number}"

@dataclass
class StackTraceEntry:
    code_location: CodeLocation
    context: Optional[str] = None

@dataclass
class AnalysisResult:
    analysis: str
    next_steps: List[str]
    suggested_tool: Optional[str] = None
    suggested_args: Optional[Dict[str, Any]] = None

@dataclass
class AnalysisRequest:
    """Request for analysis with specific type and parameters."""
    type: str  # Type of analysis requested
    params: Dict[str, Any]  # Parameters for the analysis
    context: Optional[str] = None  # Additional context

@dataclass
class AnalysisResponse:
    """Response from analysis with findings and next steps."""
    findings: List[str]  # Key findings
    next_analysis: Optional[AnalysisRequest] = None  # Next analysis to perform
    root_cause: Optional[str] = None  # Final root cause if found

class AnalysisFunction(TypedDict):
    """Definition of an analysis function."""
    name: str
    description: str
    params: Dict[str, str]  # param_name -> param_description
    returns: str

class AnalysisTools:
    def __init__(self, workspace_root: Optional[str] = None, claude_client: Optional[ClaudeClient] = None):
        """
        Initialize analysis tools.
        
        Args:
            workspace_root: Root directory of the workspace. If None, uses current directory.
            claude_client: Optional Claude client for intelligent analysis. If None, creates a new one.
        """
        self.workspace_root = workspace_root or os.getcwd()
        self.claude = claude_client or ClaudeClient()
        
    def analyze_root_cause(self, 
                          logs: Optional[str] = None,
                          entry_point: Optional[str] = None,
                          stack_trace: Optional[List[StackTraceEntry]] = None,
                          code_location: Optional[CodeLocation] = None) -> AnalysisResult:
        """
        Analyze root cause from various inputs.
        
        Args:
            logs: Full logs to analyze
            entry_point: Specific log entry point
            stack_trace: Stack trace entries
            code_location: Specific code location
            
        Returns:
            Analysis result with findings and next steps
        """
        analysis_points = []
        next_steps = []
        
        # If we have a code location, that's our primary focus
        if code_location:
            # Get the code context
            code_context = self.get_code_block(code_location)
            analysis_points.append(f"Code Context:\n{code_context}")
            
            # Use Claude to analyze the code
            code_analysis = self.claude.analyze_code(
                code_context,
                code_location.file_path,
                code_location.line_number
            )
            analysis_points.append("\nCode Analysis:\n" + code_analysis)
            
            # Get potential callers
            callers = self.get_callers(code_location)
            if callers:
                analysis_points.append("\nPotential Callers:")
                for caller in callers:
                    analysis_points.append(f"- {caller.file_path}:{caller.line_number} in {caller.function_name}")
                next_steps.append("Examine caller locations for potential issues")
                
            # Suggest getting a full stack trace
            next_steps.append("Generate full stack trace to see complete call path")
            
        # If we have a stack trace, analyze each entry
        if stack_trace:
            analysis_points.append("\nStack Trace Analysis:")
            for entry in stack_trace:
                analysis_points.append(f"\nAt {entry.code_location}:")
                if entry.context:
                    analysis_points.append(entry.context)
                    # Use Claude to analyze each frame's code
                    frame_analysis = self.claude.analyze_code(
                        entry.context,
                        entry.code_location.file_path,
                        entry.code_location.line_number
                    )
                    analysis_points.append("\nFrame Analysis:\n" + frame_analysis)
                    
            next_steps.append("Examine each stack frame for potential issues")
            
        # If we have logs, use Claude to analyze them
        if logs:
            log_analysis = self.claude.analyze_logs(logs)
            analysis_points.append("\nLog Analysis:\n" + log_analysis)
            next_steps.append("Follow up on identified log patterns")
                
        # If we have an entry point, use Claude to analyze it
        if entry_point:
            entry_analysis = self.claude.analyze_entry_point(
                logs or "",  # Pass full logs as context if available
                entry_point
            )
            analysis_points.append("\nEntry Point Analysis:\n" + entry_analysis)
            
            # Get similar patterns using Claude's suggestions
            pattern_finder = self.analyze_log_line(entry_point)
            similar_lines = pattern_finder()
            analysis_points.append("\nSimilar Log Patterns:")
            analysis_points.extend(similar_lines)
            
            next_steps.append("Look for similar log patterns in other time periods")
            
        # If we don't have much to go on, suggest gathering more info
        if not analysis_points:
            analysis_points.append("Insufficient information for analysis")
            next_steps.extend([
                "Gather relevant logs",
                "Identify specific error messages or stack traces",
                "Locate relevant code locations"
            ])
            
        # Combine all analysis points
        analysis = "\n".join(analysis_points)
        
        # Use Claude to suggest next steps
        if analysis:
            next_step_prompt = f"""
Based on the following analysis, what should be the next debugging steps?
Focus on specific, actionable items.

ANALYSIS:
{analysis}

Suggest 2-3 concrete next steps, in order of priority.
"""
            claude_suggestions = self.claude.ask_logs_question("", next_step_prompt)
            next_steps = [s.strip() for s in claude_suggestions.split("\n") if s.strip()]
        
        # Determine next tool suggestion
        suggested_tool = None
        suggested_args = None
        
        if code_location and not stack_trace:
            suggested_tool = "get_stack_trace"
            suggested_args = {"code_location": code_location}
        elif logs and not entry_point and "error" in logs.lower():
            # Suggest analyzing the first error line
            error_lines = [line for line in logs.splitlines() if "error" in line.lower()]
            if error_lines:
                suggested_tool = "analyze_log_line"
                suggested_args = {"log_line": error_lines[0]}
                
        return AnalysisResult(
            analysis=analysis,
            next_steps=next_steps,
            suggested_tool=suggested_tool,
            suggested_args=suggested_args
        )
        
    def present_options(self, entry_points: List[str]) -> str:
        """
        Present analysis options to user.
        
        Args:
            entry_points: List of possible entry points
            
        Returns:
            Selected entry point
        """
        if not entry_points:
            return "No analysis options available"
            
        # Format options for display
        options = "\nPossible analysis paths:\n\n"
        for i, entry in enumerate(entry_points, 1):
            options += f"{i}. {entry}\n"
            
        options += "\nSelect a number to analyze that path (1-{len(entry_points)}): "
        
        # In a real interactive environment, we would wait for user input here
        # For now, we'll just return the formatted options
        return options
        
    def analyze_log_line(self, log_line: str) -> Callable[[], List[str]]:
        """
        Analyze a log line and return a function to find similar patterns.
        Uses Claude to extract meaningful patterns.
        
        Args:
            log_line: Log line to analyze
            
        Returns:
            Function that when called will grep for similar patterns
        """
        # Ask Claude to analyze the log line and suggest patterns
        pattern_prompt = f"""
Analyze this log line and suggest a search pattern that would find similar log entries.
The pattern should:
1. Keep important static parts that identify this type of log
2. Remove or generalize variable parts (timestamps, IDs, specific values)
3. Focus on the core message structure

LOG LINE:
{log_line}

Return ONLY the suggested search pattern, nothing else.
"""
        static_pattern = self.claude.ask_logs_question("", pattern_prompt).strip()
        
        def find_similar_lines() -> List[str]:
            """Search for lines matching the static pattern."""
            try:
                # TODO: Implement actual log searching logic
                # This would typically involve searching through log files
                # For now, return a placeholder
                return [f"Would search for pattern: {static_pattern}"]
            except Exception as e:
                return [f"Error searching logs: {str(e)}"]
                
        return find_similar_lines
        
    def get_stack_trace(self, code_location: CodeLocation, max_depth: int = 10) -> List[StackTraceEntry]:
        """
        Get potential call stack for a code location.
        
        Args:
            code_location: Code location to analyze
            max_depth: Maximum depth of the call stack to explore
            
        Returns:
            List of stack trace entries from outermost to innermost call
        """
        def build_stack_trace(location: CodeLocation, depth: int, visited: Set[str]) -> List[List[StackTraceEntry]]:
            if depth >= max_depth:
                return [[]]
                
            # Get code context for this location
            code_context = self.get_code_block(location, context_lines=2)
            current_entry = StackTraceEntry(location, code_context)
            
            # Get callers of this location
            callers = self.get_callers(location)
            
            if not callers:
                return [[current_entry]]
                
            # Build stack traces recursively for each caller
            all_traces = []
            for caller in callers:
                # Avoid cycles in the call graph
                caller_key = f"{caller.file_path}:{caller.line_number}"
                if caller_key in visited:
                    continue
                    
                visited.add(caller_key)
                caller_traces = build_stack_trace(caller, depth + 1, visited)
                visited.remove(caller_key)
                
                # Add current entry to each trace from the caller
                for trace in caller_traces:
                    all_traces.append(trace + [current_entry])
                    
            return all_traces or [[current_entry]]
            
        try:
            # Build all possible stack traces
            traces = build_stack_trace(code_location, 0, set())
            
            # Return the most likely trace (for now, just take the longest one)
            return max(traces, key=len)
            
        except Exception as e:
            print(f"Error building stack trace: {str(e)}")
            return [StackTraceEntry(code_location, "Error building stack trace")]
        
    def get_callers(self, code_location: CodeLocation) -> List[CodeLocation]:
        """
        Get direct callers of a code location.
        
        Args:
            code_location: Code location to analyze
            
        Returns:
            List of caller locations
        """
        class FunctionCallVisitor(ast.NodeVisitor):
            def __init__(self, target_func: str):
                self.target_func = target_func
                self.calls: List[tuple[str, int]] = []
                self.current_function: Optional[str] = None
                
            def visit_FunctionDef(self, node: ast.FunctionDef):
                old_function = self.current_function
                self.current_function = node.name
                self.generic_visit(node)
                self.current_function = old_function
                
            def visit_Call(self, node: ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == self.target_func:
                    if self.current_function:
                        self.calls.append((self.current_function, node.lineno))
                self.generic_visit(node)
                
        try:
            # First get the function name at the target location
            with open(os.path.join(self.workspace_root, code_location.file_path)) as f:
                tree = ast.parse(f.read())
                
            # Find the function name at the target line
            target_func = None
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and \
                   node.lineno <= code_location.line_number <= node.end_lineno:
                    target_func = node.name
                    break
                    
            if not target_func:
                return []
                
            # Now search for calls to this function
            callers: List[CodeLocation] = []
            
            # Search in Python files in the workspace
            for root, _, files in os.walk(self.workspace_root):
                for file in files:
                    if not file.endswith('.py'):
                        continue
                        
                    rel_path = os.path.relpath(os.path.join(root, file), self.workspace_root)
                    
                    try:
                        with open(os.path.join(root, file)) as f:
                            tree = ast.parse(f.read())
                            visitor = FunctionCallVisitor(target_func)
                            visitor.visit(tree)
                            
                            for func_name, line_no in visitor.calls:
                                callers.append(CodeLocation(
                                    file_path=rel_path,
                                    line_number=line_no,
                                    function_name=func_name
                                ))
                    except:
                        continue
                        
            return callers
            
        except Exception as e:
            print(f"Error finding callers: {str(e)}")
            return []
        
    def get_code_block(self, code_location: CodeLocation, context_lines: int = 20) -> str:
        """
        Get code block around a location.
        
        Args:
            code_location: Code location to get
            context_lines: Number of lines before and after
            
        Returns:
            Code block as string
        """
        try:
            file_path = code_location.file_path
            if not os.path.isabs(file_path):
                file_path = os.path.join(self.workspace_root, file_path)
                
            if not os.path.exists(file_path):
                return f"Error: File not found: {file_path}"
                
            with open(file_path, 'r') as f:
                lines = f.readlines()
                
            start_line = max(0, code_location.line_number - context_lines - 1)
            end_line = min(len(lines), code_location.line_number + context_lines)
            
            code_block = ''.join(lines[start_line:end_line])
            return (f"File: {code_location.file_path}, "
                   f"Lines {start_line+1}-{end_line}\n\n{code_block}")
                   
        except Exception as e:
            return f"Error reading file: {str(e)}"

@dataclass
class ToolCall:
    """Represents a tool that Claude wants to call"""
    tool_name: str
    params: Dict[str, Any]
    reason: str  # Why this tool is being called

@dataclass
class AnalysisContext:
    """Analysis context for a debugging session."""
    initial_input: str  # Initial input (logs, code, etc.)
    current_findings: List[Dict[str, Any]]  # Findings so far
    
class Analyzer:
    """Simple recursive analysis system using Claude."""
    
    def __init__(self, workspace_root: Optional[str] = None):
        """Initialize the analyzer."""
        self.workspace_root = workspace_root or os.getcwd()
        self.claude = ClaudeClient()
        self.display_callback: Optional[Callable[[str], None]] = None
        
    def analyze(self, initial_input: str, display_callback: Optional[Callable[[str], None]] = None) -> None:
        """Start analysis with initial input."""
        self.display_callback = display_callback
        
        # Initialize context
        context = AnalysisContext(
            initial_input=initial_input,
            current_findings=[]
        )
        
        # Start analysis loop
        while True:
            # Get next tool choice from Claude
            result = self.claude.analyze_error(initial_input, context.current_findings)
            
            # Extract tool choice
            tool_name = result.get("tool")
            params = result.get("params", {})
            analysis = result.get("analysis", "")
            
            # Display analysis if callback is provided
            if self.display_callback:
                if analysis:
                    self.display_callback(analysis)
                
                # Display tool choice
                tool_msg = f"\nChose tool: {tool_name}"
                if tool_name == "get_info":
                    info_type = params.get("type", "unknown")
                    tool_context = params.get("context", "no context")
                    tool_msg += f"\n- Type: {info_type}\n- Context: {tool_context}"
                elif tool_name == "show_root_cause":
                    tool_msg += "\n- Preparing final analysis..."
                
                self.display_callback(tool_msg)
            
            # Handle tool choice
            if tool_name == "show_root_cause":
                # Terminal action - show the root cause and end analysis
                root_cause = result.get("root_cause", "No root cause analysis provided")
                if self.display_callback:
                    self.display_callback("Root Cause Analysis:\n" + root_cause)
                break
                
            elif tool_name == "get_info":
                # Execute the chosen info-gathering tool
                info_type = params.get("type")
                info_context = params.get("context", "")
                
                if info_type == "fetch_files":
                    self._fetch_files(context, info_context)
                elif info_type == "fetch_logs":
                    self._fetch_logs(context, info_context)
                elif info_type == "fetch_code":
                    self._fetch_code(context, info_context)
                else:
                    if self.display_callback:
                        self.display_callback(f"Unknown info type: {info_type}")
            else:
                if self.display_callback:
                    self.display_callback(f"Unknown tool: {tool_name}")
                    
    def _fetch_files(self, context: AnalysisContext, search_context: str) -> None:
        """Fetch files matching patterns mentioned in the context."""
        if self.display_callback:
            self.display_callback(f"Searching for files related to: {search_context}")
            
        # Extract potential patterns from the context
        patterns = re.findall(r'[\w\-\.\/]+', search_context)
        patterns = [p for p in patterns if len(p) > 3]  # Filter out too short patterns
        
        all_matching_files = []
        
        for pattern in patterns[:3]:  # Limit to first 3 patterns to avoid overload
            # Search for files
            matching_files = []
            for root, _, files in os.walk(self.workspace_root):
                for file in files:
                    if pattern.lower() in file.lower():
                        rel_path = os.path.relpath(os.path.join(root, file), self.workspace_root)
                        matching_files.append(rel_path)
            
            # Get file contents for first few matches
            file_contents = []
            for file_path in matching_files[:3]:  # Limit to first 3 files per pattern
                try:
                    full_path = os.path.join(self.workspace_root, file_path)
                    with open(full_path, 'r') as f:
                        content = f.read()
                    file_contents.append({
                        "path": file_path,
                        "content": content[:2000]  # First 2000 chars
                    })
                    all_matching_files.append(file_path)
                except Exception as e:
                    if self.display_callback:
                        self.display_callback(f"Error reading file {file_path}: {str(e)}")
            
            # Add finding
            finding_result = f"Found {len(matching_files)} files matching '{pattern}'.\n"
            finding_result += f"Examined contents of {len(file_contents)} files."
            
            context.current_findings.append({
                "type": "fetch_files",
                "context": pattern,
                "result": finding_result,
                "file_contents": file_contents
            })
        
        # Display result if callback is provided
        if self.display_callback:
            self.display_callback(f"Files found: {len(all_matching_files)}")
        
    def _fetch_logs(self, context: AnalysisContext, log_context: str) -> None:
        """Fetch logs from user."""
        # In a real implementation, this would prompt the user for logs
        # For now, we'll just use the initial input as logs
        
        if self.display_callback:
            self.display_callback(f"Log analysis requested for: {log_context}")
            self.display_callback("Using initial input as logs")
        
        # Add finding
        context.current_findings.append({
            "type": "fetch_logs",
            "context": log_context,
            "result": "Using initial input as logs"
        })
        
    def _fetch_code(self, context: AnalysisContext, code_context: str) -> None:
        """Fetch code based on file and line number hints in the context."""
        if self.display_callback:
            self.display_callback(f"Fetching code related to: {code_context}")
            
        # Try to extract file path and line number from context
        file_pattern = r'([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+):?(\d+)?'
        matches = re.findall(file_pattern, code_context)
        
        if not matches:
            if self.display_callback:
                self.display_callback("No file references found in context")
                
            context.current_findings.append({
                "type": "fetch_code",
                "context": code_context,
                "result": "No file references found"
            })
            return
            
        # Process each potential file reference
        for file_path, line_str in matches:
            try:
                # Default line number if not specified
                line_number = 1
                if line_str:
                    line_number = int(line_str)
                
                # Check if file path is absolute or relative
                full_path = file_path
                if not os.path.isabs(file_path):
                    # Try both workspace root and current directory
                    potential_paths = [
                        os.path.join(self.workspace_root, file_path),
                        file_path
                    ]
                    
                    full_path = None
                    for path in potential_paths:
                        if os.path.exists(path):
                            full_path = path
                            break
                    
                    if not full_path:
                        raise FileNotFoundError(f"File not found: {file_path}")
                
                # Read the file
                with open(full_path, 'r') as f:
                    lines = f.readlines()
                    
                # Get code context (20 lines before and after)
                context_lines = 20
                start = max(0, line_number - context_lines)
                end = min(len(lines), line_number + context_lines + 1)
                code = ''.join(lines[start:end])
                
                # Add finding
                result = f"Code from {file_path} (line {line_number}):\n\n{code}"
                context.current_findings.append({
                    "type": "fetch_code",
                    "context": f"{file_path}:{line_number}",
                    "result": result
                })
                
                if self.display_callback:
                    self.display_callback(f"Fetched code from {file_path} around line {line_number}")
                
            except Exception as e:
                error = f"Error fetching code for {file_path}: {str(e)}"
                context.current_findings.append({
                    "type": "fetch_code",
                    "context": code_context,
                    "result": error
                })
                
                if self.display_callback:
                    self.display_callback(error) 