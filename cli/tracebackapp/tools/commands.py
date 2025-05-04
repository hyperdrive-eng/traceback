"""Command handlers for the root cause analysis tools."""

from typing import Dict, Any, List, Optional
from .analysis_tools import Analyzer

class RootCauseCommands:
    """Command handlers for the root cause analysis tools in the Traceback CLI."""
    
    def __init__(self):
        """Initialize the command handlers."""
        self.analyzer = Analyzer()
        self.current_options = []  # Store current options for user selection
        
    def handle_command(self, command: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Handle a root cause analysis command.
        
        Args:
            command: The command to execute
            args: Arguments for the command
            
        Returns:
            Dictionary with the command results
        """
        args = args or {}
        
        # Map commands to their handlers
        command_map = {
            "/analyze": self._analyze_root_cause,
            "/options": self._present_options,
            "/log": self._analyze_log_line,
            "/stack": self._get_stack_trace,
            "/callers": self._get_callers,
            "/code": self._send_code,
            "/select": self._select_option
        }
        
        # Execute the command if it exists
        if command in command_map:
            return command_map[command](args)
        
        return {
            "status": "error",
            "message": f"Unknown command: {command}"
        }
    
    def _analyze_root_cause(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the analyze root cause command using the new Analyzer."""
        logs = args.get("logs")
        
        if not logs:
            return {
                "status": "error",
                "message": "No logs provided for analysis"
            }
            
        # Note: We don't call analyzer.analyze() directly here
        # because that's handled by _analyze_logs_with_llm in the TUI
        
        return {
            "status": "success",
            "result": {
                "analysis": "Analysis initiated. Results will be displayed incrementally."
            }
        }
    
    def _present_options(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the present options command."""
        options = args.get("options", self.current_options)
        result = self.analyzer.present_options(options)
        
        # Store the options for later selection
        self.current_options = options
        
        return {
            "status": "success",
            "options": result
        }
    
    def _analyze_log_line(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the analyze log line command."""
        log_line = args.get("log_line", "")
        if not log_line:
            return {
                "status": "error",
                "message": "No log line provided"
            }
        
        result = self.analyzer.analyze_log_line(log_line)
        return {
            "status": "success",
            "result": result
        }
    
    def _get_stack_trace(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the get stack trace command."""
        code_location = args.get("code_location", "")
        if not code_location:
            return {
                "status": "error",
                "message": "No code location provided"
            }
        
        result = self.analyzer.get_stack_trace(code_location)
        return {
            "status": "success",
            "result": result
        }
    
    def _get_callers(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the get callers command."""
        code_location = args.get("code_location", "")
        if not code_location:
            return {
                "status": "error",
                "message": "No code location provided"
            }
        
        result = self.analyzer.get_callers(code_location)
        return {
            "status": "success",
            "result": result
        }
    
    def _send_code(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the send code command."""
        code_location = args.get("code_location", "")
        if not code_location:
            return {
                "status": "error",
                "message": "No code location provided"
            }
        
        context_lines = args.get("context_lines", 20)
        result = self.analyzer.send_code(code_location, context_lines)
        return {
            "status": "success",
            "result": result
        }
    
    def _select_option(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle option selection."""
        option_id = args.get("option_id")
        if option_id is None:
            return {
                "status": "error",
                "message": "No option ID provided"
            }
        
        # Convert to int if it's a string
        try:
            option_id = int(option_id)
        except ValueError:
            return {
                "status": "error",
                "message": f"Invalid option ID: {option_id}"
            }
        
        # Check if the option ID is valid
        if not self.current_options or option_id < 1 or option_id > len(self.current_options):
            return {
                "status": "error",
                "message": f"Invalid option ID: {option_id}"
            }
        
        # Get the selected option
        selected_option = self.current_options[option_id - 1]
        
        # Based on the option type, take appropriate action
        option_type = selected_option.get("type", "")
        
        if option_type == "log_segment":
            # Analyze the log segment
            return self._analyze_root_cause({
                "logs": selected_option.get("segment", "")
            })
        elif option_type == "send_code":
            # Send the code
            return self._send_code({
                "code_location": f"{selected_option.get('file_path')}:{selected_option.get('line', 1)}"
            })
        elif option_type == "get_callers":
            # Get the callers
            return self._get_callers({
                "code_location": f"{selected_option.get('file_path')}:{selected_option.get('line', 1)}"
            })
        
        return {
            "status": "success",
            "message": f"Selected option {option_id}: {selected_option.get('message', '')}"
        }