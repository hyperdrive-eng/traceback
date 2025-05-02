"""Claude API client for interacting with Claude 3.7 Sonnet."""

import os
import json
from typing import Dict, Any, List, Optional, Union
from dataclasses import dataclass
import requests
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('claude_api.log'),
        logging.StreamHandler()
    ]
)

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
    
    def __init__(self, api_key: Optional[str] = None, model: str = "claude-3-7-sonnet-20250219"):
        """
        Initialize Claude API client.
        
        Args:
            api_key: Anthropic API key. If not provided, will try to get from ANTHROPIC_API_KEY env var.
            model: Claude model to use.
        """
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ValueError("API key must be provided either as argument or in ANTHROPIC_API_KEY environment variable")
            
        self.model = model
        self.api_url = "https://api.anthropic.com/v1/messages"
        self.max_tokens = 4096  # Default max tokens for response
        self.logger = logging.getLogger(__name__)

    def analyze_error(self, error_context: str, current_findings: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """
        Analyze an error with Claude and determine next steps.
        
        Args:
            error_context: Current error context to analyze
            current_findings: List of previous findings and tool outputs
            
        Returns:
            Dict containing analysis and next action
        """
        findings_str = ""
        if current_findings:
            findings_str = "\nCurrent Findings:\n" + "\n".join(
                f"- {finding.get('tool', 'Analysis')}: {finding.get('output', '')}"
                for finding in current_findings
            )

        prompt = f"""
You are an expert system debugging assistant. Analyze the following error context and determine the next step in debugging.

ERROR CONTEXT:
{error_context}
{findings_str}

Analyze the error and choose the appropriate tool to continue the investigation. If you have enough information to determine the root cause, use show_root_cause. Otherwise, use get_info to gather more specific information.
"""
        response = self._call_claude(prompt, tools=self.TOOLS)
        
        try:
            return json.loads(response)
        except json.JSONDecodeError:
            # If response isn't JSON, wrap it in a basic structure
            return {
                "analysis": response,
                "next_action": None
            }

    def _call_claude(self, prompt: str, tools: Optional[List[Dict[str, Any]]] = None) -> str:
        """
        Call Claude API with a prompt.
        
        Args:
            prompt: The prompt to send to Claude
            tools: Optional list of tools to make available to Claude
            
        Returns:
            Claude's response text
        """
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        
        data = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [{"role": "user", "content": prompt}]
        }
        
        if tools:
            data["tools"] = tools
            data["tool_choice"] = "any"
            
        # Log the API request
        self.logger.info("Calling Claude API:")
        self.logger.info(f"Prompt: {prompt[:500]}..." if len(prompt) > 500 else f"Prompt: {prompt}")
        if tools:
            self.logger.info(f"Tools: {json.dumps(tools, indent=2)}")
            
        try:
            response = requests.post(self.api_url, headers=headers, json=data)
            response.raise_for_status()
            
            response_json = response.json()
            response_text = response_json["content"][0]["text"]
            
            # Log the API response
            self.logger.info("Claude API Response:")
            self.logger.info(f"Response: {response_text[:500]}..." if len(response_text) > 500 else f"Response: {response_text}")
            
            return response_text
            
        except Exception as e:
            self.logger.error(f"Error calling Claude API: {str(e)}")
            raise