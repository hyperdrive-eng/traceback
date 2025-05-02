"""Claude API client for interacting with Claude 3.7 Sonnet."""

import os
import json
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
            "name": "get_info",
            "description": "Gather more information about the problem",
            "input_schema": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["fetch_files", "fetch_logs", "fetch_code"],
                        "description": "Type of information to gather"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context for the information request"
                    }
                },
                "required": ["type", "context"]
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

    def analyze_error(self, error_input: str, findings: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Ask Claude to analyze an error and suggest next steps.
        """
        logger.info("=== Starting new LLM analysis ===")
        logger.info(f"Input length: {len(error_input)} chars")
        logger.info(f"Current findings count: {len(findings)}")
        
        try:
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

Choose the appropriate tool to continue the investigation. If you have enough information to determine the root cause, use show_root_cause. Otherwise, use get_info to gather more specific information.
"""
            
            # Call Claude using the SDK
            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}],
                tools=self.TOOLS,
                tool_choice={"type": "any"}
            )
            
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
                        'analysis': ''  # Tool calls don't include analysis text
                    }
                    break
                elif item.type == 'text':
                    # If it's a text response, treat it as analysis
                    tool_response = {
                        'tool': None,
                        'params': {},
                        'analysis': item.text
                    }
                    break
            
            # If no valid content found, use empty response
            if not tool_response:
                tool_response = {
                    'tool': None,
                    'params': {},
                    'analysis': 'No valid response from LLM'
                }
                
            logger.info(f"LLM suggested tool: {tool_response['tool']}")
            if tool_response['params']:
                logger.info(f"Tool parameters: {json.dumps(tool_response['params'], indent=2)}")
            
            return tool_response
            
        except Exception as e:
            logger.error(f"Error during LLM analysis: {str(e)}")
            return {"tool": None, "error": str(e)}
        finally:
            logger.info("=== LLM analysis complete ===")

    def analyze_code(self, code: str, file_path: str, line_number: int) -> str:
        """
        Ask Claude to analyze a code snippet.
        """
        logger.info(f"=== Starting code analysis for {file_path}:{line_number} ===")
        logger.info(f"Code length: {len(code)} chars")
        
        try:
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
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Code analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            logger.error(f"Error during code analysis: {str(e)}")
            return f"Error analyzing code: {str(e)}"
        finally:
            logger.info("=== Code analysis complete ===")

    def analyze_logs(self, logs: str) -> str:
        """
        Ask Claude to analyze log content.
        """
        logger.info("=== Starting log analysis ===")
        logger.info(f"Log length: {len(logs)} chars")
        
        try:
            prompt = """
Analyze these logs and identify:
1. Any error patterns or issues
2. Relevant context around the errors
3. Potential root causes
4. Suggested next steps for investigation

LOGS:
""" + logs

            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[{"role": "user", "content": prompt}]
            )
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Log analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            logger.error(f"Error during log analysis: {str(e)}")
            return f"Error analyzing logs: {str(e)}"
        finally:
            logger.info("=== Log analysis complete ===")

    def analyze_entry_point(self, logs: str, entry_point: str) -> str:
        """
        Ask Claude to analyze a specific log entry point.
        """
        logger.info("=== Starting entry point analysis ===")
        logger.info(f"Entry point: {entry_point}")
        
        try:
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
            
            analysis = response.content[0].text if response.content else "No analysis provided"
            logger.info(f"Entry point analysis received: {len(analysis)} chars")
            return analysis
            
        except Exception as e:
            logger.error(f"Error during entry point analysis: {str(e)}")
            return f"Error analyzing entry point: {str(e)}"
        finally:
            logger.info("=== Entry point analysis complete ===")
