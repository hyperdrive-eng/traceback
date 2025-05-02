"""Claude API client for interacting with Claude 3.7 Sonnet."""

import os
import json
import requests
from typing import Dict, Any, List, Optional

class ClaudeClient:
    """Client for interacting with Claude API."""
    
    def __init__(self, api_key: Optional[str] = None, model: str = "claude-3-7-sonnet-20240229"):
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
        
    def analyze_logs(self, logs: str) -> str:
        """
        Analyze logs with Claude to identify potential issues.
        
        Args:
            logs: Log content to analyze
            
        Returns:
            Claude's analysis response
        """
        prompt = f"""
You are an expert system debugging assistant. Analyze the following logs to identify potential issues or errors.
Focus on:
1. Error messages and stack traces
2. Unusual patterns or unexpected behaviors
3. Potential root causes of issues

After your analysis, suggest one of the following next steps:
- Examine specific code location (provide file path and line number if possible)
- Focus on a specific log entry point
- Provide more context or additional logs

LOGS:
```
{logs[:15000]}  # Limiting to 15000 chars to ensure it fits in context
```

Provide your analysis in a clear, structured format with bullet points for key findings.
"""
        
        return self._call_claude(prompt)
    
    def analyze_code(self, code_context: str, file_path: str, line_number: int) -> str:
        """
        Analyze code with Claude to identify potential issues.
        
        Args:
            code_context: Code context to analyze
            file_path: Path to the file being analyzed
            line_number: Line number to focus on
            
        Returns:
            Claude's analysis response
        """
        prompt = f"""
You are an expert programming debugging assistant. Analyze the following code to identify potential issues or bugs.
Focus on line {line_number} and its surrounding context.

FILE: {file_path}
```
{code_context}
```

Based on this code:
1. Identify any potential bugs, edge cases, or issues in this code
2. Explain how this code might relate to common error patterns
3. Suggest specific fixes or improvements

Provide your analysis in a clear, structured format with bullet points for key findings.
"""
        
        return self._call_claude(prompt)
    
    def analyze_entry_point(self, log_context: str, entry_point: str) -> str:
        """
        Analyze a specific log entry point with Claude.
        
        Args:
            log_context: Log context around the entry point
            entry_point: The entry point string to focus on
            
        Returns:
            Claude's analysis response
        """
        prompt = f"""
You are an expert system debugging assistant. Analyze the following log section focused on the entry point: "{entry_point}".

LOG CONTEXT:
```
{log_context}
```

Based on this log section:
1. Identify what happened at this entry point
2. Explain how this relates to the overall system behavior
3. Suggest what code or component we should examine next
4. Identify any patterns or anomalies around this entry point

Provide your analysis in a clear, structured format with bullet points for key findings.
"""
        
        return self._call_claude(prompt)
    
    def ask_logs_question(self, logs: str, question: str) -> str:
        """
        Ask Claude a question about logs.
        
        Args:
            logs: Log content to reference
            question: Question about the logs
            
        Returns:
            Claude's response to the question
        """
        prompt = f"""
You are an expert system debugging assistant. Answer the following question about the logs:

QUESTION: {question}

LOGS:
```
{logs[:15000]}  # Limiting to 15000 chars to ensure it fits in context
```

Provide a clear, concise answer based on the log content. If you need more information or context, 
specify what additional details would be helpful.
"""
        
        return self._call_claude(prompt)
    
    def _call_claude(self, prompt: str) -> str:
        """
        Make API call to Claude.
        
        Args:
            prompt: Prompt to send to Claude
            
        Returns:
            Claude's response text
        """
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01"
        }
        
        data = {
            "model": self.model,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "max_tokens": self.max_tokens
        }
        
        try:
            response = requests.post(self.api_url, headers=headers, json=data)
            response.raise_for_status()  # Raise exception for non-200 status codes
            
            result = response.json()
            return result["content"][0]["text"]
            
        except requests.exceptions.RequestException as e:
            # Handle request errors
            error_message = f"Error calling Claude API: {str(e)}"
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_data = e.response.json()
                    if "error" in error_data:
                        error_message += f". Details: {error_data['error']}"
                except:
                    error_message += f". Status code: {e.response.status_code}"
            
            return f"⚠️ API Error: {error_message}"
        
        except (KeyError, json.JSONDecodeError, ValueError) as e:
            # Handle response parsing errors
            return f"⚠️ Error parsing API response: {str(e)}"