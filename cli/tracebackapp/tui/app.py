"""Main application for the Traceback TUI."""

from textual.app import App, ComposeResult
from textual.containers import Container, Vertical, Horizontal
from textual.widgets import Header, Footer, Input, RichLog, Static, Button, Label
import os
import re
from typing import Dict, Any, List, Optional

from tracebackapp.tools.commands import RootCauseCommands

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
        
        # Handle command inputs
        if user_input.startswith("/"):
            self._handle_command(user_input)
            input_widget.value = ""
            return

        # Add user message to chat log
        chat_log.write(f"[bold blue]You:[/] {user_input}")

        # Clear input field
        input_widget.value = ""

        # In a real application, here you would send the message to an AI service
        # For now, we'll just echo a placeholder response
        chat_log.write("[bold green]AI:[/] This is a placeholder response.")
        
    def _handle_command(self, command_text: str) -> None:
        """Handle command inputs."""
        chat_log = self.query_one("#chat-log", RichLog)
        
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

[bold]Keyboard Shortcuts:[/]
- [bold]Ctrl+C[/] - Quit the application
- [bold]Ctrl+I[/] - Interrupt the current AI response
            """
            chat_log.write("[bold orange]System:[/]" + help_text)
        elif command == "/clear":
            chat_log.clear()
            chat_log.write("[bold orange]System:[/] Chat history cleared.")
        elif command == "/analyze":
            # Root cause analysis command
            self._handle_root_cause_command(command, args_text)
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
        """Display the root cause analysis result."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        # Display the analysis
        if "analysis" in result and result["analysis"]:
            chat_log.write(f"[bold green]Analysis:[/] {result['analysis']}")
        
        # Display potential causes
        if "potential_causes" in result and result["potential_causes"]:
            chat_log.write("[bold green]Potential Causes:[/]")
            for i, cause in enumerate(result["potential_causes"]):
                cause_text = f"{i+1}. "
                if "file_path" in cause:
                    cause_text += f"{cause['file_path']}:{cause.get('line', 1)} - "
                if "context" in cause:
                    cause_text += cause["context"]
                chat_log.write(cause_text)
        
        # Display next steps as options
        if "next_steps" in result and result["next_steps"]:
            chat_log.write("[bold green]Next Steps:[/]")
            for i, step in enumerate(result["next_steps"]):
                step_text = f"{i+1}. {step.get('message', '')}"
                chat_log.write(step_text)
                
            # Display selection instructions
            chat_log.write("[bold]Use /select <number> to choose an option[/]")
    
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

    def action_interrupt(self) -> None:
        """Interrupt the current AI response."""
        chat_log = self.query_one("#chat-log", RichLog)
        chat_log.write("[bold orange]System:[/] AI response interrupted.")