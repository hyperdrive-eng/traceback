"""Main application for the Traceback TUI."""

from textual.app import App, ComposeResult
from textual.containers import Container, Vertical
from textual.widgets import Header, Footer, Input, RichLog

class TracebackApp(App):
    """A terminal-based AI chat interface."""

    CSS = """
    Screen {
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
        yield Header()
        with Container():
            with Vertical(id="chat-area"):
                yield RichLog(highlight=True, markup=True, id="chat-log")
            with Vertical(id="input-area"):
                yield Input(placeholder="Type your message here (Ctrl+I to interrupt)", id="user-input")
        yield Footer()

    def on_mount(self) -> None:
        """Handle the mount event."""
        self.query_one(Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle submitted input."""
        user_input = event.value.strip()
        if not user_input:
            return

        # Add user message to chat log
        chat_log = self.query_one("#chat-log", RichLog)
        chat_log.write(f"[bold blue]You:[/] {user_input}")

        # Clear input field
        input_widget = self.query_one("#user-input", Input)
        input_widget.value = ""

        # In a real application, here you would send the message to an AI service
        # For now, we'll just echo a placeholder response
        chat_log.write("[bold green]AI:[/] This is a placeholder response.")

    def action_interrupt(self) -> None:
        """Interrupt the current AI response."""
        chat_log = self.query_one("#chat-log", RichLog)
        chat_log.write("[bold orange]System:[/] AI response interrupted.")