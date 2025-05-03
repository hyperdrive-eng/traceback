"""Claude API client for interacting with Claude 3.7 Sonnet."""

import os
import json
import time
from typing import Dict, Any, List, Optional, Union
from dataclasses import dataclass
import logging
from anthropic import Anthropic

# Configure logging
log_dir = os.path.expanduser("~/.traceback")
os.makedirs(log_dir, exist_ok=True)  # Ensure .traceback directory exists
log_file_path = os.path.join(log_dir, "claude_api.log")

# Configure our logger
logger = logging.getLogger("claude_client")
logger.setLevel(logging.DEBUG)

# Create file handler
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
class RateLimitState:
    """Track rate limit state."""
    last_request_time: float = 0.0  # Last request timestamp
    requests_remaining: int = 50  # Default to tier 1 limits
    tokens_remaining: int = 20000
    reset_time: Optional[float] = None
    
    def update_from_headers(self, headers: Dict[str, str]) -> None:
        """Update state from response headers."""
        if 'anthropic-ratelimit-requests-remaining' in headers:
            self.requests_remaining = int(headers['anthropic-ratelimit-requests-remaining'])
            logger.info(f"Rate limit update - Requests remaining: {self.requests_remaining}")
            
        if 'anthropic-ratelimit-tokens-remaining' in headers:
            self.tokens_remaining = int(headers['anthropic-ratelimit-tokens-remaining'])
            logger.info(f"Rate limit update - Tokens remaining: {self.tokens_remaining}")
            
        if 'anthropic-ratelimit-requests-reset' in headers:
            from datetime import datetime
            reset_time = datetime.fromisoformat(headers['anthropic-ratelimit-requests-reset'].replace('Z', '+00:00'))
            self.reset_time = reset_time.timestamp()
            logger.info(f"Rate limit update - Reset time: {reset_time.isoformat()}")
            
        self.last_request_time = time.time()
    
    def should_rate_limit(self) -> bool:
        """Check if we should rate limit."""
        current_time = time.time()
        
        # If we have no requests remaining, check if reset time has passed
        if self.requests_remaining <= 0:
            if self.reset_time and current_time < self.reset_time:
                logger.warning(f"Rate limit active - No requests remaining until {datetime.fromtimestamp(self.reset_time).isoformat()}")
                return True
                
        # Ensure minimum 200ms between requests as a safety measure
        time_since_last = current_time - self.last_request_time
        if time_since_last < 0.2:
            logger.info(f"Rate limit spacing - Only {time_since_last:.3f}s since last request (minimum 0.2s)")
            return True
            
        return False
        
    def wait_if_needed(self) -> None:
        """Wait if rate limiting is needed."""
        while self.should_rate_limit():
            current_time = time.time()
            wait_time = 0.2  # Default wait 200ms
            
            if self.reset_time and current_time < self.reset_time:
                wait_time = max(wait_time, self.reset_time - current_time)
                logger.warning(f"Rate limit wait - Waiting {wait_time:.2f}s for rate limit reset. Requests remaining: {self.requests_remaining}")
            else:
                # If we're just enforcing minimum spacing
                wait_time = max(0.2, 0.2 - (current_time - self.last_request_time))
                logger.info(f"Rate limit spacing - Waiting {wait_time:.3f}s between requests")
                
            time.sleep(wait_time)
            
            # Update current time after wait
            current_time = time.time()
            if self.reset_time and current_time >= self.reset_time:
                logger.info("Rate limit reset period has passed")
                self.requests_remaining = 50  # Reset to default limit
                self.reset_time = None

@dataclass
class ToolResponse:
    """Response from a tool call."""
    tool_name: str
    output: Any
    next_action: Optional[Dict[str, Any]] = None

class ClaudeClient:
    """Client for interacting with Claude API."""
    
    # Define available tools and their schemas
    TOOLS = [
        {
            "name": "fetch_files",
            "description": "Search for files containing specific patterns or strings",
            "input_schema": {
                "type": "object",
                "properties": {
                    "search_patterns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of strings or patterns to search for in files"
                    }
                },
                "required": ["search_patterns"]
            }
        },
        {
            "name": "fetch_logs",
            "description": "Fetch a specific page of logs for analysis. Pages are numbered from 1 to total_pages. The current page number and total pages will be shown in the analysis.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "page_number": {
                        "type": "integer",
                        "description": "Page number of logs to fetch (1-based indexing)"
                    }
                },
                "required": ["page_number"]
            }
        },
        {
            "name": "fetch_code",
            "description": "Fetch code from a specific file and line number",
            "input_schema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Path to the file to analyze"
                    },
                    "line_number": {
                        "type": "integer",
                        "description": "Line number to focus analysis on"
                    }
                },
                "required": ["filename", "line_number"]
            }
        },
        {
            "name": "show_root_cause",
            "description": "Display final root cause analysis when sufficient information is available",
            "input_schema": {
                "type": "object",
                "properties": {
                    "root_cause": {
                        "type": "string",
                        "description": "Detailed explanation of the root cause and recommendations"
                    }
                },
                "required": ["root_cause"]
            }
        }
    ]
    
    def __init__(self, api_key: Optional[str] = None, model: str = "claude-3-7-sonnet-latest"):
        """
        Initialize Claude API client.
        
        Args:
            api_key: Anthropic API key.
            model: Claude model to use.
        """
        self.api_key = api_key
        if not self.api_key:
            raise ValueError("API key must be provided either as argument or in ANTHROPIC_API_KEY environment variable")
            
        self.model = model
        self.client = Anthropic(api_key=self.api_key)
        self.max_tokens = 4096
        self.rate_limit_state = RateLimitState()
        self.analyzed_pages = set()  # Track which pages have been analyzed

    def analyze_error(self, error_input: str, findings: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Ask Claude to analyze an error and suggest next steps.
        
        Returns a dictionary with:
        - tool: The name of the tool to use (fetch_files, fetch_logs, fetch_code, or show_root_cause)
        - params: Parameters for the tool
        - analysis: Any additional analysis text
        - error: Optional error message if something went wrong
        """
        try:
            # Wait if rate limiting is needed
            self.rate_limit_state.wait_if_needed()
            
            # Format findings for the prompt
            findings_str = ""
            if findings:
                findings_str = "\nCurrent Findings:\n" + "\n".join(
                    f"- {finding.get('type', 'Analysis')}: {finding.get('result', '')}"
                    for finding in findings
                )

            prompt = f"""
You are an expert system debugging assistant. Analyze this error and determine the next step.

ERROR CONTEXT:
{error_input}

{findings_str}

Choose the appropriate tool to continue the investigation:
1. fetch_files: Search for files containing specific patterns (provide array of search patterns)
2. fetch_logs: Get a specific page of logs (provide page number)
3. fetch_code: Get code from a specific file and line (provide filename and line number)
4. show_root_cause: If you have enough information to determine the root cause

IMPORTANT: If you request a log page, avoid requesting pages you've already seen.
If you hit a rate limit, wait and try with a smaller context in the next request.

Respond with the most appropriate tool and its parameters.
"""
            # Call Claude using the SDK
            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}],
                tools=self.TOOLS,
                tool_choice={"type": "any"}
            )
            
            # Update rate limit state from response headers
            if hasattr(response, '_response'):
                self.rate_limit_state.update_from_headers(response._response.headers)
            
            logger.debug(f"Raw API response: {json.dumps(response.model_dump(), indent=2)}")
            
            # Extract tool choice from content array
            content = response.content
            tool_response = None
            
            # Look for tool_use in content array
            for item in content:
                if item.type == 'tool_use':
                    tool_response = {
                        'tool': item.name,
                        'params': item.input,
                        'analysis': '',  # Tool calls don't include analysis text
                        'error': None
                    }
                    break
                elif item.type == 'text':
                    # If it's a text response, treat it as analysis
                    tool_response = {
                        'tool': None,
                        'params': {},
                        'analysis': item.text,
                        'error': None
                    }
                    break
            
            # If no valid content found, use empty response
            if not tool_response:
                tool_response = {
                    'tool': None,
                    'params': {},
                    'analysis': 'No valid response from LLM',
                    'error': None
                }
                
            logger.info(f"LLM suggested tool: {tool_response['tool']}")
            if tool_response['params']:
                logger.info(f"Tool parameters: {json.dumps(tool_response['params'], indent=2)}")
            
            return tool_response
            
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error during LLM analysis: {error_msg}")
            
            # Handle rate limit errors specially
            if "rate_limit_error" in error_msg:
                time.sleep(5)  # Wait 5 seconds before next attempt
                return {
                    'tool': None,
                    'params': {},
                    'analysis': 'Rate limit reached. Please try again with a smaller context.',
                    'error': 'Rate limit error'
                }
            
            return {
                'tool': None,
                'params': {},
                'analysis': '',
                'error': error_msg
            }

    def analyze_code(self, code: str, file_path: str, line_number: int) -> str:
        """
        Ask Claude to analyze a code snippet.
        """
        logger.info(f"=== Starting code analysis for {file_path}:{line_number} ===")
        logger.info(f"Code length: {len(code)} chars")
        
        try:
            # Wait if rate limiting is needed
            self.rate_limit_state.wait_if_needed()
            
            prompt = f"""
Analyze this code snippet and explain what it does, focusing on line {line_number}.
Pay special attention to potential issues or bugs.

File: {file_path}
Line: {line_number}

CODE:
{code}
"""
            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}]
            )
            
            # Update rate limit state from response headers
            if hasattr(response, '_response'):
                self.rate_limit_state.update_from_headers(response._response.headers)
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Code analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            logger.error(f"Error during code analysis: {str(e)}")
            return f"Error analyzing code: {str(e)}"
        finally:
            logger.info("=== Code analysis complete ===")

    def analyze_logs(self, logs: str, current_page: int, total_pages: int) -> str:
        """
        Ask Claude to analyze log content.
        
        Args:
            logs: The log content to analyze
            current_page: Current page number (1-based)
            total_pages: Total number of available log pages
        """
        logger.info("=== Starting log analysis ===")
        logger.info(f"Log length: {len(logs)} chars")
        logger.info(f"Analyzing page {current_page} of {total_pages}")
        logger.info(f"Previously analyzed pages: {sorted(list(self.analyzed_pages))}")
        
        # Add this page to analyzed pages before analysis
        # This ensures it's tracked even if analysis fails
        self.analyzed_pages.add(current_page)
        
        try:
            # Wait if rate limiting is needed
            self.rate_limit_state.wait_if_needed()
            
            prompt = f"""
Analyze these logs and identify:
1. Any error patterns or issues
2. Relevant context around the errors
3. Potential root causes
4. Suggested next steps for investigation

You are looking at page {current_page} out of {total_pages} total pages of logs.
You have already analyzed pages: {sorted(list(self.analyzed_pages))}
If you need to see other pages, you can request them using the fetch_logs tool, but avoid requesting pages you've already analyzed.

IMPORTANT: If you hit a rate limit, try analyzing with less context in your next request.

LOGS:
{logs}"""

            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}]
            )
            
            # Update rate limit state from response headers
            if hasattr(response, '_response'):
                self.rate_limit_state.update_from_headers(response._response.headers)
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Log analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error during log analysis: {error_msg}")
            
            # Handle rate limit errors specially
            if "rate_limit_error" in error_msg:
                time.sleep(5)  # Wait 5 seconds before next attempt
                return "Rate limit reached. Please try again with a smaller context."
                
            return f"Error analyzing logs: {error_msg}"
        finally:
            logger.info("=== Log analysis complete ===")

    def analyze_entry_point(self, logs: str, entry_point: str) -> str:
        """
        Ask Claude to analyze a specific log entry point.
        """
        logger.info("=== Starting entry point analysis ===")
        logger.info(f"Entry point: {entry_point}")
        
        try:
            # Wait if rate limiting is needed
            self.rate_limit_state.wait_if_needed()
            
            prompt = f"""
Analyze this specific log entry and its context:

ENTRY POINT:
{entry_point}

FULL LOGS:
{logs}

Explain:
1. What this log entry indicates
2. Relevant context before and after
3. Any patterns or issues related to this entry
"""
            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}]
            )
            
            # Update rate limit state from response headers
            if hasattr(response, '_response'):
                self.rate_limit_state.update_from_headers(response._response.headers)
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Entry point analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            logger.error(f"Error during entry point analysis: {str(e)}")
            return f"Error analyzing entry point: {str(e)}"
        finally:
            logger.info("=== Entry point analysis complete ===")
