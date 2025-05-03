"""Tools for analyzing logs, stack traces, and code locations."""

import os
import re
import ast
import json
import logging
import subprocess
from dataclasses import dataclass, asdict
from typing import List, Optional, Callable, Any, Dict, Union, Set, TypedDict
from pathlib import Path
from .claude_client import ClaudeClient, ToolResponse

# Configure logging
log_dir = os.path.expanduser("~/.traceback")
os.makedirs(log_dir, exist_ok=True)  # Ensure .traceback directory exists
log_file_path = os.path.join(log_dir, "claude_api.log")

# Configure our logger
logger = logging.getLogger("analysis_tools")
logger.setLevel(logging.DEBUG)

# Create file handler if not already added
if not logger.handlers:
    file_handler = logging.FileHandler(log_file_path)
    file_handler.setLevel(logging.DEBUG)
    
    # Create formatter - simplified format focusing on key info
    formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
    file_handler.setFormatter(formatter)
    
    # Add handler to logger
    logger.addHandler(file_handler)

# Prevent propagation to avoid duplicate logs
logger.propagate = False

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
class AnalysisContext:
    """Analysis context for a debugging session."""
    initial_input: str  # Initial input (logs, code, etc.)
    current_findings: List[Dict[str, Any]]  # Findings so far
    current_page: int = 0  # Current page number (0-based internally)
    total_pages: int = 0  # Total number of pages
    page_size: int = 50000  # Characters per page
    overlap_size: int = 5000  # Characters of overlap between pages
    all_logs: str = ""  # Complete log content
    analyzed_pages: Set[int] = None  # Set of analyzed pages (1-based)
    
    def __init__(self, initial_input: str, current_findings: List[Dict[str, Any]] = None):
        self.initial_input = initial_input
        self.current_findings = current_findings or []
        self.all_logs = initial_input
        # Calculate total pages based on content length and overlap
        self.total_pages = max(1, (len(initial_input) + self.page_size - 1) // (self.page_size - self.overlap_size))
        self.current_page = 0  # Start at first page (0-based internally)
        self.analyzed_pages = set()  # Initialize empty set for analyzed pages
        logger.info(f"Total pages calculated: {self.total_pages} (input length: {len(initial_input)}, page size: {self.page_size}, overlap: {self.overlap_size})")

    def get_current_page(self) -> str:
        """Get the current page of logs with overlap."""
        # Calculate start and end positions based on 0-based page number
        start = max(0, self.current_page * (self.page_size - self.overlap_size))
        end = min(len(self.all_logs), start + self.page_size)
        
        # If this is not the first page, include overlap from previous page
        if self.current_page > 0:
            start = max(0, start - self.overlap_size)
            
        return self.all_logs[start:end]

    def advance_page(self) -> bool:
        """
        Advance to next page. Returns False if no more pages.
        Note: Uses 0-based page numbers internally.
        """
        if self.current_page + 1 >= self.total_pages:
            return False
        self.current_page += 1
        return True

    def get_current_page_number(self) -> int:
        """Get the current page number in 1-based format for external use."""
        return self.current_page + 1

    def get_total_pages(self) -> int:
        """Get the total number of pages."""
        return self.total_pages

    def mark_page_analyzed(self, page_number: int) -> None:
        """Mark a page as analyzed (using 1-based page numbers)."""
        self.analyzed_pages.add(page_number)

    def is_page_analyzed(self, page_number: int) -> bool:
        """Check if a page has been analyzed (using 1-based page numbers)."""
        return page_number in self.analyzed_pages

    def get_analyzed_pages(self) -> List[int]:
        """Get list of analyzed pages in sorted order (1-based)."""
        return sorted(list(self.analyzed_pages))

class Analyzer:
    """Analyzer for debugging issues using Claude."""
    
    def __init__(self, workspace_root: Optional[str] = None):
        """Initialize the analyzer."""
        self.workspace_root = workspace_root or os.getcwd()
        logger.info(f"Initialized analyzer with workspace root: {self.workspace_root}")
        
        # Load API key from ~/.traceback/api_key
        api_key = None
        api_key_file = os.path.expanduser("~/.traceback/api_key")
        try:
            if os.path.exists(api_key_file):
                with open(api_key_file, 'r') as f:
                    api_key = f.read().strip()
        except Exception:
            pass
            
        self.claude = ClaudeClient(api_key=api_key)
        self.display_callback: Optional[Callable[[str], None]] = None
        
    def analyze(self, initial_input: str, display_callback: Optional[Callable[[str], None]] = None, context: Optional[AnalysisContext] = None, iteration: int = 0) -> None:
        """
        Analyze input using Claude and execute suggested tools.
        
        Args:
            initial_input: Initial input to analyze (logs, error message, etc)
            display_callback: Optional callback to display progress
            context: Optional existing analysis context
            iteration: Current iteration count to prevent infinite recursion
        """
        # Prevent infinite recursion
        MAX_ITERATIONS = 50
        if iteration >= MAX_ITERATIONS:
            logger.warning(f"Analysis stopped: Maximum iterations ({MAX_ITERATIONS}) reached")
            if display_callback:
                display_callback(f"Analysis stopped: Maximum iterations ({MAX_ITERATIONS}) reached")
            return

        # Initialize context if not provided
        if not context:
            context = AnalysisContext(initial_input)
            
        # Get current page of input
        current_input = context.get_current_page()
        
        # Add analyzed pages to findings so Claude knows what's been analyzed
        analyzed_pages = context.get_analyzed_pages()
        if analyzed_pages:
            context.current_findings.append({
                "type": "analyzed_pages",
                "result": f"Previously analyzed pages: {analyzed_pages}"
            })
            
        # Log the current state
        logger.info(f"=== Starting new LLM analysis ===")
        logger.info(f"Input length: {len(current_input)} chars")
        logger.info(f"Current findings count: {len(context.current_findings)}")
        logger.info(f"Previously analyzed pages: {analyzed_pages}")
        
        # Get Claude's analysis and tool suggestion
        response = self.claude.analyze_error(current_input, context.current_findings)
        
        # Remove the analyzed_pages finding so it doesn't accumulate
        if context.current_findings and context.current_findings[-1].get("type") == "analyzed_pages":
            context.current_findings.pop()
        
        if not response or 'tool' not in response:
            logger.error("Invalid response from Claude")
            return
            
        tool_name = response.get('tool')
        tool_params = response.get('params', {})
        analysis = response.get('analysis', '')
        
        if display_callback and analysis:
            display_callback(analysis)
        
        # Execute the suggested tool
        try:
            if tool_name == 'fetch_files':
                search_patterns = tool_params.get('search_patterns', [])
                if search_patterns:
                    self._fetch_files(context, search_patterns)
                    # Continue analysis with next iteration
                    self.analyze(initial_input, display_callback, context, iteration + 1)
                    
            elif tool_name == 'fetch_logs':
                page_number = tool_params.get('page_number')
                if page_number is not None:
                    # Check if page has already been analyzed
                    if context.is_page_analyzed(page_number):
                        logger.warning(f"Page {page_number} has already been analyzed, skipping")
                        if display_callback:
                            display_callback(f"Page {page_number} has already been analyzed, skipping")
                        # Try next page
                        if context.advance_page():
                            self.analyze(initial_input, display_callback, context, iteration + 1)
                        return
                    
                    # Mark page as analyzed before fetching
                    context.mark_page_analyzed(page_number)
                    self._fetch_logs(context, page_number)
                    # Continue analysis with next iteration
                    self.analyze(initial_input, display_callback, context, iteration + 1)
                    
            elif tool_name == 'fetch_code':
                filename = tool_params.get('filename')
                line_number = tool_params.get('line_number')
                if filename and line_number:
                    self._fetch_code(context, filename, line_number)
                    # Continue analysis with next iteration
                    self.analyze(initial_input, display_callback, context, iteration + 1)
                    
            elif tool_name == 'show_root_cause':
                root_cause = tool_params.get('root_cause', '')
                if root_cause and display_callback:
                    display_callback(f"\nRoot Cause Analysis:\n{root_cause}")
                return
                
            else:
                logger.warning(f"Unknown tool: {tool_name}")
                return
                
            # If we have more pages to analyze, continue with next page
            if context.advance_page():
                self.analyze(initial_input, display_callback, context, iteration + 1)

        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {str(e)}")
            if display_callback:
                display_callback(f"Error executing tool {tool_name}: {str(e)}")
            # Try to continue with next page if available
            if context.advance_page():
                self.analyze(initial_input, display_callback, context, iteration + 1)
        
    def _fetch_files(self, context: AnalysisContext, search_patterns: List[str]) -> None:
        """
        Fetch files matching the given search patterns.
        
        Args:
            context: Analysis context
            search_patterns: List of strings to search for in files
        """
        logger.info("=== Starting file fetch ===")
        logger.info(f"Search patterns: {search_patterns}")
        
        if self.display_callback:
            self.display_callback(f"Searching for files matching patterns: {', '.join(search_patterns)}")
            
        found_files = set()
        
        # Search for each pattern
        for pattern in search_patterns:
            try:
                # Use grep instead of ripgrep for better compatibility
                cmd = ['grep', '-r', '-l', pattern]
                if self.workspace_root:
                    cmd.append(self.workspace_root)
                else:
                    cmd.append('.')
                    
                result = subprocess.run(cmd, capture_output=True, text=True)
                
                if result.returncode not in [0, 1]:  # 1 means no matches, which is ok
                    raise subprocess.CalledProcessError(result.returncode, cmd, result.stdout, result.stderr)
                    
                # Add found files to set
                for file in result.stdout.splitlines():
                    found_files.add(file)
                    
            except Exception as e:
                error = f"Error searching for pattern '{pattern}': {str(e)}"
                logger.error(error)
                if self.display_callback:
                    self.display_callback(error)
        
        # Add finding with results
        if found_files:
            result = "Found files:\n" + "\n".join(sorted(found_files))
            context.current_findings.append({
                "type": "fetch_files",
                "context": f"Search patterns: {', '.join(search_patterns)}",
                "result": result
            })
            
            logger.info(f"Found {len(found_files)} files matching patterns")
            if self.display_callback:
                self.display_callback(f"Found {len(found_files)} files matching patterns")
        else:
            result = f"No files found matching patterns: {', '.join(search_patterns)}"
            context.current_findings.append({
                "type": "fetch_files",
                "context": f"Search patterns: {', '.join(search_patterns)}",
                "result": result
            })
            
            logger.info("No files found matching patterns")
            if self.display_callback:
                self.display_callback("No files found matching patterns")
        
    def _fetch_logs(self, context: AnalysisContext, page_number: int) -> None:
        """
        Fetch a specific page of logs.
        
        Args:
            context: Analysis context
            page_number: Page number to fetch (1-based)
        """
        logger.info("=== Starting log fetch ===")
        logger.info(f"Requested page: {page_number}")
        logger.info(f"Previously analyzed pages: {context.get_analyzed_pages()}")
        
        if self.display_callback:
            self.display_callback(f"Fetching log page {page_number} of {context.total_pages}")
            
        try:
            # Convert 1-based page number to 0-based for internal use
            zero_based_page = page_number - 1
            
            # Set the current page
            context.current_page = zero_based_page
            
            # Get the page content
            page_content = context.get_current_page()
            
            # Add finding
            context.current_findings.append({
                "type": "fetch_logs",
                "context": f"Page {page_number} of {context.total_pages} (analyzed pages: {context.get_analyzed_pages()})",
                "result": page_content
            })
            
            logger.info(f"Successfully fetched page {page_number}")
            if self.display_callback:
                self.display_callback(f"Successfully fetched page {page_number}")
                
        except Exception as e:
            error = f"Error fetching log page {page_number}: {str(e)}"
            logger.error(error)
            context.current_findings.append({
                "type": "fetch_logs",
                "context": f"Page {page_number}",
                "result": error
            })
            if self.display_callback:
                self.display_callback(error)
        
    def _fetch_code(self, context: AnalysisContext, filename: str, line_number: int) -> None:
        """Fetch code based on file and line number hints in the context."""
        logger.info(f"=== Starting code fetch ===")
        logger.info(f"Code context: {filename} at line {line_number}")
        
        if self.display_callback:
            self.display_callback(f"Fetching code related to: {filename} at line {line_number}")
            
        try:
            # Get possible local paths
            possible_paths = self._translate_path(filename)
            found_path = None
            
            # Try each possible path
            for path in possible_paths:
                if os.path.exists(path):
                    found_path = path
                    logger.info(f"Found equivalent file: {path}")
                    break
            
            if not found_path:
                error_msg = f"File not found in any of the possible locations: {possible_paths}"
                logger.warning(error_msg)
                raise FileNotFoundError(error_msg)
            
            # Read the file
            with open(found_path, 'r') as f:
                lines = f.readlines()
                
            # Get code context (20 lines before and after)
            context_lines = 20
            start = max(0, line_number - context_lines)
            end = min(len(lines), line_number + context_lines + 1)
            code = ''.join(lines[start:end])
            
            # Add finding
            result = f"Code from {filename} (line {line_number}):\n\n{code}"
            context.current_findings.append({
                "type": "fetch_code",
                "context": f"{filename}:{line_number}",
                "result": result,
                "local_path": found_path
            })
            
            logger.info(f"Successfully fetched code from {found_path} around line {line_number}")
            if self.display_callback:
                self.display_callback(f"Fetched code from {filename} around line {line_number}")
                
        except Exception as e:
            error = f"Error fetching code: {str(e)}"
            logger.error(error)
            context.current_findings.append({
                "type": "fetch_code",
                "context": f"{filename}:{line_number}",
                "result": error
            })
            if self.display_callback:
                self.display_callback(error)
        
    def _translate_path(self, filename: str) -> List[str]:
        """
        Translate a filename to possible local paths.
        
        Args:
            filename: The filename to translate
            
        Returns:
            List of possible local paths
        """
        possible_paths = []
        
        # Try direct path
        if os.path.isabs(filename):
            possible_paths.append(filename)
        
        # Try relative to workspace root
        workspace_path = os.path.join(self.workspace_root, filename)
        possible_paths.append(workspace_path)
        
        # Try without leading path components
        base_name = os.path.basename(filename)
        possible_paths.append(os.path.join(self.workspace_root, base_name))
        
        return possible_paths 