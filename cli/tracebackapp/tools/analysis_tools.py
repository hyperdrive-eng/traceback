"""Tools for analyzing logs, stack traces, and code locations."""

import os
import logging
import subprocess
from dataclasses import dataclass
from typing import List, Optional, Callable, Any, Dict, Set
from .claude_client import ClaudeClient

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
    current_findings: Dict[str, Any]  # Findings so far
    current_page: int = 0  # Current page number (0-based internally)
    total_pages: int = 0  # Total number of pages
    page_size: int = 50000  # Characters per page
    overlap_size: int = 5000  # Characters of overlap between pages
    all_logs: str = ""  # Complete log content
    current_page_content: Optional[str] = None  # Content of the current page being analyzed 
    iterations: int = 0
    MAX_ITERATIONS = 50
    
    def __init__(self, initial_input: str):
        self.current_findings = {
            "searched_patterns": set(),
            "fetched_files": set(),  # This will store individual file paths, not sets of files
            "fetched_logs_pages": set([1]),
            "fetched_code": set(),
            "currentAnalysis": ""
        }
        self.all_logs = initial_input
        # Calculate total pages based on content length and overlap
        self.total_pages = max(1, (len(initial_input) + self.page_size - 1) // (self.page_size - self.overlap_size))
        self.current_page = 0  # Start at first page (0-based internally)
        self.current_page_content = "Logs: \n Page 1 of " + str(self.total_pages) + ":\n" + self.get_current_page() 
        logger.info(f"Total pages of Logs: {self.total_pages}")
        
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
        self.context = None
        
    def analyze(self, initial_input: str, display_callback: Optional[Callable[[str], None]]) -> None:
        """
        Analyze input using Claude and execute suggested tools.
        
        Args:
            initial_input: Initial input to analyze (logs, error message, etc)
            display_callback: Optional callback to display progress
        """
        
        # Initialize context if not provided
        if not self.context:
            self.context = AnalysisContext(initial_input)
        
        # Store display callback
        self.display_callback = display_callback
        
        # Prevent infinite recursion
        if self.context.iterations >= self.context.MAX_ITERATIONS:
            logger.warning(f"Analysis stopped: Maximum iterations ({self.context.MAX_ITERATIONS}) reached")
            if display_callback:
                display_callback(f"Analysis stopped: Maximum iterations ({self.context.MAX_ITERATIONS}) reached")
            return
            
        # Log the current state
        logger.info(f"=== Starting new LLM analysis ===")
        logger.info(f"Input length: {len(self.context.current_page_content)}")
        logger.info(f"Current findings: {self.context.current_findings}")
        
        response = self.claude.analyze_error(self.context.current_page_content, self.context.current_findings)
        
        if not response or 'tool' not in response:
            logger.error("Invalid response from Claude")
            return
            
        tool_name = response.get('tool')
        tool_params = response.get('params', {})
        analysis = response.get('analysis', '')
            
        if display_callback and analysis:
            display_callback(analysis)
        if tool_params.get('currentAnalysis') and display_callback:
            display_callback(f"Current analysis: {tool_params.get('currentAnalysis')}")
            self.context.current_findings['currentAnalysis'] = tool_params.get('currentAnalysis')

        try:
            # Execute the suggested tool
            if tool_name == 'fetch_files':
                search_patterns = tool_params.get('search_patterns', [])
                if search_patterns:
                    self._fetch_files(self.context, search_patterns)
                    self.context.iterations += 1
                    display_callback(f"Iteration {self.context.iterations}: Sending fetched files to LLM")
                    self.analyze(self.context.current_page_content, display_callback)
                    return
            elif tool_name == 'fetch_logs':
                page_number = tool_params.get('page_number')
                
                if page_number is not None and page_number in self.context.current_findings['fetched_logs_pages']:
                    logger.warning(f"Page {page_number} has already been analyzed, skipping")
                    display_callback(f"Page {page_number} has already been analyzed, skipping")
                
                if self.context.advance_page():
                    self.context.current_page_content = "Logs: \n Page " + str(self.context.get_current_page_number()) + " of " + str(self.context.get_total_pages()) + ":\n" + self.context.get_current_page()
                    self.context.current_findings['fetched_logs_pages'].add(page_number)
                    display_callback(f"Sending next page to LLM")
                    self.analyze(self.context.current_page_content, display_callback)
                else:
                    self.context.current_page_content = "No more pages to analyze"
                    display_callback(f"No more pages to analyze. Letting LLM know")
                    self.analyze(self.context.current_page_content, display_callback)

                return
                    
            elif tool_name == 'fetch_code':
                filename = tool_params.get('filename')
                line_number = tool_params.get('line_number')
                if filename and line_number:
                    self._fetch_code(self.context, filename, line_number)
                    self.context.iterations += 1
                    display_callback(f"Iteration {self.context.iterations}: Sending fetched code to LLM")
                    self.analyze(self.context.current_page_content, display_callback)
                    return
                    
            elif tool_name == 'show_root_cause':
                root_cause = tool_params.get('root_cause', '')
                if root_cause and display_callback:
                    display_callback(f"\nRoot Cause Analysis:\n{root_cause}")
                return
                
            else:
                logger.warning(f"Unknown tool: {tool_name}")
                return
            
        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {str(e)}")
            display_callback(f"Error executing tool {tool_name}: {str(e)}")

    def _get_gitignore_dirs(self) -> List[str]:
        """Get directory patterns from .gitignore file."""
        gitignore_path = os.path.join(self.workspace_root, '.gitignore')
        dirs_to_exclude = set()
        
        try:
            if os.path.exists(gitignore_path):
                with open(gitignore_path, 'r') as f:
                    for line in f:
                        line = line.strip()
                        # Skip comments and empty lines
                        if not line or line.startswith('#'):
                            continue
                        # Look for directory patterns (ending with /)
                        if line.endswith('/'):
                            dirs_to_exclude.add(line.rstrip('/'))
                        # Also add common build/binary directories if not already specified
                dirs_to_exclude.update(['target', 'node_modules', '.git', 'dist', 'build'])
                logger.info(f"Found directories to exclude: {sorted(dirs_to_exclude)}")
            else:
                logger.info("No .gitignore file found, using default exclusions")
                dirs_to_exclude = {'target', 'node_modules', '.git', 'dist', 'build'}
        except Exception as e:
            logger.error(f"Error reading .gitignore: {str(e)}")
            dirs_to_exclude = {'target', 'node_modules', '.git', 'dist', 'build'}
            
        return sorted(list(dirs_to_exclude))
        
    def _fetch_files(self, context: AnalysisContext, search_patterns: List[str]) -> None:
        """
        Fetch files matching the given search patterns.
        
        Args:
            context: Analysis context
            search_patterns: List of strings to search for in files
        """
        import time
        start_time = time.time()
        
        logger.info("=" * 50)
        logger.info("Starting file search operation")
        logger.info("=" * 50)
        logger.info(f"Search patterns ({len(search_patterns)}): {search_patterns}")
        logger.info(f"Working directory: {os.getcwd()}")
        logger.info(f"Workspace root: {self.workspace_root}")
        
        if self.display_callback:
            self.display_callback(f"Searching for files matching patterns: {', '.join(search_patterns)}")
            
        found_files = set()
        patterns_matched = {pattern: 0 for pattern in search_patterns}
        
        # Get directories to exclude from .gitignore
        exclude_dirs = self._get_gitignore_dirs()
        exclude_args = []
        for dir_name in exclude_dirs:
            exclude_args.extend(['--exclude-dir', dir_name])
        
        # Search for each pattern
        for pattern in search_patterns:
            pattern_start_time = time.time()
            logger.info("-" * 40)
            logger.info(f"Processing pattern: {pattern}")
            
            try:
                # Use grep with recursive search and exclusions
                grep_cmd = ['grep', '-r', '-l', *exclude_args, pattern]
                if self.workspace_root:
                    grep_cmd.append(self.workspace_root)
                else:
                    grep_cmd.append('.')
            
                logger.info(f"Running grep command: {' '.join(grep_cmd)}")
                grep_result = subprocess.run(grep_cmd, capture_output=True, text=True)
            
                # grep returns 0 if matches found, 1 if no matches (not an error)
                if grep_result.returncode not in [0, 1]:
                    error = f"Grep command failed: {grep_result.stderr}"
                    logger.error(error)
                    continue
                
                # Process matches
                matches = grep_result.stdout.splitlines()
                for file in matches:
                    found_files.add(file)
                    patterns_matched[pattern] += 1
                    logger.info(f"Match found: {file}")
                
                pattern_duration = time.time() - pattern_start_time
                logger.info(f"Pattern '{pattern}' completed in {pattern_duration:.2f}s")
                logger.info(f"Found {patterns_matched[pattern]} matches for this pattern")
                
            except Exception as e:
                error = f"Error searching for pattern '{pattern}': {str(e)}"
                logger.error(error)
                if self.display_callback:
                    self.display_callback(error)
        
        total_duration = time.time() - start_time
        
        # Log final statistics
        logger.info("=" * 50)
        logger.info("Search operation completed")
        logger.info(f"Total time: {total_duration:.2f}s")
        logger.info(f"Total unique files with matches: {len(found_files)}")
        logger.info("Pattern matches:")
        for pattern, count in patterns_matched.items():
            logger.info(f"  - '{pattern}': {count} files")
        logger.info("=" * 50)
        
        # Add finding with results
        if found_files:
            # Update the set with individual file paths instead of adding the set itself
            context.current_findings['fetched_files'].update(found_files)
            # Convert search patterns list to tuple to make it hashable
            context.current_findings['searched_patterns'].update(search_patterns)
            context.current_page_content = f"Found {len(found_files)} files matching patterns: {', '.join(search_patterns)}"
            context.current_page_content += f"\n\nList of files:\n{'\n'.join(sorted(found_files))}"
            logger.info(f"Found {len(found_files)} files matching patterns")
            if self.display_callback:
                self.display_callback(f"Found {len(found_files)} files matching patterns")
        else:
            context.current_page_content = f"No files found matching patterns: {', '.join(search_patterns)}"
            
            logger.info("No files found matching patterns")
            if self.display_callback:
                self.display_callback("No files found matching patterns")

    def _fetch_code(self, context: AnalysisContext, filename: str, line_number: int) -> None:
        """
        Fetch code based on file and line number hints in the context.
        
        Args:
            context: Analysis context
            filename: Name of the file to fetch
            line_number: Line number to focus on
        """
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
            
            self.context.current_findings['fetched_code'].add((filename, line_number))
            self.context.current_page_content = f"Code: \n File: {filename} \n Line: {line_number}"
            self.context.current_page_content += f"\n\nCode:\n{code}"
            
            logger.info(f"Successfully fetched code from {found_path} around line {line_number}")
            if self.display_callback:
                self.display_callback(f"Fetched code from {filename} around line {line_number}")
                
        except Exception as e:
            error = f"Error fetching code: {str(e)}"
            logger.error(error)

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