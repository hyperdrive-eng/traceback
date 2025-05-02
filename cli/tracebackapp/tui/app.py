"""Main application for the Traceback TUI."""

from textual.app import App, ComposeResult
from textual.containers import Container, Vertical, Horizontal
from textual.widgets import Header, Footer, Input, RichLog, Static

class CommandBar(Static):
    """A bar displaying available commands."""
    
    def __init__(self):
        super().__init__()
        self.update_commands({
            "ctrl+c": "Quit",
            "ctrl+i": "Interrupt", 
            "/help": "Show help",
            "/clear": "Clear chat"
        })
    
    def update_commands(self, commands: dict) -> None:
        """Update the displayed commands."""
        command_text = " | ".join(f"{key}: {value}" for key, value in commands.items())
        self.update(f"[bold]{command_text}[/]")

class TracebackApp(App):
    """A terminal-based AI chat interface."""

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

    Input {
        width: 100%;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+i", "interrupt", "Interrupt"),
    ]

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
        
    def _handle_command(self, command: str) -> None:
        """Handle command inputs."""
        chat_log = self.query_one("#chat-log", RichLog)
        
        if command == "/help":
            help_text = """
[bold]Available Commands:[/]
- [bold]/help[/] - Show this help message
- [bold]/clear[/] - Clear the chat history

[bold]Keyboard Shortcuts:[/]
- [bold]Ctrl+C[/] - Quit the application
- [bold]Ctrl+I[/] - Interrupt the current AI response
            """
            chat_log.write("[bold orange]System:[/]" + help_text)
        elif command == "/clear":
            chat_log.clear()
            chat_log.write("[bold orange]System:[/] Chat history cleared.")
        else:
            chat_log.write(f"[bold orange]System:[/] Unknown command: {command}")

    def action_interrupt(self) -> None:
        """Interrupt the current AI response."""
        chat_log = self.query_one("#chat-log", RichLog)
        chat_log.write("[bold orange]System:[/] AI response interrupted.")