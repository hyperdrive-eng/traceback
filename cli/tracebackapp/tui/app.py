"""Main application for the Traceback TUI."""

from textual.app import App, ComposeResult
from textual.containers import Container, Vertical, Horizontal
from textual.widgets import Header, Footer, Input, RichLog, Static, Button, Label
import os
import re
from typing import Dict, Any, List, Optional

from tracebackapp.tools.commands import RootCauseCommands
from tracebackapp.tools.claude_client import ClaudeClient

class CommandBar(Static):
    """A bar displaying available commands."""
    
    def __init__(self):
        super().__init__()
        self.update_commands({
            "ctrl+c": "Quit",
            "ctrl+i": "Interrupt", 
            "/help": "Show help",
            "/clear": "Clear chat",
            "/analyze": "Analyze root cause",
            "/code": "View code"
        })
    
    def update_commands(self, commands: dict) -> None:
        """Update the displayed commands."""
        command_text = " | ".join(f"{key}: {value}" for key, value in commands.items())
        self.update(f"[bold]{command_text}[/]")

class TracebackApp(App):
    """A terminal-based AI chat interface with root cause analysis capabilities."""

    CSS = """
    Screen {
        layout: grid;
        grid-size: 1 3;
        grid-rows: 1fr auto auto;
        grid-gutter: 0;
    }

    Container {
        height: 100%;
        layout: grid;
        grid-size: 1 2;
        grid-rows: 1fr auto;
        grid-gutter: 0;
    }

    #chat-area {
        height: 100%;
        overflow-y: auto;
    }

    #input-area {
        height: auto;
        padding: 1;
        background: $panel;
        border-top: solid $accent;
    }

    #command-bar {
        height: auto;
        padding: 1 1;
        background: $panel-darken-2;
        color: $text;
        text-align: center;
        border-top: solid $primary-lighten-2;
        dock: bottom;
    }

    #options-panel {
        layout: vertical;
        background: $surface;
        border: solid $primary;
        padding: 1;
        margin: 1;
        height: auto;
        max-height: 50%;
        overflow-y: auto;
    }

    .option-button {
        width: 100%;
        margin-bottom: 1;
        padding: 1;
    }

    .code-display {
        background: $surface-darken-1;
        color: $text;
        border: solid $primary;
        padding: 1;
        margin: 1;
        overflow-x: auto;
        overflow-y: auto;
    }

    Input {
        width: 100%;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+i", "interrupt", "Interrupt"),
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.root_cause_commands = RootCauseCommands()
        self.current_context = {}
        self.waiting_for = None  # Track what input we're waiting for
        self.current_logs = None  # Store the current log content
        self.current_log_path = None  # Store the current log file path
        self.llm_model = "claude-3-7-sonnet-20250219"  # LLM model to use
        self.api_key_file = os.path.expanduser("~/.traceback/api_key")
        
        # Try to load API key from file
        self.api_key = self._load_api_key()
        
        # Initialize Claude client - will use ANTHROPIC_API_KEY env var or stored key
        try:
            if self.api_key:
                self.claude = ClaudeClient(api_key=self.api_key, model=self.llm_model)
            else:
                self.claude = ClaudeClient(model=self.llm_model)  # Try env var
            self.claude_available = True
        except ValueError:
            self.claude_available = False

    def compose(self) -> ComposeResult:
        """Compose the application layout."""
        # No header or footer to remove default commands
        with Container():
            with Vertical(id="chat-area"):
                yield RichLog(highlight=True, markup=True, id="chat-log")
            with Vertical(id="input-area"):
                yield Input(placeholder="Type your message here (Ctrl+I to interrupt)", id="user-input")
        with Vertical(id="command-bar"):
            yield CommandBar()

    def on_mount(self) -> None:
        """Handle the mount event."""
        self.query_one(Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle submitted input."""
        user_input = event.value.strip()
        if not user_input:
            return

        chat_log = self.query_one("#chat-log", RichLog)
        input_widget = self.query_one("#user-input", Input)
        
        # Check if we're waiting for specific input
        if self.waiting_for:
            if self.waiting_for == "api_key":
                # Handle API key input
                self._handle_api_key_input(user_input)
                input_widget.value = ""
                input_widget.placeholder = "Type your message here (Ctrl+I to interrupt)"
                self.waiting_for = None
                return
            elif self.waiting_for == "analyze_file_path":
                self._process_log_file(user_input)
                input_widget.value = ""
                input_widget.placeholder = "Type your message here (Ctrl+I to interrupt)"
                self.waiting_for = None
                return
            elif self.waiting_for == "code_path":
                self._process_code_request(user_input)
                input_widget.value = ""
                input_widget.placeholder = "Type your message here (Ctrl+I to interrupt)"
                self.waiting_for = None
                return
            elif self.waiting_for == "entry_point":
                self._process_entry_point(user_input)
                input_widget.value = ""
                input_widget.placeholder = "Type your message here (Ctrl+I to interrupt)"
                self.waiting_for = None
                return
        
        # Handle command inputs
        if user_input.startswith("/"):
            self._handle_command(user_input)
            input_widget.value = ""
            return

        # Add user message to chat log
        chat_log.write(f"[bold blue]You:[/] {user_input}")

        # Clear input field
        input_widget.value = ""

        # If we have logs loaded, treat this as a follow-up question about the logs
        if self.current_logs:
            self._process_log_followup(user_input)
        else:
            # Regular chat response
            chat_log.write("[bold green]AI:[/] This is a placeholder response.")
        
    def _handle_command(self, command_text: str) -> None:
        """Handle command inputs."""
        chat_log = self.query_one("#chat-log", RichLog)
        input_widget = self.query_one("#user-input", Input)
        
        # Split the command and args
        parts = command_text.split(None, 1)
        command = parts[0].lower()
        args_text = parts[1] if len(parts) > 1 else ""
        
        if command == "/help":
            help_text = """
[bold]Available Commands:[/]
- [bold]/help[/] - Show this help message
- [bold]/clear[/] - Clear the chat history
- [bold]/analyze[/] - Analyze logs for root cause
- [bold]/code [file:line][/] - View code at location
- [bold]/log [log line][/] - Analyze a specific log line
- [bold]/stack [file:line][/] - Get stack trace for location
- [bold]/callers [file:line][/] - Find callers of a function
- [bold]/select [option_id][/] - Select an option
- [bold]/apikey [key][/] - Set API key for Claude
- [bold]/apikey-status[/] - Check API key status

[bold]Keyboard Shortcuts:[/]
- [bold]Ctrl+C[/] - Quit the application
- [bold]Ctrl+I[/] - Interrupt the current AI response
            """
            chat_log.write("[bold orange]System:[/]" + help_text)
        elif command == "/clear":
            chat_log.clear()
            chat_log.write("[bold orange]System:[/] Chat history cleared.")
        elif command == "/apikey":
            # Handle API key command
            if not args_text:
                # Prompt for API key
                self._prompt_for_api_key()
            else:
                # Set API key directly
                self._handle_api_key_input(args_text)
        elif command == "/apikey-status":
            # Check API key status
            if self.claude_available:
                chat_log.write("[bold green]API Key Status:[/] Claude API is configured and available.")
                
                # Show a masked version of the key
                if self.api_key:
                    masked_key = self.api_key[:7] + "..." + self.api_key[-4:] if len(self.api_key) > 11 else "***"
                    chat_log.write(f"[bold green]API Key:[/] {masked_key}")
                else:
                    chat_log.write("[bold green]API Key:[/] Using environment variable ANTHROPIC_API_KEY")
            else:
                chat_log.write("[bold yellow]API Key Status:[/] Claude API is not available.")
                chat_log.write("[bold yellow]Note:[/] Use /apikey to set your API key.")
        elif command == "/analyze":
            # Handle analyze workflow with file path input
            if not args_text:
                chat_log.write("[bold orange]System:[/] Please provide a log file path.")
                # Set the input widget to a special mode to capture the file path
                self.waiting_for = "analyze_file_path"
                input_widget.placeholder = "Enter path to log file"
                return
            else:
                # Process the file path directly
                self._process_log_file(args_text)
        elif command == "/code":
            # Code view command
            self._handle_root_cause_command(command, args_text)
        elif command == "/log":
            # Log analysis command
            self._handle_root_cause_command(command, args_text)
        elif command == "/stack":
            # Stack trace command
            self._handle_root_cause_command(command, args_text)
        elif command == "/callers":
            # Callers command
            self._handle_root_cause_command(command, args_text)
        elif command == "/select":
            # Option selection command
            self._handle_root_cause_command(command, args_text)
        else:
            chat_log.write(f"[bold orange]System:[/] Unknown command: {command}")

    def _handle_root_cause_command(self, command: str, args_text: str) -> None:
        """Handle root cause analysis commands."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Parse the arguments based on the command
        args = self._parse_command_args(command, args_text)
        
        # Log the command being executed
        chat_log.write(f"[bold blue]Command:[/] {command} {args_text}")
        
        # Execute the command through the root cause commands handler
        result = self.root_cause_commands.handle_command(command, args)
        
        # Handle the result
        if result.get("status") == "error":
            chat_log.write(f"[bold red]Error:[/] {result.get('message', 'Unknown error')}")
            return
        
        # Process successful command results
        if command == "/analyze":
            self._display_analysis_result(result.get("result", {}))
        elif command == "/code":
            self._display_code_result(result.get("result", {}))
        elif command == "/log":
            self._display_log_analysis(result.get("result", {}))
        elif command == "/stack":
            self._display_stack_trace(result.get("result", {}))
        elif command == "/callers":
            self._display_callers(result.get("result", {}))
        elif command == "/select":
            self._display_selection_result(result)
        
    def _parse_command_args(self, command: str, args_text: str) -> Dict[str, Any]:
        """Parse command arguments based on the command type."""
        args = {}
        
        if command == "/analyze":
            # Check if argument is a file path or raw logs
            if os.path.isfile(args_text):
                try:
                    with open(args_text, 'r') as f:
                        logs = f.read()
                    args["logs"] = logs
                except Exception as e:
                    args["error"] = f"Could not read file: {str(e)}"
            elif args_text:
                # Treat as raw logs
                args["logs"] = args_text
        elif command in ["/code", "/stack", "/callers"]:
            # These commands expect a file:line format
            args["code_location"] = args_text
        elif command == "/log":
            # Log line analysis
            args["log_line"] = args_text
        elif command == "/select":
            # Option selection
            try:
                args["option_id"] = int(args_text)
            except ValueError:
                args["error"] = f"Invalid option ID: {args_text}"
        
        return args
    
    def _display_analysis_result(self, result: Dict[str, Any]) -> None:
        """Display the analysis result and handle next steps."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display the analysis
        if "analysis" in result:
            chat_log.write("[bold green]Analysis:[/]")
            chat_log.write(result["analysis"])
            
        # Display potential causes
        if "potential_causes" in result and result["potential_causes"]:
            chat_log.write("\n[bold green]Potential Causes:[/]")
            for cause in result["potential_causes"]:
                chat_log.write(f"• {cause}")
                
        # Display next steps as options
        if "next_steps" in result and result["next_steps"]:
            chat_log.write("\n[bold green]Next Steps:[/]")
            
            # Store options for selection
            self.current_options = result["next_steps"]
            
            for i, step in enumerate(result["next_steps"], 1):
                if isinstance(step, dict):
                    # Handle structured step
                    if step.get("type") == "present_options":
                        chat_log.write(f"\n{step['message']}")
                    elif step.get("type") in ["send_code", "get_callers", "log_segment"]:
                        chat_log.write(f"{i}. {step.get('message', 'Examine')} at {step.get('file_path')}:{step.get('line', '')}")
                    else:
                        chat_log.write(f"{i}. {step.get('message', str(step))}")
                else:
                    # Handle simple string step
                    chat_log.write(f"{i}. {step}")
                    
            chat_log.write("\n[bold yellow]Use /select <number> to choose a next step[/]")
    
    def _display_code_result(self, result: Dict[str, Any]) -> None:
        """Display code view result."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        if "error" in result:
            chat_log.write(f"[bold red]Error:[/] {result['error']}")
            return
        
        # Display the code
        chat_log.write(f"[bold green]Code from {result.get('file_path')}:[/]")
        chat_log.write(f"```\n{result.get('code', '')}\n```")
    
    def _display_log_analysis(self, result: Dict[str, Any]) -> None:
        """Display log line analysis result."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display the analysis
        if "analysis" in result:
            chat_log.write(f"[bold green]Log Analysis:[/] {result['analysis']}")
        
        # Display patterns found
        if "patterns" in result and result["patterns"]:
            chat_log.write("[bold green]Patterns Found:[/]")
            for pattern in result["patterns"]:
                chat_log.write(f"- {pattern}")
        
        # Display grep commands
        if "grep_commands" in result and result["grep_commands"]:
            chat_log.write("[bold green]Suggested Grep Commands:[/]")
            for cmd in result["grep_commands"]:
                chat_log.write(f"- {cmd}")
    
    def _display_stack_trace(self, result: Dict[str, Any]) -> None:
        """Display stack trace result."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display the stack trace
        if "stack_trace" in result:
            chat_log.write("[bold green]Stack Trace:[/]")
            chat_log.write(f"```\n{result['stack_trace']}\n```")
    
    def _display_callers(self, result: Dict[str, Any]) -> None:
        """Display callers result."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display the callers
        if "callers" in result and result["callers"]:
            chat_log.write(f"[bold green]Callers of {result.get('code_location')}:[/]")
            for i, caller in enumerate(result["callers"]):
                caller_text = f"{i+1}. {caller.get('file_path')}:{caller.get('line', 1)}"
                if "function" in caller:
                    caller_text += f" in {caller['function']}"
                if "context" in caller:
                    caller_text += f"\n   {caller['context']}"
                chat_log.write(caller_text)
    
    def _display_selection_result(self, result: Dict[str, Any]) -> None:
        """Display the result of selecting an option."""
        # The result should contain either a specific result type
        # or a generic message
        if "message" in result:
            chat_log = self.query_one("#chat-log", RichLog)
            chat_log.write(f"[bold green]Selection:[/] {result['message']}")
        
        # Check for other result types and display accordingly
        if "result" in result:
            result_type = result.get("result_type", "")
            if result_type == "analysis":
                self._display_analysis_result(result["result"])
            elif result_type == "code":
                self._display_code_result(result["result"])
            elif result_type == "callers":
                self._display_callers(result["result"])

    def _process_log_file(self, file_path: str) -> None:
        """Process a log file and send to LLM for analysis."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Check if this is actually a command that was misinterpreted as a path
        if file_path.startswith("/") and len(file_path.split()) == 1 and not os.path.exists(file_path):
            known_commands = ["/help", "/clear", "/analyze", "/code", "/log", "/stack", "/callers", "/select"]
            if file_path in known_commands:
                chat_log.write(f"[bold orange]System:[/] '{file_path}' appears to be a command, not a file path.")
                chat_log.write("[bold orange]System:[/] Please provide an absolute path to a log file.")
                return
        
        # Try to read the log file
        try:
            with open(file_path, 'r') as f:
                log_content = f.read()
                
            # Store the log content and path for later reference
            self.current_logs = log_content
            self.current_log_path = file_path
            
            # Display a sample of the log content
            chat_log.write(f"[bold green]Loaded logs from:[/] {file_path}")
            
            # Get a sample to show (first 5 lines)
            sample_lines = log_content.split("\n")[:5]
            chat_log.write("[bold green]Sample of logs:[/]")
            for line in sample_lines:
                chat_log.write(f"  {line}")
            
            if len(log_content.split("\n")) > 5:
                chat_log.write("  ...")
            
            # Analyze the logs with LLM
            self._analyze_logs_with_llm(log_content)
            
        except Exception as e:
            chat_log.write(f"[bold red]Error:[/] Could not read file: {str(e)}")
    
    def _analyze_logs_with_llm(self, log_content: str) -> None:
        """Analyze logs with LLM to identify potential issues."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display loading indicator
        chat_log.write("[bold orange]System:[/] Analyzing logs with AI...")
        
        if not self.claude_available:
            # Store the operation for later resumption
            self.pending_operation = ("analyze_logs", log_content)
            
            # Prompt user for API key
            self._prompt_for_api_key()
            return
            
        # Create display callback for analysis results
        def display_analysis(message: str) -> None:
            if message.startswith("Root Cause Analysis:"):
                chat_log.write("[bold green]AI Root Cause:[/]")
            else:
                chat_log.write("[bold green]AI Analysis:[/]")
            chat_log.write(message)
            
        # Start recursive analysis
        try:
            # Create analyzer
            analyzer = self.root_cause_commands.analyzer
            
            # Start analysis with callback for displaying results
            analyzer.analyze(log_content, display_callback=display_analysis)
            
        except Exception as e:
            chat_log.write(f"[bold red]Error:[/] Failed to analyze logs: {str(e)}")
    
    def _process_code_request(self, code_path: str) -> None:
        """Process a request to examine specific code."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Check if the code path is in the correct format
        if ":" not in code_path:
            chat_log.write("[bold red]Error:[/] Code path should be in the format 'file_path:line_number'")
            return
            
        file_path, line_str = code_path.split(":", 1)
        
        try:
            line_number = int(line_str)
        except ValueError:
            chat_log.write("[bold red]Error:[/] Line number must be an integer")
            return
            
        # Try to read the code file
        try:
            with open(file_path, 'r') as f:
                code_content = f.readlines()
                
            # Get code context (20 lines before and after)
            start_line = max(0, line_number - 20)
            end_line = min(len(code_content), line_number + 20)
            
            code_context = "".join(code_content[start_line:end_line])
            
            # Display the code
            chat_log.write(f"[bold green]Code from {file_path}:[/]")
            
            # Format with line numbers
            formatted_code = ""
            for i, line in enumerate(code_content[start_line:end_line], start=start_line+1):
                prefix = "→ " if i == line_number else "  "
                formatted_code += f"{prefix}{i}: {line}"
                
            chat_log.write(f"```\n{formatted_code}```")
            
            # Analyze the code with LLM
            self._analyze_code_with_llm(code_context, file_path, line_number)
            
        except Exception as e:
            chat_log.write(f"[bold red]Error:[/] Could not read file: {str(e)}")
    
    def _analyze_code_with_llm(self, code_context: str, file_path: str, line_number: int) -> None:
        """Analyze code with LLM to identify potential issues."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display loading indicator
        chat_log.write("[bold orange]System:[/] Analyzing code with AI...")
        
        if not self.claude_available:
            # Store the operation for later resumption
            self.pending_operation = ("analyze_code", (file_path, line_number, code_context))
            
            # Prompt user for API key
            self._prompt_for_api_key()
            
            # Fallback to simulated response in the meantime
            import time
            time.sleep(2)
            
            # Sample LLM response
            analysis = f"""
I've analyzed the code at {file_path}:{line_number} and here are my findings:

• The issue appears to be in the error handling logic around line {line_number}
• The code is not properly checking for timeout conditions before attempting to access response data
• There's a potential race condition in the connection management
• Error recovery doesn't properly clean up resources

Suggested fixes:
1. Add explicit timeout handling with proper error messages
2. Implement retry logic with exponential backoff
3. Ensure connections are properly closed in all error paths
4. Add logging to capture more context when errors occur

This code is directly related to the "Connection timeout" errors in the logs. The timeout exception is being caught but not properly handled, leading to cascading failures.
"""
            chat_log.write("[bold yellow]Note:[/] Using simulated response (API key not set). Enter your API key to use Claude.")
        else:
            # Use the real Claude API
            try:
                analysis = self.claude.analyze_code(code_context, file_path, line_number)
            except Exception as e:
                analysis = f"Error analyzing code: {str(e)}"
        
        # Display the LLM analysis
        chat_log.write(f"[bold green]AI Code Analysis:[/] {analysis}")
    
    def _process_entry_point(self, entry_point: str) -> None:
        """Process a specific log entry point for analysis."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        if not self.current_logs:
            chat_log.write("[bold red]Error:[/] No logs have been loaded. Use /analyze to load logs first.")
            return
            
        # Find the entry point in the logs
        logs = self.current_logs.split("\n")
        matching_lines = []
        
        for i, line in enumerate(logs):
            if entry_point in line:
                # Get some context (5 lines before and after)
                start = max(0, i - 5)
                end = min(len(logs), i + 6)
                matching_lines.append((i, "\n".join(logs[start:end])))
                
        if not matching_lines:
            chat_log.write(f"[bold red]Error:[/] Entry point '{entry_point}' not found in logs.")
            return
            
        # Show the matching entry points
        chat_log.write(f"[bold green]Found {len(matching_lines)} matches for entry point:[/] {entry_point}")
        
        for i, (line_num, context) in enumerate(matching_lines[:3]):  # Limit to first 3 matches
            chat_log.write(f"[bold]Match {i+1} at line {line_num+1}:[/]")
            chat_log.write(f"```\n{context}\n```")
            
        if len(matching_lines) > 3:
            chat_log.write(f"[bold]...and {len(matching_lines) - 3} more matches[/]")
            
        # Analyze the first match with LLM
        self._analyze_entry_point_with_llm(matching_lines[0][1], entry_point)
    
    def _analyze_entry_point_with_llm(self, log_context: str, entry_point: str) -> None:
        """Analyze a specific log entry point with LLM."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display loading indicator
        chat_log.write("[bold orange]System:[/] Analyzing entry point with AI...")
        
        if not self.claude_available:
            # Store the operation for later resumption
            self.pending_operation = ("analyze_entry_point", (log_context, entry_point))
            
            # Prompt user for API key
            self._prompt_for_api_key()
            
            # Fallback to simulated response in the meantime
            import time
            time.sleep(2)
            
            # Sample LLM response
            analysis = f"""
I've analyzed the logs around the entry point "{entry_point}" and here are my findings:

• This entry point marks where the system started experiencing connection issues
• There's a pattern of increasing response times just before the errors appear
• The error is triggered during a high-load period (notice the increased request frequency)
• There appears to be a resource exhaustion issue (possibly connection pool or memory)

This entry point is significant because:
1. It's the first occurrence of network delays before the cascade of failures
2. The timestamp correlates with the start of system degradation
3. The user request that triggered this was processing an unusually large payload

I recommend examining:
- The connection pool management code
- Resource cleanup in the request handling pipeline
- Any recent changes to the network timeout configuration
"""
            chat_log.write("[bold yellow]Note:[/] Using simulated response (API key not set). Enter your API key to use Claude.")
        else:
            # Use the real Claude API
            try:
                analysis = self.claude.analyze_entry_point(log_context, entry_point)
            except Exception as e:
                analysis = f"Error analyzing entry point: {str(e)}"
        
        # Display the LLM analysis
        chat_log.write(f"[bold green]AI Entry Point Analysis:[/] {analysis}")
    
    def _process_log_followup(self, question: str) -> None:
        """Process a follow-up question about the logs."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        if not self.current_logs:
            chat_log.write("[bold red]Error:[/] No logs have been loaded. Use /analyze to load logs first.")
            return
            
        # Display loading indicator
        chat_log.write("[bold orange]System:[/] Processing your question...")
        
        if not self.claude_available:
            # Store the operation for later resumption
            self.pending_operation = ("log_followup", question)
            
            # Prompt user for API key
            self._prompt_for_api_key()
            
            # Fallback to simulated response in the meantime
            import time
            time.sleep(2)
            
            # Sample LLM response based on the question
            if "error" in question.lower():
                answer = """
The main errors in the logs are:

1. Connection timeouts occurring at regular intervals
2. Database query failures with "too many connections" errors
3. Memory allocation errors in the cache layer
4. Several instances of request handling threads being terminated unexpectedly

The most critical appears to be the connection pool exhaustion, which is causing cascading failures in other components.
"""
            elif "time" in question.lower() or "when" in question.lower():
                answer = """
The issues began at 2023-04-12 15:23:45 UTC, with the first connection timeout.
The system completely degraded by 15:27:30, about 4 minutes later.
The pattern shows a gradual increase in error frequency, suggesting a resource leak or cascading failure.
"""
            else:
                answer = """
Based on the logs, the root cause appears to be connection pool exhaustion. The system is not properly closing database connections, which eventually leads to the "too many connections" errors.

This is likely caused by:
1. Missing connection cleanup in error handling paths
2. No timeout on idle connections
3. No maximum lifetime setting for connections

The fix would involve reviewing connection management code, particularly ensuring connections are returned to the pool or closed in all code paths, including error handlers.
"""
            chat_log.write("[bold yellow]Note:[/] Using simulated response (API key not set). Enter your API key to use Claude.")
        else:
            # Use the real Claude API
            try:
                answer = self.claude.ask_logs_question(self.current_logs, question)
            except Exception as e:
                answer = f"Error processing question: {str(e)}"
        
        # Display the LLM response
        chat_log.write(f"[bold green]AI:[/] {answer}")

    def _load_api_key(self) -> Optional[str]:
        """Load API key from file."""
        try:
            if os.path.exists(self.api_key_file):
                with open(self.api_key_file, 'r') as f:
                    return f.read().strip()
        except Exception:
            # If we can't read the file, just return None
            pass
        return None
    
    def _save_api_key(self, api_key: str) -> bool:
        """Save API key to file."""
        try:
            # Make directory if it doesn't exist
            os.makedirs(os.path.dirname(self.api_key_file), exist_ok=True)
            
            # Save API key to file
            with open(self.api_key_file, 'w') as f:
                f.write(api_key)
            
            # Set file permissions to be readable only by the user
            os.chmod(self.api_key_file, 0o600)
            
            return True
        except Exception as e:
            print(f"Error saving API key: {str(e)}")
            return False
    
    def _prompt_for_api_key(self) -> None:
        """Prompt user for API key."""
        chat_log = self.query_one("#chat-log", RichLog)
        input_widget = self.query_one("#user-input", Input)
        
        chat_log.write("[bold orange]System:[/] Claude API key not found. Please enter your Anthropic API key.")
        chat_log.write("[bold orange]System:[/] Your key will be stored in ~/.traceback/api_key")
        
        # Set the input widget to a special mode to capture the API key
        self.waiting_for = "api_key"
        input_widget.placeholder = "Enter your Anthropic API key (starts with 'sk-')"
    
    def _handle_api_key_input(self, api_key: str) -> None:
        """Handle API key input from user."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Validate the API key format
        if not api_key.startswith("sk-"):
            chat_log.write("[bold red]Error:[/] Invalid API key format. API keys start with 'sk-'.")
            chat_log.write("[bold orange]System:[/] Please enter a valid Anthropic API key.")
            return
        
        # Save the API key
        if self._save_api_key(api_key):
            self.api_key = api_key
            
            # Initialize Claude with the new key
            try:
                self.claude = ClaudeClient(api_key=self.api_key, model=self.llm_model)
                self.claude_available = True
                chat_log.write("[bold green]Success:[/] API key saved and Claude initialized.")
                
                # If we were in the middle of an operation, continue
                if hasattr(self, 'pending_operation') and self.pending_operation:
                    operation, args = self.pending_operation
                    chat_log.write("[bold orange]System:[/] Resuming previous operation...")
                    
                    if operation == "analyze_logs":
                        self._analyze_logs_with_llm(args)
                    elif operation == "analyze_code":
                        file_path, line_number, code_context = args
                        self._analyze_code_with_llm(code_context, file_path, line_number)
                    elif operation == "analyze_entry_point":
                        log_context, entry_point = args
                        self._analyze_entry_point_with_llm(log_context, entry_point)
                    elif operation == "log_followup":
                        self._process_log_followup(args)
                    
                    self.pending_operation = None
            except ValueError as e:
                chat_log.write(f"[bold red]Error:[/] Failed to initialize Claude with the provided key: {str(e)}")
        else:
            chat_log.write("[bold red]Error:[/] Failed to save API key.")
    
    def action_interrupt(self) -> None:
        """Interrupt the current AI response."""
        chat_log = self.query_one("#chat-log", RichLog)
        chat_log.write("[bold orange]System:[/] AI response interrupted.")